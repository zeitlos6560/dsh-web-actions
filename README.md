# Web actions

**dsh-web-actions** — dsh可操作的web浏览器

A DSH bundle that gives the agent a **real Chromium browser** to operate, shows
that browser live in the **right sidebar**, and can run web search **through the
browser** instead of the DeepSeek Search API.

Built and verified against DeepSeek Harness 0.2.2-rc.3 (desktop and web
profiles). It is a *bundle*: a package whose `cordis.patch.yml` inserts the
`web-browser` plugin row into the profile.

## Install

DSH links the directory it installs from, so the repository is the package
itself, not a copy of it: `git pull` changes what DSH loads, and a restart picks
up the new module generation.

1. Clone the repository somewhere stable:

   ```sh
   git clone https://github.com/zeitlos6560/dsh-web-actions.git
   ```

2. In DSH open **Plugins** → **Add plugin** and select the cloned directory (the
   one holding this `package.json`). The bundle inserts the `web-browser` row;
   enable that row if your profile leaves it disabled. The package itself is
   named `dsh-web-actions` — the repository keeps its original name.

3. If the new rows do not appear in the same session, restart DSH once. The
   「Web actions」 switch then sits at the left of the composer tool row,
   **Settings → Web actions** has its page, and the right sidebar offers a
   `web-browser` tab.

There is no `npm install` step and no build step: the bundle depends only on the
Node.js runtime and the DSH packages that DSH provides.

## What it adds

- **`browser` tool** — one tool with an `action` switch (16 actions):
  `open`, `state`, `read` (text / links / html, 20k chars by default), `click`
  (selector, visible text, or coordinates), `type`, `press`, `scroll`, `wait`,
  `act` (batch of up to 24 input steps), `screenshot`, `eval`, `back`, `forward`,
  `reload`, `close`, and `providers` (registered/configured search providers).
  Rendered pages, JavaScript sites, and logged-in sessions work because a real
  browser does the work.
- **Browser-backed web search** — the plugin registers a `web` search provider
  (id `browser`). When it is the configured `web.searchProvider`, `web_search`
  drives the browser to Baidu → Bing → DuckDuckGo (configurable order) and reads
  the rendered result list. No search-API key or quota is used. Each search opens
  a background tab in the controlled profile's own session (a cookie-less
  throwaway context is answered with a captcha), asks for the regional Bing host
  (`cn.bing.com`, whose plain `www` host serves headless Chromium unrelated
  pages), and presents this machine's real desktop User-Agent with
  `navigator.webdriver` masked. When every engine comes back empty the error names
  each engine's reason (captcha, unrelated results, no list).
- **Composer master switch** — a compact 「Web 操作」 toggle at the left of the
  composer tool row. It only turns the feature on or off: off means the engine is
  stopped (with `clearProfileOnDisable`, its profile is deleted), the search
  provider reports unavailable, and `browser` actions refuse. Toggling it does
  **not** open the sidebar view; the view opens when the composer observes the
  model actually driving the page (`engine.lastActionAt`, throttled to once per
  15 s).
- **Settings → Web 操作** — browser card (master switch, status, executable path,
  default viewport), security card (private-address block, eval opt-in, clear
  profile on disable), web search card (takeover/restore), an **Advanced** section
  (engine mode, headless, engine order, profile directory), and save/discard.
- **Fast interaction for games and forms** — `screenshot` returns the page as an
  image in the same tool result (when the calling model accepts images), and
  `act` runs up to 24 input steps (click, clickText, key, type, scroll,
  navigate, wait) in one call, so one model turn can observe and act instead of
  spending a turn per click. Clicks settle adaptively (~240 ms once the page
  reacts) instead of paying a fixed delay per click.
