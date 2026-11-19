# 方案 B：用「内置渲染器」承载受控浏览器（实验性）

> 状态：**已实现（实验性）**。默认关闭（`engineMode: 'classic'`），Desktop-only，Web 端与失败路径全部回退到现有 CDP（classic）引擎。设计目标与当前实现的差异见文末「实现现状与差异」。
> 目标不是替换现有方案，而是在 Desktop 上提供一条"原生合成、60fps 旁观"的可选路径，并保持 `browser` 工具的行为与安全边界不变。

## 1. 为什么可行（一句话）

DSH Desktop 的渲染进程里存在一个全局桥 `globalThis.dshDesktop.browser`（`protocolVersion === 1`），内置 Browser 正是用它：

```ts
acquire(workspace) -> { lease, partition }
release(lease)
onOpenRequested(lease, cb)
```

拿到 `lease` 后可以 `document.createElement('webview')`，设置 `name=lease`、`partition`、`src=about:blank#lease`，由主进程审批并托管 guest。guest 不注入 Node/Electron 权限，下载/弹窗/权限按 DSH 策略执行。

## 2. 总体架构：双引擎 + 统一门面

```
                       ┌─────────────────────────────┐
                       │  lib/tools.js  (browser 工具) │
                       └──────────────┬──────────────┘
                                      │ 同一套 action
                       ┌──────────────▼──────────────┐
                       │  BrowserFacade (lib/engine.js)│
                       │  status/navigate/read/click/  │
                       │  type/key/scroll/act/screenshot│
                       └───────┬───────────────┬──────┘
                    mode=native│               │mode=cdp / fallback
              ┌────────────────▼───┐   ┌───────▼─────────────────┐
              │ NativeEngine       │   │ BrowserEngine (现有)     │
              │ Host 侧命令队列      │   │ 独立 Edge + CDP          │
              │ 通过 HTTP 桥委派     │   │ 直接执行                  │
              └────────┬───────────┘   └─────────────────────────┘
                       │ 命令/结果（HTTP 轮询）
              ┌────────▼────────────────────────────────────────┐
              │ client.js: NativeHost（右侧栏 tab 内）            │
              │ detect bridge → acquire → <webview> → 执行命令    │
              └─────────────────────────────────────────────────┘
```

### 2.1 Host 侧（`lib/`）
- 新增 `NativeEngine`：实现与 `BrowserEngine` 相同的方法签名（`status`、`navigate`、`read`、`click`、`clickAt`、`typeText`、`pressKey`、`scroll`、`waitFor`、`evaluate`、`captureJpeg`、`newTabPage`、`back/forward/reload`）。
- 内部维护：命令队列、`pending` map（id → resolve/reject + 超时）、最近一次状态缓存（url/title/loading/capture）。
- `status()` 返回统一结构，额外加 `mode: 'native' | 'cdp'`、`native: { available, protocolVersion, reason, tabOpen }`。
- 截图：`capture` 命令由客户端 `webview.capturePage()` 得到 NativeImage → `toJPEG(60)` → base64 → 结果返回 Host；Host 转 Buffer，继续走现有 `/frame` 与 `screenshot` 内联图片逻辑。
- 无客户端在线（tab 未挂载）时：native 模式下命令直接失败并触发自动回退（见 §5）。

### 2.2 Client 侧（`client.js`）
- 能力探测：`globalThis.dshDesktop?.browser` 存在且 `protocolVersion === 1`。
- `NativeHost`：在右侧栏 `web-browser` tab 内挂载 `<webview>`（替换现在的 `<img>` 帧画面），`keepMounted: true` 以保留页面状态。
- 执行循环：短轮询 `GET /web-browser/bridge/next?session=…`（40ms；空闲退避到 200ms），收到命令后：
  - `navigate` → `webview.loadURL(url)`
  - `evaluate` → `webview.executeJavaScript(expr)`
  - `read` → 用与 CDP 相同的提取脚本 + `executeJavaScript`
  - `click/clickAt` → 定位脚本 + `webview.sendInputEvent`（mouseDown/mouseUp 或 click）
  - `type` → `sendInputEvent` 字符事件（或 `executeJavaScript` 聚焦 + `insertText` 不可用时的替代）
  - `key` → `sendInputEvent` keyDown/char/keyUp
  - `scroll` → `sendInputEvent` mouseWheel
  - `waitFor` → 客户端内轮询 `executeJavaScript`
  - `capture` → `capturePage()` → JPEG → base64
  - `state` → `getURL/getTitle/isLoading`
