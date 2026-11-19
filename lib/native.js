/**
 * Native engine (方案 B, Host half): drives the DSH Desktop built-in renderer
 * instead of a standalone Chromium instance.
 *
 * The Host has no direct handle on the client's `<webview>`: this engine only
 * queues commands and the client half (client.js) executes them inside the
 * right-sidebar tab, polling `/web-browser/bridge/next` and posting results to
 * `/web-browser/bridge/result`. Nothing here talks to Electron or DSH core, and
 * the module only imports Node builtins plus pure helpers from `browser.js`.
 *
 * Presence model: a poll of `/bridge/next` records `lastPollAt`; `tabOpen` is
 * true while a poll happened less than {@link PRESENCE_WINDOW_MS} ago. Every
 * command method throws {@link NativeUnavailableError} immediately when the
 * bridge is unavailable or the client view is not mounted, which is exactly what
 * the `auto` facade falls back on.
 *
 * Search is deliberately NOT native: a search runs in a throwaway CDP target in
 * the background, so `searchFrom()` delegates to the classic BrowserEngine and
 * never navigates the user's visible tab.
 */
import { DEFAULT_START_URL, displayUrl, isPrivateHost, normalizeUrl, resolveProfileDir } from './browser.js';

/** Bridge protocol this Host speaks; the client must declare the same version. */
export const PROTOCOL_VERSION = 1;

/** Per-command deadlines from the frozen contract. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 8000;
export const NAVIGATE_TIMEOUT_MS = 20000;
export const CAPTURE_TIMEOUT_MS = 10000;

/** A poll younger than this keeps `tabOpen` true. */
export const PRESENCE_WINDOW_MS = 2000;

/** Longest `/bridge/next` long-poll wait the contract allows. */
export const MAX_POLL_WAIT_MS = 1000;

/** Viewport bounds shared with the sidebar view override. */
const VIEW_MIN_WIDTH = 320;
const VIEW_MAX_WIDTH = 1920;
const VIEW_MIN_HEIGHT = 240;
const VIEW_MAX_HEIGHT = 1600;
const VIEW_DEFAULT = { width: 1100, height: 820 };

