// Offline regression test for the /web-browser request guard (no DSH required).
// Run:  ELECTRON_RUN_AS_NODE=1 <node> dsh-web-browser/test/guard.test.mjs
import { registerBrowserRoutes } from '../lib/routes.js';

let captured;
const fakeCtx = {
  webServer: { register: (route) => { captured = route; return () => {}; } },
  get: () => undefined,
  web: { listProviders: () => ({ search: [{ id: 'browser' }], fetch: [] }) },
};
const state = {
  enabled: true, headless: true, browserPath: '', engineOrder: ['bing'],
  viewport: { width: 1100, height: 820 }, providerId: 'browser', profileDir: '',
};
const fakeEngine = {
  status: () => ({ enabled: true, running: false, viewport: { width: 1100, height: 820, dpr: 1 }, url: 'about:blank', title: '' }),
  ensureStarted: async () => {},
  stop: async () => {},
  latestFrame: async () => Buffer.from('jpeg'),
  setViewOverride: async () => {},
  releaseViewOverride: async () => {},
};
const fakeSettings = {
  get: () => ({ ...state }),
  setEnabled: (enabled) => { state.enabled = enabled; },
  update: (patch) => ({ ...state, ...patch }),
};

registerBrowserRoutes({ ctx: fakeCtx, engine: fakeEngine, settings: fakeSettings, log: () => {} });

function makeReq(method, url, headers, body) {
  return {
    method,
    url,
    headers: headers || {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    },
  };
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

async function call(method, url, headers, body) {
  const res = makeRes();
  await captured.handler(makeReq(method, url, headers, body), res);
  return { status: res.statusCode, body: res.body };
}

const json = { 'content-type': 'application/json' };
const cases = [
  ['cross-site GET is refused', 403, () => call('GET', '/web-browser/state', { 'sec-fetch-site': 'cross-site' })],
  ['same-origin GET is served', 200, () => call('GET', '/web-browser/state', { 'sec-fetch-site': 'same-origin' })],
  ['headerless local script GET is served', 200, () => call('GET', '/web-browser/state', {})],
  ['cross-site form POST is refused', 403, () => call('POST', '/web-browser/toggle', { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, '{"enabled":false}')],
  ['cross-site JSON POST is refused', 403, () => call('POST', '/web-browser/toggle', { 'sec-fetch-site': 'cross-site', ...json }, '{"enabled":false}')],
  ['same-origin non-JSON POST is refused', 403, () => call('POST', '/web-browser/toggle', { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }, '{"enabled":false}')],
  ['same-origin JSON viewport POST is served', 200, () => call('POST', '/web-browser/viewport', { 'sec-fetch-site': 'same-origin', ...json }, '{"width":600,"height":800}')],
  ['cross-site provider POST is refused', 403, () => call('POST', '/web-browser/provider', { 'sec-fetch-site': 'cross-site', ...json }, '{"enabled":true}')],
];

let failed = 0;
for (const [name, expected, run] of cases) {
  const result = await run();
  const ok = result.status === expected;
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + ' | expect ' + expected + ' got ' + result.status + ' | ' + name);
  if (!ok) console.log('   body: ' + result.body.slice(0, 160));
}
console.log(failed === 0 ? 'GUARD TEST OK (' + cases.length + ' cases)' : 'GUARD TEST FAILED: ' + failed);
process.exit(failed === 0 ? 0 : 1);