- **Right sidebar view** — a `web-browser` tab showing the controlled page. In
  classic mode the panel polls on-demand JPEG captures (about 2.5 fps, at the
  panel's CSS size × device-pixel ratio); in native mode it mounts the live
  embedded page. Both have an address bar, back/forward/reload, click and
  keyboard forwarding, so you can watch the agent, log in by hand, or take over.
  In native mode a link click navigates the embedded page itself (a
  `target=_blank` link opens in the same view instead of a denied popup) and the
  address bar follows that navigation. It opens automatically when the model
  operates the web: a fresh `engine.lastActionAt` reveals it, at most once every
  15 s. The page viewport
  follows the panel (size and device-pixel ratio), so a panel pixel is a page
  pixel and clicks land where you click. A fresh browser opens **Bing**
  (`https://www.bing.com/`) as its start page in both engine modes
  (`edge://newtab` maps to the same start page).
- **Native engine (experimental, Desktop)** — Settings → Advanced → Engine mode:
  `classic` (standalone Edge/Chrome process), `native` (embed the page directly in
  the DSH sidebar through the desktop `<webview>` bridge), or `auto` (prefer
  native while its view is mounted, fall back to classic per call). In native mode
  the settings page shows the engine and the native connection state instead of an
  executable path, because no separate browser process runs. The bridge is
  protocol version 1: the Host queues commands (`lib/native.js`) and the sidebar's
  `<webview>` loop in `client.js` executes them. Native commands are delivered
  only while the sidebar view is mounted and polling (presence window 2 s);
  otherwise `auto` falls back to classic per call and `native` fails with a
  normal tool error.

## Requirements

- A Chromium-family browser installed: Edge, Chrome, Brave, or Chromium. On
  Windows, Edge is detected automatically; the settings page can point at a
  specific `chrome.exe`/`msedge.exe`.
- The classic engine starts the browser headless with its own user-data directory
  under `~/.dsh/web-browser/profile`, so site logins persist between runs; native
  mode uses a DSH-owned `<webview>` partition instead.
- Settings are plain JSON in `~/.dsh/web-browser/settings.json` (written
  atomically): master switch, engine mode/order, viewport, and the security
  switches. They are not a DSH Config entry; unknown or old persisted values fall
  back to the defaults.
- Turning the switch off stops the engine and restores nothing else; the
  DeepSeek Search API provider stays registered and selectable at any time.

## Limitations

- In classic mode the engine is a separate browser process driven over the
  DevTools protocol and shown in DSH as captured frames. Native mode
  (experimental, Desktop) embeds the page in the sidebar through the desktop
  `<webview>` bridge. Frames are captured on demand (`Page.captureScreenshot` at
  the panel's CSS size × device-pixel ratio), not streamed: cheap enough to leave
  open while the agent works.
- A page still has to settle before a click lands: `click` re-reads the element
  once and verifies something is at that point, which costs ~50–170 ms.
- Screenshots are kept as the newest 20 files under `~/.dsh/web-browser/shots`.
- In classic mode, only one controlled page is operated at a time. A click that
  opens a new tab is followed automatically; popups that never load a page are
  ignored.
- Pages that refuse automation (bot checks, captchas) still fail; the search
  provider then falls through to the next engine.
- `eval` runs arbitrary page JavaScript and is intended for the agent's own
  diagnostics.
- Removing the plugin stops the browser through its teardown; a leftover
  controlled browser is reused (not duplicated) on the next start.

## Security notes

- **The `/web-browser/*` routes are state-changing** (navigate, click, type,
  toggle, search-provider rewrite) and are therefore guarded: a request whose
  `Sec-Fetch-Site` says it comes from another site is refused (403), and every
  POST must be `application/json`, which a cross-site form or `no-cors` fetch
  cannot satisfy. Requests without that header (local scripts, curl) are allowed,
  matching the trust level of the rest of the local Host API. The native
  `/bridge/*` routes inherit the same guard. The guard is covered by
  `test/guard.test.mjs` (run it with the Host's Node).
- **Three security switches** live in Settings → Web actions → Security:
  - `blockPrivateAddresses` (on by default): `open` refuses loopback, private,
    link-local and local-only hostnames, so the controlled browser cannot be
    steered at the machine's own services. The check is lexical on the URL host in
    the tool/route path: page-initiated navigation (clicking a link, JS redirects)
    is not intercepted, and DNS names that resolve to private addresses are not
    resolved.
  - `allowEval` (off by default): the `browser` tool's `eval` action is refused
    until this is enabled, so page JavaScript needs a deliberate opt-in.
  - `clearProfileOnDisable` (off by default): turning the master switch off also
    deletes the classic browser profile — cookies, logins and cache. Every
    switch-off then loses sessions stored in that profile. The native view's
    partition belongs to DSH and is not deleted.
- The listener is loopback-only (`127.0.0.1`); CORS headers are never sent, so
  another origin cannot read `/state` or `/frame` contents.
- The controlled browser is launched with the default Chromium sandbox,
  extensions disabled, audio muted, and a random loopback DevTools port. That
  DevTools endpoint has no authentication, so any process already running as
  this user can drive the browser — the same trust boundary as the rest of the
  user's desktop applications.
- The browser profile under `~/.dsh/web-browser/profile` keeps site logins and
  cookies (it grows with use); screenshots land in `~/.dsh/web-browser/shots`.
  Both stay in the user's home directory. The Advanced section accepts a custom
  profile directory instead.
- Offline regression tests live in `test/`: `guard.test.mjs` (route guard),
  `security.test.mjs` (private-address rules, defaults, locale parity),
  `native-bridge.test.mjs` (bridge routes, command queue, ignore/stop behavior),
  `settings.test.mjs` (settings normalization, defaults, engine-mode fallback)
  and `search.test.mjs` (desktop User-Agent, engine hosts, provider fallback).
  Run them with the Host's Node.
- Page content read through this tool is **untrusted data**: a page can try to
  steer the agent with prompt-injection text. With `blockPrivateAddresses` off,
  `open`/`navigate` will reach loopback and private addresses, so treat that
  capability with the same care as shell access.
- Web search queries leave the machine through the public search engine that
  served them (Baidu, Bing, or DuckDuckGo); no search-API key is involved.

## Development

The bundle is plain ES modules: no build step, no bundler, no TypeScript.

| Path | What it holds |
| --- | --- |
| `index.js` | Host entry: wires the engine, settings, the tool, the routes, and the search provider |
| `lib/browser.js` | Classic engine: discovery, launch, CDP connection, frames, input, security helpers |
| `lib/cdp.js` | Minimal DevTools protocol client |
| `lib/native.js` | Native engine: command queue and page-presence window for the bridge |
| `lib/routes.js` | `/web-browser/*` and `/web-browser/bridge/*` routes and their guard |
| `lib/settings.js` | Settings store, defaults, and normalization |
| `lib/tools.js` | The `browser` tool definition |
| `lib/search.js` | Browser-backed search provider and engine specs |
| `client.js` | Web client module: composer switch, settings page, sidebar view |
| `locale/` | Display metadata and UI copy (`en`, `zh`) |
| `docs/` | Detail document, preview image, and the contracts both halves follow |

Run the offline suite (no DSH, no browser, no dependencies):

```sh
node --test                  # every file, discovered as **/*.test.mjs
node test/search.test.mjs    # one file, prints a PASS/FAIL line per case
```

The files are standalone scripts that end with `process.exit()`, so the runner
must keep one process per file (the default); they do not run in-process.

## 二创说明 / Derivative works

欢迎二次修改，不必先问作者。改了就改，只希望你在衍生项目里留一行出处：

```text
基于 dsh-web-actions：https://github.com/zeitlos6560/dsh-web-actions
```

写进 README、关于页或者提交说明都行。

Forks and rework are welcome — no need to ask first. If you publish a derivative,
a credit line back to this repository is all the author asks for:

```text
Based on dsh-web-actions: https://github.com/zeitlos6560/dsh-web-actions
```

## License

MIT — see [LICENSE](LICENSE). 上面那行出处是作者的一点期待，不改变 MIT 本身的条款。
The credit line above is a request, not an extra condition on the MIT terms.

