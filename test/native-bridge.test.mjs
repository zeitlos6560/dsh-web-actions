// Offline regression test for the native-view bridge routes (/web-browser/bridge/*).
// Drives the real route handler with fake req/res and the real NativeEngine.
// Run:  ELECTRON_RUN_AS_NODE=1 <node> dsh-web-browser/test/native-bridge.test.mjs
import { Readable } from 'node:stream';
import { NativeEngine } from '../lib/native.js';
import { registerBrowserRoutes } from '../lib/routes.js';

let failed = 0;
let total = 0;
function check(name, actual, expected) {
  total += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)));
}

// --- harness ---------------------------------------------------------------
const settingsState = {
  enabled: true,
  headless: true,
  engineMode: 'classic',
  engineOrder: ['bing'],
  viewport: { width: 1100, height: 820 },
  blockPrivateAddresses: true,
};
const settings = { get: () => ({ ...settingsState }) };
const native = new NativeEngine({
  settings: () => settingsState,
  classic: { status: () => ({}) },
  log: () => {},
});

let captured;
const fakeCtx = {
  webServer: { register: (route) => { captured = route; return () => {}; } },
  get: () => undefined,
  web: { listProviders: () => ({ search: [], fetch: [] }) },
};
registerBrowserRoutes({ ctx: fakeCtx, engine: native, settings, log: () => {}, native });

