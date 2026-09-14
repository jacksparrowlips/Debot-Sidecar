# 排查交接：Side Panel badge 恒显「未连接」（WS 实际已连通）

> 交接时间：2026-09-14。撰写：实现本项目的 agent（上下文被压缩，本文自包含，无需对话历史）。
> 目的：接管一个高度反直觉的 UI 状态 bug——**所有机器级证据都表明 WebSocket 已连通，但 Side Panel 的 badge 永远显示「未连接」**。

## TL;DR

- 服务端 Fastify 监听 `127.0.0.1:8787`，健康（HTTP 200）
- `lsof` 证实 **Edge(Microsoft)→8787 的 WS 连接持续 ESTABLISHED**（多次检查均存活，端口还换过一次 = SW 重连过，连接是活的）
- 但 Edge 的 Side Panel badge 恒「未连接」，用户已重载/重新导入扩展、F5 debot 页、重开 Side Panel，均无效
- **推断问题在 SW↔Side Panel 的消息链路（状态快照查询与广播均未生效），而非 WS 本身**

## 项目与环境

- 仓库：`/Users/lip/Debot_Sidecar`（pnpm monorepo，git 已提交至 0163093）
- 技术栈：服务 Fastify4 + @fastify/websocket + better-sqlite3（`apps/server`）；扩展 WXT 0.19.29 + vanilla TS（`apps/extension`）；WebUI Vite+React+AntD（`apps/web`）
- 用户浏览器：**Edge（Chromium 内核），macOS**，以「加载解压缩的扩展」方式安装 `apps/extension/extension-build/chrome-mv3`
- 服务启动：双击项目根 `启动Sidecar.command`（= `pnpm dev:server` = tsx 直跑 `apps/server/src/index.ts`），node PID 13313
- 复现路径：服务在跑 → Edge 装扩展 → 打开 https://debot.ai（已登录）→ 打开 Side Panel → badge「未连接」（期望「已连接」绿色）

## 消息链路（理解问题的核心）

```
[background.ts SW]
  connectWs() → new WebSocket("ws://127.0.0.1:8787/ext")   ← 已 ESTABLISHED（lsof 证实）
  onopen → broadcastToPages({type:"ws-status", connected:true})   ─┐
  onMessage case "get-ws-status" → return Promise.resolve({connected}) ─┤
                                        browser.runtime.sendMessage / onMessage
[sidepanel/sidepanel.ts（扩展页面）]
  onMessage("ws-status") → 更新 badge
  启动时 sendMessage({type:"get-ws-status"}) → 用响应渲染 badge
[content.ts] → sendMessage({type:"get-keepalive"}) → 拿 L0 配置（同链路，同样疑似失效）
```

badge 初始 HTML 文本就是「未连接」（`sidepanel/index.html` 的 `#ws-badge`）。更新只靠两条路：①收到 `ws-status` 广播；②打开时的快照查询。两条路似乎都没生效。

## 机器级已验证事实（均可复现执行）

1. `curl http://127.0.0.1:8787/api/config` → 200
2. `lsof -nP -iTCP:8787` → `node 13313 LISTEN` + `Microsoft <pid> → ESTABLISHED`（**Edge 到服务的 WS 活着**；两次检查间源端口从 54643 变为 55620，说明期间 SW 重连过至少一次且成功）
3. `curl` 手工 WS 握手 `/ui`、`/ext` → 101（服务端 WS 升级正常）
4. `node --check .../background.js` → 语法 OK
5. 产物 `grep 'get-ws-status'` → `return Promise.resolve({connected:...})` 已在（15:48 构建版本）
6. 全仓 `pnpm -r typecheck` / `pnpm -r test` 通过
7. `/api/signals` 空（尚无信号入库——**注意：这也是个未验证点，用户页面尚未产生过可见信号流**）

## 已做修复（均已提交、已构建进产物）

| commit | 内容 | 结果 |
|---|---|---|
| `dc84821` | Side Panel 打开时发 `get-ws-status` 拉快照（此前 badge 只靠状态变化广播，打开晚于连接则永远错过） | 未解决 |
| `0163093` | SW onMessage 的 `get-keepalive`/`get-ws-status` 响应改为 `Promise.resolve(...)`。根因分析：WXT 内置 webextension-polyfill 在 Chromium 下，onMessage 监听器**同步返回普通对象**会 `return false` → 立即关闭响应通道 → 调用方 `sendMessage` reject（"The message port closed before a response was received."）| 用户操作后仍未解决 |

另外的历史噪音（非问题）：错误面板里的 `ERR_CONNECTION_REFUSED`（服务未启动期）、重载产生的 "message port closed"。

## 核心矛盾（待解）

WS 在 TCP 层 ESTABLISHED，服务端正常收发——为什么 badge 两条更新路径（快照+广播）都无效？

