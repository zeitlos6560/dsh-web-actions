# Client ↔ Host contract (Web actions bundle)

The Host half is `index.js` + `lib/` (tool, routes, classic CDP engine, native
bridge engine, settings, search provider). The Client half is `client.js` (single
file, `window.__ModuleLoader__.load` format). The two halves talk only through the
same-origin HTTP routes below. This file replaces the earlier `CONTRACT.md` and
`CONTRACT-VIEWPORT.md`.

## API base

Same-origin `fetch` against `/web-browser/...`.

### Security guard (all routes)

- A request carrying a cross-site `Sec-Fetch-Site` value is refused with `403`.
- POST bodies must be `application/json` (a cross-site form or `no-cors` fetch
  cannot satisfy this), otherwise `403`.
- Requests without the header (local scripts) are allowed, matching the local
  Host API trust level. Covered by `test/guard.test.mjs`.
- The native bridge routes `/web-browser/bridge/*` inherit this guard; they add
  no second auth model.

### GET /web-browser/state

```json
{
  "settings": {
    "enabled": true, "headless": true, "engineMode": "classic",
    "browserPath": "", "profileDir": "",
    "engineOrder": ["baidu", "bing", "duckduckgo"],
    "viewport": { "width": 1100, "height": 820 },
    "providerId": "browser",
    "blockPrivateAddresses": true, "allowEval": false, "clearProfileOnDisable": false
  },
  "engine": {
    "enabled": true, "running": true, "executable": "C:\\...\\msedge.exe",
    "executableFound": true,
    "viewport": { "width": 1100, "height": 820, "dpr": 1.5 },
    "headless": true, "url": "https://...", "title": "...", "loading": false,
    "frameSeq": 12, "frameAt": 1712345678901, "lastActionAt": 1712345678901,
    "engines": ["baidu", "bing", "duckduckgo"],
    "mode": "classic",
    "degradedReason": "optional: why auto fell back last time",
    "native": { "available": false, "protocolVersion": 0, "tabOpen": false, "reason": "optional" }
  },
  "provider": {
    "id": "browser", "configured": "browser", "active": true,
    "switchable": true, "registered": ["deepseek-search-api", "browser"]
  }
}
```

- `settings.engineMode` is `classic` | `native` | `auto`; unknown persisted values
  normalize to `classic` (`lib/settings.js`). Classic runs a standalone Chromium
  process, native embeds the page in the Desktop sidebar, and `auto` prefers
  native only while the native view is available and polling.
- `engine.mode` says which engine actually answered `status()`: `native` when
  native is active (`engineMode: native`, or `auto` with a usable view), else
  `classic`.
- `engine.native` is the bridge snapshot: `available` is what `/bridge/hello`
  last reported, `protocolVersion` is the client's declared version (1 is
  supported), `tabOpen` is true while a `/bridge/next` poll happened within the
  2 s presence window, and `reason` explains an unavailable bridge.
- `engine.degradedReason` is the last reason `auto` fell back to classic for one
  call; absent when native last succeeded.
- `engine.viewport` is the *effective* viewport: the transient sidebar override
  when one is set, otherwise `settings.viewport`. `engine.viewport.dpr` is the
  panel's device-pixel ratio (1–3). In native mode the `<webview>` fills CSS
  pixels, so this value is diagnostic.
- `engine.lastActionAt` moves whenever the model drives the page; the composer
  switch watches it to reveal the live view (see Surfaces).
- `engine.running`: classic — the CDP connection is alive; native — the bridge is
  available and its view is polling.
- A plain `GET /state` never carries `error`; a failed start is reported as
  `error` on the `/toggle` response, which clients also keep as their state
  snapshot.

### POST /web-browser/toggle

Body `{ "enabled": true|false }` → the state payload (plus optional `error` when
a start fails, and `profileCleared: { cleared, dir, reason? }` when turning off
with `clearProfileOnDisable`). Enabling starts the active engine (a classic
launch can take a few seconds; native needs its sidebar view mounted and polling
first). Turning it off stops both engines and, when `clearProfileOnDisable` is
set, deletes the profile.

### GET /web-browser/frame

