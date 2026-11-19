/**
 * Same-origin HTTP routes the browser UI (composer switch, settings page, and
 * right sidebar tab) uses to read state and drive the controlled browser.
 *
 * Everything runs through the DSH web server under `/web-browser`, so the page
 * needs no Remote namespace and no extra IPC channel. Bodies are small JSON;
 * frames are JPEG bytes.
 *
 * Security: these routes change real browser state (navigate, click, type,
 * toggle, search-provider rewrite), so every request is checked before it is
 * dispatched. Browsers always send `Sec-Fetch-Site`, and a cross-site request
 * that gets through would be a CSRF hole; POST bodies must be JSON, which a
 * simple cross-site form/no-cors fetch cannot claim (it would need a CORS
 * preflight this server never grants). Requests without the header (local
 * scripts, curl) are allowed, exactly like the rest of the local Host API.
 */

const MAX_BODY_BYTES = 1024 * 1024;

/** `Sec-Fetch-Site` values a same-origin UI request may carry. */
const SAME_ORIGIN_SITES = new Set(['same-origin', 'none']);

/**
 * Reject cross-site requests before any route logic runs.
 * @param req - incoming request.
 * @returns a refusal reason, or undefined when the request may proceed.
 */
function crossSiteProblem(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '' && !SAME_ORIGIN_SITES.has(site.toLowerCase())) {
    return '拒绝跨站请求（Sec-Fetch-Site: ' + site + '）';
  }
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.includes('application/json')) {
      return 'POST 请求需要 content-type: application/json';
    }
  }
  return undefined;
}

function sendJson(res, status, value, extraHeaders) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...(extraHeaders || {}),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Empty bridge reply (204): `/bridge/next` has no command right now. */
function sendNoContent(res, extraHeaders) {
  res.writeHead(204, { ...(extraHeaders || {}), 'cache-control': 'no-store' });
  res.end();
}

/** Render one error as route text without leaking stack traces. */
function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function sendText(res, status, text, type) {
  res.writeHead(status, { 'content-type': (type || 'text/plain') + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text);
  return parsed !== null && typeof parsed === 'object' ? parsed : {};
}

/** Read one JSON body, answering 400 instead of escaping as a 500. */
async function readJsonOr400(req, res) {
  try {
    return await readJson(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, reason: '无效的请求体：' + errorText(error) });
    return undefined;
  }
}

