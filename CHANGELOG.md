# Changelog

Notable changes to this bundle. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-20

First public release, built and verified against DeepSeek Harness 0.2.2-rc.3.

### Added

- `browser` tool with 16 actions: `open`, `state`, `read`, `click`, `type`,
  `press`, `scroll`, `wait`, `act`, `screenshot`, `eval`, `back`, `forward`,
  `reload`, `close`, `providers`.
- Browser-backed web search: a `web` search provider (id `browser`) that drives
  the controlled browser through Baidu, Bing, or DuckDuckGo, with per-engine
  fallback and a fall-through reason for each failed engine.
- Composer master switch (「Web actions」) and a **Settings → Web actions** page
  with browser, security, web-search, and advanced (engine mode, order, profile)
  controls.
- Right sidebar view of the controlled page: address bar, navigation, and click
  and keyboard forwarding, so the page can be watched or taken over by hand.
- Two engine modes: `classic` (separate headless Edge/Chrome over the DevTools
  protocol) and `native` (page embedded in the sidebar through the desktop
  `<webview>` bridge), plus `auto`.
- Request guard for the state-changing `/web-browser/*` and `/bridge/*` routes,
  and three security switches (`blockPrivateAddresses`, `allowEval`,
  `clearProfileOnDisable`).
- Offline regression tests: `test/guard`, `native-bridge`, `search`, `security`,
  and `settings`.