JPEG bytes of the most recent page frame (PNG when a native capture fell back to
a PNG data URL); HTTP 503 (`no frame yet`) while none exists. Frames are captured
on demand, not streamed: classic uses `Page.captureScreenshot` at the emulated
CSS size × device scale factor, native reuses the last client `capturePage()`
result (so `/frame` 503s in native mode until the first native capture arrives).
The view polls this route while it is visible, the engine is running, and native
is not covering the stage (about 2.5 fps, i.e. every 400 ms), and preloads a
frame before swapping.

### POST /web-browser/viewport

Body `{ "width", "height", "dpr" }` (sidebar stage CSS size, dpr 1–3) or
`{ "release": true }`. The override is transient: never persisted, never written
to `settings.viewport`. Classic applies it with
`Emulation.setDeviceMetricsOverride` (`deviceScaleFactor = dpr`) and invalidates
the cached frame, so frames then match CSS × dpr. Native has no CDP viewport
emulation: it records the same values for diagnostics only (the `<webview>` fills
CSS pixels), while the classic engine still receives the override. Calls while
the engine is stopped only record the override. 400 when `width`/`height` are not
finite numbers. Clamped to `[320,1920] × [240,1600]` and `dpr [1,3]`, with a frame
cap of 3840×2560.

### POST /web-browser/navigate, /nav, /input

- `/navigate` `{ url }` → `{ ok, url, title, engine }`; 400 when `url` is missing
  or not a string, and 500 with `{ ok:false, reason }` for an invalid URL, a
  blocked host, or a failed launch. `blockPrivateAddresses` refuses
  loopback/private/link-local hosts lexically on the URL host (page-initiated
  navigation is not intercepted); `edge://newtab` opens the start page
  (`https://www.bing.com/`).
- `/nav` `{ action: "back"|"forward"|"reload" }` → `{ ok, engine }`; 400 for an
  unknown action. Back/forward/reload are dispatched through the engine facade's
  `back`/`forward`/`reload` (native executes them in the `<webview>` history).
- `/input`:
  - `{ type: "click", x, y, button? }` — page CSS pixels; `x`/`y` must be finite
    numbers;
  - `{ type: "wheel", dy }` — finite number;
  - `{ type: "text", text }`;
  - `{ type: "key", key }` (Enter, Tab, Escape, Backspace, Delete, arrows, Home,
    End, PageUp/Down, Space).

  A malformed body or an unknown `type` answers 400 `{ ok:false, reason }`.

### GET/POST /web-browser/settings

GET → `{ ok, settings }`. POST `{ patch: {...} }` (a bare body is also accepted as
the patch) → `{ ok, settings }`, plus `ok:false` with `reason` when a start
triggered by the patch fails and `profileCleared` when the patch turns the
switch off with `clearProfileOnDisable`: the patch is normalized and persisted
(see Settings storage), the effective viewport is re-applied when the engine
runs, and flipping `enabled` applies the same start/stop/profile-clearing side
effects as `/toggle`.

### POST /web-browser/provider

Body `{ enabled: true|false }` → `{ ok:true, configured }` or `{ ok:false, reason }`.
Turns this plugin's provider into (or out of) `web.searchProvider`.

### Native bridge routes

Used by the sidebar view's Desktop `<webview>` loop. All inherit the same guard,
never throw for a bad body, and answer 4xx JSON with a reason instead.

```
POST /web-browser/bridge/hello
  { protocolVersion, available, reason?, url? } -> { ok, accepted, native }
GET  /web-browser/bridge/next?waitMs=<0..1000>
  -> 200 { id, command, params } | 204 (no command)
POST /web-browser/bridge/result
  { id, ok, value?, reason? } -> { ok, ignored? }
POST /web-browser/bridge/state
  { url?, title?, loading? } -> { ok, ignored? }
GET  /web-browser/bridge/status
  -> { ok, mode, native, pending }
```

- `/bridge/hello` requires a numeric `protocolVersion` and a boolean `available`
  (400 otherwise). It records availability and presence, adopts the page `url`
  the client mounted, and replies with `accepted: false` when the native engine
  is not wired.
- `/bridge/next` waits at most `waitMs` (clamped 0–1000), answers
  `{ id, command, params }` or 204, and always sends `x-web-browser-native`
  with one of three values: `on` (native mode, commands may follow), `off`
  (classic mode: stop polling) or `register` (native mode but the Host has no
  capability report yet, e.g. after a plugin reload: the mounted view should
  `POST /bridge/hello` again and keep polling instead of falling back).
  Every poll is a presence heartbeat (`tabOpen` stays true for 2 s after the last
  one).