function textOf(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (value instanceof Error && typeof value.message === 'string' && value.message.trim() !== '') return value.message.trim();
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampDpr(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.min(3, Math.max(1, Math.round(number * 100) / 100));
}

/**
 * Raised when the native path cannot run right now: bridge missing/unavailable,
 * protocol mismatch, or the client view not mounted. `reason` is a stable,
 * human-readable string suitable for `status().degradedReason`.
 */
export class NativeUnavailableError extends Error {
  constructor(reason) {
    const text = textOf(reason, '原生视图不可用');
    super(text);
    this.name = 'NativeUnavailableError';
    /** Stable reason the UI and the facade can show. */
    this.reason = text;
  }
}

/** Timeout failure of one queued command (not a fallback signal by itself). */
function timeoutError(entry) {
  const error = new Error('原生命令超时（' + String(entry.timeoutMs) + 'ms）：' + entry.command);
  error.code = 'NATIVE_TIMEOUT';
  error.command = entry.command;
  return error;
}

/** Failure reported by the client for one command (page-level, not fallback). */
function commandFailure(command, reason) {
  const error = new Error(textOf(reason, '原生命令失败：' + command));
  error.code = 'NATIVE_COMMAND_FAILED';
  error.command = command;
  return error;
}

/** The native renderer engine for one plugin instance. */
export class NativeEngine {
  /**
   * @param options - settings reader, the classic engine (search/profile
   *   delegation), and a logger.
   */
  constructor({ settings, classic, log } = {}) {
    /** Settings reader; every call returns a fresh snapshot. */
    this.settings = typeof settings === 'function' ? settings : () => ({});
    /** Classic CDP engine: owns search, profile, and status merge. */
    this.classic = classic;
    /** Logger prefix handled by index.js. */
    this.log = typeof log === 'function' ? log : () => {};

    /** Commands not handed to a polling client yet (FIFO). */
    this.queue = [];
    /** id -> pending entry; entries leave this map on result, timeout, or stop. */
    this.pending = new Map();
    /** Resolvers of in-flight `/bridge/next` long polls. */
    this.waiters = [];
    /** Monotonic command id source. */
    this.nextId = 1;

    /** Whether `/bridge/hello` reported a usable native view. */
    this.availableFlag = false;
    /** Bridge protocol declared by the client. */
    this.protocolVersion = 0;
    /** Why native is unavailable, when the client said so. */
    this.reason = undefined;
    /** Last `/bridge/next` poll (presence heartbeat). */
    this.lastPollAt = 0;
    /** Last `/bridge/result` arrival (diagnostics). */
    this.lastResultAt = 0;

    /** Last known page state, mirrored from command results. */
    this.url = '';
    this.title = '';
    this.loading = false;
    /** Last capture (JPEG bytes) so `/frame` and screenshot can reuse it. */
    this.frameBuffer = undefined;
    this.frameMediaType = 'image/jpeg';
    this.frameAt = 0;
    this.frameSeq = 0;

    /** When input was last dispatched, and when the model last drove the page. */
    this.lastInputAt = 0;
    this.lastActionAt = 0;

    /** Last fallback reason recorded by the facade, exposed in status(). */
    this.degradedReason = undefined;

    /** Transient view override (webview has no CDP viewport; this is status-only). */
    this.viewOverride = undefined;
    this.viewport = this.#settingsViewport();
  }

  // --- small internal helpers -------------------------------------------

  #settings() {
    try {
      const value = this.settings();
      return value !== null && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  #settingsViewport() {
    const configured = this.#settings().viewport;
    const width = configured === undefined || configured === null ? NaN : Number(configured.width);
    const height = configured === undefined || configured === null ? NaN : Number(configured.height);
    return {
      width: clampInt(width, VIEW_MIN_WIDTH, VIEW_MAX_WIDTH, VIEW_DEFAULT.width),
      height: clampInt(height, VIEW_MIN_HEIGHT, VIEW_MAX_HEIGHT, VIEW_DEFAULT.height),
      dpr: 1,
    };
  }

  #effectiveViewport() {
    const override = this.viewOverride;
    if (override !== undefined) return { width: override.width, height: override.height, dpr: override.dpr };
    return { width: this.viewport.width, height: this.viewport.height, dpr: this.viewport.dpr };
  }

  #classicStatus() {
    if (this.classic === undefined || this.classic === null || typeof this.classic.status !== 'function') return {};
    try {
      const value = this.classic.status();
      return value !== null && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  #snapshot() {
    return {
      available: this.availableFlag === true,
      protocolVersion: this.protocolVersion,
      tabOpen: this.tabOpen(),
      reason: this.reason,
    };
  }

  // --- availability / presence ------------------------------------------

  /** Whether `/bridge/hello` reported a usable native view. */
  available() {
    return this.availableFlag === true;
  }

  /** Whether a client polled recently enough to receive commands right now. */
  tabOpen() {
    return this.lastPollAt > 0 && Date.now() - this.lastPollAt < PRESENCE_WINDOW_MS;
  }

  /** Poller presence (same as native.tabOpen in status). */
  usable() {
    return this.available() && this.tabOpen();
  }

  /** Throw when no command can be delivered; `auto` mode falls back on this. */
  assertUsable() {
    if (this.availableFlag !== true) {
      throw new NativeUnavailableError(this.reason !== undefined ? this.reason : '内置渲染器桥不可用（未收到可用性报告）');
    }
    if (this.protocolVersion !== PROTOCOL_VERSION) {
      throw new NativeUnavailableError('原生桥协议版本不支持：' + String(this.protocolVersion) + '（Host 需要 ' + String(PROTOCOL_VERSION) + '）');
    }
    if (!this.tabOpen()) {
      throw new NativeUnavailableError('原生视图未打开（右侧栏 Web 视图未挂载或脚本轮询已停止）');
    }
  }

  /** The native view is already live while it polls; there is nothing to start. */
  async ensureStarted() {
    this.assertUsable();
    return this;
  }

  /**
   * Record the capability report from `POST /bridge/hello`.
   * @returns the native snapshot the route echoes back.
   */
  setNativeStatus(message) {
    const source = message !== null && typeof message === 'object' ? message : {};
    const version = Number(source.protocolVersion);
    this.protocolVersion = Number.isFinite(version) ? Math.round(version) : 0;
    const reported = typeof source.reason === 'string' && source.reason.trim() !== '' ? source.reason.trim() : undefined;
    if (source.available !== true) {
      this.availableFlag = false;
      this.reason = reported !== undefined ? reported : '内置渲染器桥报告不可用';
    } else if (this.protocolVersion !== PROTOCOL_VERSION) {
      this.availableFlag = false;
      this.reason = '不支持的桥协议版本：' + String(this.protocolVersion) + '（需要 ' + String(PROTOCOL_VERSION) + '）';
    } else {
      this.availableFlag = true;
      this.reason = reported;
      // Adopt the page the client mounted with, so `/state` shows a real URL
      // before the first command (the view already navigated to the start page).
      if (typeof source.url === 'string' && source.url !== '' && source.url !== 'about:blank') {
        this.url = displayUrl(source.url);
      }
      // Only a live client sends hello, so it is also a first presence beat;
      // the poll loop keeps it fresh from here on. Without this a command that
      // races the first poll would spuriously count as "view not mounted".
      this.lastPollAt = Date.now();
    }
    return this.#snapshot();
  }

  /**
   * Record a page-state report from a mounted view. User-driven navigation
   * (clicking a link, redirects, a popup opened in place) never goes through a
   * queued command, so without this report the Host would keep showing the
   * previous URL in every surface.
   */
  notePageState(message) {
    const source = message !== null && typeof message === 'object' ? message : {};
    const url = typeof source.url === 'string' ? source.url : '';
    if (url !== '' && url !== this.url) {
      // The cached frame belongs to the previous page now.
      this.frameBuffer = undefined;
      this.frameAt = 0;
      this.url = url;
    }
    if (typeof source.title === 'string' && source.title !== '') this.title = source.title;
    if (typeof source.loading === 'boolean') this.loading = source.loading;
    return this.#snapshot();
  }

  // --- command queue ----------------------------------------------------

  /** Number of commands still waiting for a result (diagnostics route). */
  pendingCount() {
    return this.pending.size;
  }

  #take() {
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry.settled) continue;
      entry.dispatchedAt = Date.now();
      return { id: entry.id, command: entry.command, params: entry.params };
    }
    return undefined;
  }

  #wakePollers() {
    if (this.waiters.length === 0) return;
    for (const waiter of this.waiters.slice()) waiter.finish(this.#take());
  }

  #clearEntryTimer(entry) {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  #discard(entry, error) {
    if (entry.settled) return;
    entry.settled = true;
    this.#clearEntryTimer(entry);
    this.pending.delete(entry.id);
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    entry.reject(error);
  }

  #resolve(entry, value) {
    if (entry.settled) return;
    entry.settled = true;
    this.#clearEntryTimer(entry);
    this.pending.delete(entry.id);
    entry.resolve(value);
  }

  /**
   * Queue one command for the client and resolve with its result value.
   * Throws {@link NativeUnavailableError} synchronously when no client can run it.
   */
  queueCommand(command, params, timeoutMs) {
    this.assertUsable();
    const name = String(command === undefined || command === null ? '' : command);
    if (name === '') throw new Error('native 命令名不能为空');
    const payload = params !== null && typeof params === 'object' ? params : {};
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : DEFAULT_COMMAND_TIMEOUT_MS;
    const id = 'c' + String(this.nextId);
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const entry = {
        id,
        command: name,
        params: payload,
        timeoutMs: limit,
        enqueuedAt: Date.now(),
        dispatchedAt: 0,
        settled: false,
        resolve,
        reject,
        timer: undefined,
      };
      entry.timer = setTimeout(() => this.#discard(entry, timeoutError(entry)), limit);
      if (entry.timer !== undefined && typeof entry.timer.unref === 'function') entry.timer.unref();
      this.pending.set(id, entry);
      this.queue.push(entry);
      this.#wakePollers();
    });
  }

  async #command(command, params, timeoutMs) {
    return await this.queueCommand(command, params, timeoutMs);
  }

  /**
   * Hand one queued command to a polling client, waiting at most `waitMs`.
   * Every call records presence, even when it ends empty (204).
   * @returns `{ id, command, params }` or undefined when idle.
   */
  nextCommand(waitMs) {
    this.lastPollAt = Date.now();
    const limit = clampInt(waitMs, 0, MAX_POLL_WAIT_MS, 0);
    const immediate = this.#take();
    if (immediate !== undefined || limit === 0 || this.availableFlag !== true) return immediate;
    return new Promise((resolve) => {
      const waiter = { done: false, timer: undefined, finish: undefined };
      waiter.finish = (value) => {
        if (waiter.done) return;
        waiter.done = true;
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.timer = undefined;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(value);
      };
      waiter.timer = setTimeout(() => waiter.finish(this.#take()), limit);
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  /**
   * Resolve/reject one pending command from `POST /bridge/result`.
   * Unknown ids are ignored (a slow client may post after a timeout).
   */
  applyResult(message) {
    const source = message !== null && typeof message === 'object' ? message : {};
    const rawId = source.id;
    const id = rawId === undefined || rawId === null ? '' : String(rawId);
    const entry = id === '' ? undefined : this.pending.get(id);
    if (entry === undefined) return { ignored: true };
    this.lastResultAt = Date.now();
    if (source.ok !== true) {
      this.#discard(entry, commandFailure(entry.command, source.reason));
      return { ignored: false, ok: false };
    }
    this.#absorb(entry.command, source.value);
    this.#resolve(entry, source.value);
    return { ignored: false, ok: true };
  }

  /** Mirror page state out of one command result. */
  #absorb(command, value) {
    if (value === null || typeof value !== 'object') return;
    if (typeof value.url === 'string' && value.url !== '') {
      if (value.url !== this.url) {
        // The captured frame belongs to the previous page now; drop it instead
        // of letting `/frame` serve a picture of the page we just left.
        this.frameBuffer = undefined;
        this.frameAt = 0;
        this.url = value.url;
      }
    }
    if (typeof value.title === 'string') this.title = value.title;
    if (typeof value.loading === 'boolean') this.loading = value.loading;
    if (command === 'capture') {
      const data = typeof value.data === 'string' ? value.data : '';
      if (data !== '') {
        this.frameBuffer = Buffer.from(data, 'base64');
        this.frameAt = Date.now();
        this.frameSeq += 1;
      }
    }
    if (command === 'navigate' || command === 'newtab' || command === 'back' || command === 'forward' || command === 'reload') {
      this.loading = false;
    }
  }

  /** Turn a page-level command failure into a classic-style result object. */
  #pageFailure(error) {
    if (error instanceof NativeUnavailableError) throw error;
    return { ok: false, reason: textOf(error, '原生命令失败'), url: this.url };
  }

  // --- status -----------------------------------------------------------

  /** Classic status fields plus the native view block. */
  status() {
    const base = this.#classicStatus();
    const settings = this.#settings();
    const viewport = base.viewport !== undefined && base.viewport !== null ? base.viewport : this.#effectiveViewport();
    const tabOpen = this.tabOpen();
    return {
      ...base,
      enabled: typeof base.enabled === 'boolean' ? base.enabled : settings.enabled !== false,
      // "running" means the native page is live in the mounted view; the classic
      // CDP process may or may not exist alongside (it serves search).
      running: this.availableFlag === true && tabOpen,
      executable: base.executable,
      // In native mode the page is usable even without a local Chromium install.
      executableFound: this.availableFlag === true ? true : base.executableFound,
      viewport,
      headless: typeof base.headless === 'boolean' ? base.headless : settings.headless !== false,
      url: this.url,
      title: this.title,
      loading: this.loading,
      frameSeq: this.frameSeq,
      frameAt: this.frameAt,
      lastActionAt: this.lastActionAt !== 0 ? this.lastActionAt : (base.lastActionAt === undefined ? 0 : base.lastActionAt),
      engines: base.engines !== undefined ? base.engines : settings.engineOrder,
      mode: 'native',
      degradedReason: this.degradedReason,
      native: this.#snapshot(),
    };
  }

  /** Last capture buffer, or undefined when it no longer matches the page. */
  async latestFrame() {
    // frameAt is cleared when the page changes, so a stale image is never shown.
    if (this.frameAt === 0) return undefined;
    return this.frameBuffer;
  }

  // --- navigation -------------------------------------------------------

  /**
   * Navigation-family deadline: the contract fixes navigate at 20s; back /
   * forward / reload are the same kind of operation and share that budget.
   */
  async #navigateLike(command, params) {
    this.loading = true;
    try {
      const value = await this.#command(command, params, NAVIGATE_TIMEOUT_MS);
      if (value !== null && typeof value === 'object' && typeof value.url === 'string' && value.url !== '') {
        this.url = displayUrl(value.url);
      }
      if (value !== null && typeof value === 'object' && typeof value.title === 'string') {
        this.title = value.title;
      }
      return { url: this.url, title: this.title };
    } finally {
      this.loading = false;
    }
  }

  /** Navigate the visible native page; local/private hosts follow classic rules. */
  async navigate(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (url === undefined) throw new Error('无效的 URL：需要 http(s) 链接');
    if (url === 'edge://newtab') return await this.newTabPage();
    if (this.#settings().blockPrivateAddresses !== false) {
      let host;
      try { host = new URL(url).hostname; } catch { host = undefined; }
      if (host !== undefined && isPrivateHost(host)) {
        throw new Error('已拦截本机/内网地址（' + host + '）。确需访问时请在 设置 → Web操作 里关闭「拦截本机与内网地址」。');
      }
    }
    return await this.#navigateLike('navigate', { url });
  }

  /** Show a blank start page in the native view (client loads about:blank). */
  async newTabPage() {
    const result = await this.#navigateLike('newtab', {});
    if (result.url === '') {
      this.url = DEFAULT_START_URL;
      result.url = this.url;
    }
    return result;
  }

  async back() {
    return await this.#navigateLike('back', {});
  }

  async forward() {
    return await this.#navigateLike('forward', {});
  }

  async reload() {
    return await this.#navigateLike('reload', {});
  }

  // --- page commands ----------------------------------------------------

  /** Evaluate one expression in the page and return its JSON value. */
  async evaluate(expression) {
    return await this.#command('evaluate', { expression: String(expression === undefined || expression === null ? '' : expression) }, DEFAULT_COMMAND_TIMEOUT_MS);
  }

  /** Read the page as text, links, or HTML (same result shape as classic). */
  async read(options) {
    const source = options !== null && typeof options === 'object' ? options : {};
    const kind = source.mode === 'links' || source.mode === 'html' ? source.mode : 'text';
    let value;
    try {
      value = await this.#command('read', { mode: kind, selector: source.selector, maxChars: source.maxChars }, DEFAULT_COMMAND_TIMEOUT_MS);
    } catch (error) {
      return this.#pageFailure(error);
    }
    if (value === null || value === undefined || typeof value !== 'object') return { ok: false, reason: 'no-result', url: this.url };
    if (value.ok === false) return { ok: false, reason: textOf(value.reason, 'read failed'), selector: source.selector, url: value.url || this.url };
    const result = { ok: true, url: value.url || this.url, title: value.title || this.title };
    if (kind === 'links') result.links = Array.isArray(value.links) ? value.links : [];
    else if (kind === 'html') result.html = typeof value.html === 'string' ? value.html : '';
    else result.text = typeof value.text === 'string' ? value.text : '';
    return result;
  }

  /** Click by selector, visible text, or coordinates. */
  async click(options) {
    const source = options !== null && typeof options === 'object' ? options : {};
    const { selector, text, button } = source;
    const x = Number(source.x);
    const y = Number(source.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      await this.clickAt(x, y, button);
      return { ok: true, method: 'point', x, y };
    }
    if ((selector === undefined || selector === '') && (text === undefined || text === '')) {
      throw new Error('click 需要 selector、text 或 x/y 之一');
    }
    let value;
    try {
      value = await this.#command('click', { selector, text, x: source.x, y: source.y, button }, DEFAULT_COMMAND_TIMEOUT_MS);
    } catch (error) {
      return this.#pageFailure(error);
    }
    if (value === null || value === undefined || typeof value !== 'object') return { ok: false, reason: 'no-result', url: this.url };
    if (value.ok === false) return { ok: false, reason: textOf(value.reason, 'click failed'), url: value.url || this.url };
    return {
      ok: true,
      method: textOf(value.method, 'native'),
      tag: value.tag,
      label: value.label,
      x: value.x,
      y: value.y,
    };
  }

  /** Mouse click at page CSS coordinates. */
  async clickAt(x, y, buttonMode = 'left') {
    const button = buttonMode === 'right' ? 'right' : buttonMode === 'middle' ? 'middle' : 'left';
    this.lastInputAt = Date.now();
    let value;
    try {
      value = await this.#command('clickAt', { x: Number(x), y: Number(y), button }, DEFAULT_COMMAND_TIMEOUT_MS);
    } catch (error) {
      return this.#pageFailure(error);
    }
    return value !== null && typeof value === 'object' ? { ok: true, ...value } : { ok: true };
  }

  /** Focus a field (or the active element) and insert text. */
  async typeText(options) {
    const source = options !== null && typeof options === 'object' ? options : {};
    this.lastInputAt = Date.now();
    let value;
    try {
      value = await this.#command('type', {
        text: String(source.text === undefined || source.text === null ? '' : source.text),
        selector: source.selector,
        submit: source.submit === true,
      }, DEFAULT_COMMAND_TIMEOUT_MS);
    } catch (error) {
      return this.#pageFailure(error);
    }
    if (value === null || value === undefined || typeof value !== 'object') return { ok: false, reason: 'no-result' };
    if (value.ok === false) return { ok: false, reason: textOf(value.reason, 'type failed') };
    return {
      ok: true,
      target: textOf(value.target, source.selector === undefined ? 'native-view' : String(source.selector)),
      url: value.url || this.url,
    };
  }

  /** Press one named key at the page's focus (client maps the key). */
  async pressKey(name) {
    this.lastInputAt = Date.now();
    await this.#command('key', { name: String(name === undefined || name === null ? '' : name) }, DEFAULT_COMMAND_TIMEOUT_MS);
  }

  /** Wheel-scroll the page from its center. */
  async scroll(dy) {
    this.lastInputAt = Date.now();
    const delta = Number.isFinite(dy) ? dy : 600;
    await this.#command('scroll', { dy: delta }, DEFAULT_COMMAND_TIMEOUT_MS);
  }

  /** Poll a page condition through the client until it holds or times out. */
  async waitFor(options) {
    const source = options !== null && typeof options === 'object' ? options : {};
    const limit = Number.isFinite(source.timeoutMs) ? Math.max(200, Math.min(60000, Math.round(source.timeoutMs))) : 10000;
    const condition = source.kind === 'text' || source.kind === 'url' ? source.kind : 'selector';
    const target = String(source.value === undefined || source.value === null ? '' : source.value);
    // The contract default is 8s, but a caller may legitimately ask to wait
    // longer; the deadline follows the requested wait plus a settle margin.
    const deadline = Math.max(DEFAULT_COMMAND_TIMEOUT_MS, limit + 2000);
    let value;
    try {
      value = await this.#command('waitFor', { kind: condition, value: target, timeoutMs: limit }, deadline);
    } catch (error) {
      if (error instanceof NativeUnavailableError) throw error;
      return { ok: false, reason: textOf(error, 'native wait failed'), waitedMs: limit, url: this.url };
    }
    if (value === null || value === undefined || typeof value !== 'object') return { ok: false, reason: 'no-result', waitedMs: limit, url: this.url };
    if (value.ok === true) return { ok: true, waitedMs: Number.isFinite(value.waitedMs) ? value.waitedMs : limit, url: value.url || this.url };
    return { ok: false, reason: textOf(value.reason, 'timeout'), waitedMs: Number.isFinite(value.waitedMs) ? value.waitedMs : limit, url: value.url || this.url };
  }

  /** Capture one JPEG through the client and keep it for `latestFrame()`. */
  async captureJpeg(quality) {
    const value = Number.isFinite(quality) ? Math.max(20, Math.min(90, Math.round(quality))) : 62;
    const result = await this.#command('capture', { quality: value }, CAPTURE_TIMEOUT_MS);
    if (result === null || result === undefined || typeof result !== 'object' || typeof result.data !== 'string' || result.data === '') {
      throw new Error('原生视图截图失败：客户端没有返回图像数据');
    }
    const buffer = Buffer.from(result.data, 'base64');
    const mediaType = typeof result.mimeType === 'string' && /^image\//.test(result.mimeType) ? result.mimeType : 'image/jpeg';
    // #absorb already stored this frame and bumped frameSeq once when the
    // command result arrived; doing it again here double-counted every capture.
    this.frameBuffer = buffer;
    this.frameMediaType = mediaType;
    return {
      buffer,
      mediaType,
      quality: value,
      url: typeof result.url === 'string' && result.url !== '' ? result.url : this.url,
      title: typeof result.title === 'string' ? result.title : this.title,
    };
  }

  /** Re-read the document title through the native view. */
  async refreshTitle() {
    try {
      const title = await this.evaluate('document.title');
      if (typeof title === 'string') this.title = title;
    } catch { /* a closing page keeps the last known title */ }
  }

  // --- search / profile / lifecycle -------------------------------------

  /**
   * Search through the classic engine's throwaway CDP target. Never routed
   * through the native view: the user's visible tab must not be navigated.
   */
  async searchFrom(query, extractor) {
    if (this.classic === undefined || this.classic === null || typeof this.classic.searchFrom !== 'function') {
      throw new Error('原生引擎缺少经典引擎，无法执行浏览器搜索');
    }
    return await this.classic.searchFrom(query, extractor);
  }

  /** The user-data directory this plugin's profile lives in (classic engine). */
  profileDir() {
    if (this.classic !== undefined && this.classic !== null && typeof this.classic.profileDir === 'function') {
      try { return this.classic.profileDir(); } catch { /* fall through to settings */ }
    }
    return resolveProfileDir(this.#settings());
  }

  /** Clear the plugin's own browser profile; the native partition is DSH-owned. */
  async clearProfile() {
    try { await this.stop(); } catch { /* best effort */ }
    if (this.classic !== undefined && this.classic !== null && typeof this.classic.clearProfile === 'function') {
      return await this.classic.clearProfile();
    }
    return { cleared: false, dir: this.profileDir(), reason: '原生视图的分区由 DSH 管理，Host 无法删除' };
  }

  /** Record the reported stage size (diagnostics only; the webview fills CSS). */
  async setViewOverride(width, height, dpr) {
    const requested = { width: Number(width), height: Number(height) };
    if (!Number.isFinite(requested.width) || !Number.isFinite(requested.height)) {
      throw new Error('viewport 覆盖需要有限的 width/height 数字');
    }
    this.viewOverride = {
      width: clampInt(requested.width, VIEW_MIN_WIDTH, VIEW_MAX_WIDTH, VIEW_DEFAULT.width),
      height: clampInt(requested.height, VIEW_MIN_HEIGHT, VIEW_MAX_HEIGHT, VIEW_DEFAULT.height),
      dpr: clampDpr(dpr),
    };
    return this.#effectiveViewport();
  }

  async releaseViewOverride() {
    this.viewOverride = undefined;
    return this.#effectiveViewport();
  }

  async setViewport(width, height, dpr) {
    const configured = this.#settingsViewport();
    this.viewport = {
      width: clampInt(width, VIEW_MIN_WIDTH, VIEW_MAX_WIDTH, configured.width),
      height: clampInt(height, VIEW_MIN_HEIGHT, VIEW_MAX_HEIGHT, configured.height),
      dpr: clampDpr(dpr),
    };
    return this.#effectiveViewport();
  }

  async applyViewport() {
    return this.#effectiveViewport();
  }

  /**
   * Drop Host-side state for the current page. The `<webview>` and its lease
   * belong to the client, so this never closes the user's tab; availability and
   * presence deliberately stay as they are, because the poll loop keeps running
   * and the next command is served without another handshake.
   */
  async stop() {
    for (const waiter of this.waiters.splice(0)) waiter.finish(undefined);
    for (const entry of Array.from(this.pending.values())) this.#discard(entry, new Error('原生引擎已停止'));
    this.queue = [];
    this.url = '';
    this.title = '';
    this.loading = false;
    this.frameBuffer = undefined;
    this.frameMediaType = 'image/jpeg';
    this.frameAt = 0;
    this.frameSeq = 0;
    this.viewOverride = undefined;
    this.degradedReason = undefined;
    this.lastInputAt = 0;
    this.lastActionAt = 0;
    this.log('native engine stopped (host state cleared; the client keeps its view)');
  }
}
