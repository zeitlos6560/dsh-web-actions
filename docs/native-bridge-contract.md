# Native view bridge — implementation contract (freeze)

Status: implemented (experimental, DSH Desktop only). The Host half is
`lib/native.js` plus the engine facade in `index.js`; the client half is the
`<webview>` command loop in `client.js`. Both halves implement only this
contract. Do not change `lib/tools.js` action names; the `browser` tool must
behave the same in both modes.

## Settings

`lib/settings.js` defines `engineMode` in its `DEFAULTS`:

```js
engineMode: 'classic'  // 'classic' | 'native' | 'auto'
```

Unknown persisted values normalize to `'classic'`. The client settings page
exposes it in the Advanced card as a select; saving posts
`/settings {patch:{engineMode}}`.

## Host side

### Facade (`createEngineFacade` in `index.js`)

A facade object implements the methods the tool and routes use (`status`,
`available`, `ensureStarted`, `stop`, `navigate`, `read`, `click`, `clickAt`,
`typeText`, `pressKey`, `scroll`, `waitFor`, `evaluate`, `captureJpeg`,
`newTabPage`, `back`, `forward`, `reload`, `refreshTitle`, `latestFrame`,
`searchFrom`, `setViewOverride`, `releaseViewOverride`, `setViewport`,
`applyViewport`, `profileDir`, `clearProfile`, and a `lastActionAt` accessor that
mirrors both engines).

- `engineMode === 'classic'` → call the existing `BrowserEngine`.
- `engineMode === 'native' | 'auto'` and native is usable → call `NativeEngine`.
- Any native call that throws `NativeUnavailableError` → in `auto` mode fall back
  to `BrowserEngine` for that call (remember `degradedReason`, expose it in
  status); in `native` mode return the same graceful error (tool message), do not
  crash.
- `auto` prefers native only when `status().native.available === true` and
  `status().native.tabOpen === true`; otherwise classic.
- Search is never native: `searchFrom` always runs on the classic engine as a
  background tab in the controlled profile's session, so the visible page is not
  navigated (no cookie-less throwaway context: search engines answer that with a
  captcha).
- View/profile helpers stay on the classic engine: it owns the persisted profile
  and the CDP view emulation, while the native engine only records `/viewport`
  values for diagnostics (its `<webview>` fills CSS pixels). `clearProfile()`
  stops both engines and clears the classic profile; the native partition belongs
  to DSH, so the Host cannot delete it. `latestFrame()` prefers the last native
  capture, then the classic frame.

`status()` returns the existing shape plus:

```json
{ "mode": "native" | "classic",
  "degradedReason": "optional string",
  "native": { "available": false, "protocolVersion": 0, "tabOpen": false, "reason": "optional" } }
```

### `lib/native.js`

`NativeEngine` class with the same public method surface as `BrowserEngine`.
Responsibilities: command queue, pending map (id → resolve/reject), per-command
timeout (default 8s; navigate 20s; capture 10s), last known state, last capture
buffer for `latestFrame()`, and presence tracking.

Presence: the client calls `POST /web-browser/bridge/next` for work; the Engine
records `lastPollAt`. `tabOpen` = `Date.now() - lastPollAt < 2000`.

Methods map to commands (same names, params passed through):

| method | command | params |
|---|---|---|
| navigate(url) | `navigate` | `{url}` |
| evaluate(expr) | `evaluate` | `{expression}` |
| read(opts) | `read` | `{mode, selector, maxChars}` |
| click(opts) | `click` | `{selector, text, x, y, button}` |
| clickAt(x,y,button) | `clickAt` | `{x, y, button}` |
| typeText(opts) | `type` | `{text, selector, submit}` |
| pressKey(name) | `key` | `{name}` |
| scroll(dy) | `scroll` | `{dy}` |
| waitFor(opts) | `waitFor` | `{kind, value, timeoutMs}` |
| captureJpeg(quality) | `capture` | `{quality}` |
| newTabPage() | `newtab` | `{}` |
| back/forward/reload | same | `{}` |

`capture` result: `{ data: base64, mimeType?, url, title, width, height }`; Engine
keeps `Buffer.from(data,'base64')` as `latestFrame()` value, remembers the media
type, and updates url/title.

If no client is polling (`tabOpen === false`) or `available === false`, every
command method throws `NativeUnavailableError('...reason')` immediately.

### Routes (`lib/routes.js`, prefix `/web-browser`)

All inherit the existing same-origin + JSON guard.

```
POST /bridge/hello   { protocolVersion, available, reason?, url? } -> { ok, accepted, native }
GET  /bridge/next    ?waitMs=40 -> 200 { id, command, params } | 204 (empty)
POST /bridge/result  { id, ok, value?, reason? } -> { ok, ignored? }
POST /bridge/state   { url?, title?, loading? } -> { ok, ignored? }
GET  /bridge/status  -> { ok, mode, native, pending }
```