function makeReq(method, path, options) {
  const opts = options || {};
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body), 'utf8')]);
  req.method = method;
  req.url = path;
  req.headers = opts.headers || {};
  return req;
}
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; this.headersSent = true; },
    end(chunk) { if (chunk !== undefined && chunk !== null) this.body += chunk.toString(); },
  };
}
async function call(method, path, options) {
  const res = makeRes();
  await captured.handler(makeReq(method, path, options), res);
  let json;
  try { json = res.body === '' ? undefined : JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, headers: res.headers, body: res.body, json };
}

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const JSON_POST = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const CROSS_SITE_POST = { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' };
const hello = (body) => call('POST', '/web-browser/bridge/hello', { body, headers: JSON_POST });
const next = (suffix) => call('GET', '/web-browser/bridge/next' + (suffix || ''), { headers: SAME_ORIGIN });
const statusOf = () => call('GET', '/web-browser/bridge/status', { headers: SAME_ORIGIN });
const postResult = (body) => call('POST', '/web-browser/bridge/result', { body, headers: JSON_POST });

let queued;
let commandId;
let held;
let heldSettled = false;
let heldRejected = false;

try {
  // 0. Native mode with no capability report yet: the Host asks a mounted view
  //    to say hello again instead of letting it fall back to the frame view. --
  settingsState.engineMode = 'native';
  const preHello = await next();
  check('native mode before hello: 204', preHello.status, 204);
  check('native mode before hello: register header', preHello.headers['x-web-browser-native'], 'register');

  // 1. A successful hello records availability and the protocol version. ----
  const first = await hello({ protocolVersion: 1, available: true, url: 'https://example.com/' });
  check('hello: 200', first.status, 200);
  check('hello: accepted', first.json && first.json.accepted, true);
  check('hello: native.available true', first.json && first.json.native && first.json.native.available, true);
  check('hello: native.protocolVersion 1', first.json && first.json.native && first.json.native.protocolVersion, 1);
  check('hello: native.available() true', native.available(), true);

  // 2. A protocol mismatch reports native unavailable with a protocol reason.
  //    (A bare { protocolVersion: 2 } body is a 400 because `available` is
  //    required; the mismatch path needs available:true.)
  const badProtocol = await hello({ protocolVersion: 2, available: true });
  check('protocol 2 hello: 200', badProtocol.status, 200);
  check('protocol 2 hello: native.available false', badProtocol.json && badProtocol.json.native && badProtocol.json.native.available, false);
  check(
    'protocol 2 hello: reason mentions the protocol',
    /协议|protocol/i.test(String(badProtocol.json && badProtocol.json.native && badProtocol.json.native.reason)),
    true,
  );
  check('protocol 2 hello: native.available() false', native.available(), false);

  // 3. Bad hello bodies are rejected before they touch native state. --------
  check('hello without protocolVersion: 400', (await hello({ available: true })).status, 400);
  check('hello with non-boolean available: 400', (await hello({ protocolVersion: 1, available: 'yes' })).status, 400);
  check('hello with numeric available: 400', (await hello({ protocolVersion: 1, available: 1 })).status, 400);

  // 4. Classic mode: /bridge/next tells the client to stop polling. ---------
  settingsState.engineMode = 'classic';
  const classicNext = await next();
  check('classic /bridge/next: 204', classicNext.status, 204);
  check('classic /bridge/next: header off', classicNext.headers['x-web-browser-native'], 'off');
  check('classic /bridge/next: empty body', classicNext.body, '');
  const classicStatus = await statusOf();
  check('classic /bridge/status: 200', classicStatus.status, 200);
  check('classic /bridge/status: ok', classicStatus.json && classicStatus.json.ok, true);
  check('classic /bridge/status: mode classic', classicStatus.json && classicStatus.json.mode, 'classic');
  check('classic /bridge/status: pending 0', classicStatus.json && classicStatus.json.pending, 0);
  check('classic /bridge/status: native is a snapshot object', classicStatus.json && typeof classicStatus.json.native, 'object');
  check('classic /bridge/status: native unavailable', classicStatus.json && classicStatus.json.native && classicStatus.json.native.available, false);

  // 5. Native mode hands out one queued command, then reports idle. ---------
  settingsState.engineMode = 'native';
  const nativeHello = await hello({ protocolVersion: 1, available: true, url: 'https://example.com/' });
  check('native mode hello: accepted', nativeHello.json && nativeHello.json.accepted, true);
  queued = native.queueCommand('navigate', { url: 'https://example.com/' }, 2000);
  queued.catch(() => {});
  const dispatched = await next();
  check('native /bridge/next: 200', dispatched.status, 200);
  check('native /bridge/next: header on', dispatched.headers['x-web-browser-native'], 'on');
  commandId = dispatched.json && dispatched.json.id;
  check('native /bridge/next: id present', typeof commandId === 'string' && commandId !== '', true);
  check('native /bridge/next: command', dispatched.json && dispatched.json.command, 'navigate');
  check('native /bridge/next: params', dispatched.json && dispatched.json.params, { url: 'https://example.com/' });
  const idle = await next('?waitMs=0');
  check('native /bridge/next idle: 204', idle.status, 204);
  check('native /bridge/next idle: header on', idle.headers['x-web-browser-native'], 'on');
  check('native /bridge/next idle: empty body', idle.body, '');

  // 6. A result resolves the queued command and mirrors page state. ---------
  const settled = await postResult({ id: commandId, ok: true, value: { url: 'https://example.com/', title: 'Example' } });
  check('result: 200', settled.status, 200);
  check('result: ok true', settled.json && settled.json.ok, true);
  check('result: not ignored', settled.json && settled.json.ignored, undefined);
  const value = await queued;
  check('queued promise resolves with the posted value', value, { url: 'https://example.com/', title: 'Example' });
  check('native.status().url mirrors the result', native.status().url, 'https://example.com/');
  check('native.status().title mirrors the result', native.status().title, 'Example');

  // 6b. Guest-driven navigation (link click, redirect) reaches the Host without
  //     a command queue entry, and invalidates the cached frame. -------------
  native.frameAt = 12345;
  native.frameBuffer = Buffer.from('stale');
  const reported = await call('POST', '/web-browser/bridge/state', {
    body: { url: 'https://example.org/next', title: 'Next page', loading: false },
    headers: JSON_POST,
  });
  check('bridge/state: 200', reported.status, 200);
  check('bridge/state: ok', reported.json && reported.json.ok, true);
  check('bridge/state: url mirrored', native.status().url, 'https://example.org/next');
  check('bridge/state: title mirrored', native.status().title, 'Next page');
  check('bridge/state: cached frame dropped', native.status().frameAt, 0);
  check('bridge/state: latestFrame is undefined again', await native.latestFrame(), undefined);
  settingsState.engineMode = 'classic';
  const ignoredState = await call('POST', '/web-browser/bridge/state', {
    body: { url: 'https://ignored.example/' },
    headers: JSON_POST,
  });
  check('classic bridge/state: ignored', ignoredState.json && ignoredState.json.ignored, true);
  check('classic bridge/state: url unchanged', native.status().url, 'https://example.org/next');
  settingsState.engineMode = 'native';

  // 7. Unknown ids are ignored; malformed results are 400. ------------------
  const unknown = await postResult({ id: 'c999', ok: true });
  check('unknown result id: 200', unknown.status, 200);
  check('unknown result id: ok true', unknown.json && unknown.json.ok, true);
  check('unknown result id: ignored true', unknown.json && unknown.json.ignored, true);
  check('result without id: 400', (await postResult({ ok: true })).status, 400);
  check('result with non-boolean ok: 400', (await postResult({ id: 'c999', ok: 'yes' })).status, 400);
  check('malformed results leave the queue empty', native.pendingCount(), 0);

  // 8. A result posted after switching back to classic is ignored and the
  //    command stays pending instead of settling in the wrong mode. ---------
  await hello({ protocolVersion: 1, available: true });
  held = native.queueCommand('evaluate', { expression: '1 + 1' }, 5000);
  held.catch(() => {});
  held.then(() => { heldSettled = true; }, () => { heldSettled = true; heldRejected = true; });
  const heldId = [...native.pending.keys()][0];
  check('one command pending before the mode switch', native.pendingCount(), 1);
  settingsState.engineMode = 'classic';
  const ignored = await postResult({ id: heldId, ok: true, value: 2 });
  check('classic-mode result: 200', ignored.status, 200);
  check('classic-mode result: ignored true', ignored.json && ignored.json.ignored, true);
  check('ignored result keeps the command pending', native.pendingCount(), 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('ignored result does not settle the command', heldSettled, false);

  // 9. The same-origin guard covers the bridge routes too. ------------------
  const crossHello = await call('POST', '/web-browser/bridge/hello', {
    body: { protocolVersion: 1, available: true },
    headers: CROSS_SITE_POST,
  });
  check('cross-site /bridge/hello: 403', crossHello.status, 403);
  const crossResult = await call('POST', '/web-browser/bridge/result', {
    body: { id: heldId, ok: true, value: 2 },
    headers: CROSS_SITE_POST,
  });
  check('cross-site /bridge/result: 403', crossResult.status, 403);
  check('cross-site hello left native state untouched', native.available(), true);
  check('cross-site result left the command pending', native.pendingCount(), 1);
} finally {
  // Never leave timers or queued commands behind: node must exit on its own.
  await native.stop();
}

check('stop clears pending commands', native.pendingCount(), 0);
await new Promise((resolve) => setTimeout(resolve, 10));
check('stopped command is rejected instead of hanging', heldRejected, true);

console.log(failed === 0 ? 'NATIVE BRIDGE TEST OK (' + String(total) + ' checks)' : 'NATIVE BRIDGE TEST FAILED: ' + failed);
process.exit(failed === 0 ? 0 : 1);
