/**
 * Web actions for DSH: one controlled browser that the agent can drive and the
 * user can watch in the right sidebar.
 *
 * The plugin owns four contributions:
 * - `browser` tool: open/read/click/type/scroll/wait/screenshot/eval;
 * - a `web` search provider that searches through the browser instead of the
 *   DeepSeek Search API;
 * - `/web-browser` HTTP routes used by the sidebar view, the composer switch,
 *   and the settings page;
 * - no Host UI of its own. The master switch lives in the client half.
 *
 * Execution runs through a small facade: `settings.engineMode` picks the
 * standalone-Chromium engine (`classic`) or the Desktop built-in renderer
 * driven over the client bridge (`native`). `auto` prefers native while its
 * view is mounted and falls back per call; search always stays on classic.
 */
import { BrowserEngine } from './lib/browser.js';
import { NativeEngine, NativeUnavailableError } from './lib/native.js';
import { createBrowserSearchProvider } from './lib/search.js';
import { createBrowserTool } from './lib/tools.js';
import { registerBrowserRoutes } from './lib/routes.js';
import { SettingsStore } from './lib/settings.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-composer-tools';

/** Services this plugin needs: tool registry, web seam, and the HTTP carrier. */
export const inject = ['tools', 'web', 'webServer'];

/** Short logger prefix so Host logs stay attributable. */
const PREFIX = '[web-actions] ';

/**
 * Build the engine facade that routes calls per `settings.engineMode`.
 *
 * - `classic`: everything goes to the BrowserEngine (today's behavior);
 * - `native`: everything goes to the NativeEngine; an unavailable native view
 *   is surfaced as a normal tool error instead of crashing the Host;
 * - `auto`: native wins only while `available && tabOpen`; every
 *   `NativeUnavailableError` falls back to the classic engine for that call and
 *   is remembered as `degradedReason` in `status()`.
 *
 * View/profile helpers stay on the classic engine: it owns the persisted profile
 * and the CDP view override, while the native `<webview>` has no CDP viewport.
 * Search is delegated to the classic engine on purpose (throwaway CDP target).
 *
 * @param options - settings reader, both engines, and a logger.
 */