- `/bridge/result` resolves one pending command; unknown ids (a slow client after
  a timeout) answer `{ ok:true, ignored:true }`, and every result is ignored the
  same way while the bridge is inactive (classic mode). A missing `id` or a
  non-boolean `ok` answers 400.
- `/bridge/state` records page identity after guest-driven navigation (a link
  click, a redirect, a popup opened in place). It updates `engine.url/title/
  loading`, drops the cached frame, and is ignored in classic mode. The client
  throttles it to ~200 ms while the view navigates.
- `/bridge/status` reports `{ ok, mode: "native"|"classic", native, pending }`,
  where `pending` is the number of queued/in-flight commands; there is no `fps`
  field.
- Command set: `navigate`, `newtab`, `back`, `forward`, `reload`, `evaluate`,
  `read`, `click`, `clickAt`, `type`, `key`, `scroll`, `waitFor`, `capture`.
  Host-side deadlines: 8 s default, 20 s navigate, 10 s capture.

## Settings storage

Settings are not a DSH Config entry. They live in
`~/.dsh/web-browser/settings.json`, are read synchronously at activation, and are
written atomically (temp file + rename) on every change. `normalizeSettings()`
coerces unknown data onto the known shape — an unrecognized `engineMode` falls
back to `classic`, loose `true`/`false` spellings are accepted — while preserving
unknown persisted keys. Defaults: `enabled: true`, `headless: true`,
`engineMode: "classic"`, `engineOrder: ["baidu", "bing", "duckduckgo"]`,
`viewport: { width: 1100, height: 820 }`, `blockPrivateAddresses: true`,
`allowEval: false`, `clearProfileOnDisable: false`.

## Surfaces

1. **Composer master switch** (`conversation.input.left`, id `web-browser`,
   order 5): one compact control, no panel. Polls `/state` every 3 s, POSTs
   `/toggle` on click. It only switches the feature on/off; toggling never opens
   the sidebar view. The view is revealed when the poll first observes a model
   `lastActionAt` that is recent (within 15 s) and on later increases, throttled
   to one reveal per 15 s. The user can also open it from the tab.

2. **Settings section** (`settings.section` + `settings.section.icon`, same id,
   order 70). Cards: browser (master switch, status, executable path or native
   connection state, default viewport), security (block private addresses, allow
   eval, clear profile on disable), web search (provider takeover/restore),
   advanced (`<details>`: engine mode, headless, search-engine order, profile
   directory), view (hint + save/discard). Save POSTs `/settings`; feedback shows
   saved, restart-needed, or "engine mode applies the next time the view opens",
   plus failures.

3. **Right sidebar view** — tab type `web-browser` via
   `ctx.sidebarRightTabs.register` (id `dsh-web-actions`, `keepMounted`
   when the Desktop bridge is detected), body in `sidebar.right.pane.tab` with
   `key: <id>`, title in `sidebar.right.pane.tab.title`. Address bar, back/
   forward/reload, live frame image, click/wheel/keyboard forwarding, and a
   `ResizeObserver` that reports the stage size to `/viewport` (180 ms debounce,
   ≥4 px or ≥0.02 dpr change; `release` on unmount). With `engineMode`
   `native`/`auto` on Desktop, the body mounts the `<webview>` for an acquired
   lease and runs the `/bridge/*` command loop instead of (or on top of) the frame
   image; any native failure falls back to the polled frame view with a reason
   line.

## Rules

- Single file; React via `require('react')`; no JSX; no imports of
  `@deepseek-ai/*`; inline SVG icons; styles through a rendered `<style>` using
  `--dsw-alias-*`, `--dsw-radius-*`, `--dsw-focus-ring-*`; all copy through
  `ctx.locale.register(NS, …)` with `zh` and `en` dictionaries (parity checked by
  `test/security.test.mjs`).
- Every registration goes through `ctx.effect`; polling/subscriptions clear on
  unmount.
- Host: ESM, Node builtins only; routes never throw for a bad body (400/500 JSON
  with a reason).
- The `browser` tool (16 actions, `providers` included) and the routes share the
  same engine facade, so a tool action behaves the same in both engine modes.