/** Read the configured web provider ids through the config editor, when available. */
function webProviderConfig(ctx) {
  const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
  if (editor === undefined || editor === null) return undefined;
  try {
    const rows = editor.configuration();
    for (const row of rows) {
      const merged = { ...(row.inherited || {}), ...(row.override || {}) };
      if (Object.prototype.hasOwnProperty.call(merged, 'searchProvider')) {
        return { row, merged };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The state payload every UI surface reads. */
function stateOf(engine, settings, ctx) {
  const current = settings.get();
  const providers = (() => {
    try { return ctx.web.listProviders(); } catch { return undefined; }
  })();
  const config = webProviderConfig(ctx);
  const configuredSearchProvider = config === undefined
    ? undefined
    : (config.merged.searchProvider === undefined ? undefined : String(config.merged.searchProvider));
  return {
    settings: current,
    engine: engine.status(),
    provider: {
      id: current.providerId,
      configured: configuredSearchProvider,
      active: configuredSearchProvider === current.providerId,
      switchable: config !== undefined,
      registered: providers === undefined ? undefined : (providers.search || []).map((entry) => entry.id),
    },
  };
}

/**
 * Register the `/web-browser` prefix route.
 * @param options - plugin context, engine (facade), settings store, logger, and
 *   the native engine backing the `/bridge/*` routes (optional; without it the
 *   bridge reports itself as unwired and clients fall back to the frame view).
 * @returns disposer removing the route.
 */
export function registerBrowserRoutes({ ctx, engine, settings, log, native }) {
  /** Whether the native bridge should hand out commands for the current mode. */
  const bridgeActive = () => {
    if (native === undefined || native === null) return false;
    let mode = 'classic';
    try { mode = String(settings.get().engineMode || 'classic'); } catch { mode = 'classic'; }
    return mode === 'native' || mode === 'auto';
  };
  /** Native snapshot for bridge replies; never throws. */
  const nativeSnapshot = () => {
    try {
      if (native !== undefined && native !== null && typeof native.status === 'function') {
        const status = native.status();
        if (status !== null && status !== undefined && status.native !== undefined && status.native !== null) return status.native;
      }
    } catch { /* fall through to the unwired shape */ }
    return { available: false, protocolVersion: 0, tabOpen: false, reason: '原生引擎未接线' };
  };

  const handler = async (req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch { /* keep default */ }
    const route = pathname.startsWith('/web-browser') ? pathname.slice('/web-browser'.length) || '/' : pathname;
    const method = req.method || 'GET';
    try {
      const refused = crossSiteProblem(req);
      if (refused !== undefined) {
        sendJson(res, 403, { ok: false, reason: refused });
        return;
      }
      if (route === '/state' && method === 'GET') {
        sendJson(res, 200, stateOf(engine, settings, ctx));
        return;
      }
      if (route === '/toggle' && method === 'POST') {
        const body = await readJsonOr400(req, res);
        if (body === undefined) return;
        const enabled = body.enabled === true;
        settings.setEnabled(enabled);
        let failure;
        let profileCleared;
        if (enabled) {
          try { await engine.ensureStarted(); } catch (error) { failure = String(error && error.message ? error.message : error); }
        } else {
          try { await engine.stop(); } catch { /* stopping is best effort */ }
          if (settings.get().clearProfileOnDisable === true) {
            try { profileCleared = await engine.clearProfile(); } catch (error) { profileCleared = { cleared: false, reason: String(error && error.message ? error.message : error) }; }
          }
        }
        log('toggle ' + (enabled ? 'on' : 'off') + (failure === undefined ? '' : ' (start failed: ' + failure + ')'));
        const payload = stateOf(engine, settings, ctx);
        if (failure !== undefined) payload.error = failure;
        if (profileCleared !== undefined) payload.profileCleared = profileCleared;
        sendJson(res, 200, payload);
        return;
      }
      if (route === '/frame' && method === 'GET') {
        const frame = await engine.latestFrame();
        if (frame === undefined) { sendText(res, 503, 'no frame yet'); return; }
        const mediaType = frame.length > 3 && frame[0] === 0x89 && frame[1] === 0x50 ? 'image/png' : 'image/jpeg';
        res.writeHead(200, { 'content-type': mediaType, 'cache-control': 'no-store', 'content-length': frame.length });
        res.end(frame);
        return;
      }
      if (route === '/navigate' && method === 'POST') {
        const body = await readJsonOr400(req, res);
        if (body === undefined) return;
        if (typeof body.url !== 'string' || body.url.trim() === '') {
          sendJson(res, 400, { ok: false, reason: 'navigate 需要 url 字符串' });
          return;
        }
        const result = await engine.navigate(body.url);
        sendJson(res, 200, { ok: true, url: result.url, title: result.title, engine: engine.status() });
        return;
      }
      if (route === '/nav' && method === 'POST') {
        const body = await readJsonOr400(req, res);
        if (body === undefined) return;
        const action = String(body.action || '');
        if (action === 'back' || action === 'forward' || action === 'reload') {
          // Go through the engine facade, so the native view navigates through
          // its own bridge instead of being sent a CDP-only `evaluate`.
          await engine[action]();
        } else {
          sendJson(res, 400, { ok: false, reason: 'unknown nav action' });
          return;
        }
        sendJson(res, 200, { ok: true, engine: engine.status() });
        return;
      }
      if (route === '/input' && method === 'POST') {
        const body = await readJsonOr400(req, res);
        if (body === undefined) return;
        const kind = String(body.type || '');
        if (kind === 'click') {
          const x = Number(body.x);
          const y = Number(body.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            sendJson(res, 400, { ok: false, reason: 'click 需要有限的 x/y 数字' });
            return;
          }
          await engine.clickAt(x, y, String(body.button || 'left'));
        } else if (kind === 'wheel') {
          const dy = Number(body.dy);
          if (!Number.isFinite(dy)) {
            sendJson(res, 400, { ok: false, reason: 'wheel 需要有限的 dy 数字' });
            return;
          }
          await engine.scroll(dy);
        } else if (kind === 'text') {
          await engine.typeText({ text: String(body.text === undefined ? '' : body.text) });
        } else if (kind === 'key') {
          await engine.pressKey(String(body.key || 'Enter'));
        } else {
          sendJson(res, 400, { ok: false, reason: 'unknown input type' });
          return;
        }
        sendJson(res, 200, { ok: true, engine: engine.status() });
        return;
      }
      if (route === '/viewport' && method === 'POST') {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          sendJson(res, 400, { ok: false, reason: '无效的请求体：' + String(error && error.message ? error.message : error) });
          return;
        }
        if (body.release === true) {
          await engine.releaseViewOverride();
          sendJson(res, 200, { ok: true, engine: engine.status() });
          return;
        }
        const width = Number(body.width);
        const height = Number(body.height);
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          sendJson(res, 400, { ok: false, reason: 'viewport 需要 { width, height } 数字，或 { release: true }' });
          return;
        }
        const dpr = body.dpr === undefined || body.dpr === null ? 1 : Number(body.dpr);
        await engine.setViewOverride(width, height, dpr);
        sendJson(res, 200, { ok: true, engine: engine.status() });
        return;
      }
      if (route === '/settings' && method === 'GET') {
        sendJson(res, 200, { ok: true, settings: settings.get() });
        return;
      }
      if (route === '/settings' && method === 'POST') {
        const body = await readJsonOr400(req, res);
        if (body === undefined) return;
        const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : body;
        const before = settings.get();
        const next = settings.update(patch);
        let failure;
        let profileCleared;
        // The settings page can flip the master switch as well; give it the same
        // side effects as `/toggle` instead of leaving a stopped or running
        // browser behind the value that was just saved.
        if (before.enabled !== next.enabled) {
          if (next.enabled) {
            try { await engine.ensureStarted(); } catch (error) { failure = errorText(error); }
          } else {
            try { await engine.stop(); } catch { /* stopping is best effort */ }
            if (next.clearProfileOnDisable === true) {
              try { profileCleared = await engine.clearProfile(); } catch (error) { profileCleared = { cleared: false, reason: errorText(error) }; }
            }
          }
        }
        // Re-apply the *effective* viewport (override wins over the new default)
        // so changing settings while the sidebar is narrow cannot resize the page
        // back to settings.viewport behind the panel's back.
        if (next.viewport !== undefined && engine.status().running) {
          try { await engine.applyViewport(); } catch { /* applies on next start */ }
        }
        const payload = { ok: failure === undefined, settings: next };
        if (failure !== undefined) payload.reason = failure;
        if (profileCleared !== undefined) payload.profileCleared = profileCleared;
        sendJson(res, 200, payload);
        return;
      }
      if (route === '/provider' && method === 'POST') {
        const body = await readJsonOr400(req, res);
        if (body === undefined) return;
        const want = body.enabled === true ? settings.get().providerId : 'deepseek-search-api';
        const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
        if (editor === undefined || editor === null) {
          sendJson(res, 200, { ok: false, reason: 'configEditor 服务不可用（非 profile 启动），请在 设置 → 网页搜索 里手动选择搜索源。' });
          return;
        }
        const config = webProviderConfig(ctx);
        if (config === undefined) {
          sendJson(res, 200, { ok: false, reason: '没有找到 web 配置行，无法切换搜索源。' });
          return;
        }
        const fetchProvider = config.merged.fetchProvider === undefined ? 'http' : String(config.merged.fetchProvider);
        try {
          await editor.edit(config.row.entry, () => ({ searchProvider: want, fetchProvider }));
        } catch (error) {
          sendJson(res, 200, { ok: false, reason: '切换失败：' + String(error && error.message ? error.message : error) });
          return;
        }
        sendJson(res, 200, { ok: true, configured: want });
        return;
      }
      // --- native view bridge (方案 B) ------------------------------------
      // The renderer half polls these routes from inside the sidebar tab. They
      // are behind the same guard as everything else and never throw: bad
      // bodies answer 4xx JSON, unknown ids are simply ignored.
      if (route === '/bridge/hello' && method === 'POST') {
        let body;
        try { body = await readJson(req); } catch (error) { sendJson(res, 400, { ok: false, reason: '无效的请求体：' + errorText(error) }); return; }
        const protocolVersion = Number(body.protocolVersion);
        if (!Number.isFinite(protocolVersion)) { sendJson(res, 400, { ok: false, reason: 'bridge/hello 需要 protocolVersion 数字' }); return; }
        if (typeof body.available !== 'boolean') { sendJson(res, 400, { ok: false, reason: 'bridge/hello 需要 available 布尔值' }); return; }
        if (native === undefined || native === null || typeof native.setNativeStatus !== 'function') {
          sendJson(res, 200, { ok: true, accepted: false, native: nativeSnapshot() });
          return;
        }
        const snapshot = native.setNativeStatus({ available: body.available === true, protocolVersion, reason: body.reason, url: body.url });
        log('bridge hello: available=' + String(snapshot.available) + ' protocol=' + String(snapshot.protocolVersion));
        sendJson(res, 200, { ok: true, accepted: true, native: snapshot });
        return;
      }
      if (route === '/bridge/next' && method === 'GET') {
        // In classic mode the client should stop polling and keep the frame view.
        if (!bridgeActive()) { sendNoContent(res, { 'x-web-browser-native': 'off' }); return; }
        // `register` asks a still-mounted view to announce itself again: after a
        // plugin reload (or a DSH restart) the Host has no capability report yet,
        // but the webview is alive and can re-hello without a page refresh.
        const headers = { 'x-web-browser-native': nativeSnapshot().available === true ? 'on' : 'register' };
        if (typeof native.nextCommand !== 'function') {
          sendJson(res, 500, { ok: false, reason: '原生引擎未接线（缺少 nextCommand）' });
          return;
        }
        let waitMs = 0;
        try { waitMs = Number(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('waitMs')); } catch { waitMs = 0; }
        const clamped = Number.isFinite(waitMs) ? Math.min(1000, Math.max(0, Math.round(waitMs))) : 0;
        let command;
        try {
          command = await native.nextCommand(clamped);
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: errorText(error) });
          return;
        }
        if (command === undefined || command === null) { sendNoContent(res, headers); return; }
        sendJson(res, 200, { id: command.id, command: command.command, params: command.params }, headers);
        return;
      }
      if (route === '/bridge/result' && method === 'POST') {
        let body;
        try { body = await readJson(req); } catch (error) { sendJson(res, 400, { ok: false, reason: '无效的请求体：' + errorText(error) }); return; }
        const rawId = body.id;
        if (rawId === undefined || rawId === null || String(rawId) === '') {
          sendJson(res, 400, { ok: false, reason: 'bridge/result 需要 id' });
          return;
        }
        if (typeof body.ok !== 'boolean') { sendJson(res, 400, { ok: false, reason: 'bridge/result 需要 ok 布尔值' }); return; }
        if (native === undefined || native === null || typeof native.applyResult !== 'function') {
          sendJson(res, 200, { ok: true, ignored: true });
          return;
        }
        if (!bridgeActive()) {
          // Only the mode that hands out commands may settle them: a stale tab
          // left on the native protocol must not resolve commands in classic mode.
          sendJson(res, 200, { ok: true, ignored: true });
          return;
        }
        const outcome = native.applyResult({ id: String(rawId), ok: body.ok === true, value: body.value, reason: body.reason });
        sendJson(res, 200, outcome !== null && outcome !== undefined && outcome.ignored === true ? { ok: true, ignored: true } : { ok: true });
        return;
      }
      if (route === '/bridge/state' && method === 'POST') {
        const body = await readJsonOr400(req, res);
        if (body === undefined) return;
        if (native === undefined || native === null || typeof native.notePageState !== 'function') {
          sendJson(res, 200, { ok: true, ignored: true });
          return;
        }
        if (!bridgeActive()) {
          sendJson(res, 200, { ok: true, ignored: true });
          return;
        }
        native.notePageState({ url: body.url, title: body.title, loading: body.loading });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (route === '/bridge/status' && method === 'GET') {
        let pending = 0;
        try { pending = native !== undefined && native !== null && typeof native.pendingCount === 'function' ? native.pendingCount() : 0; } catch { pending = 0; }
        sendJson(res, 200, { ok: true, mode: bridgeActive() ? 'native' : 'classic', native: nativeSnapshot(), pending });
        return;
      }
      sendJson(res, 404, { ok: false, reason: 'unknown route ' + method + ' ' + route });
    } catch (error) {
      log('route ' + method + ' ' + route + ' failed: ' + (error && error.stack ? error.stack : String(error)));
      if (!res.headersSent) sendJson(res, 500, { ok: false, reason: String(error && error.message ? error.message : error) });
      else res.end();
    }
  };
  return ctx.webServer.register({ kind: 'prefix', path: '/web-browser', handler });
}
