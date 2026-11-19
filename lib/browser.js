/**
 * The controlled browser: launch, connect, drive, and frame-capture one
 * Chromium-family browser (Edge or Chrome) over the DevTools Protocol.
 *
 * The browser runs headless by default and is shown inside DSH through the
 * right sidebar tab, which polls `latestFrame()`. Every page operation goes
 * through one attached page target; searches use a short-lived second target so
 * they never disturb the page a user is watching.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CdpConnection } from './cdp.js';

/** Chromium-family executables checked in order when no explicit path is set. */
const CANDIDATES = [
  () => path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  () => path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  () => path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  () => path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  () => path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  () => path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  () => path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  () => path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Chromium', 'Application', 'chrome.exe'),
];

/** Bounds applied to a transient sidebar view override, in CSS pixels. */
const VIEW_MIN_WIDTH = 320;
const VIEW_MAX_WIDTH = 1920;
const VIEW_MIN_HEIGHT = 240;
const VIEW_MAX_HEIGHT = 1600;
/** Device-pixel ratio bounds for the panel's screen density. */
const DPR_MIN = 1;
const DPR_MAX = 3;
/** Upper bound on one emitted frame, so a retina panel cannot explode the stream. */
const FRAME_MAX_WIDTH = 3840;
const FRAME_MAX_HEIGHT = 2560;
/** JPEG quality for emitted frames and on-demand captures. */
const FRAME_QUALITY = 82;

/** The page a fresh controlled browser opens on. */
export const DEFAULT_START_URL = 'https://www.bing.com/';

/** Last-resort viewport used only when the settings carry no usable one. */
const DEFAULT_VIEWPORT = { width: 1100, height: 820 };

/** Key names a tool call may press, mapped to DevTools virtual key codes. */
const KEYS = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', key: 'Tab', vk: 9 },
  Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', key: 'Delete', vk: 46 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', key: 'Home', vk: 36 },
  End: { code: 'End', key: 'End', vk: 35 },
  PageUp: { code: 'PageUp', key: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', key: 'PageDown', vk: 34 },
  Space: { code: 'Space', key: ' ', vk: 32, text: ' ' },
};