- `/bridge/hello` requires a numeric `protocolVersion` and boolean `available`
  (400 otherwise). It records availability and presence, adopts the page `url`
  the client mounted, and answers `accepted:false` when the native engine is not
  wired.
- `/bridge/next` returns 204 when idle; it never blocks longer than `waitMs`
  (clamp 0–1000), and every poll is a presence heartbeat. The
  `x-web-browser-native` header carries `off` when native is not the active mode
  (the client stops polling), `on` while commands may be delivered, and
  `register` when native mode is active but the Host has no capability report
  yet (a plugin reload): the mounted view re-posts `/bridge/hello` and keeps
  polling instead of falling back to the frame view.
- `/bridge/result` resolves the pending command, ignores unknown ids with
  `{ok:true, ignored:true}`, and answers 400 for a missing `id` or a non-boolean
  `ok`. While the bridge is inactive (classic mode) every result is ignored the
  same way, so a stale client cannot settle commands it was never handed.
- `/bridge/status` reports `{ ok, mode, native, pending }`; `pending` is the
  queued/in-flight command count. There is no `fps` field.
- `/bridge/state` reports guest-driven navigation (link click, redirect, a
  `target=_blank` popup that the client redirects into the same view). The Host
  mirrors `url`/`title`/`loading` and drops the cached frame; the route is
  ignored in classic mode and the client throttles it to ~200 ms.
- `target=_blank` links: the `<webview>` carries `allowpopups`, and the client
  cancels the popup and loads its URL in the same view, so a link click behaves
  like a normal browser tab instead of silently doing nothing.

## Client side (`client.js`)

1. Detect once per mount: `globalThis.dshDesktop?.browser` with
   `protocolVersion === 1` and `acquire`/`release` functions. If absent → mark
   unavailable and keep the existing polling frame view.
2. If available, `settings.engineMode !== 'classic'`, and the master switch is
   on, acquire a lease (`bridge.acquire(workspaceKey)` with a 2s timeout;
   workspace key may fall back to a fixed string `'dsh-web-browser'`), create
   `<webview name=lease partition=... src=about:blank#lease>`, and fill the stage
   container. The tab registration uses `keepMounted: desktopBridge.ok === true`
   so the guest survives tab switches. Release on unmount/rebuild; a mount that
   never reports `dom-ready` within 8 s fails back to the frame view. A guest that
   starts on `about:blank` is navigated to the shared start page
   (`https://www.bing.com/`).
3. Post `POST /bridge/hello { protocolVersion:1, available:true, url }` once;
   then poll `GET /bridge/next` in a loop (40ms right after a command, 200ms
   while idle). Execute one command at a time, then `POST /bridge/result`. Stop
   when `hello` answers `accepted:false` or `/bridge/next` stops sending
   `x-web-browser-native: on`.
4. Command handlers: navigate (loadURL + wait for `did-navigate`/`dom-ready`/
   `did-stop-loading` up to 15s), evaluate/read (executeJavaScript; read uses the
   same extraction scripts as the CDP engine), click/clickAt (sendInputEvent
   mouse), type (sendInputEvent char events; if unsupported, focus via
   executeJavaScript then dispatch an `input` event fallback), key
   (keyDown/char/keyUp), scroll (mouseWheel), waitFor (client-side polling using
   executeJavaScript), capture (`capturePage()` → JPEG base64 via `toJPEG`, or a
   PNG data URL fallback → `{data, mimeType, url, title, width, height}`),
   newtab (loadURL start page), back/forward/reload (webview methods). Each
   command runs under a client-side deadline (9s default, 16s navigate, 14s
   capture) so one stuck command cannot stall the loop.
5. View: when native mode is active and the webview is mounted, the stage shows
   the live webview instead of the polled `<img>`; the address bar, back/forward/
   reload buttons keep working by calling the same routes (Host delegates).
   If anything native fails, fall back to the existing frame view and show the
   reason in the status line.
6. Never throw from the bridge loop; a failed command posts `ok:false` with a
   reason. `/frame` keeps returning 503 until the first native capture arrives;
   the mounted webview is the live visual, so the frame poll is disabled while
   native is ready.

## Tests (offline, no DSH)

`test/native-bridge.test.mjs`: drive the real route handlers with fake
req/res and the real `NativeEngine` to prove:
- `/bridge/hello` records availability, and a protocol mismatch is reported as
  unavailable;
- bad hello/result bodies answer 400;
- in classic mode `/bridge/next` answers 204 with `x-web-browser-native: off` and
  results are ignored;
- `/bridge/next` returns a queued command then 204;
- `/bridge/result` resolves the pending command and mirrors url/title; unknown
  ids are ignored;
- the same-origin guard still rejects cross-site requests;
- `stop()` rejects pending commands instead of leaving them to hang.

## Non-goals

Do not modify `lib/tools.js`, `lib/search.js`, `lib/cdp.js`, the guard, or the
security switches. Do not install/uninstall the plugin from a subagent.