- 结果回传：`POST /web-browser/bridge/result` `{ id, ok, value | reason }`。
- 视口：webview 以容器 100% 填充；`ResizeObserver` 仅更新上报（无 CDP 视口概念）。

## 3. 协议（新增路由，全部走现有同源守卫）

```
GET  /web-browser/bridge/next?session=<id>&waitMs=40
  -> 200 { id, command, params } | 204 (无命令)
POST /web-browser/bridge/result
  { id, ok, value?, reason? }
GET  /web-browser/bridge/status
  -> { available, protocolVersion, mode, tabOpen, fps }
```

- 命令 id 单调递增；Host 端 5s 超时；结果未知 id 直接丢弃。
- 路由沿用 `Sec-Fetch-Site` + `application/json` 守卫；不新增鉴权模型。
- `tools.js` 无需改动：所有 action 走 `BrowserFacade`。

## 4. 设置与开关（默认关）

设置页"高级"新增：

| 键 | 默认 | 说明 |
|---|---|---|
| `engineMode` | `classic` | `classic`（独立 Edge，稳定）/ `native`（实验：内置渲染器，仅 Desktop）/ `auto`（能用就用 native，否则 classic） |
| `nativeFallbackNotice` | true | 回退时在设置页/视图里显示一行原因 |

功能探测失败或 `acquire()` 失败时：自动落到 classic，并在 `status().native.reason` 写明原因（不弹错、不白屏）。

## 5. 失败与降级矩阵

| 场景 | 行为 |
|---|---|
| Web 端（没有 `dshDesktop`） | 探测失败 → classic，设置项显示"当前环境不支持" |
| `protocolVersion !== 1` | 同上 |
| `acquire()` 失败/超时（2s） | 标记本会话不可用 → classic |
| webview 未挂载（用户关了视图） | native 命令返回"原生视图未打开"；`auto` 模式下一次动作前自动请求打开 tab（复用 `lastActionAt` 机制），仍失败则 classic |
| 页面导航到下载/弹窗 | 遵循 DSH 主进程策略：下载被拒、批准后的弹窗走 `onOpenRequested` → 同标签导航或新开 tab（与内置 Browser 一致） |
| 插件重载/DSH 升级 | 重新探测；协议不匹配自动回退 |
| 页面崩溃（guest 崩溃） | 捕获 `crashed` 事件 → 标记不可用 → classic，提示重开 |

## 6. 安全边界（与现状对比）

- **不变**：guest 沙箱、不注入 Node/Electron、页面内容不可信、`browser` 工具只暴露受控动作、路由同源守卫、`allowEval`/私网拦截/清档开关继续生效。
- **新增风险**：借用的是**私有桥**（非插件契约）；页面活在 DSH 宿主渲染进程里（与内置 Browser 相同模型）；存储分区按 workspace，cookie 不跨应用重启保留；下载/权限受限。
- **控制**：设置在"高级"中，默认关；打开时显示一行"实验性"说明；`bridge/status` 暴露 `available/reason` 便于排查。

## 7. 实施里程碑

- **M1 · Spike（约半天）**
  - 探测 + `acquire` + 挂 webview + `navigate`/`evaluate`/`capture` + 轮询桥 + `engineMode=native` 开关 + 手动回退。
  - 验收：Desktop 下右侧栏显示原生页面；`browser state/read/open/screenshot` 可用；`/frame` 返回截图；关闭开关回到 classic。
- **M2 · 动作对齐（约 1 天）**
  - click/type/key/scroll/waitFor/act/back/forward/reload 全部对齐；截图内联；`/state` 增加 mode/native 字段；视图地址栏/按钮在 native 下继续可用。