## 疑点假设（按优先级）

1. **SW→Side Panel 方向的 runtime 消息从未送达**。polyfill 的 SW→页面广播在此 Edge 版本有坑？或 Side Panel 页面上下文没收到 `runtime.onMessage`。验证：panel 控制台手动 `browser.runtime.sendMessage({type:"get-ws-status"}).then(console.log, console.error)`（终极单点测试，能直接把问题切成「通道坏了」还是「渲染坏了」）。
2. **用户加载的产物不是最新构建**（Edge 解压扩展的缓存/重载时 Side Panel chunk 未刷新；WXT chunk 文件名带 hash：`chunks/sidepanel-D_43xulS.js`，若 panel 加载的是旧 hash 文件则新代码没跑）。验证：panel 控制台 `document.scripts` 或 Sources 面板看实际加载的 chunk 名是否 `sidepanel-D_43xulS.js`；或直接看 Sources 里 sidepanel.js 是否含 `get-ws-status` 字样。
3. **时序竞争**：panel 打开瞬间 SW 冷启动、WS 恰在 CONNECTING → 快照返回 false（正确行为）→ 数秒后 `onopen` 广播 true → panel 应刷新。若广播送达失败即回到疑点 1。
4. **Edge 特有**：Edge 的 Side Panel/runtime 消息、SW WS 保活策略与 Chrome 差异。
5. **服务端主动断开 /ext 或从不推送**：服务端 `/ext` 握手后是否有 keepalive/ping，或连接建立后静默半死（TCP ESTABLISHED 但服务端 socket 处理有问题）？验证：服务端窗口日志 + ws.ts 的连接处理逻辑。

## 建议诊断步骤（拿到机器就能做）

1. **Side Panel 控制台**（右键 Side Panel → 检查 → Console）：
   ```js
   browser.runtime.sendMessage({type:"get-ws-status"}).then(console.log, console.error)
   ```
   - 响应 `{connected:true}` → 通道没坏，问题在 sidepanel.ts 渲染/加载的旧 chunk → 查疑点 2
   - reject（port closed）→ polyfill 响应仍坏 → 深挖 wxt/browser polyfill 版本行为
   - 永久 pending → 通道/SW 未激活
2. **SW 控制台**（edge://extensions 卡片「Service worker」链接）：
   - Console 有无报错；Network/WS 面板看 `ws://127.0.0.1:8787/ext` 的帧（服务端是否推过 `signal.scored` 等广播）
   - 手动 `chrome.runtime.sendMessage({type:"ping"})` 观察面板方向
3. **对照 Network**：panel 里 `fetch /api/signals` 是否 200（panel 直连服务路径正常与否）
4. 需要的话在 background.ts/sidepanel.ts 加 `console.log`（`pnpm build:extension` 后 edge://extensions ↻），逐跳打点：`onopen`、`broadcastToPages` 前后、panel `onMessage` 入口。
5. 服务端：`apps/server/src/gateway/ws.ts` 检查 `/ext` onOpen 是否有日志/心跳；用户终端窗口（双击启动的那个）滚动日志里找 ext 连接记录。

## 关键文件索引（仓库相对路径）

| 文件 | 角色 |
|---|---|
| `apps/extension/entrypoints/background.ts` | SW：`connectWs`(L45-81)、`broadcastToPages`(L119-121)、onMessage switch(L131-192) |
| `apps/extension/entrypoints/sidepanel/sidepanel.ts` | badge 更新（onMessage L101-123 / 快照查询 L151-162） |
| `apps/extension/entrypoints/sidepanel/index.html` | `#ws-badge` 初始「未连接」 |
| `apps/extension/entrypoints/content.ts` | L0 查 `get-keepalive`（L48-52，同样疑似拿不到） |
| `apps/extension/wxt.config.ts` | outDir `extension-build`；manifest（host_permissions 含 `http://127.0.0.1/*`） |
| `apps/server/src/gateway/ws.ts` | `/ext`、`/ui` 两个 WS 端点 |
| `apps/server/src/index.ts` | 服务入口（listen 127.0.0.1:8787） |
| `packages/shared/src/p0.ts` | `DEFAULT_SERVER_PORT=8787`、`WS_PATH_EXT="/ext"` |
| `apps/extension/extension-build/chrome-mv3/` | Edge 加载的产物目录（15:48 构建 = 含两轮修复） |

## 已知次要问题（交接顺带，不阻塞主线）

- `defineBackground(async () => …)`：WXT 打包层要求 main 同步，async 会产生一条 console.warn（非致命；连接已证明能建立）
- `refreshConfig` 靠 60 分钟 setInterval，SW 休眠时不执行（alarm tick 里未调用），实际几乎不刷新——与主线无关
