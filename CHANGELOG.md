# Changelog

Notable changes to this bundle. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-11-20

### Changed

- README: the derivative-work note (二创说明) only asks for a credit line back to
  this repository. The earlier wording listed permissions one by one and is gone.
- The repository was renamed to `dsh-web-actions`: `repository`, `homepage`, and
  `bugs` in `package.json`, the `LICENSE` holder string, and the README links all
  point at the new name. The local directory name and the internal tab id are
  unchanged.

## [1.1.0] - 2026-11-20

### Changed

- **Package renamed from `@local/dsh-web-browser` to `dsh-web-actions`.** The
  bundle row id (`web-browser`), the sidebar tab id, and the on-disk state under
  `~/.dsh/web-browser/` are unchanged, so settings, profile data, and screenshots
  carry over.
- README: add a derivative-work note asking for a credit line back to the
  repository.

Reinstalling is required after pulling this version: the profile links bundles by
package name, so the old `@local/dsh-web-browser` link has to be replaced by
`dsh-web-actions` (remove and add the plugin once).

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