- **M3 · 打磨（约半天）**
  - `auto` 模式、tab 关闭自动重开、`onOpenRequested` 处理、崩溃回退；bridge 协议单测（离线模拟）；README/设置文案；性能与延迟记录。

## 8. 验收标准（量化）

| 项 | 目标 |
|---|---|
| 旁观看感 | 原生合成，滚动/动画接近 60fps（肉眼） |
| 动作延迟 | 单击工具侧 ≤ 120ms（Host↔renderer 40ms 轮询 + 页面响应） |
| 截图清晰度 | `capturePage` 的 DPR 输出（≥ 现有设备像素） |
| 回退 | Web 端、协议不匹配、acquire 失败、tab 未开 → 100% 落到 classic，工具不报异常 |
| 兼容 | `browser` 工具 16 个 action 在两种模式下行为一致（除模式特有字段） |

## 9. 未决问题（spike 先验证）

1. `<webview>` 的 `sendInputEvent` 能否可靠产生文本输入与快捷键（必要时降级为聚焦 + `executeJavaScript` 派发，或仅用 native 显示 + 消息提示输入受限）。
2. `acquire(workspace)` 的 `workspace` 取值：需要从会话上下文拿 canonical 工作区路径（可能复用一个固定 key 导致分区共享，需要验证）。
3. 与内置 Browser 标签的租约/分区是否互相干扰（同一 workspace 下多 guest）。
4. `capturePage` 在隐藏/未聚焦 webview 上的可用性。
5. 插件 client 模块能否稳定拿到 `globalThis.dshDesktop`（内置包能，plugin 理论上同渲染进程，需实测）。

## 10. 明确不做

- 不改 DSH 核心、不替换默认引擎、不在 Web 端尝试 iframe 控制。
- 不接触 Node/Electron 权限，不绕过主进程租约策略。
- 不在 native 模式里引入新的鉴权模型；复用现有同源守卫。

## 11. 实现现状与差异

以下按实际代码记录设计稿与实现的偏差（设计目标仍以上文为准）：

- **门面位置**：统一门面是 `index.js` 的 `createEngineFacade`，不是 §2 图中的 `lib/engine.js`（该文件不存在）；原生引擎在 `lib/native.js`；`lib/tools.js` 的 action 集合没有因原生引擎改动。
- **状态字段**：`/bridge/status` 返回 `{ ok, mode, native, pending }`，没有 `fps` 字段；`/state` 的 `engine` 额外带 `mode`（`native` | `classic`）、`degradedReason` 和 `native { available, protocolVersion, tabOpen, reason }`。
- **无会话绑定**：没有 `?session=` 租约绑定，`/bridge/hello`、`/bridge/next`、`/bridge/result` 不按 session 区分，只服务当前挂载的一个原生视图。
- **超时**：Host 侧命令超时默认 8s、navigate 20s、capture 10s（§3 的 5s 未采用）；客户端另有 9s / 16s / 14s 的兜底。
- **在线判定与回退**：客户端轮询 `/bridge/next`，2s 内有轮询即 `tabOpen = true`；`auto` 仅在 `available && tabOpen` 时优先原生，不可用时逐次回退到 classic 并记录 `degradedReason`，不会自动拉起侧栏标签；`native` 模式下直接返回工具错误，不崩溃。
- **`/frame` 时序**：原生模式在第一次 `capture` 结果到达前返回 503（“还没有帧”）；原生截图按需采集，不持续推流。
- **视口**：原生模式没有 CDP 视口模拟，`<webview>` 直接铺满容器 CSS 像素；`/viewport` 上报只用于诊断（同时仍会镜像到经典引擎的 CDP override）。
- **搜索**：始终走经典引擎的一次性 CDP target（`searchFrom` 委派给 `BrowserEngine`），不会导航可见的原生页面。
- **profile/分区**：原生视图的分区归 DSH 管理，Host 的 `clearProfile` 删不掉它，只清插件自己的经典 profile 并返回说明。
- **未实现项**：`nativeFallbackNotice` 设置项不存在（回退原因直接显示在侧栏视图状态行）；`onOpenRequested` 未接管，弹窗/下载按 DSH 主进程默认策略处理。