/** Locate a Chromium executable; an explicit path wins, then the candidate list. */
export function resolveExecutable(explicitPath) {
  if (typeof explicitPath === 'string' && explicitPath.trim() !== '') {
    const candidate = explicitPath.trim();
    // A configured path that no longer exists must not disable the plugin:
    // fall through to auto-detection, exactly like an empty setting.
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const locate of CANDIDATES) {
    const candidate = locate();
    if (candidate !== '' && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The platform token a desktop User-Agent advertises on this host. */
function uaPlatform() {
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7';
  if (process.platform === 'linux') return 'X11; Linux x86_64';
  return 'Windows NT 10.0; Win64; x64';
}

/**
 * Build the normal desktop User-Agent for the browser that is actually running.
 * Headless Chromium announces itself as `HeadlessChrome/...`, which makes search
 * engines serve captchas or unrelated result pages; presenting the same build as
 * its windowed counterpart is both accurate and necessary for search to work.
 * @param product - the `Browser` string from `/json/version` (e.g. `Edg/157.0.4341.60`).
 */
export function desktopUserAgent(product) {
  const text = String(product === undefined || product === null ? '' : product).trim();
  const edge = /Edg\/(\d+(?:\.\d+)*)/i.exec(text);
  const chrome = /Chrome\/(\d+(?:\.\d+)*)/i.exec(text);
  const version = edge !== null ? edge[1] : chrome !== null ? chrome[1] : '126.0.0.0';
  const major = version.split('.')[0];
  // Edge advertises the Chrome major it is built on; plain Chromium uses its
  // own full version, exactly like the windowed builds do.
  const engineVersion = edge !== null ? major + '.0.0.0' : version;
  const base = 'Mozilla/5.0 (' + uaPlatform() + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + engineVersion + ' Safari/537.36';
  return edge !== null ? base + ' Edg/' + version : base;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Read the DevTools port a previous controlled browser left in this profile. */
async function existingDevtoolsPort(profileDir) {
  try {
    const text = await fs.promises.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
    const port = Number.parseInt(text.split('\n')[0], 10);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** One short read of the DevTools version document. */
async function probeVersion(port) {
  try {
    const response = await fetch('http://127.0.0.1:' + String(port) + '/json/version', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return undefined;
    const version = await response.json();
    return typeof version.webSocketDebuggerUrl === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Poll the profile's DevToolsActivePort until the endpoint answers or the process dies. */
async function waitForDevtools(profileDir, deathReason) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const reason = deathReason();
    if (reason !== undefined) throw new Error('浏览器进程启动后立刻退出：' + (reason || 'no diagnostic'));
    const port = await existingDevtoolsPort(profileDir);
    if (port !== undefined) {
      const version = await probeVersion(port);
      if (version !== undefined) return { version, port };
    }
    await sleep(250);
  }
  throw new Error('浏览器 DevTools 端口在 25 秒内没有就绪（若之前手动启动过受控浏览器，请先关闭它）');
}

function clampText(value, limit) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  return text.slice(0, limit) + '\n…[truncated ' + String(text.length - limit) + ' characters]';
}

/** Coerce a requested view size to clamped integer CSS pixels, or undefined. */
function clampViewport(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return undefined;
  return {
    width: Math.min(VIEW_MAX_WIDTH, Math.max(VIEW_MIN_WIDTH, Math.round(w))),
    height: Math.min(VIEW_MAX_HEIGHT, Math.max(VIEW_MIN_HEIGHT, Math.round(h))),
  };
}

/** Clamp the panel's device-pixel ratio; unknown values fall back to 1. */
function clampDpr(dpr) {
  const value = Number(dpr);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(DPR_MAX, Math.max(DPR_MIN, Math.round(value * 100) / 100));
}

/** Present Edge's hosted new-tab page as the friendly `edge://newtab` address. */
export function displayUrl(url) {
  const text = String(url === undefined || url === null ? '' : url);
  if (text === '' || text === 'about:blank') return text;
  if (/^edge:\/\/newtab\/?$/i.test(text)) return 'edge://newtab';
  // The hosted new-tab page lives on an MSN host. Matching any URL that merely
  // contains `/edge/ntp` would let an ordinary site masquerade as it in the
  // address bar, so check the origin and path instead.
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    const edgeHosted = host === 'ntp.msn.com' || host.endsWith('.msn.com');
    if (edgeHosted && parsed.pathname.startsWith('/edge/ntp')) return 'edge://newtab';
  } catch { /* not an absolute URL: keep the raw text */ }
  return text;
}

/** Normalize a user- or model-supplied URL, adding https:// to a bare host. */
export function normalizeUrl(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (text === '') return undefined;
  if (/^edge:\/\/newtab\/?$/i.test(text)) return 'edge://newtab';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.hostname === '') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * Whether an IPv4 address belongs to a range that reaches the local machine or
 * its own network: 0/8, 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16 and
 * 100.64/10 (carrier-grade NAT, which on a desktop reaches the local router).
 */
function privateIpv4(first, second) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return true;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

/**
 * Decode the IPv4 address an IPv6 literal embeds in `::ffff:0:0/96`
 * (`::ffff:127.0.0.1`) or `::/96` (`::127.0.0.1`), including the compressed
 * hex spelling (`::ffff:7f00:1`) and the fully expanded form. Returns the first
 * two octets, or undefined when the literal does not embed an IPv4 address.
 */
function ipv4FromIpv6Literal(host) {
  if (host.indexOf(':') < 0) return undefined;
  let body = host;
  let dotted;
  const dottedMatch = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dottedMatch !== null) {
    const octets = [Number(dottedMatch[1]), Number(dottedMatch[2]), Number(dottedMatch[3]), Number(dottedMatch[4])];
    if (octets.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return undefined;
    dotted = [((octets[0] << 8) | octets[1]), ((octets[2] << 8) | octets[3])];
    body = host.slice(0, dottedMatch.index);
  }
  const sides = body.split('::');
  if (sides.length > 2) return undefined;
  const toGroups = (part) => (part === '' ? [] : part.split(':').filter((piece) => piece !== ''));
  const head = toGroups(sides[0]);
  const tail = sides.length === 2 ? toGroups(sides[1]) : [];
  const known = head.length + tail.length + (dotted === undefined ? 0 : dotted.length);
  if (known > 8 || (sides.length === 1 && dotted === undefined && known !== 8)) return undefined;
  const groups = [...head.map((piece) => Number.parseInt(piece, 16)), ...new Array(sides.length === 2 ? 8 - known : 0).fill(0), ...tail.map((piece) => Number.parseInt(piece, 16)), ...(dotted === undefined ? [] : dotted)];
  if (groups.length !== 8 || groups.some((value) => !Number.isFinite(value) || value < 0 || value > 0xffff)) return undefined;
  // Only the ::/96 and ::ffff:0:0/96 prefixes carry an IPv4 address.
  if (groups[0] !== 0 || groups[1] !== 0 || groups[2] !== 0 || groups[3] !== 0 || groups[4] !== 0) return undefined;
  if (groups[5] !== 0 && groups[5] !== 0xffff) return undefined;
  return [groups[6] >> 8, groups[6] & 0xff];
}

/**
 * Whether a hostname is loopback, private, link-local, or a local-only name.
 * Used to keep the controlled browser out of the machine's own network unless
 * the user explicitly allows it. The check is lexical: a DNS name that resolves
 * to a private address is not resolved here.
 */
export function isPrivateHost(hostname) {
  let host = String(hostname === undefined || hostname === null ? '' : hostname).toLowerCase().trim();
  // `[::1]` → `::1`; a zone id (`fe80::1%eth0`) never changes the address.
  host = host.replace(/^\[|\]$/g, '');
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  // DNS treats `localhost.` and `localhost` as the same name.
  host = host.replace(/\.+$/, '');
  if (host === '') return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 !== null) return privateIpv4(Number(ipv4[1]), Number(ipv4[2]));
  // An IPv4-mapped/compatible IPv6 address reaches exactly the IPv4 host it
  // embeds, so it must not slip past the block list.
  const mapped = ipv4FromIpv6Literal(host);
  if (mapped !== undefined) return privateIpv4(mapped[0], mapped[1]);
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}

/** The user-data directory a given settings snapshot describes. */
export function resolveProfileDir(settings) {
  const configured = settings === undefined || settings === null ? '' : String(settings.profileDir === undefined || settings.profileDir === null ? '' : settings.profileDir).trim();
  return configured !== '' ? configured : path.join(os.homedir(), '.dsh', 'web-browser', 'profile');
}

/** Script that locates a clickable element by CSS selector or visible text. */
function locateScript(selector, text) {
  return `(() => {
    const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    let el = null;
    if (${JSON.stringify(selector || '')} !== '') {
      try { el = document.querySelector(${JSON.stringify(selector || '')}); } catch (error) { return { ok: false, reason: 'bad-selector', detail: String(error && error.message) }; }
    }
    if (el === null && ${JSON.stringify(text || '')} !== '') {
      const wanted = norm(${JSON.stringify(text || '')});
      const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,label,span,div,li,p,strong'));
      for (const node of candidates.slice(0, 4000)) {
        const own = norm(node.innerText || node.value || '');
        if (own === '' || !node.getBoundingClientRect().width) continue;
        if (own === wanted) { el = node; break; }
        if (el === null && own.includes(wanted) && own.length <= wanted.length * 3 + 24) el = node;
      }
    }
    if (el === null) return { ok: false, reason: 'no-match' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return { ok: false, reason: 'not-visible', tag: el.tagName };
    return {
      ok: true,
      tag: el.tagName,
      label: norm(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 120),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  })()`;
}

/** Script that focuses an element (or the active element) before typing. */
function focusScript(selector) {
  return `(() => {
    let el = null;
    if (${JSON.stringify(selector || '')} !== '') {
      try { el = document.querySelector(${JSON.stringify(selector || '')}); } catch (error) { return { ok: false, reason: 'bad-selector' }; }
      if (el === null) return { ok: false, reason: 'no-match' };
    } else {
      el = document.activeElement;
      if (el === null || el === document.body) return { ok: true, target: 'document-body' };
    }
    if (typeof el.focus === 'function') el.focus();
    if (el.select && typeof el.select === 'function' && el.tagName === 'INPUT') el.select();
    return { ok: true, target: el.tagName + (el.id ? '#' + el.id : '') };
  })()`;
}

/** Rendering text/links/html from the current document. */
function readScript(mode, selector, maxChars) {
  const limit = Number.isFinite(maxChars) ? Math.max(200, Math.min(200000, Math.round(maxChars))) : 60000;
  const sel = JSON.stringify(selector || '');
  if (mode === 'links') {
    return `(() => {
      const root = ${sel} === '' ? document : (document.querySelector(${sel}) || document);
      const seen = new Set();
      const links = [];
      for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
        const href = anchor.href || '';
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const text = (anchor.innerText || anchor.textContent || '').replace(/\\s+/g, ' ').trim();
        links.push({ text: text.slice(0, 160), href });
        if (links.length >= 200) break;
      }
      return { url: location.href, title: document.title, links };
    })()`;
  }
  if (mode === 'html') {
    return `(() => {
      const root = ${sel} === '' ? document.documentElement : document.querySelector(${sel});
      if (root === null) return { ok: false, reason: 'no-match', url: location.href, title: document.title };
      return { url: location.href, title: document.title, html: (root.outerHTML || '').slice(0, ${String(limit)}) };
    })()`;
  }
  return `(() => {
    const root = ${sel} === '' ? document.body : document.querySelector(${sel});
    if (root === null) return { ok: false, reason: 'no-match', url: location.href, title: document.title };
    const text = (root.innerText || root.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${String(limit)});
    return { url: location.href, title: document.title, text };
  })()`;
}

/** The controlled browser for one plugin instance. */
export class BrowserEngine {
  constructor({ settings }) {
    this.settings = settings;
    /**
     * Transient view override ({width,height}) from the sidebar panel; it wins
     * over settings.viewport, is never persisted, and survives a stop/start.
     */
    this.viewOverride = undefined;
    this.child = undefined;
    this.connection = undefined;
    this.sessionId = undefined;
    this.targetId = undefined;
    this.port = undefined;
    /** The browser's own product string (`Edg/...` or `Chrome/...`) for the UA override. */
    this.browserProduct = undefined;
    this.starting = undefined;
    /** Incremented by stop() so a launch that finishes late cannot adopt a browser. */
    this.startEpoch = 0;
    /** The `browserPath` value `this.executable` was resolved from. */
    this.executablePath = undefined;
    this.loading = false;
    this.url = '';
    this.title = '';
    this.frame = undefined;
    this.frameSeq = 0;
    this.frameAt = 0;
    /** When input was last dispatched; frame capture backs off briefly after it. */
    this.lastInputAt = 0;
    /** When the model last drove the page; the UI opens its view on a new value. */
    this.lastActionAt = 0;
    this.executable = undefined;
    this.stderrTail = '';
    /** Page targets this plugin created on purpose (searches); they are never adopted. */
    this.expectedTargets = new Set();
    /** Why the last background search returned nothing (provider diagnostics). */
    this.lastSearchFailure = undefined;
    /** Newly created page targets waiting to be adopted after a click. */
    this.newTargets = [];
  }

  /** The viewport the controlled page should use: transient override, else setting. */
  #effectiveViewport() {
    const override = this.viewOverride;
    if (override !== undefined) return { width: override.width, height: override.height, dpr: override.dpr };
    const settings = this.settings();
    const configured = settings === undefined || settings === null ? undefined : settings.viewport;
    const width = configured === undefined || configured === null ? NaN : Number(configured.width);
    const height = configured === undefined || configured === null ? NaN : Number(configured.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height, dpr: 1 };
    }
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), dpr: 1 };
  }

  /** Whether an executable is available without launching anything. */
  available() {
    const current = this.settings().browserPath;
    if (this.executable !== undefined && this.executablePath === current) return true;
    const found = resolveExecutable(current);
    this.executable = found;
    this.executablePath = current;
    return found !== undefined;
  }

  /** Cheap status for routes and tools. */
  status() {
    const settings = this.settings();
    return {
      enabled: settings.enabled,
      running: this.connection !== undefined && !this.connection.closed,
      executable: this.executable,
      executableFound: this.available(),
      viewport: this.#effectiveViewport(),
      headless: settings.headless,
      url: this.url,
      title: this.title,
      loading: this.loading,
      frameSeq: this.frameSeq,
      frameAt: this.frameAt,
      lastActionAt: this.lastActionAt,
      engines: settings.engineOrder,
    };
  }

  /**
   * Present one attached page as the windowed browser it really is. CDP keeps
   * the headless User-Agent (`HeadlessChrome/...`) otherwise, and search engines
   * answer that with captchas or unrelated result pages.
   */
  async #applyDesktopIdentity(sessionId) {
    const connection = this.connection;
    if (connection === undefined) return;
    const userAgent = desktopUserAgent(this.browserProduct);
    const platform = process.platform === 'darwin' ? 'MacIntel' : process.platform === 'linux' ? 'Linux x86_64' : 'Win32';
    await connection.send('Network.enable', {}, sessionId).catch(() => undefined);
    await connection.send('Network.setUserAgentOverride', {
      userAgent,
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6',
      platform,
    }, sessionId).catch(() => undefined);
    // `navigator.webdriver` is the other obvious automation flag; pages and
    // search engines read it before any of our scripts run.
    await connection.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });",
    }, sessionId).catch(() => undefined);
  }

  /** Start the browser if it is not running; concurrent callers share one attempt. */
  async ensureStarted() {
    if (this.connection !== undefined && !this.connection.closed) return this;
    if (this.starting !== undefined) return await this.starting;
    this.starting = this.#start().finally(() => { this.starting = undefined; });
    return await this.starting;
  }

  async #start() {
    const settings = this.settings();
    const epoch = this.startEpoch;
    const effectiveViewport = this.#effectiveViewport();
    if (!settings.enabled) throw new Error('Web 操作当前是关闭状态（可用输入框里的「Web操作」开关或设置页启用）');
    const executable = resolveExecutable(settings.browserPath);
    if (executable === undefined) {
      throw new Error('没有找到 Chromium 浏览器（Chrome/Edge/Brave）。请在 设置 → Web操作 里指定浏览器可执行文件路径。');
    }
    this.executable = executable;
    this.executablePath = settings.browserPath;
    const profileDir = this.profileDir();
    fs.mkdirSync(profileDir, { recursive: true });

    // A controlled browser left over from a previous run writes its DevTools
    // port into the profile; reuse it instead of fighting over the profile.
    let port = await existingDevtoolsPort(profileDir);
    let version = port === undefined ? undefined : await probeVersion(port);
    if (version !== undefined) {
      this.child = undefined;
    } else {
      await fs.promises.unlink(path.join(profileDir, 'DevToolsActivePort')).catch(() => {});
      const args = [
        // Port 0 lets Chromium pick and publish the port in DevToolsActivePort,
        // which is also how a later run finds this browser again.
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        '--user-data-dir=' + profileDir,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        '--mute-audio',
        '--hide-scrollbars',
        '--window-size=' + String(effectiveViewport.width) + ',' + String(effectiveViewport.height),
        'about:blank',
      ];
      if (settings.headless) args.unshift('--headless=new');
      if (process.platform === 'linux') args.push('--no-sandbox');

      // A browser that is still shutting down keeps the profile lock for a
      // moment; retry once instead of reporting a launch failure.
      let lastError;
      for (let attempt = 0; attempt < 2 && version === undefined; attempt += 1) {
        if (attempt > 0) {
          await sleep(1500);
          await fs.promises.unlink(path.join(profileDir, 'DevToolsActivePort')).catch(() => {});
        }
        const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
        child.on('error', (error) => { this.stderrTail = String(error && error.message); });
        child.on('exit', () => {
          // A retry can replace `child`; an old process exiting must not clear
          // the state of the newer attempt.
          if (this.child !== child) return;
          this.child = undefined;
          this.connection = undefined;
          this.sessionId = undefined;
          this.targetId = undefined;
          this.frame = undefined;
        });
        this.child = child;
        try {
          const started = await waitForDevtools(profileDir, () => (this.child === undefined ? this.stderrTail : undefined));
          version = started.version;
          port = started.port;
        } catch (error) {
          lastError = error;
          if (this.child !== undefined) {
            try { this.child.kill(); } catch { /* already gone */ }
            this.child = undefined;
          }
        }
      }
      if (version === undefined) throw lastError === undefined ? new Error('浏览器启动失败') : lastError;
    }
    if (epoch !== this.startEpoch) {
      // The switch was turned off while Chromium was launching: do not adopt a
      // browser the user already asked to stop.
      if (this.child !== undefined) {
        try { this.child.kill(); } catch { /* already gone */ }
        this.child = undefined;
      }
      throw new Error('浏览器启动已取消（开关已关闭）');
    }
    this.port = port;
    this.browserProduct = typeof version.Browser === 'string' ? version.Browser : undefined;

    const connection = new CdpConnection(version.webSocketDebuggerUrl);
    await connection.opened;
    if (epoch !== this.startEpoch) {
      connection.close();
      throw new Error('浏览器启动已取消（开关已关闭）');
    }
    this.connection = connection;

    // Reuse the page a previous run left open, otherwise create one.
    const targets = await connection.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const pages = (targets.targetInfos || []).filter((info) => info.type === 'page' && !String(info.url || '').startsWith('devtools://'));
    let targetId = pages.length > 0 ? pages[0].targetId : undefined;
    if (targetId === undefined) {
      const created = await connection.send('Target.createTarget', { url: 'about:blank' });
      targetId = created.targetId;
    }
    this.targetId = targetId;
    const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = attached.sessionId;

    await connection.send('Page.enable', {}, this.sessionId);
    await connection.send('Runtime.enable', {}, this.sessionId);
    await this.#applyDesktopIdentity(this.sessionId);
    await this.applyViewport();
    this.#trackEvents();
    this.url = 'about:blank';
    this.title = '';
    // A reused page may already be on a real URL; report it right away.
    let current;
    try {
      const page = await connection.send('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })', returnByValue: true, timeout: 5000,
      }, this.sessionId);
      current = page.result === undefined ? undefined : page.result.value;
    } catch { current = undefined; }
    if (current !== undefined && typeof current.url === 'string' && current.url !== '' && current.url !== 'about:blank') {
      this.url = displayUrl(current.url);
      this.title = typeof current.title === 'string' ? current.title : '';
    } else {
      // A fresh browser opens on Edge's new-tab page instead of a blank canvas.
      await this.newTabPage().catch(() => undefined);
    }
    return this;
  }

  #trackEvents() {
    const connection = this.connection;
    if (connection === undefined) return;
    // Only the controlled page's session may change page state: a search opens
    // a second target in the same browser, and its navigation events must not
    // overwrite the URL/title/loading of the page the user is watching.
    const isMainSession = (sessionId) => sessionId === undefined || sessionId === this.sessionId;
    connection.on('Page.frameNavigated', (params, sessionId) => {
      if (!isMainSession(sessionId)) return;
      const frame = params && params.frame;
      if (frame !== undefined && frame.parentId === undefined) {
        const next = displayUrl(frame.url || this.url);
        // The cached frame belongs to the previous page now.
        if (next !== this.url) this.frame = undefined;
        this.url = next;
        this.title = frame.name || this.title;
        this.loading = true;
      }
    });
    connection.on('Page.loadEventFired', (params, sessionId) => {
      if (!isMainSession(sessionId)) return;
      this.loading = false;
      // Frame-navigation events carry no document title, so a click-driven
      // navigation would otherwise keep reporting the previous page's title.
      void this.refreshTitle();
    });
    // Links commonly open a new page target; remember it so a click can follow
    // the navigation instead of leaving the view on the old page.
    connection.on('Target.targetCreated', (params) => {
      const info = params && params.targetInfo;
      if (info === undefined || info.type !== 'page') return;
      if (info.targetId === this.targetId || this.expectedTargets.has(info.targetId)) return;
      const url = String(info.url || '');
      // A click's new tab usually starts blank and navigates afterwards, so a
      // blank page target is still worth adopting; service pages are excluded.
      if (url.startsWith('chrome-extension://') || url.startsWith('devtools://')) return;
      this.newTargets.push({ targetId: info.targetId, url, at: Date.now() });
      // Bound the candidate list: a pathological page must not grow it forever.
      if (this.newTargets.length > 20) this.newTargets.splice(0, this.newTargets.length - 20);
    });
    connection.on('Target.targetDestroyed', (params) => {
      const id = params && params.targetId;
      if (id === undefined) return;
      this.newTargets = this.newTargets.filter((entry) => entry.targetId !== id);
    });
    void connection.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  }

  /** Attach to a page target created by a click and make it the controlled page. */
  async #adoptNewTarget(waitMs = 700) {
    const connection = this.connection;
    if (connection === undefined) return false;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const fresh = this.newTargets.filter((entry) => Date.now() - entry.at < 8000);
      if (fresh.length === 0) {
        await sleep(120);
        continue;
      }
      const candidate = fresh[fresh.length - 1];
      this.newTargets = this.newTargets.filter((entry) => entry.targetId !== candidate.targetId);
      let sessionId;
      try {
        const attached = await connection.send('Target.attachToTarget', { targetId: candidate.targetId, flatten: true });
        sessionId = attached.sessionId;
        await connection.send('Page.enable', {}, sessionId);
        await connection.send('Runtime.enable', {}, sessionId);
        await this.#applyDesktopIdentity(sessionId);
        const viewport = this.#effectiveViewport();
        await connection.send('Emulation.setDeviceMetricsOverride', {
          width: Math.round(viewport.width), height: Math.round(viewport.height), deviceScaleFactor: viewport.dpr, mobile: false,
        }, sessionId);
        // Only take over a tab that actually landed on a page; a blank popup
        // (ads, window.open placeholders) leaves the current page in place.
        let landed;
        const landingDeadline = Date.now() + 2500;
        while (Date.now() < landingDeadline) {
          const page = await connection.send('Runtime.evaluate', {
            expression: '({ url: location.href, title: document.title })', returnByValue: true, timeout: 5000,
          }, sessionId).catch(() => undefined);
          const value = page === undefined || page.result === undefined ? undefined : page.result.value;
          if (value !== undefined && typeof value.url === 'string' && value.url !== '' && value.url !== 'about:blank') { landed = value; break; }
          await sleep(150);
        }
        if (landed === undefined) {
          await connection.send('Target.detachFromTarget', { sessionId }).catch(() => {});
          await connection.send('Target.closeTarget', { targetId: candidate.targetId }).catch(() => {});
          continue;
        }
        const previous = this.targetId;
        this.targetId = candidate.targetId;
        this.sessionId = sessionId;
        this.url = landed.url;
        this.title = landed.title || '';
        if (previous !== undefined) await connection.send('Target.closeTarget', { targetId: previous }).catch(() => {});
        return true;
      } catch {
        if (sessionId !== undefined) await connection.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        await connection.send('Target.closeTarget', { targetId: candidate.targetId }).catch(() => {});
      }
    }
    return false;
  }

  /**
   * Force one viewport size so frame pixels map 1:1 onto CSS pixels.
   * While the browser is stopped this only reports the size it would apply.
   */
  async setViewport(width, height, dpr) {
    const requested = clampViewport(width, height);
    const target = requested === undefined
      ? this.#effectiveViewport()
      : { width: requested.width, height: requested.height, dpr: clampDpr(dpr) };
    const connection = this.connection;
    if (connection === undefined || this.sessionId === undefined) return target;
    await connection.send('Emulation.setDeviceMetricsOverride', {
      width: target.width, height: target.height, deviceScaleFactor: target.dpr, mobile: false,
    }, this.sessionId);
    // The cached frame still has the old pixel size: mark it stale so the next
    // read captures a frame that matches the new emulation.
    this.frameAt = 0;
    return target;
  }

  /** Apply the effective viewport to the attached page; safe while stopped. */
  async applyViewport() {
    const viewport = this.#effectiveViewport();
    await this.setViewport(viewport.width, viewport.height, viewport.dpr);
    return viewport;
  }

  /**
   * Set or replace the transient view override and apply it immediately.
   * While the browser is stopped the override is only recorded (no error).
   */
  async setViewOverride(width, height, dpr) {
    const size = clampViewport(width, height);
    if (size === undefined) throw new Error('viewport 覆盖需要有限的 width/height 数字');
    // Cap the ratio so one frame never exceeds the emission bounds (a 3x panel
    // at the maximum CSS size would otherwise ask for a 5760x4800 screenshot).
    const capped = Math.min(
      clampDpr(dpr),
      FRAME_MAX_WIDTH / size.width,
      FRAME_MAX_HEIGHT / size.height,
    );
    this.viewOverride = {
      width: size.width,
      height: size.height,
      dpr: Math.max(DPR_MIN, Math.round(capped * 100) / 100),
    };
    // The cached frame has the old size; the next `/frame` must capture at the
    // new one instead of scaling a stale image into the panel.
    this.frame = undefined;
    return await this.applyViewport();
  }

  /** Drop the transient override and restore settings.viewport. */
  async releaseViewOverride() {
    this.viewOverride = undefined;
    this.frame = undefined;
    return await this.applyViewport();
  }

  /** Latest displayed frame as JPEG bytes, capturing on demand when stale. */
  async latestFrame() {
    if (this.connection === undefined || this.connection.closed) return undefined;
    // On-demand capture, not the screencast stream: a screenshot is emitted at
    // the emulated CSS size times deviceScaleFactor, which is exactly the
    // panel's device pixels. The screencast stream ignores deviceScaleFactor and
    // would hand back CSS-pixel frames that a scaled desktop blurs.
    if (this.frame !== undefined && typeof this.frame.at === 'number' && Date.now() - this.frame.at < 120) {
      return this.frame.buffer;
    }
    // Step back while the page is digesting input: capturing then is slow and
    // the previous frame is still representative, so the view does not freeze.
    if (this.frame !== undefined && this.lastInputAt !== undefined && Date.now() - this.lastInputAt < 220) {
      return this.frame.buffer;
    }
    try {
      const shot = await this.connection.send('Page.captureScreenshot', { format: 'jpeg', quality: FRAME_QUALITY }, this.sessionId);
      const buffer = Buffer.from(shot.data, 'base64');
      this.frame = { buffer, format: 'jpeg', at: Date.now() };
      this.frameAt = Date.now();
      this.frameSeq += 1;
      return buffer;
    } catch {
      return this.frame === undefined ? undefined : this.frame.buffer;
    }
  }

  /** Re-read the document title after a navigation this engine did not drive. */
  async refreshTitle() {
    try {
      const title = await this.evaluate('document.title');
      if (typeof title === 'string') this.title = title;
    } catch { /* a closing page keeps the last known title */ }
  }

  /** Evaluate one expression in the main page and return its JSON value. */
  async evaluate(expression) {
    await this.ensureStarted();
    const result = await this.connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 30000,
    }, this.sessionId);
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails;
      const message = detail.exception && detail.exception.description ? detail.exception.description : (detail.text || 'page script failed');
      throw new Error(String(message).slice(0, 600));
    }
    return result.result === undefined ? undefined : result.result.value;
  }

  /** Navigate the main page and wait for its load event. */
  async navigate(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (url === undefined) throw new Error('无效的 URL：需要 http(s) 链接');
    if (url === 'edge://newtab') return await this.newTabPage();
    const settings = this.settings();
    if (settings.blockPrivateAddresses !== false) {
      let host;
      try { host = new URL(url).hostname; } catch { host = undefined; }
      if (host !== undefined && isPrivateHost(host)) {
        throw new Error('已拦截本机/内网地址（' + host + '）。确需访问时请在 设置 → Web操作 里关闭「拦截本机与内网地址」。');
      }
    }
    await this.ensureStarted();
    this.loading = true;
    const loaded = this.connection.once('Page.loadEventFired', this.sessionId, 25000).catch(() => undefined);
    const navigation = await this.connection.send('Page.navigate', { url }, this.sessionId);
    if (navigation.errorText !== undefined && navigation.errorText !== '') {
      // The load event will never arrive for a refused navigation; without this
      // `status().loading` would stay true until the next successful page load.
      this.loading = false;
      throw new Error('导航失败：' + String(navigation.errorText));
    }
    this.url = displayUrl(navigation.url === undefined ? url : navigation.url);
    await loaded;
    this.loading = false;
    await sleep(250);
    try {
      const page = await this.evaluate('({ url: location.href, title: document.title, ready: document.readyState })');
      if (page !== undefined) {
        this.url = displayUrl(page.url || this.url);
        this.title = page.title || this.title;
      }
    } catch { /* a page without scripts still navigated */ }
    return { url: this.url, title: this.title };
  }

  /** Show Edge's new-tab page: the familiar browser start surface. */
  async newTabPage() {
    await this.ensureStarted();
    this.loading = true;
    const loaded = this.connection.once('Page.loadEventFired', this.sessionId, 25000).catch(() => undefined);
    await this.connection.send('Page.navigate', { url: DEFAULT_START_URL }, this.sessionId).catch(() => undefined);
    await loaded;
    this.loading = false;
    await sleep(500);
    try {
      const page = await this.evaluate('({ url: location.href, title: document.title })');
      if (page !== undefined) {
        this.url = displayUrl(page.url);
        this.title = page.title || this.title;
      }
    } catch { /* the start page is best effort */ }
    return { url: this.url, title: this.title };
  }

  /** Mouse click at page CSS coordinates. */
  async clickAt(x, y, buttonMode = 'left') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('点击坐标需要有限数字（x=' + String(x) + ', y=' + String(y) + '）');
    }
    await this.ensureStarted();
    this.lastInputAt = Date.now();
    const button = buttonMode === 'right' ? 'right' : buttonMode === 'middle' ? 'middle' : 'left';
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, this.sessionId);
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 }, this.sessionId);
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons, clickCount: 1 }, this.sessionId);
    // A click may navigate in place or open a new tab. Prefer the in-place
    // navigation; adopt a new tab only when the current page stayed put.
    const before = this.url;
    const beforeLoading = this.loading;
    this.lastInputAt = Date.now();
    // Adaptive settle: a click that navigates returns as soon as the URL or
    // loading state changes instead of always paying a fixed delay.
    const settleDeadline = Date.now() + 240;
    while (Date.now() < settleDeadline) {
      await sleep(40);
      if (this.url !== before || this.loading !== beforeLoading) return;
    }
    // Only chase a popup tab when this click actually produced one; waiting for
    // a tab that will never appear is what made plain clicks feel stuck.
    if (this.newTargets.some((entry) => Date.now() - entry.at < 3000)) {
      await this.#adoptNewTarget(600);
    }
    return { ok: true, x, y, button };
  }

  /** Click by selector, visible text, or coordinates. */
  async click({ selector, text, x, y, button }) {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      await this.clickAt(x, y, button);
      return { ok: true, method: 'point', x, y };
    }
    if ((selector === undefined || selector === '') && (text === undefined || text === '')) {
      throw new Error('click 需要 selector、text 或 x/y 之一');
    }
    const located = await this.evaluate(locateScript(selector, text));
    if (located === undefined || located.ok !== true) {
      return { ok: false, reason: located === undefined ? 'no-result' : String(located.reason), url: this.url };
    }
    // A click can miss while the page is still scrolling or settling after
    // scrollIntoView, which looks like "clicked but nothing happened": re-read
    // the element once and only click when something is actually at the point.
    let target = located;
    await sleep(50);
    const refreshed = await this.evaluate(locateScript(selector, text)).catch(() => undefined);
    if (refreshed !== undefined && refreshed.ok === true) target = refreshed;
    const hit = await this.evaluate(`(() => {
      const el = document.elementFromPoint(${String(target.x)}, ${String(target.y)});
      if (el === null) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`).catch(() => false);
    if (hit !== true) {
      await sleep(120);
      const again = await this.evaluate(locateScript(selector, text)).catch(() => undefined);
      if (again !== undefined && again.ok === true) target = again;
    }
    // Keep a target=_blank result click inside the controlled page.
    await this.evaluate(`(() => {
      const el = document.elementFromPoint(${String(target.x)}, ${String(target.y)});
      const anchor = el && typeof el.closest === 'function' ? el.closest('a[target]') : null;
      if (anchor !== null && anchor.getAttribute('target') !== '_self') anchor.setAttribute('target', '_self');
      return true;
    })()`).catch(() => undefined);
    await this.clickAt(target.x, target.y, button);
    return { ok: true, method: selector ? 'selector' : 'text', tag: target.tag, label: target.label, x: target.x, y: target.y };
  }

  /** Focus a field (or the active element) and insert text. */
  async typeText({ selector, text, submit }) {
    await this.ensureStarted();
    const focused = await this.evaluate(focusScript(selector));
    if (focused === undefined || focused.ok !== true) {
      return { ok: false, reason: focused === undefined ? 'no-result' : String(focused.reason) };
    }
    await this.connection.send('Input.insertText', { text: String(text === undefined ? '' : text) }, this.sessionId);
    // Text insertion changes the page as much as a key press does; the frame
    // cache backs off after it for the same reason.
    this.lastInputAt = Date.now();
    if (submit === true) {
      await this.pressKey('Enter');
      await sleep(220);
    }
    return { ok: true, target: String(focused.target), url: this.url };
  }

  /** Press one named key at the page's focus. */
  async pressKey(name) {
    await this.ensureStarted();
    this.lastInputAt = Date.now();
    const key = String(name === undefined ? '' : name);
    const spec = KEYS[key];
    if (spec === undefined) throw new Error('不支持的按键：' + key + '（支持 Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space）');
    const base = {
      key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk,
    };
    await this.connection.send('Input.dispatchKeyEvent', { type: spec.text === undefined ? 'rawKeyDown' : 'keyDown', ...base, ...(spec.text === undefined ? {} : { text: spec.text, unmodifiedText: spec.text }) }, this.sessionId);
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId);
  }

  /** Wheel-scroll the page from its center. */
  async scroll(dy) {
    await this.ensureStarted();
    this.lastInputAt = Date.now();
    const viewport = this.#effectiveViewport();
    await this.connection.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2),
      deltaX: 0, deltaY: Number.isFinite(dy) ? dy : 600,
    }, this.sessionId);
    await sleep(150);
  }

  /** Read the page as text, links, or HTML. */
  async read({ mode, selector, maxChars }) {
    const value = await this.evaluate(readScript(mode === 'links' || mode === 'html' ? mode : 'text', selector, maxChars));
    if (value === undefined) return { ok: false, reason: 'no-result', url: this.url };
    if (value.ok === false && value.reason !== undefined) {
      return { ok: false, reason: String(value.reason), selector, url: this.url };
    }
    const result = { ok: true, url: value.url || this.url, title: value.title || this.title };
    if (mode === 'links') result.links = value.links || [];
    else if (mode === 'html') result.html = value.html || '';
    else result.text = clampText(value.text || '', Number.isFinite(maxChars) ? maxChars : 60000);
    return result;
  }

  /** Capture one JPEG of the page (used for inline model images). */
  async captureJpeg(quality) {
    await this.ensureStarted();
    const value = Number.isFinite(quality) ? Math.max(20, Math.min(90, Math.round(quality))) : 62;
    const shot = await this.connection.send('Page.captureScreenshot', { format: 'jpeg', quality: value, captureBeyondViewport: false }, this.sessionId);
    return { buffer: Buffer.from(shot.data, 'base64'), mediaType: 'image/jpeg', quality: value, url: this.url, title: this.title };
  }

  /** Poll a page condition until it holds or the deadline passes. */
  async waitFor({ kind, value, timeoutMs }) {
    await this.ensureStarted();
    const limit = Number.isFinite(timeoutMs) ? Math.max(200, Math.min(60000, timeoutMs)) : 10000;
    const deadline = Date.now() + limit;
    const target = String(value === undefined ? '' : value);
    const script = kind === 'text'
      ? `document.body ? document.body.innerText.includes(${JSON.stringify(target)}) : false`
      : kind === 'url'
        ? `location.href.includes(${JSON.stringify(target)})`
        : `(() => { try { return document.querySelector(${JSON.stringify(target)}) !== null; } catch (error) { return false; } })()`;
    while (Date.now() < deadline) {
      let ok = false;
      try { ok = await this.evaluate(String(script)) === true; } catch { ok = false; }
      if (ok) return { ok: true, waitedMs: limit - (deadline - Date.now()), url: this.url };
      await sleep(250);
    }
    return { ok: false, reason: 'timeout', waitedMs: limit, url: this.url };
  }

  /**
   * Open one background tab in the controlled profile, run one extractor there,
   * and close it again. The tab lives in the profile's own context on purpose: a
   * cookie-less throwaway context looks like a first-time visitor, and Baidu
   * answers that with a captcha. `lastSearchFailure` records why a search came
   * back empty so the provider can report a useful reason.
   */
  async searchFrom(query, extractor) {
    this.lastSearchFailure = undefined;
    await this.ensureStarted();
    const connection = this.connection;
    const viewport = this.settings().viewport;
    let created;
    try {
      created = await connection.send('Target.createTarget', { url: 'about:blank' });
    } catch (error) {
      this.lastSearchFailure = '无法打开搜索页面';
      throw error;
    }
    // Never let the popup-adoption logic mistake a search tab for a page a click
    // opened.
    this.expectedTargets.add(created.targetId);
    let sessionId;
    try {
      const attached = await connection.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
      sessionId = attached.sessionId;
      await connection.send('Page.enable', {}, sessionId);
      await connection.send('Runtime.enable', {}, sessionId);
      // A search must look like this machine's normal desktop browser: Baidu
      // serves a captcha to the headless User-Agent.
      await this.#applyDesktopIdentity(sessionId);
      await connection.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      // Present a normal zh-CN desktop browser to the search engine.
      await connection.send('Emulation.setLocaleOverride', { locale: 'zh-CN' }, sessionId).catch(() => undefined);
      await connection.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' }, sessionId).catch(() => undefined);
      await connection.send('Network.setExtraHTTPHeaders', {
        headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
      }, sessionId).catch(() => undefined);
      const loaded = connection.once('Page.loadEventFired', sessionId, 25000).catch(() => undefined);
      try {
        await connection.send('Page.navigate', { url: extractor.url }, sessionId);
      } catch (error) {
        this.lastSearchFailure = '无法打开搜索页：' + String(error && error.message ? error.message : error);
        throw error;
      }
      await loaded;
      await sleep(500);
      // A captcha/verification interstitial renders no result list; detect it
      // instead of scraping its unrelated links and passing them off as results.
      const probe = await connection.send('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })',
        returnByValue: true,
        timeout: 5000,
      }, sessionId).catch(() => undefined);
      const info = probe !== undefined && probe.result !== undefined ? probe.result.value : undefined;
      const fingerprint = String(info !== undefined && info.url !== undefined ? info.url : '') + ' ' + String(info !== undefined && info.title !== undefined ? info.title : '');
      if (/\u9a8c\u8bc1|captcha|ds_svcp|bioc-static|security/i.test(fingerprint)) {
        this.lastSearchFailure = '搜索引擎要求人机验证';
        return [];
      }
      // Result lists often render a moment after load; poll the extractor
      // instead of trusting one fixed delay.
      const script = extractor.script(Number.isFinite(extractor.limit) ? extractor.limit : 10);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const result = await connection.send('Runtime.evaluate', {
          expression: script,
          returnByValue: true,
          awaitPromise: true,
          timeout: 20000,
        }, sessionId).catch((error) => ({ exceptionDetails: { text: String(error && error.message ? error.message : error) } }));
        if (result.exceptionDetails !== undefined) {
          this.lastSearchFailure = '页面结构不匹配（提取脚本执行失败）';
          return [];
        }
        const rows = result.result === undefined ? undefined : result.result.value;
        if (Array.isArray(rows) && rows.length > 0) return rows;
        await sleep(350);
      }
      this.lastSearchFailure = '页面没有结果列表';
      return [];
    } finally {
      await connection.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
      this.expectedTargets.delete(created.targetId);
    }
  }

  /** The user-data directory this engine uses (see {@link resolveProfileDir}). */
  profileDir() {
    return resolveProfileDir(this.settings());
  }

  /**
   * Delete the browser profile (cookies, logins, cache). Stops the browser
   * first, so it also ends any page session. Used when the master switch turns
   * off with `clearProfileOnDisable` enabled.
   */
  async clearProfile() {
    const dir = this.profileDir();
    if (this.connection !== undefined) {
      try { await this.stop(); } catch { /* best effort */ }
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
        return { cleared: true, dir };
      } catch (error) {
        await sleep(250);
        if (attempt === 2) {
          return { cleared: false, dir, reason: String(error && error.message ? error.message : error) };
        }
      }
    }
    return { cleared: false, dir };
  }

  /** Stop the browser and release the connection. */
  async stop() {
    // Invalidate any launch in flight: `#start` checks this epoch after the
    // long awaits and aborts instead of adopting a browser we just stopped.
    this.startEpoch += 1;
    const connection = this.connection;
    const child = this.child;
    const settings = this.settings();
    const profileDir = resolveProfileDir(settings);
    this.connection = undefined;
    this.sessionId = undefined;
    this.targetId = undefined;
    this.frame = undefined;
    this.newTargets = [];
    this.expectedTargets.clear();
    if (connection !== undefined) {
      await connection.send('Browser.close').catch(() => {});
      connection.close();
    }
    // Wait for the process and its profile lock to go away: a relaunch while the
    // previous instance is still shutting down cannot take the profile.
    if (child !== undefined) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill(); } catch { clearTimeout(timer); resolve(); }
      });
    } else {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const port = await existingDevtoolsPort(profileDir);
        if (port === undefined || (await probeVersion(port)) === undefined) break;
        await sleep(200);
      }
    }
    this.child = undefined;
    await fs.promises.unlink(path.join(profileDir, 'DevToolsActivePort')).catch(() => {});
    this.url = '';
    this.title = '';
    this.loading = false;
    // Diagnostics must not describe a page that is no longer open.
    this.frameSeq = 0;
    this.frameAt = 0;
    this.lastInputAt = 0;
    this.lastActionAt = 0;
  }
}