export function createEngineFacade({ settings, classic, native, log }) {
  const note = typeof log === 'function' ? log : () => {};
  /** Last fallback reason, exposed through status().degradedReason. */
  let degradedReason;

  const readMode = () => {
    let value;
    try { value = settings(); } catch { value = undefined; }
    const mode = value === undefined || value === null ? undefined : value.engineMode;
    return mode === 'native' || mode === 'auto' ? mode : 'classic';
  };

  const nativeSnapshot = () => {
    try {
      if (native !== undefined && native !== null && typeof native.status === 'function') {
        const status = native.status();
        if (status !== undefined && status !== null && status.native !== undefined && status.native !== null) return status.native;
      }
    } catch { /* treat an unreadable native engine as unavailable */ }
    return { available: false, protocolVersion: 0, tabOpen: false, reason: '原生引擎状态不可读' };
  };

  const nativeUsable = () => {
    const snapshot = nativeSnapshot();
    return snapshot.available === true && snapshot.tabOpen === true;
  };

  /** Why native is not being used right now. */
  const fallbackReason = () => {
    const snapshot = nativeSnapshot();
    if (snapshot.available !== true) {
      return typeof snapshot.reason === 'string' && snapshot.reason !== '' ? snapshot.reason : '内置渲染器桥不可用';
    }
    if (snapshot.tabOpen !== true) return '原生视图未打开（右侧栏 Web 视图未挂载）';
    return '原生视图不可用';
  };

  const degrade = (reason) => {
    const text = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : fallbackReason();
    degradedReason = text;
    try { if (native !== undefined && native !== null) native.degradedReason = text; } catch { /* diagnostics only */ }
    return text;
  };

  const clearDegrade = () => {
    degradedReason = undefined;
    try { if (native !== undefined && native !== null) native.degradedReason = undefined; } catch { /* diagnostics only */ }
  };

  /** Classic implementations used whenever the classic engine takes the call. */
  const classicCall = {
    navigate: (args) => classic.navigate(...args),
    read: (args) => classic.read(...args),
    click: (args) => classic.click(...args),
    clickAt: (args) => classic.clickAt(...args),
    typeText: (args) => classic.typeText(...args),
    pressKey: (args) => classic.pressKey(...args),
    scroll: (args) => classic.scroll(...args),
    waitFor: (args) => classic.waitFor(...args),
    evaluate: (args) => classic.evaluate(...args),
    captureJpeg: (args) => classic.captureJpeg(...args),
    newTabPage: () => classic.newTabPage(),
    back: () => classic.evaluate('history.back()'),
    forward: () => classic.evaluate('history.forward()'),
    reload: () => classic.evaluate('location.reload()'),
    refreshTitle: () => classic.refreshTitle(),
  };

  async function viaNative(method, args) {
    try {
      const value = await native[method](...args);
      clearDegrade();
      return value;
    } catch (error) {
      if (!(error instanceof NativeUnavailableError)) throw error;
      const reason = degrade(error.reason || error.message);
      note('native ' + method + ' unavailable, using classic: ' + reason);
      return await classicCall[method](args);
    }
  }

  /** One dispatched method: classic, native, or auto with per-call fallback. */
  function command(method) {
    return async (...args) => {
      const mode = readMode();
      if (mode === 'classic') return await classicCall[method](args);
      if (mode === 'native') return await native[method](...args);
      if (!nativeUsable()) {
        degrade();
        return await classicCall[method](args);
      }
      return await viaNative(method, args);
    };
  }

  const facade = {
    status() {
      const mode = readMode();
      const snapshot = nativeSnapshot();
      const nativeActive = mode === 'native' || (mode === 'auto' && snapshot.available === true && snapshot.tabOpen === true);
      let base;
      if (nativeActive) {
        try { base = native.status(); } catch { base = classic.status(); }
      } else {
        base = classic.status();
      }
      return {
        ...base,
        mode: nativeActive ? 'native' : 'classic',
        degradedReason,
        native: snapshot,
      };
    },

    /** Usable right now, from the caller's perspective (search still uses classic). */
    available() {
      const mode = readMode();
      if (mode === 'native') {
        try { return native.available() === true; } catch { return false; }
      }
      if (mode === 'auto') {
        if (nativeUsable()) return true;
        try { return classic.available() === true; } catch { return false; }
      }
      return classic.available();
    },

    async ensureStarted() {
      const mode = readMode();
      if (mode === 'classic') return await classic.ensureStarted();
      if (mode === 'native') return await native.ensureStarted();
      if (nativeUsable()) {
        try {
          return await native.ensureStarted();
        } catch (error) {
          if (!(error instanceof NativeUnavailableError)) throw error;
          degrade(error.reason || error.message);
        }
      } else {
        degrade();
      }
      return await classic.ensureStarted();
    },

    /** Stop both engines; either one may already be down, so this never throws. */
    async stop() {
      const results = await Promise.allSettled([
        (async () => classic.stop())(),
        (async () => {
          if (native !== undefined && native !== null && typeof native.stop === 'function') await native.stop();
        })(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') note('engine stop failed: ' + String(result.reason && result.reason.message ? result.reason.message : result.reason));
      }
    },

    // Page commands: mode-dispatched, identical surface in both modes.
    navigate: command('navigate'),
    read: command('read'),
    click: command('click'),
    clickAt: command('clickAt'),
    typeText: command('typeText'),
    pressKey: command('pressKey'),
    scroll: command('scroll'),
    waitFor: command('waitFor'),
    evaluate: command('evaluate'),
    captureJpeg: command('captureJpeg'),
    newTabPage: command('newTabPage'),
    back: command('back'),
    forward: command('forward'),
    reload: command('reload'),
    refreshTitle: command('refreshTitle'),

    /** Latest JPEG: native capture when one exists, otherwise the classic frame. */
    async latestFrame() {
      if (readMode() !== 'classic') {
        try {
          const frame = await native.latestFrame();
          if (frame !== undefined) return frame;
        } catch { /* fall through to the classic frame */ }
      }
      return await classic.latestFrame();
    },

    /** Search is never native: throwaway CDP target, classic engine, always. */
    async searchFrom(...args) {
      return await classic.searchFrom(...args);
    },

    // View overrides: the classic engine owns the CDP emulation; native only
    // mirrors the size for diagnostics, because its webview fills CSS pixels.
    async setViewOverride(...args) {
      try { if (native !== undefined && native !== null && typeof native.setViewOverride === 'function') await native.setViewOverride(...args); } catch { /* diagnostics only */ }
      return await classic.setViewOverride(...args);
    },
    async releaseViewOverride(...args) {
      try { if (native !== undefined && native !== null && typeof native.releaseViewOverride === 'function') await native.releaseViewOverride(...args); } catch { /* diagnostics only */ }
      return await classic.releaseViewOverride();
    },
    async setViewport(...args) {
      try { if (native !== undefined && native !== null && typeof native.setViewport === 'function') await native.setViewport(...args); } catch { /* diagnostics only */ }
      return await classic.setViewport(...args);
    },
    async applyViewport() {
      try { if (native !== undefined && native !== null && typeof native.applyViewport === 'function') await native.applyViewport(); } catch { /* diagnostics only */ }
      return await classic.applyViewport();
    },
    profileDir() {
      return classic.profileDir();
    },
    async clearProfile() {
      if (native !== undefined && native !== null && typeof native.stop === 'function') {
        try { await native.stop(); } catch { /* best effort */ }
      }
      return await classic.clearProfile();
    },
  };

  // The tool marks model activity through `engine.lastActionAt`; keep both
  // engines in sync so whichever one reports status carries the same value.
  Object.defineProperty(facade, 'lastActionAt', {
    enumerable: true,
    get() {
      if (classic.lastActionAt !== undefined && classic.lastActionAt !== 0) return classic.lastActionAt;
      return native !== undefined && native !== null && native.lastActionAt !== undefined ? native.lastActionAt : 0;
    },
    set(value) {
      const at = Number.isFinite(value) ? value : Date.now();
      classic.lastActionAt = at;
      if (native !== undefined && native !== null) native.lastActionAt = at;
    },
  });

  return facade;
}

/**
 * Wire the controlled browser into the Host.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const settings = new SettingsStore();
  const log = (message) => {
    try { console.log(PREFIX + String(message)); } catch { /* a closed stdout must not break a tool */ }
  };
  const readSettings = () => settings.get();
  const classic = new BrowserEngine({ settings: readSettings });
  const native = new NativeEngine({ settings: readSettings, classic, log });
  const engine = createEngineFacade({ settings: readSettings, classic, native, log });
  // Search always runs on the classic engine (background CDP target), so the
  // provider keeps a direct reference to it instead of the facade.
  const provider = createBrowserSearchProvider({ settings: readSettings, engine: classic, log });

  // The web seam can be re-created when its provider selection changes through
  // configuration; its registry then starts empty. Keep this provider present
  // instead of assuming one registration survives the reload.
  let providerDisposer;
  const ensureProvider = () => {
    let present = false;
    try {
      present = ctx.web.listProviders().search.some((entry) => entry.id === provider.id);
    } catch {
      present = false;
    }
    if (present) return;
    try {
      providerDisposer = ctx.web.registerSearchProvider(provider);
    } catch (error) {
      log('search provider not registered: ' + (error && error.message ? error.message : String(error)));
    }
  };

  ctx.effect(
    () => {
      ensureProvider();
      const off = ctx.on('web/providers-changed', ensureProvider);
      return () => {
        off();
        if (providerDisposer !== undefined) {
          try { providerDisposer(); } catch { /* registry already replaced */ }
          providerDisposer = undefined;
        }
      };
    },
    'dsh-web-browser: search provider',
  );

  ctx.effect(
    () => ctx.tools.register(createBrowserTool({ engine, settings: readSettings, log, ctx, provider })),
    'dsh-web-browser: browser tool',
  );

  ctx.effect(
    () => registerBrowserRoutes({ ctx, engine, settings, log, native }),
    'dsh-web-browser: routes',
  );

  ctx.effect(
    () => () => { void engine.stop(); },
    'dsh-web-browser: engine teardown',
  );

  // An enabled switch means the user expects the viewport to be live; a failed
  // launch stays reported through `/web-browser/state` instead of blocking here.
  // Only the classic mode pre-warms Chromium: native has no process of its own
  // and auto should not launch Edge before the sidebar view asks for native.
  const initial = settings.get();
  if (initial.enabled && initial.engineMode === 'classic') {
    engine.ensureStarted().catch((error) => {
      log('initial launch failed: ' + (error && error.message ? error.message : String(error)));
    });
  }
  log('activated (enabled=' + String(settings.isEnabled()) + ', engineMode=' + String(initial.engineMode) + ')');
}
