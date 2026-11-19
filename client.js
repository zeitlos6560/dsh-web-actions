/**
 * Client half of the Web actions bundle.
 *
 * Three surfaces over the Host's `/web-browser` HTTP routes:
 * - a compact master switch in the composer tool row (`conversation.input.left`);
 * - a settings page with its nav icon (`settings.section` + `settings.section.icon`);
 * - a live browser view in the right sidebar (`sidebarRightTabs.register` plus the
 *   `sidebar.right.pane.tab` body and its title).
 *
 * Everything is one browser module: React from the module table, inline SVG
 * icons, component-rendered styles over `--dsw-alias-*` tokens, and copy through
 * the `webBrowser` locale namespace (zh + en).
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-actions',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    /** Locale namespace shared by every surface. */
    const NS = 'webBrowser';
    /** Settings section id; must equal the `settings.section.icon` registration id. */
    const SECTION_ID = 'web-browser';
    /** Sidebar page kind opened through `ctx.sidebarRight.openTab`. */
    const TAB_KIND = 'web-browser';
    /** Sidebar tab-type identity and the key its body/title register under. */
    const TAB_ID = 'dsh-web-actions';
    /** `/state` poll for the composer switch (contract: every 3 s). */
    const STATE_INTERVAL_MS = 3000;
    /** Live view poll (~2.5 fps). */
    const FRAME_INTERVAL_MS = 400;
    /** Sidebar `/state` poll while the view is visible. */
    const VIEW_STATE_INTERVAL_MS = 2500;
    /** Wheel batches so one gesture does not post hundreds of requests. */
    const WHEEL_THROTTLE_MS = 70;
    /** Debounce before the sidebar stage size is reported to the Host. */
    const VIEWPORT_DEBOUNCE_MS = 180;
    /** Minimum stage-size delta (CSS px) that triggers a `/viewport` post. */
    const VIEWPORT_MIN_DELTA = 4;
    /** Minimum device-pixel-ratio delta that triggers a fresh `/viewport` post. */
    const VIEWPORT_MIN_DPR_DELTA = 0.02;

    /** Desktop bridge protocol this client speaks; the Host requires exactly 1. */
    const BRIDGE_PROTOCOL_VERSION = 1;
    /** The page a fresh view opens on (both engines use the same start page). */
    const DEFAULT_START_URL = 'https://www.bing.com/';
    /** The frozen contract's lease deadline before falling back to the classic view. */
    const BRIDGE_ACQUIRE_TIMEOUT_MS = 2000;
    /** How long the `<webview>` may take to report `dom-ready` before falling back. */
    const BRIDGE_MOUNT_TIMEOUT_MS = 8000;
    /** `/bridge/next` backoff: short right after a command, long while idle. */
    const BRIDGE_POLL_BUSY_MS = 40;
    const BRIDGE_POLL_IDLE_MS = 200;
    /** Client-side deadlines so one stuck command can never stall the bridge loop. */
    const NATIVE_NAVIGATE_DEADLINE_MS = 16000;
    const NATIVE_CAPTURE_DEADLINE_MS = 14000;
    const NATIVE_COMMAND_DEADLINE_MS = 9000;
    /** A settled DOM needs a beat before its URL/title are trustworthy. */
    const NATIVE_SETTLE_MS = 120;
    /** Throttle for reporting guest-driven navigation (link clicks, redirects). */
    const NATIVE_STATE_REPORT_MS = 200;
    /** Window key names accepted by the Host's `browser` tool, mapped to Electron. */
    const NATIVE_KEY_NAMES = {
      Enter: { keyCode: 'Enter', text: '\r' },
      Tab: { keyCode: 'Tab' },
      Escape: { keyCode: 'Escape' },
      Backspace: { keyCode: 'Backspace' },
      Delete: { keyCode: 'Delete' },
      ArrowLeft: { keyCode: 'Left' },
      ArrowUp: { keyCode: 'Up' },
      ArrowRight: { keyCode: 'Right' },
      ArrowDown: { keyCode: 'Down' },
      Home: { keyCode: 'Home' },
      End: { keyCode: 'End' },
      PageUp: { keyCode: 'PageUp' },
      PageDown: { keyCode: 'PageDown' },
      Space: { keyCode: 'Space', text: ' ' },
    };

    /**
     * The panel's device-pixel ratio, so the Host can emit frames at screen
     * resolution instead of CSS pixels (which a scaled desktop would blur).
     * @returns {number} clamped, two-decimal ratio.
     */
    function currentDevicePixelRatio() {
      const raw = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
      return Math.min(3, Math.max(1, Math.round(raw * 100) / 100));
    }

    /** Engine ids accepted by `/input {type:'key'}`. */
    const SPECIAL_KEYS = [
      'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown',
    ];

    /** Search engines, in the order the settings page edits them. */
    const DEFAULT_ENGINE_ORDER = ['baidu', 'bing', 'duckduckgo'];

    /** Engine id → dictionary key for its display name. */
    const ENGINE_LABEL_KEYS = {
      bing: 'settings.engineBing',
      baidu: 'settings.engineBaidu',
      duckduckgo: 'settings.engineDuckduckgo',
    };

    // ---------------------------------------------------------------------
    // Copy: zh and en dictionaries with the same keys.
    // ---------------------------------------------------------------------

    const zh = {
      'section.label': 'Web 操作',
      'composer.label': 'Web 操作',
      'composer.toggle': '开关 Web 操作',
      'composer.title': 'Web 操作（{state}）',
      'settings.title': 'Web 操作',
      'settings.description': '让 DSH 操作一个受控的浏览器，并在右侧边栏实时显示它正在看的页面。输入框左侧的按钮是总开关。',
      'settings.browserSection': '浏览器',
      'settings.master': '启用 Web 操作',
      'settings.masterHint': '关闭后停止浏览器：模型无法再操作网页，网页搜索也不再可用。',
      'settings.enabledOn': '已启用',
      'settings.enabledOff': '已关闭',
      'settings.executable': '可执行文件',
      'settings.executableAuto': '自动检测通过',
      'settings.executableMissing': '没有找到 Chromium 浏览器',
      'settings.running': '运行状态',
      'settings.runningYes': '运行中',
      'settings.runningNo': '未运行',
      'settings.currentUrl': '当前网址',
      'settings.engineLabel': '引擎',
      'settings.engineNative': '内置渲染器（原生视图）',
      'settings.engineClassic': '独立 Chromium 进程（经典）',
      'settings.nativeConnected': '原生视图已连接',
      'settings.nativeDisconnected': '原生视图未连接',
      'settings.nativeNoProcess': '原生模式直接使用 DSH 内置渲染器，不启动独立的 Edge/Chrome 进程，因此不需要可执行文件与视口设置。',
      'settings.noUrl': '（还没有打开网页）',
      'settings.launchError': '启动失败：{reason}',
      'settings.toggleFailed': '切换失败：{reason}',
      'settings.toggledOn': 'Web 操作已启用',
      'settings.toggledOff': 'Web 操作已关闭',
      'settings.pathLabel': '浏览器路径',
      'settings.pathHint': '留空则自动查找 Chrome / Edge / Brave；修改后重新启用浏览器才会生效。',
      'settings.pathPlaceholder': '例如 C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'settings.headless': '无窗口运行',
      'settings.headlessHint': '开启后浏览器在后台运行，只通过右侧画面观看。',
      'settings.securitySection': '安全',
      'settings.securityHint': '以下选项默认取更安全的一侧，保存后立即生效。',
      'settings.blockPrivate': '拦截本机与内网地址',
      'settings.blockPrivateHint': '禁止打开 localhost、127.0.0.1、192.168.x.x 等地址，避免受控浏览器被用来访问本机或内网服务。',
      'settings.allowEval': '允许页面脚本执行（eval）',
      'settings.allowEvalHint': '打开后模型可以对页面执行任意 JavaScript，仅建议排查问题时临时开启。',
      'settings.clearProfile': '关闭开关时清空浏览器配置档',
      'settings.clearProfileHint': '删除 cookie、登录态和缓存；开启后每次关闭都会丢失该配置档里的登录状态。',
      'settings.profileCleared': '浏览器已关闭，配置档已清空',
      'settings.profileClearFailed': '配置档清理失败：{reason}',
      'settings.viewport': '默认视口',
      'settings.viewportWidth': '宽度',
      'settings.viewportHeight': '高度',
      'settings.viewportHint': '页面 CSS 像素，仅在右侧视图未打开时生效（例如后台搜索）。宽度 480–1920，高度 360–1600。',
      'settings.viewportInvalid': '视口宽度需为 480–1920 的整数，高度需为 360–1600 的整数。',
      'settings.engines': '搜索引擎顺序',
      'settings.enginesHint': '网页搜索按此顺序尝试，直到某个引擎返回结果。',
      'settings.engineBing': 'Bing',
      'settings.engineBaidu': '百度',
      'settings.engineDuckduckgo': 'DuckDuckGo',
      'settings.engineUp': '上移',
      'settings.engineDown': '下移',
      'settings.enginePosition': '第 {n} 位',
      'settings.searchSection': '网页搜索',
      'settings.provider': '网页搜索来源',
      'settings.providerActive': '当前由浏览器接管网页搜索',
      'settings.providerInactive': '当前使用 DeepSeek 搜索 API',
      'settings.providerTakeOver': '把网页搜索交给浏览器',
      'settings.providerRestore': '恢复 DeepSeek 搜索',
      'settings.providerSwitching': '正在切换…',
      'settings.providerDone': '搜索来源已切换',
      'settings.providerFailed': '切换失败：{reason}',
      'settings.providerUnavailable': '当前启动方式没有配置编辑器，无法切换搜索来源，请在 设置 → 网页搜索 里手动选择。',
      'settings.viewSection': '浏览视图',
      'settings.viewHint': '模型开始操作网页时，会自动在右侧打开实时画面；也可以点右上角的标签手动打开，并直接在画面里点击、滚动和输入。',
      'settings.advanced': '高级',
      'settings.profileDir': '浏览器配置档目录',
      'settings.profileDirPlaceholder': '留空使用 ~/.dsh/web-browser/profile',
      'settings.profileDirHint': '改成自定义目录可以隔离登录态；修改后需要重新启用浏览器。',
      'settings.engineMode': '引擎模式',
      'settings.engineModeHint': '经典模式使用独立的 Edge 进程（默认、稳定）；原生模式在 DSH Desktop 的右侧栏里直接嵌入页面（实验性，借私有桌面桥）；自动模式优先原生，不可用时逐次回退到经典。',
      'settings.engineModeClassic': '经典（独立 Edge，稳定）',
      'settings.engineModeNative': '原生（实验，仅 Desktop）',
      'settings.engineAuto': '自动（能用就用原生）',
      'settings.nativeSupported': '当前环境支持原生视图（私有桌面桥，实验性）。',
      'settings.nativeUnsupported': '当前环境不支持原生视图：{reason}',
      'settings.savedEngineMode': '设置已保存；引擎模式会在右侧视图下次打开时生效',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.saved': '设置已保存',
      'settings.saveFailed': '保存失败：{reason}',
      'settings.refresh': '刷新状态',
      'settings.discardRefresh': '放弃修改并刷新',
      'settings.savedRestart': '设置已保存；headless 或浏览器路径的改动需要重新启用浏览器后生效',
      'settings.providerOff': '「Web操作」开关关闭期间，浏览器搜索不可用',
      'settings.loading': '正在读取状态…',
      'settings.loadFailed': '无法读取浏览器状态：{reason}',
      'settings.noData': '没有返回状态数据',
      'tab.title': 'Web 浏览',
      'tab.guide': '受控浏览器：显示并操作网页',
      'tab.addressPlaceholder': '输入网址或搜索内容，回车打开',
      'tab.go': '前往',
      'tab.back': '后退',
      'tab.forward': '前进',
      'tab.reload': '刷新',
      'tab.waitingState': '正在读取浏览器状态…',
      'tab.stateFailed': '无法读取浏览器状态：{reason}',
      'tab.waitingFrame': '等待浏览器画面…',
      'tab.engineDisabled': 'Web 操作已关闭。打开输入框左侧的开关，这里才会显示浏览器画面。',
      'tab.engineStopped': '浏览器没有运行。',
      'tab.enable': '启用 Web 操作',
      'tab.start': '启动浏览器',
      'tab.starting': '正在启动…',
      'tab.toggleFailed': '启动失败：{reason}',
      'tab.frameFailed': '画面读取失败：{reason}',
      'tab.navFailed': '导航失败：{reason}',
      'tab.inputFailed': '操作失败：{reason}',
      'tab.invalidAddress': '请输入有效的网址或搜索内容。',
      'tab.focusHint': '点击画面中的网页即可操作；滚轮滚动，键盘输入会发送到网页。',
      'tab.stageLabel': '浏览器实时画面',
      'tab.viewLabel': '浏览器实时画面',
      'tab.nativeConnecting': '正在连接原生视图…',
      'tab.nativeHint': '原生视图（实验）：可直接在画面中点击、输入和滚动。',
      'tab.nativeFallback': '原生视图不可用，已回退到经典画面：{reason}',
      'tab.nativeUnsupported': '当前环境不支持原生视图，使用经典画面：{reason}',
      'tab.nativeLabel': '原生浏览器视图',
      'native.noBridge': '当前环境没有桌面桥（仅 DSH Desktop 支持）',
      'native.badProtocol': '桌面桥协议版本不匹配（需要 protocolVersion 1）',
      'native.noApi': '桌面桥缺少 browser.acquire/release',
      'native.acquireFailed': '原生视图租约获取失败或超时',
      'native.mountFailed': '原生视图挂载失败',
      'native.mountTimeout': '原生视图挂载超时',
      'native.crashed': '原生视图进程已崩溃',
      'native.loopStopped': '宿主已关闭原生通道',
      'native.timeout': '原生命令超时',
    };

    const en = {
      'section.label': 'Web actions',
      'composer.label': 'Web actions',
      'composer.toggle': 'Toggle web actions',
      'composer.title': 'Web actions ({state})',
      'settings.title': 'Web actions',
      'settings.description': 'Let DSH drive a controlled browser and watch the page it is using live in the right sidebar. The button in the composer is the master switch.',
      'settings.browserSection': 'Browser',
      'settings.master': 'Enable web actions',
      'settings.masterHint': 'Turning this off stops the browser: the model can no longer act on pages and browser web search is unavailable.',
      'settings.enabledOn': 'On',
      'settings.enabledOff': 'Off',
      'settings.executable': 'Executable',
      'settings.executableAuto': 'Auto-detected',
      'settings.executableMissing': 'No Chromium browser found',
      'settings.running': 'State',
      'settings.runningYes': 'Running',
      'settings.runningNo': 'Stopped',
      'settings.currentUrl': 'Current URL',
      'settings.engineLabel': 'Engine',
      'settings.engineNative': 'Embedded renderer (native view)',
      'settings.engineClassic': 'Standalone Chromium process (classic)',
      'settings.nativeConnected': 'Native view connected',
      'settings.nativeDisconnected': 'Native view not connected',
      'settings.nativeNoProcess': 'Native mode uses the renderer inside DSH and starts no separate Edge/Chrome process, so no executable path or viewport is involved.',
      'settings.noUrl': '(no page open yet)',
      'settings.launchError': 'Launch failed: {reason}',
      'settings.toggleFailed': 'Toggle failed: {reason}',
      'settings.toggledOn': 'Web actions enabled',
      'settings.toggledOff': 'Web actions disabled',
      'settings.pathLabel': 'Browser path',
      'settings.pathHint': 'Leave empty to auto-detect Chrome / Edge / Brave. Restart the browser for a new path to apply.',
      'settings.pathPlaceholder': 'e.g. C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'settings.headless': 'Run headless',
      'settings.headlessHint': 'The browser runs in the background; watch it through the sidebar view.',
      'settings.securitySection': 'Security',
      'settings.securityHint': 'These options default to the safer side; changes apply as soon as they are saved.',
      'settings.blockPrivate': 'Block local and private addresses',
      'settings.blockPrivateHint': 'Refuse localhost, 127.0.0.1, 192.168.x.x and similar hosts so the controlled browser cannot be used against local or intranet services.',
      'settings.allowEval': 'Allow page script execution (eval)',
      'settings.allowEvalHint': 'Lets the model run arbitrary JavaScript in the page; keep it off except while diagnosing a problem.',
      'settings.clearProfile': 'Clear the browser profile when the switch turns off',
      'settings.clearProfileHint': 'Deletes cookies, logins and cache; with this on, every switch-off loses sessions stored in this profile.',
      'settings.profileCleared': 'Browser stopped and its profile was cleared',
      'settings.profileClearFailed': 'Could not clear the profile: {reason}',
      'settings.viewport': 'Default viewport',
      'settings.viewportWidth': 'Width',
      'settings.viewportHeight': 'Height',
      'settings.viewportHint': 'Page CSS pixels, used when the right-sidebar view is closed (for example, background searches). Width 480–1920, height 360–1600.',
      'settings.viewportInvalid': 'Viewport width must be an integer from 480–1920 and height an integer from 360–1600.',
      'settings.engines': 'Search engine order',
      'settings.enginesHint': 'Browser web search tries these engines in order until one returns results.',
      'settings.engineBing': 'Bing',
      'settings.engineBaidu': 'Baidu',
      'settings.engineDuckduckgo': 'DuckDuckGo',
      'settings.engineUp': 'Move up',
      'settings.engineDown': 'Move down',
      'settings.enginePosition': 'Position {n}',
      'settings.searchSection': 'Web search',
      'settings.provider': 'Search provider',
      'settings.providerActive': 'The browser currently handles web search',
      'settings.providerInactive': 'The DeepSeek Search API currently handles web search',
      'settings.providerTakeOver': 'Hand web search to the browser',
      'settings.providerRestore': 'Restore DeepSeek search',
      'settings.providerSwitching': 'Switching…',
      'settings.providerDone': 'Search provider switched',
      'settings.providerFailed': 'Switch failed: {reason}',
      'settings.providerUnavailable': 'This launch has no configuration editor, so the search provider cannot be switched here. Choose it manually in Settings → Web search.',
      'settings.viewSection': 'Browser view',
      'settings.viewHint': 'The live page opens on the right when the model starts working on the web; you can also open it from the tab and click, scroll, or type in the picture.',
      'settings.advanced': 'Advanced',
      'settings.profileDir': 'Browser profile directory',
      'settings.profileDirPlaceholder': 'Leave empty to use ~/.dsh/web-browser/profile',
      'settings.profileDirHint': 'A custom directory isolates the stored logins; restart the browser after changing it.',
      'settings.engineMode': 'Engine mode',
      'settings.engineModeHint': 'Classic drives a standalone Edge process (the default and the most stable). Native embeds the page in the DSH Desktop sidebar through a private desktop bridge (experimental). Auto prefers native and falls back to classic call by call when it cannot run.',
      'settings.engineModeClassic': 'Classic (standalone Edge, stable)',
      'settings.engineModeNative': 'Native (experimental, Desktop only)',
      'settings.engineAuto': 'Auto (use native when possible)',
      'settings.nativeSupported': 'This environment supports the native view (private desktop bridge, experimental).',
      'settings.nativeUnsupported': 'This environment does not support the native view: {reason}',
      'settings.savedEngineMode': 'Settings saved; the engine mode applies the next time the sidebar view opens',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.saved': 'Settings saved',
      'settings.saveFailed': 'Save failed: {reason}',
      'settings.refresh': 'Refresh state',
      'settings.discardRefresh': 'Discard changes and refresh',
      'settings.savedRestart': 'Settings saved; changes to headless or the browser path apply after the browser is restarted',
      'settings.providerOff': 'Browser search is unavailable while the Web actions switch is off',
      'settings.loading': 'Reading state…',
      'settings.loadFailed': 'Could not read browser state: {reason}',
      'settings.noData': 'the state response was empty',
      'tab.title': 'Web view',
      'tab.guide': 'The controlled browser: watch and operate a web page',
      'tab.addressPlaceholder': 'Enter a URL or search, then press Enter',
      'tab.go': 'Go',
      'tab.back': 'Back',
      'tab.forward': 'Forward',
      'tab.reload': 'Reload',
      'tab.waitingState': 'Reading browser state…',
      'tab.stateFailed': 'Could not read browser state: {reason}',
      'tab.waitingFrame': 'Waiting for the browser picture…',
      'tab.engineDisabled': 'Web actions are off. Turn on the switch left of the composer to show the browser picture here.',
      'tab.engineStopped': 'The browser is not running.',
      'tab.enable': 'Enable web actions',
      'tab.start': 'Start browser',
      'tab.starting': 'Starting…',
      'tab.toggleFailed': 'Could not start the browser: {reason}',
      'tab.frameFailed': 'Could not read the picture: {reason}',
      'tab.navFailed': 'Navigation failed: {reason}',
      'tab.inputFailed': 'Action failed: {reason}',
      'tab.invalidAddress': 'Enter a valid URL or search text.',
      'tab.focusHint': 'Click the page to act on it; the wheel scrolls and key presses go to the page.',
      'tab.stageLabel': 'Live browser picture',
      'tab.viewLabel': 'Live browser picture',
      'tab.nativeConnecting': 'Connecting the native view…',
      'tab.nativeHint': 'Native view (experimental): click, type, and scroll directly in the page.',
      'tab.nativeFallback': 'The native view is unavailable; showing the classic picture instead: {reason}',
      'tab.nativeUnsupported': 'This environment does not support the native view; showing the classic picture: {reason}',
      'tab.nativeLabel': 'Native browser view',
      'native.noBridge': 'No desktop bridge in this environment (DSH Desktop only)',
      'native.badProtocol': 'Desktop bridge protocol mismatch (protocolVersion 1 required)',
      'native.noApi': 'The desktop bridge has no browser.acquire/release',
      'native.acquireFailed': 'Could not acquire the native view lease (or it timed out)',
      'native.mountFailed': 'Could not mount the native view',
      'native.mountTimeout': 'Mounting the native view timed out',
      'native.crashed': 'The native view process crashed',
      'native.loopStopped': 'The host closed the native channel',
      'native.timeout': 'Native command timed out',
    };

    // ---------------------------------------------------------------------
    // HTTP routes.
    // ---------------------------------------------------------------------

    /**
     * Turn a failed request into display text.
     * @param {unknown} reason - thrown value.
     * @returns {string} user-visible message.
     */
    function errorMessage(reason) {
      if (reason instanceof Error) return reason.message;
      if (reason !== null && typeof reason === 'object' && typeof reason.message === 'string') return reason.message;
      return String(reason);
    }

    /**
     * Call one JSON route under `/web-browser`.
     * @param {string} path - route suffix, starting with `/`.
     * @param {{ method?: string, body?: unknown }} [init] - method and JSON body.
     * @returns {Promise<any>} parsed payload.
     */
    async function requestRoute(path, init) {
      const options = { method: init !== undefined && init.method !== undefined ? init.method : 'GET', cache: 'no-store' };
      if (init !== undefined && init.body !== undefined) {
        options.headers = { 'content-type': 'application/json' };
        options.body = JSON.stringify(init.body);
      }
      const response = await fetch('/web-browser' + path, options);
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (response.ok !== true) {
        const text = payload !== null && typeof payload === 'object' && typeof payload.reason === 'string' && payload.reason !== ''
          ? payload.reason
          : String(response.status) + ' ' + String(response.statusText || 'request failed');
        const failure = new Error(text);
        failure.status = response.status;
        throw failure;
      }
      return payload;
    }

    /**
     * Fetch the latest JPEG frame.
     * @returns {Promise<Blob | null>} frame bytes, or null while the Host has no frame (503).
     */
    async function requestFrame() {
      const response = await fetch('/web-browser/frame?t=' + String(Date.now()), { cache: 'no-store' });
      if (response.status === 503) return null;
      if (response.ok !== true) {
        throw new Error(String(response.status) + ' ' + String(response.statusText || 'frame request failed'));
      }
      return await response.blob();
    }

    // ---------------------------------------------------------------------
    // Desktop native view (方案 B): `globalThis.dshDesktop.browser` + bridge
    // ---------------------------------------------------------------------

    /** Wait one short beat without holding the bridge loop. */
    function sleep(ms) {
      return new Promise((resolve) => { window.setTimeout(resolve, ms); });
    }

    /** Reject with `reason` when `task` has not settled in `ms`. */
    function withTimeout(task, ms, reason) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(reason));
        }, ms);
        Promise.resolve(task).then((value) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        });
      });
    }

    /**
     * Feature-detect the Desktop renderer bridge. Never throws: anything
     * unexpected is "native unavailable" and keeps the classic frame view.
     * @returns {{ ok: boolean, bridge: any, reason: string }} capability report;
     *   `reason` is a locale key for the fixed cases or an error message.
     */
    function detectDesktopBridge() {
      try {
        const carrier = globalThis !== null && typeof globalThis === 'object' ? globalThis.dshDesktop : undefined;
        if (carrier === null || carrier === undefined || typeof carrier !== 'object') {
          return { ok: false, bridge: null, reason: 'native.noBridge' };
        }
        if (carrier.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
          return { ok: false, bridge: null, reason: 'native.badProtocol' };
        }
        const bridge = carrier.browser;
        if (bridge === null || bridge === undefined || typeof bridge !== 'object'
          || typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function') {
          return { ok: false, bridge: null, reason: 'native.noApi' };
        }
        return { ok: true, bridge: bridge, reason: '' };
      } catch (error) {
        return { ok: false, bridge: null, reason: errorMessage(error) };
      }
    }

    /** Translate a fixed detection reason key; pass any other text through. */
    function nativeReasonText(t, reason) {
      const text = typeof reason === 'string' ? reason : '';
      if (text === '') return '';
      if (text.indexOf('native.') !== 0) return text;
      const translated = t(text);
      return typeof translated === 'string' && translated !== '' && translated !== text ? translated : text;
    }

    /**
     * Storage account for the guest lease. The plugin has no Workspace service,
     * so this is best-effort: a real session key when the slot supplies one,
     * otherwise the fixed contract fallback.
     */
    function resolveWorkspaceKey(props) {
      try {
        if (props !== null && props !== undefined && typeof props === 'object') {
          const key = typeof props.workspaceKey === 'string' ? props.workspaceKey.trim() : '';
          if (key !== '') return key;
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
          if (sessionId !== '') return 'session:' + sessionId;
        }
      } catch { /* an exotic props object is not worth failing the view over */ }
      return 'dsh-web-browser';
    }

    /** Build the detached `<webview>` for one approved lease. */
    function createNativeWebview(lease, partition) {
      const element = document.createElement('webview');
      element.className = 'wb-webview';
      element.setAttribute('name', lease);
      if (typeof partition === 'string' && partition !== '') element.setAttribute('partition', partition);
      // Links commonly use `target=_blank`; without this the guest asks for a
      // popup window, Electron denies it, and the click looks dead. The mount
      // code prevents the popup and loads its URL in this same view instead.
      element.setAttribute('allowpopups', '');
      element.setAttribute('src', 'about:blank#' + lease);
      return element;
    }

    /** Release a lease without letting a failed release break the view. */
    function safeRelease(bridge, lease) {
      try {
        const released = bridge.release(lease);
        if (released !== null && released !== undefined && typeof released.catch === 'function') released.catch(() => {});
      } catch { /* the guest may already be gone */ }
    }

    /** Resolve on the first of `names`, or reject at the deadline. */
    function waitForWebviewEvent(element, names, timeoutMs) {
      return new Promise((resolve, reject) => {
        let done = false;
        const listeners = [];
        const timer = window.setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error('native.mountTimeout'));
        }, timeoutMs);
        function cleanup() {
          window.clearTimeout(timer);
          for (const entry of listeners) {
            try { element.removeEventListener(entry.name, entry.listener); } catch { /* detached */ }
          }
        }
        function settle(event) {
          if (done) return;
          done = true;
          cleanup();
          resolve(event);
        }
        for (const name of names) {
          const listener = (event) => { settle(event); };
          listeners.push({ name: name, listener: listener });
          element.addEventListener(name, listener);
        }
      });
    }

    /**
     * Keep `target=_blank` links inside this single view. The listener runs in
     * the guest document, so it covers the user's own clicks as well as clicks
     * the agent sends; `allowpopups` and the `new-window` handler are only the
     * backstop for anything this does not catch.
     */
    function ensureSameViewLinks(webview) {
      try {
        void webview.executeJavaScript(`(() => {
          if (window.__dshWebBrowserTargetFix === true) return true;
          window.__dshWebBrowserTargetFix = true;
          document.addEventListener('click', (event) => {
            const node = event !== null && event !== undefined ? event.target : null;
            const anchor = node !== null && node !== undefined && typeof node.closest === 'function' ? node.closest('a[target]') : null;
            if (anchor === null) return;
            const value = anchor.getAttribute('target');
            if (value !== null && value !== '_self' && value !== '_top' && value !== '_parent') anchor.setAttribute('target', '_self');
          }, true);
          return true;
        })()`).catch(() => {});
      } catch { /* the guest may already be gone */ }
    }

    /** Current URL/title of the guest, tolerating a destroyed element. */
    function nativePageInfo(webview) {
      let url = '';
      let title = '';
      try { url = typeof webview.getURL === 'function' ? String(webview.getURL() || '') : ''; } catch { url = ''; }
      try { title = typeof webview.getTitle === 'function' ? String(webview.getTitle() || '') : ''; } catch { title = ''; }
      return { url: url, title: title };
    }

    /** Execute page JavaScript in the guest and return its JSON value. */
    function nativeExecute(webview, expression) {
      return Promise.resolve(webview.executeJavaScript(String(expression), true));
    }

    /** Wait for a navigation to settle, then report the page identity. */
    async function nativeWaitForLoad(webview, timeoutMs) {
      try {
        await waitForWebviewEvent(webview, ['did-navigate', 'dom-ready', 'did-stop-loading'], timeoutMs);
      } catch { /* a page that never settles still answers with its current URL */ }
      await sleep(NATIVE_SETTLE_MS);
      return nativePageInfo(webview);
    }

    // --- extraction scripts (same shape as the Host's CDP engine) ---------

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

    /** Renders text/links/html from the guest document (Host's read口径). */
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

    /** Keep a target=_blank result click inside the guest page. */
    function anchorTargetScript(x, y) {
      return `(() => {
    const el = document.elementFromPoint(${String(x)}, ${String(y)});
    const anchor = el && typeof el.closest === 'function' ? el.closest('a[target]') : null;
    if (anchor !== null && anchor.getAttribute('target') !== '_self') anchor.setAttribute('target', '_self');
    return true;
  })()`;
    }

    /** Fallback text insertion when `sendInputEvent` cannot type. */
    function insertTextFallbackScript(text) {
      const literal = JSON.stringify(String(text === undefined || text === null ? '' : text));
      return `(() => {
    const value = ${literal};
    const el = document.activeElement;
    if (el !== null && el !== undefined) {
      if (el.isContentEditable === true) {
        const inserted = typeof document.execCommand === 'function' ? document.execCommand('insertText', false, value) : false;
        if (!inserted) el.textContent = (el.textContent || '') + value;
        return { ok: true, target: 'contenteditable' };
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(el, (el.value || '') + value);
        else el.value = (el.value || '') + value;
        if (typeof el.dispatchEvent === 'function') {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, target: el.tagName };
      }
    }
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, value)) {
      return { ok: true, target: 'document' };
    }
    return { ok: false, reason: 'no-focus' };
  })()`;
    }

    // --- native commands ---------------------------------------------------

    /** Largest client-side wait one queued command may occupy. */
    function nativeCommandDeadline(command, params) {
      if (command === 'navigate') return NATIVE_NAVIGATE_DEADLINE_MS;
      if (command === 'capture') return NATIVE_CAPTURE_DEADLINE_MS;
      if (command === 'waitFor') {
        const limit = Number(params !== null && typeof params === 'object' ? params.timeoutMs : NaN);
        return (Number.isFinite(limit) ? Math.max(200, Math.min(60000, limit)) : 10000) + 2500;
      }
      return NATIVE_COMMAND_DEADLINE_MS;
    }

    /** Type one text event at the guest focus. */
    function nativeClickAt(webview, x, y, buttonMode) {
      if (typeof webview.sendInputEvent !== 'function') throw new Error('原生视图不支持输入事件');
      try { webview.focus(); } catch { /* the guest may already be gone */ }
      const button = buttonMode === 'right' ? 'right' : buttonMode === 'middle' ? 'middle' : 'left';
      const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
      webview.sendInputEvent({ type: 'mouseMove', x: x, y: y });
      webview.sendInputEvent({ type: 'mouseDown', x: x, y: y, button: button, buttons: buttons, clickCount: 1 });
      webview.sendInputEvent({ type: 'mouseUp', x: x, y: y, button: button, buttons: buttons, clickCount: 1 });
    }

    /** Press one named key at the guest focus. */
    function nativePressKey(webview, name) {
      if (typeof webview.sendInputEvent !== 'function') throw new Error('原生视图不支持按键事件');
      const key = String(name === undefined || name === null ? '' : name);
      try { webview.focus(); } catch { /* the guest may already be gone */ }
      const spec = NATIVE_KEY_NAMES[key];
      if (spec === undefined) {
        if (key.length === 1) {
          webview.sendInputEvent({ type: 'keyDown', keyCode: key });
          webview.sendInputEvent({ type: 'char', keyCode: key });
          webview.sendInputEvent({ type: 'keyUp', keyCode: key });
          return;
        }
        throw new Error('不支持的按键：' + key);
      }
      webview.sendInputEvent({ type: 'keyDown', keyCode: spec.keyCode });
      if (spec.text !== undefined) webview.sendInputEvent({ type: 'char', keyCode: spec.text });
      webview.sendInputEvent({ type: 'keyUp', keyCode: spec.keyCode });
    }

    /** Type text into the guest, falling back to a page-dispatched insertion. */
    async function nativeTypeText(webview, text, selector, submit) {
      const focused = await nativeExecute(webview, focusScript(selector));
      if (focused === null || focused === undefined || typeof focused !== 'object' || focused.ok !== true) {
        return {
          ok: false,
          reason: focused !== null && focused !== undefined && typeof focused === 'object' && typeof focused.reason === 'string'
            ? focused.reason
            : 'no-match',
        };
      }
      const value = String(text === undefined || text === null ? '' : text);
      let typed = false;
      if (value !== '' && typeof webview.sendInputEvent === 'function') {
        try {
          try { webview.focus(); } catch { /* focus is best effort */ }
          for (const char of Array.from(value)) webview.sendInputEvent({ type: 'char', keyCode: char });
          typed = true;
        } catch { typed = false; }
      }
      if (typed !== true && value !== '') {
        const inserted = await nativeExecute(webview, insertTextFallbackScript(value));
        if (inserted === null || inserted === undefined || typeof inserted !== 'object' || inserted.ok !== true) {
          return { ok: false, reason: inserted !== null && inserted !== undefined && typeof inserted === 'object' && typeof inserted.reason === 'string' ? inserted.reason : 'no-focus' };
        }
      }
      if (submit === true) {
        try { nativePressKey(webview, 'Enter'); } catch { /* the form still saw the text */ }
        await sleep(220);
      }
      return { ok: true, target: String(typeof focused.target === 'string' ? focused.target : 'native-view'), url: nativePageInfo(webview).url };
    }

    /** Wheel-scroll the guest from its center. */
    function nativeScroll(webview, dy) {
      if (typeof webview.sendInputEvent !== 'function') throw new Error('原生视图不支持滚动事件');
      const rect = webview.getBoundingClientRect();
      const x = Math.max(1, Math.round(rect.width / 2));
      const y = Math.max(1, Math.round(rect.height / 2));
      webview.sendInputEvent({ type: 'mouseWheel', x: x, y: y, deltaX: 0, deltaY: Number.isFinite(dy) ? dy : 600, canScroll: true });
    }

    /** Pure-JS base64 so a guest capture needs no Node `Buffer` global. */
    function base64FromBytes(bytes) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let out = '';
      let index = 0;
      for (; index + 2 < bytes.length; index += 3) {
        const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
        out += alphabet[(chunk >> 18) & 63] + alphabet[(chunk >> 12) & 63]
          + alphabet[(chunk >> 6) & 63] + alphabet[chunk & 63];
      }
      const remaining = bytes.length - index;
      if (remaining === 1) {
        const chunk = bytes[index] << 16;
        out += alphabet[(chunk >> 18) & 63] + alphabet[(chunk >> 12) & 63] + '==';
      } else if (remaining === 2) {
        const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
        out += alphabet[(chunk >> 18) & 63] + alphabet[(chunk >> 12) & 63] + alphabet[(chunk >> 6) & 63] + '=';
      }
      return out;
    }

    /** Encode a NativeImage as base64 JPEG without assuming Node globals. */
    function nativeImagePayload(image, quality) {
      const value = Number.isFinite(quality) ? Math.max(20, Math.min(90, Math.round(quality))) : 62;
      if (image === null || image === undefined) return null;
      // Electron may expose toJPEG in one context and only toDataURL in another;
      // the real media type travels with the bytes so Host-side image admission
      // sees a PNG as PNG and a JPEG as JPEG.
      if (typeof image.toJPEG === 'function') {
        try {
          const buffer = image.toJPEG(value);
          if (typeof buffer === 'string' && buffer !== '') return { data: buffer, mimeType: 'image/jpeg' };
          if (buffer !== null && buffer !== undefined) {
            const bytes = buffer instanceof Uint8Array
              ? buffer
              : (typeof buffer.length === 'number' ? new Uint8Array(buffer) : null);
            if (bytes !== null && bytes.length > 0) return { data: base64FromBytes(bytes), mimeType: 'image/jpeg' };
          }
        } catch { /* fall through to toDataURL */ }
      }
      if (typeof image.toDataURL === 'function') {
        try {
          const dataUrl = image.toDataURL();
          if (typeof dataUrl === 'string') {
            const comma = dataUrl.indexOf(',');
            const match = comma >= 0 ? /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(dataUrl.slice(0, comma)) : null;
            if (comma >= 0 && match !== null) return { data: dataUrl.slice(comma + 1), mimeType: match[1].toLowerCase() };
          }
        } catch { /* no image data */ }
      }
      return null;
    }

    /** Capture the guest as a base64 JPEG result the Host can keep. */
    async function nativeCapture(webview, quality) {
      if (typeof webview.capturePage !== 'function') throw new Error('原生视图不支持截图');
      let shot = null;
      let lastError = null;
      // A freshly attached guest may not have a compositor surface yet, and a
      // hidden sidebar view cannot be captured at all: retry briefly, then say so.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          shot = await webview.capturePage();
          if (shot !== null && shot !== undefined) break;
        } catch (error) {
          lastError = error;
          shot = null;
        }
        if (attempt < 2) await new Promise((resolve) => { window.setTimeout(resolve, 180); });
      }
      if (shot === null || shot === undefined) {
        throw new Error('原生视图当前无法截图（右侧「Web 浏览」可能没有显示），请打开该标签后重试'
          + (lastError === null ? '' : '：' + errorMessage(lastError)));
      }
      const payload = nativeImagePayload(shot, quality);
      if (payload === null || payload.data === '') throw new Error('原生视图截图失败');
      const info = nativePageInfo(webview);
      let width = 0;
      let height = 0;
      try {
        const size = typeof shot.getSize === 'function' ? shot.getSize() : null;
        if (size !== null && typeof size === 'object') { width = Math.round(Number(size.width)); height = Math.round(Number(size.height)); }
      } catch { width = 0; height = 0; }
      if (!(width > 0) || !(height > 0)) {
        const rect = webview.getBoundingClientRect();
        width = Math.max(1, Math.round(rect.width));
        height = Math.max(1, Math.round(rect.height));
      }
      return { data: payload.data, mimeType: payload.mimeType, url: info.url, title: info.title, width: width, height: height };
    }

    /** Poll one page condition in the guest until it holds or times out. */
    async function nativeWaitFor(webview, kind, value, timeoutMs) {
      const requested = Number(timeoutMs);
      const limit = Number.isFinite(requested) ? Math.max(200, Math.min(60000, Math.round(requested))) : 10000;
      const deadline = Date.now() + limit;
      const target = String(value === undefined || value === null ? '' : value);
      const script = kind === 'text'
        ? 'document.body ? document.body.innerText.includes(' + JSON.stringify(target) + ') : false'
        : kind === 'url'
          ? 'location.href.includes(' + JSON.stringify(target) + ')'
          : '(() => { try { return document.querySelector(' + JSON.stringify(target) + ') !== null; } catch (error) { return false; } })()';
      while (Date.now() < deadline) {
        let ok = false;
        try { ok = (await nativeExecute(webview, script)) === true; } catch { ok = false; }
        if (ok) return { ok: true, waitedMs: limit - (deadline - Date.now()), url: nativePageInfo(webview).url };
        await sleep(250);
      }
      return { ok: false, reason: 'timeout', waitedMs: limit, url: nativePageInfo(webview).url };
    }

    /** Execute exactly one bridge command against the mounted guest. */
    async function runNativeCommand(webview, command, params) {
      const source = params !== null && typeof params === 'object' ? params : {};
      switch (command) {
        case 'navigate': {
          const url = String(source.url === undefined || source.url === null ? '' : source.url);
          if (url === '') throw new Error('导航失败：缺少 url');
          try { await webview.loadURL(url); } catch (error) { throw new Error('导航失败：' + errorMessage(error)); }
          return await nativeWaitForLoad(webview, 15000);
        }
        case 'evaluate':
          return await nativeExecute(webview, String(source.expression === undefined || source.expression === null ? '' : source.expression));
        case 'read': {
          const mode = source.mode === 'links' || source.mode === 'html' ? source.mode : 'text';
          const value = await nativeExecute(webview, readScript(mode, source.selector, source.maxChars));
          return value === undefined ? null : value;
        }
        case 'click': {
          const x = Number(source.x);
          const y = Number(source.y);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            nativeClickAt(webview, x, y, source.button);
            return { ok: true, method: 'point', x: x, y: y };
          }
          if ((source.selector === undefined || source.selector === '') && (source.text === undefined || source.text === '')) {
            throw new Error('click 需要 selector、text 或 x/y 之一');
          }
          const located = await nativeExecute(webview, locateScript(source.selector, source.text));
          if (located === null || located === undefined || typeof located !== 'object' || located.ok !== true) {
            return {
              ok: false,
              reason: located !== null && located !== undefined && typeof located === 'object' && typeof located.reason === 'string'
                ? located.reason
                : 'no-result',
            };
          }
          await nativeExecute(webview, anchorTargetScript(located.x, located.y));
          nativeClickAt(webview, located.x, located.y, source.button);
          return {
            ok: true,
            method: typeof source.selector === 'string' && source.selector !== '' ? 'selector' : 'text',
            tag: located.tag,
            label: located.label,
            x: located.x,
            y: located.y,
          };
        }
        case 'clickAt': {
          const x = Number(source.x);
          const y = Number(source.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('clickAt 需要数字 x/y');
          nativeClickAt(webview, x, y, source.button);
          return { ok: true };
        }
        case 'type':
          return await nativeTypeText(webview, source.text, source.selector, source.submit === true);
        case 'key':
          nativePressKey(webview, source.name);
          return { ok: true };
        case 'scroll':
          nativeScroll(webview, Number(source.dy));
          return { ok: true };
        case 'waitFor':
          return await nativeWaitFor(webview, source.kind, source.value, source.timeoutMs);
        case 'capture':
          return await nativeCapture(webview, source.quality);
        case 'newtab': {
          try { await webview.loadURL(DEFAULT_START_URL); } catch (error) { throw new Error('导航失败：' + errorMessage(error)); }
          return await nativeWaitForLoad(webview, 5000);
        }
        case 'back':
        case 'forward':
        case 'reload': {
          try {
            if (command === 'back') webview.goBack();
            else if (command === 'forward') webview.goForward();
            else webview.reload();
          } catch (error) { throw new Error('导航失败：' + errorMessage(error)); }
          await sleep(250);
          return nativePageInfo(webview);
        }
        default:
          throw new Error('原生视图不支持的命令：' + String(command));
      }
    }

    /** Post one command outcome; unknown ids are ignored by the Host. */
    async function postNativeResult(id, outcome) {
      const body = outcome.ok === true ? { id: id, ok: true } : { id: id, ok: false, reason: outcome.reason };
      if (outcome.ok === true && outcome.value !== undefined) body.value = outcome.value;
      try {
        await requestRoute('/bridge/result', { method: 'POST', body: body });
      } catch {
        try {
          await requestRoute('/bridge/result', { method: 'POST', body: { id: id, ok: false, reason: '原生命令结果无法回传' } });
        } catch { /* the Host ignores a lost or stale result */ }
      }
    }

    /**
     * `POST /bridge/hello` once, then poll `/bridge/next` and run one command
     * at a time until stopped or the Host stops advertising native mode.
     * A `register` header means the Host lost the capability report (plugin
     * reload) while this view is still mounted: say hello again and keep going.
     * Never throws; resolves to `'stopped'` or `'off'`.
     */
    function startNativeBridge(webview) {
      let stopped = false;
      let abort = null;
      async function sayHello() {
        const hello = await requestRoute('/bridge/hello', {
          method: 'POST',
          body: {
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            available: true,
            url: typeof webview.getURL === 'function' ? String(webview.getURL() || '') : '',
          },
        });
        // The frozen contract only promises `{ok:true}`; an explicit
        // `accepted:false` is the Host saying the bridge is not wired.
        if (hello !== null && typeof hello === 'object' && hello.accepted === false) return 'off';
        return 'on';
      }
      const done = (async () => {
        try {
          if ((await sayHello()) !== 'on') return 'off';
        } catch {
          return 'off';
        }
        if (stopped) return 'stopped';
        let busy = false;
        while (stopped !== true) {
          abort = typeof AbortController === 'function' ? new AbortController() : null;
          let response;
          try {
            response = await fetch('/web-browser/bridge/next?waitMs=' + String(busy ? BRIDGE_POLL_BUSY_MS : BRIDGE_POLL_IDLE_MS), {
              cache: 'no-store',
              signal: abort === null ? undefined : abort.signal,
            });
          } catch {
            if (stopped) return 'stopped';
            await sleep(BRIDGE_POLL_IDLE_MS);
            continue;
          } finally {
            abort = null;
          }
          if (stopped) return 'stopped';
          const mode = response.headers.get('x-web-browser-native');
          if (mode === 'register') {
            // The Host was reloaded underneath us; re-announce the webview so
            // native commands resume without the user refreshing the page.
            try {
              if ((await sayHello()) !== 'on') return 'off';
            } catch {
              return 'off';
            }
            busy = false;
            continue;
          }
          if (mode !== 'on') return 'off';
          if (response.status === 204) {
            busy = false;
            continue;
          }
          if (response.ok !== true) {
            await sleep(BRIDGE_POLL_IDLE_MS);
            continue;
          }
          let message = null;
          try { message = await response.json(); } catch { message = null; }
          if (message === null || typeof message !== 'object' || message.id === undefined || typeof message.command !== 'string') {
            busy = false;
            continue;
          }
          busy = true;
          const params = message.params !== null && typeof message.params === 'object' ? message.params : {};
          let outcome;
          try {
            const value = await withTimeout(
              runNativeCommand(webview, message.command, params),
              nativeCommandDeadline(message.command, params),
              '原生命令超时',
            );
            outcome = { ok: true, value: value };
          } catch (error) {
            outcome = { ok: false, reason: errorMessage(error) };
          }
          if (stopped) return 'stopped';
          await postNativeResult(String(message.id), outcome);
          busy = false;
        }
        return 'stopped';
      })();
      return {
        done: done,
        stop: () => {
          stopped = true;
          const current = abort;
          abort = null;
          if (current !== null) {
            try { current.abort(); } catch { /* already settled */ }
          }
        },
      };
    }

    /** Search URL prefix per engine id, used when the address bar gets text, not a host. */
    const SEARCH_URL_PREFIXES = {
      bing: 'https://www.bing.com/search?q=',
      baidu: 'https://www.baidu.com/s?wd=',
      duckduckgo: 'https://html.duckduckgo.com/html/?q=',
    };

    /**
     * Normalize an address-bar value the same way the Host does, with a search
     * fallback for text that is not a host.
     * @param {unknown} raw - typed text.
     * @param {string[] | undefined} engineOrder - configured engines, the first one wins.
     * @returns {string | undefined} http(s) URL.
     */
    function normalizeAddress(raw, engineOrder) {
      const text = String(raw === undefined || raw === null ? '' : raw).trim();
      if (text === '') return undefined;
      if (/^edge:\/\/newtab\/?$/i.test(text)) return 'edge://newtab';
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        try {
          const parsed = new URL(text);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
          return parsed.href;
        } catch { return undefined; }
      }
      if (/^[^\s/]+\.[^\s/]+/.test(text) || /^localhost(:\d+)?(\/|$)/i.test(text)) return 'https://' + text;
      // Text, not a host: search with the first configured engine this UI knows,
      // falling back to Bing when the order is empty or holds no known id.
      const order = Array.isArray(engineOrder) ? engineOrder : [];
      const engine = order.find((id) => DEFAULT_ENGINE_ORDER.indexOf(id) !== -1);
      return SEARCH_URL_PREFIXES[engine === undefined ? 'bing' : engine] + encodeURIComponent(text);
    }

    /**
     * Read a usable `{ width, height }` pixel pair from an engine/settings
     * viewport object.
     * @param {unknown} source - candidate viewport object.
     * @returns {{ width: number, height: number } | null} normalized pair.
     */
    function normalizeViewport(source) {
      if (source === null || source === undefined || typeof source !== 'object') return null;
      const width = Number(source.width);
      const height = Number(source.height);
      if (!Number.isFinite(width) || width <= 0) return null;
      if (!Number.isFinite(height) || height <= 0) return null;
      return { width: width, height: height };
    }

    /**
     * Project the Host settings payload onto the editable settings draft.
     * @param {any} settings - `/settings` or `/state` settings object.
     * @returns {{ browserPath: string, profileDir: string, headless: boolean,
     *   engineMode: string, engineOrder: string[], width: string, height: string }} draft.
     */
    function draftFromSettings(settings) {
      const source = settings !== null && typeof settings === 'object' ? settings : {};
      const order = Array.isArray(source.engineOrder) && source.engineOrder.length > 0
        ? source.engineOrder.filter((id) => typeof id === 'string')
        : DEFAULT_ENGINE_ORDER.slice();
      const viewport = source.viewport !== null && typeof source.viewport === 'object' ? source.viewport : {};
      return {
        browserPath: typeof source.browserPath === 'string' ? source.browserPath : '',
        profileDir: typeof source.profileDir === 'string' ? source.profileDir : '',
        headless: source.headless !== false,
        engineMode: source.engineMode === 'native' || source.engineMode === 'auto' ? source.engineMode : 'classic',
        blockPrivateAddresses: source.blockPrivateAddresses !== false,
        allowEval: source.allowEval === true,
        clearProfileOnDisable: source.clearProfileOnDisable === true,
        engineOrder: order.slice(),
        width: String(Number.isFinite(viewport.width) ? Math.round(viewport.width) : 1100),
        height: String(Number.isFinite(viewport.height) ? Math.round(viewport.height) : 820),
      };
    }

    /**
     * Read `/state` while `active`, refreshing on an interval.
     * @param {boolean} active - whether the surface is visible.
     * @param {number} intervalMs - poll interval.
     * @returns {[any, Function, string | null]} latest state, its setter, and the last read failure.
     */
    function useBrowserState(active, intervalMs) {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      useEffect(() => {
        if (!active) return undefined;
        let cancelled = false;
        let timer = 0;
        function schedule() {
          if (!cancelled) timer = window.setTimeout(tick, intervalMs);
        }
        function tick() {
          requestRoute('/state').then((next) => {
            if (cancelled) return;
            if (next !== null && typeof next === 'object') { setState(next); setError(null); }
          }, (reason) => {
            if (!cancelled) setError(errorMessage(reason));
          }).finally(schedule);
        }
        tick();
        return () => { cancelled = true; window.clearTimeout(timer); };
      }, [active, intervalMs]);
      return [state, setState, error];
    }

    // ---------------------------------------------------------------------
    // Inline SVG artwork.
    // ---------------------------------------------------------------------

    /** Draw one 16×16 glyph wrapper. */
    function glyph(size, children) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      }, children);
    }

    /** Read a numeric icon size with a fallback. */
    function iconSize(props, fallback) {
      return props !== null && props !== undefined && Number.isFinite(props.size) ? props.size : fallback;
    }

    /** Globe glyph used by the composer switch and the view title. */
    function GlobeIcon(props) {
      const size = iconSize(props, 14);
      return glyph(size, [
        h('circle', { key: 'c', cx: 8, cy: 8, r: 5.5, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { key: 'h', d: 'M2.6 8h10.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('ellipse', { key: 'e', cx: 8, cy: 8, rx: 2.6, ry: 5.5, stroke: 'currentColor', strokeWidth: 1.2 }),
      ]);
    }

    /** Browser-window glyph used by the settings nav and the default favicon. */
    function WindowIcon(props) {
      const size = iconSize(props, 16);
      return glyph(size, [
        h('rect', { key: 'r', x: 2, y: 3, width: 12, height: 10, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { key: 'b', d: 'M2 6.2h12', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { key: 'd', cx: 4.6, cy: 4.6, r: 0.55, fill: 'currentColor' }),
      ]);
    }

    /** Back chevron. */
    function ChevronLeftIcon() {
      return glyph(14, h('path', {
        d: 'M10 3.5 5.5 8l4.5 4.5', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    /** Forward chevron. */
    function ChevronRightIcon() {
      return glyph(14, h('path', {
        d: 'M6 3.5 10.5 8 6 12.5', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    /** Reload arrow. */
    function RefreshIcon() {
      return glyph(14, [
        h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.7', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M13.4 2.9v3.4h-3.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }

    /** Go arrow. */
    function ArrowRightIcon() {
      return glyph(14, [
        h('path', { key: 'a', d: 'M3 8h9', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M8.5 3.5 13 8l-4.5 4.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }

    /** Up arrow. */
    function ArrowUpIcon() {
      return glyph(12, [
        h('path', { key: 'a', d: 'M8 12.5V4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M4.9 7.1 8 4l3.1 3.1', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }

    /** Down arrow. */
    function ArrowDownIcon() {
      return glyph(12, [
        h('path', { key: 'a', d: 'M8 3.5V12', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M4.9 8.9 8 12l3.1-3.1', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }

    /** Small busy indicator. */
    function Spinner() {
      return h('span', { className: 'wb-spinner', 'aria-hidden': 'true' });
    }

    /** Component-rendered stylesheet; surfaces share one string. */
    function Style() {
      return h('style', null, CSS);
    }

    // ---------------------------------------------------------------------
    // Shared settings-page atoms.
    // ---------------------------------------------------------------------

    /** One definition-list status row. */
    function statusRow(label, value) {
      return h('div', { className: 'wb-statusRow', key: label },
        h('dt', { className: 'wb-statusLabel' }, label),
        h('dd', { className: 'wb-statusValue' }, value));
    }

    /** Read a localized engine name. */
    function engineLabel(t, id) {
      const key = ENGINE_LABEL_KEYS[id];
      return key === undefined ? String(id) : t(key);
    }

    // ---------------------------------------------------------------------
    // Surface 1: composer master switch.
    // ---------------------------------------------------------------------

    /**
     * One compact switch in the composer tool row: globe glyph, label, and a
     * state dot. Polls `/state` every 3 s and posts `/toggle` while busy.
     */
    function ComposerSwitch(props) {
      const t = props.t;
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const busyRef = useRef(false);
      /** Last model-driven activity seen, so a new value reveals the view once. */
      const lastActionRef = useRef(null);
      /** Throttle automatic reveals so a long action series does not steal focus. */
      const lastOpenedAtRef = useRef(0);

      useEffect(() => {
        let cancelled = false;
        let timer = 0;
        function schedule() {
          if (!cancelled) timer = window.setTimeout(tick, STATE_INTERVAL_MS);
        }
        function tick() {
          requestRoute('/state').then((next) => {
            if (cancelled || busyRef.current) return;
            if (next !== null && typeof next === 'object') {
              setState(next);
              setError(null);
              // The switch only turns the feature on. The live view appears when
              // the model actually drives the page, i.e. when lastActionAt moves.
              // The first sighting counts too when that action is recent, so a
              // session whose only action predates this poll still reveals the view.
              const engine = next.engine !== null && typeof next.engine === 'object' ? next.engine : null;
              const at = engine !== null ? Number(engine.lastActionAt) : NaN;
              if (Number.isFinite(at) && at > 0) {
                const first = lastActionRef.current === null;
                if (first || at > lastActionRef.current) {
                  lastActionRef.current = at;
                  // An action older than 15 s only seeds the baseline.
                  const now = Date.now();
                  if ((first === false || now - at <= 15000)
                    && (lastOpenedAtRef.current === 0 || now - lastOpenedAtRef.current > 15000)) {
                    lastOpenedAtRef.current = now;
                    try {
                      if (typeof props.openView === 'function') props.openView();
                    } catch { /* the sidebar view is optional */ }
                  }
                }
              }
            }
          }, () => {
            // Keep the last known state; a transient read failure is not toggle state.
          }).finally(schedule);
        }
        tick();
        return () => { cancelled = true; window.clearTimeout(timer); };
      }, []);

      const toggle = () => {
        if (busyRef.current || state === null) return;
        const enabled = state.settings !== null && typeof state.settings === 'object' && state.settings.enabled === true;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        requestRoute('/toggle', { method: 'POST', body: { enabled: !enabled } }).then((next) => {
          if (next !== null && typeof next === 'object') {
            setState(next);
            if (typeof next.error === 'string' && next.error !== '') {
              setError(next.error);
            }
          }
        }, (reason) => {
          setError(errorMessage(reason));
        }).finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
      };

      const enabled = state !== null && state.settings !== null && typeof state.settings === 'object' && state.settings.enabled === true;
      const stateLabel = t(enabled ? 'settings.enabledOn' : 'settings.enabledOff');
      const title = error !== null
        ? t('settings.toggleFailed', { reason: error })
        : t('composer.title', { state: stateLabel });

      return h(React.Fragment, null,
        h(Style, { key: 'style' }),
        h('button', {
          key: 'switch',
          type: 'button',
          className: 'wb-chip',
          'aria-pressed': enabled,
          'aria-busy': busy ? 'true' : undefined,
          'aria-label': t('composer.toggle'),
          title: title,
          disabled: busy || state === null,
          'data-busy': busy ? 'true' : 'false',
          onClick: toggle,
        },
          h(GlobeIcon, { key: 'icon', size: 14 }),
          h('span', { key: 'label', className: 'wb-chipLabel' }, t('composer.label')),
          h('span', { key: 'dot', className: 'wb-chipDot', 'data-on': enabled ? 'true' : 'false', 'aria-hidden': 'true' })));
    }

    // ---------------------------------------------------------------------
    // Surface 2: settings section and its nav icon.
    // ---------------------------------------------------------------------

    /** The settings navigation icon; the shell sizes it and matches it by section id. */
    function SettingsSectionIcon(props) {
      const size = iconSize(props, 16);
      return WindowIcon({ size: size });
    }

    /**
     * The Web actions settings page: master switch, browser status, path,
     * headless, engine order, viewport, search-provider switch, and the button
     * that opens the sidebar view.
     */
    function SettingsSection(props) {
      const t = props.t;
      const close = typeof props.close === 'function' ? props.close : undefined;

      const [state, setState] = useState(null);
      const [draft, setDraft] = useState(null);
      const [loading, setLoading] = useState(true);
      const [loadError, setLoadError] = useState(null);
      const [busy, setBusy] = useState(null);
      const [feedback, setFeedback] = useState(null);
      const [nativeBridge] = useState(detectDesktopBridge);
      const aliveRef = useRef(true);

      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const loadState = useCallback((resetDraft) => {
        setLoading(true);
        return requestRoute('/state').then((next) => {
          if (!aliveRef.current) return;
          if (next !== null && typeof next === 'object' && next.settings !== undefined) {
            setState(next);
            setDraft((previous) => (resetDraft || previous === null ? draftFromSettings(next.settings) : previous));
            setLoadError(null);
          } else {
            setLoadError(t('settings.noData'));
          }
        }, (reason) => {
          if (aliveRef.current) setLoadError(errorMessage(reason));
        }).finally(() => {
          if (aliveRef.current) setLoading(false);
        });
      }, [t]);

      const initialLoadRef = useRef(false);
      useEffect(() => {
        if (initialLoadRef.current) return;
        initialLoadRef.current = true;
        void loadState(false);
      }, [loadState]);

      const settings = state !== null && state.settings !== null && typeof state.settings === 'object' ? state.settings : null;
      const engine = state !== null && state.engine !== null && typeof state.engine === 'object' ? state.engine : null;
      const provider = state !== null && state.provider !== null && typeof state.provider === 'object' ? state.provider : null;
      const enabled = settings !== null && settings.enabled === true;
      const running = engine !== null && engine.running === true;
      const working = busy !== null;
      const model = draft !== null ? draft : draftFromSettings(settings);
      const executable = engine !== null && typeof engine.executable === 'string' && engine.executable !== '' ? engine.executable : undefined;
      const executableFound = engine === null || engine.executableFound !== false;
      const currentUrl = engine !== null && typeof engine.url === 'string' && engine.url !== '' ? engine.url : undefined;
      const nativeMode = engine !== null && engine.mode === 'native';
      const nativeInfo = engine !== null && engine.native !== null && typeof engine.native === 'object' ? engine.native : null;
      const nativeConnected = nativeInfo !== null && nativeInfo.available === true && nativeInfo.tabOpen === true;
      const providerActive = provider !== null && provider.active === true;
      const providerSwitchable = provider === null || provider.switchable !== false;

      /** Merge one field into the draft, seeding it from the server when needed. */
      const updateDraft = (patch) => {
        setDraft((previous) => Object.assign({}, previous === null ? draftFromSettings(settings) : previous, patch));
      };

      const toggleMaster = () => {
        if (working) return;
        setBusy('toggle');
        setFeedback(null);
        requestRoute('/toggle', { method: 'POST', body: { enabled: !enabled } }).then((next) => {
          if (!aliveRef.current) return;
          if (next !== null && typeof next === 'object' && next.settings !== undefined) {
            setState(next);
            setDraft((previous) => (previous === null ? draftFromSettings(next.settings) : previous));
            if (typeof next.error === 'string' && next.error !== '') {
              setFeedback({ tone: 'error', text: t('settings.launchError', { reason: next.error }), area: 'master' });
            } else if (next.profileCleared !== undefined && next.profileCleared !== null) {
              const cleared = next.profileCleared.cleared === true;
              setFeedback({
                tone: cleared ? 'success' : 'error',
                text: t(cleared ? 'settings.profileCleared' : 'settings.profileClearFailed', {
                  reason: next.profileCleared.reason === undefined ? '' : next.profileCleared.reason,
                }),
                area: 'master',
              });
            } else {
              setFeedback({ tone: 'success', text: t(!enabled ? 'settings.toggledOn' : 'settings.toggledOff'), area: 'master' });
            }
          } else {
            setFeedback({ tone: 'error', text: t('settings.noData'), area: 'master' });
          }
        }, (reason) => {
          if (aliveRef.current) setFeedback({ tone: 'error', text: t('settings.toggleFailed', { reason: errorMessage(reason) }), area: 'master' });
        }).finally(() => {
          if (aliveRef.current) setBusy(null);
        });
      };

      const save = () => {
        if (working) return;
        const width = Math.round(Number(model.width));
        const height = Math.round(Number(model.height));
        if (!Number.isInteger(width) || width < 480 || width > 1920
          || !Number.isInteger(height) || height < 360 || height > 1600) {
          setFeedback({ tone: 'error', text: t('settings.viewportInvalid'), area: 'save' });
          return;
        }
        setBusy('save');
        setFeedback(null);
        const patch = {
          browserPath: String(model.browserPath).trim(),
          profileDir: String(model.profileDir === undefined || model.profileDir === null ? '' : model.profileDir).trim(),
          headless: model.headless === true,
          engineMode: model.engineMode === 'native' || model.engineMode === 'auto' ? model.engineMode : 'classic',
          blockPrivateAddresses: model.blockPrivateAddresses === true,
          allowEval: model.allowEval === true,
          clearProfileOnDisable: model.clearProfileOnDisable === true,
          engineOrder: model.engineOrder.slice(),
          viewport: { width: width, height: height },
        };
        requestRoute('/settings', { method: 'POST', body: { patch: patch } }).then((result) => {
          if (!aliveRef.current) return;
          // A rejected write (`ok:false`, or a payload without settings) must not
          // read as saved: report the Host's reason and keep the draft for a retry.
          if (result === null || typeof result !== 'object' || result.ok === false || result.settings === undefined) {
            const reason = result !== null && typeof result === 'object'
              && typeof result.reason === 'string' && result.reason !== ''
              ? result.reason
              : t('settings.noData');
            setFeedback({ tone: 'error', text: t('settings.saveFailed', { reason: reason }), area: 'save' });
            return;
          }
          setState((previous) => (previous === null ? previous : Object.assign({}, previous, { settings: result.settings })));
          setDraft(draftFromSettings(result.settings));
          const before = state !== null && state.settings !== null && typeof state.settings === 'object' ? state.settings : {};
          const beforeMode = before.engineMode === 'native' || before.engineMode === 'auto' ? before.engineMode : 'classic';
          const modeChanged = beforeMode !== patch.engineMode;
          const restartNeeded = before.headless !== patch.headless
            || String(before.browserPath === undefined || before.browserPath === null ? '' : before.browserPath).trim() !== patch.browserPath;
          setFeedback({
            tone: 'success',
            text: t(modeChanged ? 'settings.savedEngineMode' : (restartNeeded ? 'settings.savedRestart' : 'settings.saved')),
            area: 'save',
          });
        }, (reason) => {
          if (aliveRef.current) setFeedback({ tone: 'error', text: t('settings.saveFailed', { reason: errorMessage(reason) }), area: 'save' });
        }).finally(() => {
          if (aliveRef.current) setBusy(null);
        });
      };

      const toggleProvider = () => {
        if (working || !providerSwitchable) return;
        setBusy('provider');
        setFeedback(null);
        requestRoute('/provider', { method: 'POST', body: { enabled: !providerActive } }).then((result) => {
          if (!aliveRef.current) return;
          if (result !== null && typeof result === 'object' && result.ok === true) {
            setFeedback({ tone: 'success', text: t('settings.providerDone'), area: 'provider' });
            void loadState(false);
          } else {
            const reason = result !== null && typeof result === 'object' && typeof result.reason === 'string'
              ? result.reason
              : t('settings.providerUnavailable');
            setFeedback({ tone: 'error', text: t('settings.providerFailed', { reason: reason }), area: 'provider' });
          }
        }, (reason) => {
          if (aliveRef.current) setFeedback({ tone: 'error', text: t('settings.providerFailed', { reason: errorMessage(reason) }), area: 'provider' });
        }).finally(() => {
          if (aliveRef.current) setBusy(null);
        });
      };

      const moveEngine = (index, delta) => {
        setDraft((previous) => {
          const source = previous === null ? draftFromSettings(settings) : previous;
          const target = index + delta;
          if (target < 0 || target >= source.engineOrder.length) return previous;
          const order = source.engineOrder.slice();
          const moved = order.splice(index, 1)[0];
          order.splice(target, 0, moved);
          return Object.assign({}, source, { engineOrder: order });
        });
      };

      const header = h('header', { className: 'wb-header', key: 'header' },
        h('h2', { className: 'wb-title' }, t('settings.title')),
        h('p', { className: 'wb-desc' }, t('settings.description')));

      const feedbackRow = feedback === null || feedback.area === 'save' ? null : h('div', {
        className: 'wb-notice', 'data-tone': feedback.tone, role: 'status', key: 'feedback',
      }, feedback.text);

      const saveFeedbackRow = feedback === null || feedback.area !== 'save' ? null : h('div', {
        className: 'wb-notice', 'data-tone': feedback.tone, role: 'status', key: 'save-feedback',
      }, feedback.text);

      const loadFailure = loadError === null ? null : h('div', {
        className: 'wb-notice', 'data-tone': 'error', role: 'alert', key: 'load-error',
      }, t('settings.loadFailed', { reason: loadError }));

      const browserCard = h('section', { className: 'wb-card', key: 'browser' },
        h('div', { className: 'wb-cardHead' },
          h('h3', { className: 'wb-cardTitle' }, t('settings.browserSection')),
          h('span', { className: 'wb-pill', 'data-on': enabled ? 'true' : 'false' }, t(enabled ? 'settings.enabledOn' : 'settings.enabledOff'))),
        h('div', { className: 'wb-row' },
          h('div', { className: 'wb-rowText' },
            h('span', { className: 'wb-label' }, t('settings.master')),
            h('span', { className: 'wb-hint' }, t('settings.masterHint'))),
          h('button', {
            type: 'button', className: 'wb-switch', role: 'switch',
            'aria-checked': enabled, 'aria-label': t('settings.master'),
            'aria-busy': busy === 'toggle' ? 'true' : undefined,
            'data-on': enabled ? 'true' : 'false', disabled: working,
            onClick: toggleMaster,
          }, h('span', { className: 'wb-switchThumb', 'aria-hidden': 'true' }))),
        h('dl', { className: 'wb-status' },
          statusRow(t('settings.engineLabel'), t(nativeMode ? 'settings.engineNative' : 'settings.engineClassic')),
          nativeMode
            ? statusRow(t('settings.running'), t(nativeConnected ? 'settings.nativeConnected' : 'settings.nativeDisconnected'))
            : statusRow(t('settings.executable'), executable !== undefined
              ? executable
              : (executableFound ? t('settings.executableAuto') : t('settings.executableMissing'))),
          nativeMode
            ? null
            : statusRow(t('settings.running'), t(running ? 'settings.runningYes' : 'settings.runningNo')),
          statusRow(t('settings.currentUrl'), currentUrl !== undefined ? currentUrl : t('settings.noUrl'))),
        engine !== null && typeof state.error === 'string' && state.error !== ''
          ? h('div', { className: 'wb-notice', 'data-tone': 'error', role: 'status' }, t('settings.launchError', { reason: state.error }))
          : null,
        nativeMode
          ? h('p', { className: 'wb-hint' }, t('settings.nativeNoProcess'))
          : h(React.Fragment, null,
            h('label', { className: 'wb-field' },
              h('span', { className: 'wb-fieldLabel' }, t('settings.pathLabel')),
              h('input', {
                className: 'wb-input', type: 'text', value: model.browserPath, spellCheck: false,
                placeholder: t('settings.pathPlaceholder'), disabled: working,
                onChange: (event) => { updateDraft({ browserPath: event.currentTarget.value }); },
              }),
              h('span', { className: 'wb-hint' }, t('settings.pathHint'))),
            h('h4', { className: 'wb-subTitle' }, t('settings.viewport')),
            h('div', { className: 'wb-viewport' },
              h('label', { className: 'wb-field wb-fieldInline' },
                h('span', { className: 'wb-fieldLabel' }, t('settings.viewportWidth')),
                h('input', {
                  className: 'wb-input wb-inputNum', type: 'number', min: 480, max: 1920,
                  value: model.width, disabled: working,
                  onChange: (event) => { updateDraft({ width: event.currentTarget.value }); },
                })),
              h('label', { className: 'wb-field wb-fieldInline' },
                h('span', { className: 'wb-fieldLabel' }, t('settings.viewportHeight')),
                h('input', {
                  className: 'wb-input wb-inputNum', type: 'number', min: 360, max: 1600,
                  value: model.height, disabled: working,
                  onChange: (event) => { updateDraft({ height: event.currentTarget.value }); },
                }))),
            h('p', { className: 'wb-hint' }, t('settings.viewportHint'))));

      const securityCard = h('section', { className: 'wb-card', key: 'security' },
        h('h3', { className: 'wb-cardTitle' }, t('settings.securitySection')),
        h('p', { className: 'wb-hint' }, t('settings.securityHint')),
        h('label', { className: 'wb-check' },
          h('input', {
            type: 'checkbox', checked: model.blockPrivateAddresses === true, disabled: working,
            onChange: (event) => { updateDraft({ blockPrivateAddresses: event.currentTarget.checked }); },
          }),
          h('span', { className: 'wb-checkText' }, t('settings.blockPrivate')),
          h('span', { className: 'wb-hint' }, t('settings.blockPrivateHint'))),
        h('label', { className: 'wb-check' },
          h('input', {
            type: 'checkbox', checked: model.allowEval === true, disabled: working,
            onChange: (event) => { updateDraft({ allowEval: event.currentTarget.checked }); },
          }),
          h('span', { className: 'wb-checkText' }, t('settings.allowEval')),
          h('span', { className: 'wb-hint' }, t('settings.allowEvalHint'))),
        h('label', { className: 'wb-check' },
          h('input', {
            type: 'checkbox', checked: model.clearProfileOnDisable === true, disabled: working,
            onChange: (event) => { updateDraft({ clearProfileOnDisable: event.currentTarget.checked }); },
          }),
          h('span', { className: 'wb-checkText' }, t('settings.clearProfile')),
          h('span', { className: 'wb-hint' }, t('settings.clearProfileHint'))));

      const searchCard = h('section', { className: 'wb-card', key: 'search' },
        h('h3', { className: 'wb-cardTitle' }, t('settings.searchSection')),
        h('div', { className: 'wb-row' },
          h('div', { className: 'wb-rowText' },
            h('span', { className: 'wb-label' }, t('settings.provider')),
            h('span', { className: 'wb-hint' }, t(providerActive ? 'settings.providerActive' : 'settings.providerInactive')),
            providerActive && state !== null && state.settings !== null && typeof state.settings === 'object' && state.settings.enabled === false
              ? h('span', { className: 'wb-hint' }, t('settings.providerOff'))
              : null,
            providerSwitchable ? null : h('span', { className: 'wb-hint' }, t('settings.providerUnavailable'))),
          h('button', {
            type: 'button', className: 'wb-btn', disabled: working || !providerSwitchable,
            onClick: toggleProvider,
          }, busy === 'provider'
            ? t('settings.providerSwitching')
            : t(providerActive ? 'settings.providerRestore' : 'settings.providerTakeOver'))));

      const advancedCard = h('details', { className: 'wb-card', key: 'advanced' },
        h('summary', { className: 'wb-cardTitle' }, t('settings.advanced')),
        h('h4', { className: 'wb-subTitle' }, t('settings.engineMode')),
        h('label', { className: 'wb-field' },
          h('select', {
            className: 'wb-select', value: model.engineMode, disabled: working,
            'aria-label': t('settings.engineMode'),
            onChange: (event) => { updateDraft({ engineMode: event.currentTarget.value }); },
          },
            h('option', { key: 'classic', value: 'classic' }, t('settings.engineModeClassic')),
            h('option', { key: 'native', value: 'native' }, t('settings.engineModeNative')),
            h('option', { key: 'auto', value: 'auto' }, t('settings.engineAuto'))),
          h('span', { className: 'wb-hint' }, t('settings.engineModeHint')),
          h('span', { className: 'wb-hint' }, nativeBridge.ok === true
            ? t('settings.nativeSupported')
            : t('settings.nativeUnsupported', { reason: nativeReasonText(t, nativeBridge.reason) }))),
        h('label', { className: 'wb-check' },
          h('input', {
            type: 'checkbox', checked: model.headless === true, disabled: working,
            onChange: (event) => { updateDraft({ headless: event.currentTarget.checked }); },
          }),
          h('span', { className: 'wb-checkText' }, t('settings.headless')),
          h('span', { className: 'wb-hint' }, t('settings.headlessHint'))),
        h('h4', { className: 'wb-subTitle' }, t('settings.engines')),
        h('p', { className: 'wb-hint' }, t('settings.enginesHint')),
        h('ol', { className: 'wb-engines' },
          model.engineOrder.map((id, index) => h('li', { className: 'wb-engine', key: id },
            h('span', { className: 'wb-engineIndex' }, t('settings.enginePosition', { n: String(index + 1) })),
            h('span', { className: 'wb-engineName' }, engineLabel(t, id)),
            h('button', {
              type: 'button', className: 'wb-mini', 'aria-label': t('settings.engineUp'),
              title: t('settings.engineUp'), disabled: working || index === 0,
              onClick: () => { moveEngine(index, -1); },
            }, h(ArrowUpIcon, null)),
            h('button', {
              type: 'button', className: 'wb-mini', 'aria-label': t('settings.engineDown'),
              title: t('settings.engineDown'), disabled: working || index === model.engineOrder.length - 1,
              onClick: () => { moveEngine(index, 1); },
            }, h(ArrowDownIcon, null))))),
        h('label', { className: 'wb-field' },
          h('span', { className: 'wb-fieldLabel' }, t('settings.profileDir')),
          h('input', {
            className: 'wb-input', type: 'text', value: model.profileDir, spellCheck: false,
            placeholder: t('settings.profileDirPlaceholder'), disabled: working,
            onChange: (event) => { updateDraft({ profileDir: event.currentTarget.value }); },
          }),
          h('span', { className: 'wb-hint' }, t('settings.profileDirHint'))));

      const viewCard = h('section', { className: 'wb-card', key: 'view' },
        h('h3', { className: 'wb-cardTitle' }, t('settings.viewSection')),
        h('p', { className: 'wb-hint' }, t('settings.viewHint')),
        h('div', { className: 'wb-actions' },
          h('button', {
            type: 'button', className: 'wb-btn', disabled: working || loading,
            onClick: () => { void loadState(true); },
          }, t('settings.discardRefresh'))),
        h('div', { className: 'wb-actions' },
          h('button', {
            type: 'button', className: 'wb-btn', 'data-primary': 'true', disabled: working || state === null,
            onClick: save,
          }, busy === 'save' ? t('settings.saving') : t('settings.save'))),
        saveFeedbackRow);

      const body = state === null
        ? h('p', { className: 'wb-muted', key: 'loading' }, loading ? t('settings.loading') : t('settings.loadFailed', { reason: t('settings.noData') }))
        : h(React.Fragment, null, browserCard, securityCard, searchCard, advancedCard, viewCard);

      return h('div', { className: 'wb-page' },
        h(Style, { key: 'style' }),
        header,
        feedbackRow,
        loadFailure,
        body);
    }

    // ---------------------------------------------------------------------
    // Surface 3: right-sidebar live browser view and its title.
    // ---------------------------------------------------------------------

    /** The sidebar tab title: a globe and the fixed localized label. */
    function WebBrowserTitle(props) {
      const t = props.t;
      return h(React.Fragment, null,
        h(GlobeIcon, { key: 'icon', size: 14 }),
        h('span', { key: 'label', className: 'wb-tabTitleText' }, t('tab.title')));
    }

    /**
     * The live view: address bar and navigation, the polled JPEG picture, and
     * pointer/wheel/keyboard input forwarded to `/input` in page CSS pixels.
     */
    function WebBrowserBody(props) {
      const t = props.t;
      const useTabInfo = props.useTabInfo;
      const tabInfo = useTabInfo();
      const visible = tabInfo !== null && tabInfo !== undefined
        && tabInfo.tab !== undefined && tabInfo.tab.visible === true;
      const initialUrl = tabInfo !== null && tabInfo !== undefined
        && tabInfo.tab !== undefined
        && tabInfo.tab.navigation !== undefined
        && tabInfo.tab.navigation.params !== null
        && tabInfo.tab.navigation.params !== undefined
        && typeof tabInfo.tab.navigation.params.url === 'string'
        ? tabInfo.tab.navigation.params.url
        : undefined;

      const browserState = useBrowserState(visible, VIEW_STATE_INTERVAL_MS);
      const state = browserState[0];
      const setState = browserState[1];
      const stateError = browserState[2];

      const [draft, setDraft] = useState(initialUrl !== undefined ? initialUrl : '');
      const [focused, setFocused] = useState(false);
      const [navigating, setNavigating] = useState(false);
      const [starting, setStarting] = useState(false);
      const [notice, setNotice] = useState(null);
      const [frame, setFrame] = useState({ status: 'idle', url: null, reason: null });
      const stageRef = useRef(null);
      const imgRef = useRef(null);
      const frameUrlRef = useRef(null);
      const reportedSizeRef = useRef(null);
      const viewportTimerRef = useRef(0);
      const flushViewportRef = useRef(() => {});
      const visibleRef = useRef(false);
      const stateRef = useRef(null);
      /** Desktop bridge capability, detected once per view mount. */
      const [nativeBridge] = useState(detectDesktopBridge);
      /** Native host lifecycle: off | connecting | mounting | ready | failed. */
      const [nativePhase, setNativePhase] = useState({ phase: 'off', reason: null });
      const nativeHostRef = useRef(null);

      const settings = state !== null && state.settings !== null && typeof state.settings === 'object' ? state.settings : null;
      const engine = state !== null && state.engine !== null && typeof state.engine === 'object' ? state.engine : null;
      const running = engine !== null && engine.running === true;
      const enabled = settings === null || settings.enabled === true;
      /** Settings mode, normalized the same way the Host normalizes it. */
      const engineMode = settings !== null && (settings.engineMode === 'native' || settings.engineMode === 'auto')
        ? settings.engineMode
        : 'classic';
      /** Whether this mount should try the native host at all. */
      const nativeEligible = nativeBridge.ok === true && engineMode !== 'classic' && enabled === true;
      const nativeReady = nativeEligible === true && nativePhase.phase === 'ready';
      const nativeWorkspaceKey = resolveWorkspaceKey(props);
      const engineUrl = engine !== null && typeof engine.url === 'string' ? engine.url : '';
      // Clicks map against the Host's *effective* viewport: the runtime
      // override echoed by `/state`, falling back to the saved setting.
      const engineViewport = normalizeViewport(engine !== null ? engine.viewport : null);
      const settingsViewport = normalizeViewport(settings !== null ? settings.viewport : null);
      const viewport = engineViewport !== null ? engineViewport : settingsViewport;
      const frameActive = visible && running && nativeReady !== true;

      // Report the sidebar stage's CSS size to the Host so the controlled page
      // follows the panel instead of a fixed 1100x820 frame. The override is
      // transient runtime state; unmounting the pane releases it.
      useEffect(() => {
        visibleRef.current = visible;
        flushViewportRef.current();
      }, [visible]);

      useEffect(() => {
        stateRef.current = state;
        flushViewportRef.current();
      }, [state]);

      useEffect(() => {
        const stage = stageRef.current;
        if (stage === null) return undefined;

        function flush() {
          const node = stageRef.current;
          if (node === null) return;
          // No report while the pane is hidden or the browser state is unknown.
          if (visibleRef.current !== true || stateRef.current === null) return;
          const width = Math.round(node.clientWidth);
          const height = Math.round(node.clientHeight);
          if (!(width > 0) || !(height > 0)) return;
          const dpr = currentDevicePixelRatio();
          const previous = reportedSizeRef.current;
          if (previous !== null
            && Math.abs(width - previous.width) <= VIEWPORT_MIN_DELTA
            && Math.abs(height - previous.height) <= VIEWPORT_MIN_DELTA
            && Math.abs(dpr - previous.dpr) <= VIEWPORT_MIN_DPR_DELTA) return;
          reportedSizeRef.current = { width: width, height: height, dpr: dpr };
          requestRoute('/viewport', { method: 'POST', body: { width: width, height: height, dpr: dpr } }).then((result) => {
            // Adopt the effective viewport immediately so clicks match the new
            // frame before the next `/state` poll.
            if (result === null || typeof result !== 'object') return;
            if (result.engine === null || result.engine === undefined || typeof result.engine !== 'object') return;
            setState((current) => (current === null ? current : Object.assign({}, current, { engine: result.engine })));
          }, () => {
            // Best effort: a missed report only means the next resize retries.
          });
        }

        function schedule() {
          if (viewportTimerRef.current !== 0) window.clearTimeout(viewportTimerRef.current);
          viewportTimerRef.current = window.setTimeout(() => {
            viewportTimerRef.current = 0;
            flush();
          }, VIEWPORT_DEBOUNCE_MS);
        }

        flushViewportRef.current = flush;
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { schedule(); }) : null;
        if (observer !== null) observer.observe(stage);
        schedule();
        return () => {
          flushViewportRef.current = () => {};
          if (viewportTimerRef.current !== 0) {
            window.clearTimeout(viewportTimerRef.current);
            viewportTimerRef.current = 0;
          }
          if (observer !== null) observer.disconnect();
          requestRoute('/viewport', { method: 'POST', body: { release: true } }).then(() => {}, () => {});
        };
      }, []);

      // Native host (方案 B): acquire a Desktop guest lease, mount its <webview>
      // over the stage, and run the bridge command loop. Every failure tears the
      // host down again and leaves the polled frame view as the visible fallback.
      useEffect(() => {
        if (nativeEligible !== true) return undefined;
        if (nativeBridge.ok !== true || nativeBridge.bridge === null || nativeBridge.bridge === undefined) return undefined;
        const bridge = nativeBridge.bridge;
        const host = nativeHostRef.current;
        if (host === null || host === undefined) return undefined;

        let disposed = false;
        let cleaned = false;
        let lease;
        let webview = null;
        let loop = null;
        let acquireTimer = 0;
        let stateTimer = 0;
        let lastReportAt = 0;
        let pageLoading = false;

        function teardown() {
          if (cleaned === true) return;
          cleaned = true;
          if (acquireTimer !== 0) {
            window.clearTimeout(acquireTimer);
            acquireTimer = 0;
          }
          if (stateTimer !== 0) {
            window.clearTimeout(stateTimer);
            stateTimer = 0;
          }
          if (loop !== null) {
            loop.stop();
            loop = null;
          }
          const element = webview;
          webview = null;
          if (element !== null) {
            try { element.removeEventListener('render-process-gone', onCrash); } catch { /* detached */ }
            try { element.removeEventListener('crashed', onCrash); } catch { /* detached */ }
            try { element.removeEventListener('destroyed', onCrash); } catch { /* detached */ }
            try { element.removeEventListener('did-navigate', onPageNavigate); } catch { /* detached */ }
            try { element.removeEventListener('did-navigate-in-page', onPageNavigate); } catch { /* detached */ }
            try { element.removeEventListener('page-title-updated', onPageNavigate); } catch { /* detached */ }
            try { element.removeEventListener('did-start-loading', onLoadingStart); } catch { /* detached */ }
            try { element.removeEventListener('did-stop-loading', onLoadingStop); } catch { /* detached */ }
            try { element.removeEventListener('new-window', onNewWindow); } catch { /* detached */ }
            try { if (element.parentNode === host) host.removeChild(element); } catch { /* already gone */ }
          }
          const held = lease;
          lease = undefined;
          if (held !== undefined) safeRelease(bridge, held);
        }

        /**
         * Tell the Host which page the guest is showing. Link clicks, redirects
         * and popups never pass through the command queue, so without this report
         * the address bar and `/state` would keep showing the previous page.
         */
        function reportPageState(immediate) {
          if (webview === null) return;
          if (immediate !== true && lastReportAt !== 0 && Date.now() - lastReportAt < NATIVE_STATE_REPORT_MS) {
            if (stateTimer === 0) {
              stateTimer = window.setTimeout(() => {
                stateTimer = 0;
                reportPageState(true);
              }, NATIVE_STATE_REPORT_MS);
            }
            return;
          }
          lastReportAt = Date.now();
          const info = nativePageInfo(webview);
          requestRoute('/bridge/state', {
            method: 'POST',
            body: { url: info.url, title: info.title, loading: pageLoading },
          }).catch(() => {});
        }

        function onPageNavigate() {
          if (webview !== null) ensureSameViewLinks(webview);
          reportPageState(false);
        }
        function onLoadingStart() { pageLoading = true; reportPageState(false); }
        function onLoadingStop() { pageLoading = false; reportPageState(false); }
        /** Keep a `target=_blank` navigation inside this single view. */
        function onNewWindow(event) {
          try { event.preventDefault(); } catch { /* best effort */ }
          const url = String(event !== null && event !== undefined && event.url !== undefined ? event.url : '');
          if (!/^https?:/i.test(url)) return;
          try { void webview.loadURL(url); } catch { /* the guest may be gone */ }
        }

        function fail(reason) {
          if (disposed === true || cleaned === true) return;
          setNativePhase({ phase: 'failed', reason: reason });
          teardown();
        }

        function onCrash() {
          fail('native.crashed');
        }

        setNativePhase({ phase: 'connecting', reason: null });

        void (async () => {
          try {
            // Acquire under the contract's deadline, but keep handling a late
            // reservation: an acquire that times out and later succeeds must
            // still release its lease (teardown has run by then).
            const acquired = Promise.resolve().then(() => bridge.acquire(nativeWorkspaceKey));
            acquireTimer = window.setTimeout(() => {
              acquireTimer = 0;
              if (disposed === true || cleaned === true) return;
              fail('native.acquireFailed');
            }, BRIDGE_ACQUIRE_TIMEOUT_MS);
            let reservation;
            try {
              reservation = await acquired;
            } finally {
              if (acquireTimer !== 0) {
                window.clearTimeout(acquireTimer);
                acquireTimer = 0;
              }
            }
            if (disposed === true || cleaned === true) { safeRelease(bridge, reservation); return; }
            if (reservation === null || typeof reservation !== 'object'
              || typeof reservation.lease !== 'string' || reservation.lease === '') {
              throw new Error('native.acquireFailed');
            }
            lease = reservation.lease;
            const partition = typeof reservation.partition === 'string' ? reservation.partition : '';
            webview = createNativeWebview(lease, partition);
            webview.addEventListener('render-process-gone', onCrash);
            webview.addEventListener('crashed', onCrash);
            webview.addEventListener('destroyed', onCrash);
            // Guest-driven navigation must reach the Host, and `target=_blank`
            // links must open in this view instead of a denied popup window.
            webview.addEventListener('did-navigate', onPageNavigate);
            webview.addEventListener('did-navigate-in-page', onPageNavigate);
            webview.addEventListener('page-title-updated', onPageNavigate);
            webview.addEventListener('did-start-loading', onLoadingStart);
            webview.addEventListener('did-stop-loading', onLoadingStop);
            webview.addEventListener('new-window', onNewWindow);
            const ready = waitForWebviewEvent(webview, ['dom-ready', 'render-process-gone', 'destroyed'], BRIDGE_MOUNT_TIMEOUT_MS);
            host.appendChild(webview);
            setNativePhase({ phase: 'mounting', reason: null });
            const event = await ready;
            if (disposed === true || cleaned === true) return;
            if (event === null || event === undefined || event.type !== 'dom-ready') throw new Error('native.crashed');
            setNativePhase({ phase: 'ready', reason: null });
            ensureSameViewLinks(webview);
            // The lease bootstraps on about:blank; show the real start page next.
            try {
              const current = typeof webview.getURL === 'function' ? String(webview.getURL() || '') : '';
              if (current === '' || /^about:blank/i.test(current)) {
                const startPage = waitForWebviewEvent(webview, ['did-navigate', 'dom-ready', 'did-stop-loading'], 8000);
                await webview.loadURL(DEFAULT_START_URL);
                await startPage;
              }
            } catch { /* the bridge still works on a blank page */ }
            if (disposed === true || cleaned === true) return;
            loop = startNativeBridge(webview);
            // The effect can be torn down while the mount awaits the start page;
            // in that case stop the loop we just created instead of leaving a
            // second poller that fights the live view over the Host's commands.
            if (disposed === true || cleaned === true) {
              loop.stop();
              loop = null;
              return;
            }
            reportPageState(true);
            loop.done.then((outcome) => {
              if (disposed === true || cleaned === true) return;
              if (outcome === 'off') fail('native.loopStopped');
            }).catch(() => {});
          } catch (error) {
            if (disposed === true || cleaned === true) return;
            fail(errorMessage(error));
          }
        })();

        return () => {
          disposed = true;
          teardown();
        };
      }, [nativeEligible, nativeBridge, nativeWorkspaceKey, setNativePhase]);

      // Frame polling: preload the next JPEG, swap only once decoded, and keep
      // the previous object URL until the swap so the picture never flickers.
      useEffect(() => {
        if (!frameActive) return undefined;
        let cancelled = false;
        let timer = 0;
        function schedule() {
          if (!cancelled) timer = window.setTimeout(tick, FRAME_INTERVAL_MS);
        }
        function tick() {
          requestFrame().then((blob) => {
            if (cancelled) return;
            if (blob === null) {
              setFrame((previous) => (previous.status === 'ready' ? previous : { status: 'empty', url: previous.url, reason: null }));
              schedule();
              return;
            }
            const objectUrl = URL.createObjectURL(blob);
            const probe = new Image();
            probe.onload = () => {
              if (cancelled) { URL.revokeObjectURL(objectUrl); return; }
              const previousUrl = frameUrlRef.current;
              frameUrlRef.current = objectUrl;
              setFrame({ status: 'ready', url: objectUrl, reason: null });
              if (previousUrl !== null && previousUrl !== undefined) URL.revokeObjectURL(previousUrl);
              schedule();
            };
            probe.onerror = () => {
              URL.revokeObjectURL(objectUrl);
              if (cancelled) return;
              setFrame((previous) => (previous.status === 'ready' ? previous : { status: 'error', url: null, reason: 'image decode failed' }));
              schedule();
            };
            probe.src = objectUrl;
          }, (reason) => {
            if (cancelled) return;
            setFrame((previous) => (previous.status === 'ready' ? previous : { status: 'error', url: null, reason: errorMessage(reason) }));
            schedule();
          });
        }
        tick();
        return () => { cancelled = true; window.clearTimeout(timer); };
      }, [frameActive]);

      // Release the last frame's object URL when the body unmounts.
      useEffect(() => () => {
        if (frameUrlRef.current !== null && frameUrlRef.current !== undefined) URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }, []);

      // Follow the browser while the address bar is not being edited.
      useEffect(() => {
        if (focused) return;
        if (engineUrl !== '') setDraft(engineUrl);
      }, [engineUrl, focused]);

      // Dismiss a transient input/navigation error on its own.
      useEffect(() => {
        if (notice === null) return undefined;
        const timer = window.setTimeout(() => { setNotice(null); }, 6000);
        return () => { window.clearTimeout(timer); };
      }, [notice]);

      const reportFailure = useCallback((key, reason) => {
        setNotice({ tone: 'error', text: t(key, { reason: errorMessage(reason) }) });
      }, [t]);

      // One ordered chain for input: keystrokes must arrive in the order typed,
      // and a burst of characters is coalesced into one insertion.
      const inputChainRef = useRef(Promise.resolve());
      const textBufferRef = useRef('');
      const textTimerRef = useRef(0);
      const sendInput = useCallback((payload) => {
        inputChainRef.current = inputChainRef.current
          .then(() => requestRoute('/input', { method: 'POST', body: payload }))
          .catch((reason) => { reportFailure('tab.inputFailed', reason); });
        return inputChainRef.current;
      }, [reportFailure]);
      const flushTypedText = useCallback(() => {
        if (textTimerRef.current !== 0) {
          window.clearTimeout(textTimerRef.current);
          textTimerRef.current = 0;
        }
        const pending = textBufferRef.current;
        textBufferRef.current = '';
        if (pending !== '') void sendInput({ type: 'text', text: pending });
      }, [sendInput]);
      const queueTypedChar = useCallback((char) => {
        textBufferRef.current += char;
        if (textTimerRef.current !== 0) return;
        textTimerRef.current = window.setTimeout(() => {
          textTimerRef.current = 0;
          const pending = textBufferRef.current;
          textBufferRef.current = '';
          if (pending !== '') void sendInput({ type: 'text', text: pending });
        }, 60);
      }, [sendInput]);
      useEffect(() => () => {
        if (textTimerRef.current !== 0) window.clearTimeout(textTimerRef.current);
      }, []);

      const refreshState = useCallback(() => {
        requestRoute('/state').then((next) => {
          if (next !== null && typeof next === 'object') setState(next);
        }, (reason) => {
          reportFailure('tab.stateFailed', reason);
        });
      }, [reportFailure, setState]);

      const navigate = useCallback((raw) => {
        // Text that is not a host searches with the first configured engine.
        const target = normalizeAddress(raw, settings !== null && Array.isArray(settings.engineOrder) ? settings.engineOrder : undefined);
        if (target === undefined) {
          setNotice({ tone: 'error', text: t('tab.invalidAddress') });
          return;
        }
        setNavigating(true);
        setNotice(null);
        requestRoute('/navigate', { method: 'POST', body: { url: target } }).then((result) => {
          if (result !== null && typeof result === 'object') {
            if (result.engine !== undefined && result.engine !== null) {
              setState((previous) => (previous === null ? previous : Object.assign({}, previous, { engine: result.engine })));
            }
            if (typeof result.url === 'string' && result.url !== '') setDraft(result.url);
          }
        }, (reason) => {
          reportFailure('tab.navFailed', reason);
        }).finally(() => { setNavigating(false); });
      }, [reportFailure, setState, settings, t]);

      const navigateAction = useCallback((action) => {
        setNavigating(true);
        setNotice(null);
        requestRoute('/nav', { method: 'POST', body: { action: action } }).then((result) => {
          if (result !== null && typeof result === 'object'
            && result.engine !== undefined && result.engine !== null) {
            setState((previous) => (previous === null ? previous : Object.assign({}, previous, { engine: result.engine })));
          }
        }, (reason) => {
          reportFailure('tab.navFailed', reason);
        }).finally(() => { setNavigating(false); });
      }, [reportFailure, setState]);

      const startEngine = useCallback(() => {
        if (starting) return;
        setStarting(true);
        setNotice(null);
        requestRoute('/toggle', { method: 'POST', body: { enabled: true } }).then((next) => {
          if (next !== null && typeof next === 'object') {
            setState(next);
            if (typeof next.error === 'string' && next.error !== '') reportFailure('tab.toggleFailed', next.error);
          }
        }, (reason) => {
          reportFailure('tab.toggleFailed', reason);
        }).finally(() => { setStarting(false); });
      }, [reportFailure, setState, starting]);

      // Wheel is attached natively so preventDefault actually stops the host page.
      useEffect(() => {
        const stage = stageRef.current;
        if (stage === null) return undefined;
        let last = 0;
        const onWheel = (event) => {
          // The guest scrolls itself while the native view is live.
          if (nativeReady === true) return;
          event.preventDefault();
          if (!running) return;
          const now = Date.now();
          if (now - last < WHEEL_THROTTLE_MS) return;
          last = now;
          const dy = Number.isFinite(event.deltaY) ? event.deltaY : 0;
          if (dy === 0) return;
          void sendInput({ type: 'wheel', dy: Math.round(dy) });
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => { stage.removeEventListener('wheel', onWheel); };
      }, [running, sendInput, nativeReady]);

      const onSubmit = (event) => {
        event.preventDefault();
        navigate(draft);
      };

      const focusStage = () => {
        if (stageRef.current !== null) stageRef.current.focus({ preventScroll: true });
      };

      const onStageClick = (event) => {
        if (viewport === null || imgRef.current === null) return;
        const rect = imgRef.current.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const ratioX = (event.clientX - rect.left) / rect.width;
        const ratioY = (event.clientY - rect.top) / rect.height;
        if (ratioX < 0 || ratioY < 0 || ratioX > 1 || ratioY > 1) return;
        const x = Math.min(viewport.width - 1, Math.max(0, Math.round(ratioX * viewport.width)));
        const y = Math.min(viewport.height - 1, Math.max(0, Math.round(ratioY * viewport.height)));
        focusStage();
        void sendInput({ type: 'click', x: x, y: y, button: 'left' });
      };

      const onStageKeyDown = (event) => {
        if (event.defaultPrevented) return;
        if (event.target !== event.currentTarget) return;
        if (!running) return;
        const key = event.key;
        if (typeof key !== 'string' || key === '' || key === 'Unidentified') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // Tab is how a keyboard user leaves the stage; never capture it.
        if (key === 'Tab') return;
        // Escape leaves the stage (the page keeps its own clipboard/dialog keys).
        if (key === 'Escape') {
          event.preventDefault();
          flushTypedText();
          const stage = stageRef.current;
          if (stage !== null && stage !== undefined && typeof stage.blur === 'function') stage.blur();
          return;
        }
        if (key === ' ' || key === 'Spacebar') {
          event.preventDefault();
          flushTypedText();
          void sendInput({ type: 'key', key: 'Space' });
          return;
        }
        if (SPECIAL_KEYS.indexOf(key) !== -1) {
          event.preventDefault();
          flushTypedText();
          void sendInput({ type: 'key', key: key });
          return;
        }
        if (key.length === 1) {
          event.preventDefault();
          queueTypedChar(key);
        }
      };

      let overlay = null;
      // While the native host is connecting or live it owns the stage; a failed
      // attempt drops straight back into the classic overlays below.
      const nativeAttempting = nativeEligible === true && nativePhase.phase !== 'failed';
      if (nativeAttempting === true) {
        if (nativeReady !== true) {
          overlay = h('div', { className: 'wb-overlay', key: 'overlay' },
            h(Spinner, null),
            h('p', { className: 'wb-overlayTitle' }, t('tab.nativeConnecting')));
        }
      } else if (state === null) {
        overlay = h('div', { className: 'wb-overlay', key: 'overlay' },
          stateError !== null
            ? h(React.Fragment, null,
              h('p', { className: 'wb-overlayTitle' }, t('tab.stateFailed', { reason: stateError })),
              h('button', { type: 'button', className: 'wb-btn', onClick: refreshState }, t('settings.refresh')))
            : h(React.Fragment, null, h(Spinner, null), h('p', { className: 'wb-overlayTitle' }, t('tab.waitingState'))));
      } else if (!enabled) {
        overlay = h('div', { className: 'wb-overlay', key: 'overlay' },
          h('p', { className: 'wb-overlayTitle' }, t('tab.engineDisabled')),
          h('button', {
            type: 'button', className: 'wb-btn', 'data-primary': 'true',
            disabled: starting, onClick: startEngine,
          }, starting ? t('tab.starting') : t('tab.enable')));
      } else if (!running) {
        overlay = h('div', { className: 'wb-overlay', key: 'overlay' },
          h('p', { className: 'wb-overlayTitle' }, t('tab.engineStopped')),
          typeof state.error === 'string' && state.error !== ''
            ? h('p', { className: 'wb-overlayText' }, t('settings.launchError', { reason: state.error }))
            : null,
          h('button', {
            type: 'button', className: 'wb-btn', 'data-primary': 'true',
            disabled: starting, onClick: startEngine,
          }, starting ? t('tab.starting') : t('tab.start')));
      } else if (frame.status === 'error') {
        overlay = h('div', { className: 'wb-overlay', key: 'overlay' },
          h(Spinner, null),
          h('p', { className: 'wb-overlayTitle' }, t('tab.frameFailed', { reason: String(frame.reason) })));
      } else if (frame.status !== 'ready') {
        overlay = h('div', { className: 'wb-overlay', key: 'overlay' },
          h(Spinner, null),
          h('p', { className: 'wb-overlayTitle' }, t('tab.waitingFrame')));
      }

      const toolbar = h('form', { className: 'wb-toolbar', key: 'toolbar', onSubmit: onSubmit },
        h('button', {
          type: 'button', className: 'wb-tool', title: t('tab.back'), 'aria-label': t('tab.back'),
          disabled: !running || navigating, onClick: () => { navigateAction('back'); },
        }, h(ChevronLeftIcon, null)),
        h('button', {
          type: 'button', className: 'wb-tool', title: t('tab.forward'), 'aria-label': t('tab.forward'),
          disabled: !running || navigating, onClick: () => { navigateAction('forward'); },
        }, h(ChevronRightIcon, null)),
        h('button', {
          type: 'button', className: 'wb-tool', title: t('tab.reload'), 'aria-label': t('tab.reload'),
          disabled: !running || navigating, onClick: () => { navigateAction('reload'); },
        }, h(RefreshIcon, null)),
        h('div', { className: 'wb-addressWrap' },
          h('input', {
            className: 'wb-address', type: 'text', value: draft, spellCheck: false,
            placeholder: t('tab.addressPlaceholder'), 'aria-label': t('tab.addressPlaceholder'),
            disabled: !enabled,
            onChange: (event) => { setDraft(event.currentTarget.value); },
            onFocus: () => { setFocused(true); },
            onBlur: () => {
              setFocused(false);
              if (engineUrl !== '') setDraft(engineUrl);
            },
          }),
          h('button', {
            type: 'submit', className: 'wb-tool wb-go', title: t('tab.go'), 'aria-label': t('tab.go'),
            disabled: navigating,
          }, navigating ? h(Spinner, null) : h(ArrowRightIcon, null))));

      // One short status line for the native experiment: connecting/ready hint,
      // or the reason the classic picture came back.
      const nativeStatusText = nativeEligible === true
        ? (nativePhase.phase === 'failed'
          ? t('tab.nativeFallback', { reason: nativeReasonText(t, nativePhase.reason) })
          : (nativeReady === true ? t('tab.nativeHint') : t('tab.nativeConnecting')))
        : (engineMode !== 'classic' && settings !== null && nativeBridge.ok !== true
          ? t('tab.nativeUnsupported', { reason: nativeReasonText(t, nativeBridge.reason) })
          : null);

      const stage = h('div', {
        className: 'wb-stage',
        ref: stageRef,
        tabIndex: 0,
        role: 'group',
        'aria-label': t('tab.stageLabel'),
        'data-native': nativeReady === true ? 'true' : undefined,
        onKeyDown: onStageKeyDown,
      },
        nativeEligible === true
          ? h('div', {
            ref: nativeHostRef,
            className: 'wb-nativeHost',
            'data-visible': nativePhase.phase === 'mounting' || nativeReady === true ? 'true' : 'false',
            'aria-label': t('tab.nativeLabel'),
          })
          : null,
        nativeReady !== true && frame.status === 'ready' && frame.url !== null
          ? h('img', {
            ref: imgRef, className: 'wb-shot', src: frame.url,
            alt: t('tab.viewLabel'), draggable: false,
            onPointerDown: focusStage, onClick: onStageClick,
          })
          : null,
        overlay);

      const noticeRow = notice === null ? null : h('div', {
        className: 'wb-notice wb-noticeInline', 'data-tone': notice.tone, role: 'status', key: 'notice',
      }, notice.text);

      const statusbar = h('div', { className: 'wb-statusbar', key: 'statusbar' },
        h('span', { className: 'wb-statusText', 'data-native': nativeReady === true ? 'true' : undefined },
          nativeStatusText !== null ? nativeStatusText : t('tab.focusHint')),
        engine !== null && typeof engine.title === 'string' && engine.title !== ''
          ? h('span', { className: 'wb-pageTitle', title: engine.title }, engine.title)
          : null);

      return h('div', { className: 'wb-view' },
        h(Style, { key: 'style' }),
        toolbar,
        noticeRow,
        stage,
        statusbar);
    }

    // ---------------------------------------------------------------------
    // Styles: only `--dsw-alias-*` palette tokens (plus radius/focus-ring).
    // ---------------------------------------------------------------------

    const CSS = `
.wb-chip{display:inline-flex;align-items:center;gap:4px;height:28px;min-width:0;max-width:220px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap}
@media (hover:hover){.wb-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.wb-chip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.wb-chip:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.wb-chip[aria-pressed="true"]{color:var(--dsw-alias-label-primary)}
.wb-chip[data-busy="true"] .wb-chipLabel{opacity:.6}
.wb-chipLabel{min-width:0;overflow:hidden;text-overflow:ellipsis}
.wb-chipDot{flex:0 0 auto;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-idle-primary)}
.wb-chipDot[data-on="true"]{background:var(--dsw-alias-state-success-primary)}
@container (max-width:460px){.wb-chipLabel{display:none}}
.wb-spinner{display:inline-block;flex:0 0 auto;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:999px;animation:wb-spin 800ms linear infinite}
@keyframes wb-spin{to{transform:rotate(360deg)}}
.wb-page{display:flex;flex-direction:column;gap:16px;padding:4px 2px 28px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.wb-header{display:flex;flex-direction:column;gap:6px;min-width:0}
.wb-title{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}
.wb-desc{margin:0;color:var(--dsw-alias-label-secondary)}
.wb-muted{margin:0;color:var(--dsw-alias-label-secondary)}
.wb-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);min-width:0}
.wb-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.wb-cardTitle{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.wb-subTitle{margin:4px 0 0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.wb-pill{flex:0 0 auto;padding:1px 8px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.wb-pill[data-on="true"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.wb-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.wb-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}
.wb-label{color:var(--dsw-alias-label-primary);font-weight:500}
.wb-hint{margin:0;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.wb-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border:0.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease}
.wb-switch[data-on="true"]{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary)}
.wb-switch:disabled{opacity:.45;cursor:default}
.wb-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.wb-switchThumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.wb-switch[data-on="true"] .wb-switchThumb{transform:translateX(16px)}
.wb-status{display:flex;flex-direction:column;gap:0;margin:0;padding:10px 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.wb-statusRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:4px 0;min-width:0}
.wb-statusLabel{margin:0;flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.wb-statusValue{margin:0;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;text-align:right;word-break:break-all}
.wb-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.wb-fieldInline{flex:1 1 0}
.wb-fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.wb-input{height:28px;min-width:0;box-sizing:border-box;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.wb-input::placeholder{color:var(--dsw-alias-label-caption)}
.wb-input:focus{outline:none;border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.wb-input:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.wb-inputNum{width:92px;flex:0 0 auto}
.wb-select{height:28px;min-width:0;box-sizing:border-box;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.wb-select:focus{outline:none;border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.wb-select:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.wb-check{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;cursor:pointer}
.wb-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.wb-checkText{color:var(--dsw-alias-label-primary);font-weight:500}
.wb-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.wb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
@media (hover:hover){.wb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.wb-btn[data-primary="true"]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
@media (hover:hover){.wb-btn[data-primary="true"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}}
.wb-btn:disabled{opacity:.45;cursor:default}
.wb-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.wb-notice{padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-word}
.wb-notice[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.wb-notice[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.wb-engines{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.wb-engine{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.wb-engineIndex{flex:0 0 auto;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.wb-engineName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.wb-mini{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:24px;height:24px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
@media (hover:hover){.wb-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.wb-mini:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.wb-mini:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.wb-viewport{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.wb-view{display:flex;flex:1 1 auto;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base)}
.wb-toolbar{display:flex;align-items:center;gap:4px;flex:0 0 auto;padding:6px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-width:0}
.wb-tool{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
@media (hover:hover){.wb-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.wb-tool:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.wb-tool:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.wb-addressWrap{display:flex;align-items:center;flex:1 1 auto;gap:2px;min-width:0;height:28px;box-sizing:border-box;padding:0 2px 0 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}
.wb-addressWrap:focus-within{border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.wb-address{flex:1 1 auto;min-width:0;height:24px;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.wb-address::placeholder{color:var(--dsw-alias-label-caption)}
.wb-address:disabled{color:var(--dsw-alias-label-dimmed)}
.wb-go{width:24px;height:24px}
.wb-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-layer-2);outline:none;cursor:crosshair}
.wb-stage:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.wb-stage[data-native="true"]{cursor:default}
.wb-nativeHost{position:absolute;inset:0;display:none;background:var(--dsw-alias-bg-base)}
.wb-nativeHost[data-visible="true"]{display:block}
.wb-webview{display:flex;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}
.wb-shot{display:block;width:100%;height:100%;object-fit:fill;user-select:none}
.wb-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);text-align:center;cursor:default}
.wb-overlayTitle{margin:0;max-width:420px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.wb-overlayText{margin:0;max-width:420px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;word-break:break-word}
.wb-statusbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:0 0 auto;padding:4px 10px;border-top:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-width:0}
.wb-statusText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.wb-pageTitle{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.wb-noticeInline{flex:0 0 auto;margin:6px 8px 0}
.wb-tabTitleText{margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.wb-spinner{animation:none}.wb-switch,.wb-switchThumb{transition:none}}
`;

    // ---------------------------------------------------------------------
    // Registrations.
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        // Keep the native body mounted through tab switches only when this
        // renderer can host a guest at all (same rule as the builtin Browser).
        const desktopBridge = detectDesktopBridge();

        ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'dsh-web-browser: copy');

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          keepMounted: desktopBridge.ok === true,
          title: () => t('tab.title'),
          guide: [{ id: 'web-browser-view', order: 40, title: () => t('tab.title'), description: () => t('tab.guide') }],
        }), 'dsh-web-browser: tab type');

        ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: SECTION_ID,
          order: 5,
          locale: NS,
          inject: () => ({
            openView: () => { ctx.sidebarRight.openTab(TAB_KIND); },
          }),
        }, ComposerSwitch)), 'dsh-web-browser: composer switch');

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 70,
          label: () => t('section.label'),
          locale: NS,
          inject: () => ({}),
        }, SettingsSection)), 'dsh-web-browser: settings section');

        ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: SECTION_ID,
          order: 70,
        }, SettingsSectionIcon)), 'dsh-web-browser: settings icon');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
        }, WebBrowserBody)), 'dsh-web-browser: sidebar body');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          locale: NS,
        }, WebBrowserTitle)), 'dsh-web-browser: sidebar title');
      },
    };
  },
});
