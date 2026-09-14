# DeBot Signal Sidecar

DeBot AI Signal（debot.ai）信号的本地 Sidecar：浏览器扩展**被动捕获**页面信号 → 本地服务过滤/分级/富化 → WebUI 实时呈现、复盘与统计。**只做信号处理，不做自动交易，不接触任何账户凭证。**

完整需求见 `SPEC.md`，设计文档见 `docs/design-docs/active/`。

## 架构

```
packages/
  shared/          # P0 常量收口、信号契约、DeBot 响应解析（零依赖，禁 Node API）
  rules-engine/    # 规则 DSL 求值 + 规则集校验（纯函数，Vitest）
  simulator-core/ # 模拟交易引擎（纯函数，Vitest）
apps/
  extension/       # Chrome MV3 扩展（WXT）：MAIN world fetch/XHR hook → content 桥 → SW WS 客户端 + Side Panel
  server/         # Fastify + better-sqlite3：差分/评分/富化/通知/回放/统计/模拟账户/价格追踪
  web/            # Vite + React 18 + Ant Design 5：实时流/规则编辑器/回放/统计/设置 + /notify 通知小窗
```

- 单一端口 `127.0.0.1:8787`（可在配置改）：REST `/api/*`、扩展 WS `/ext`、WebUI WS `/ui`、WebUI `/`、通知小窗 `/notify`。
- 数据全存（含 REJECT），呈现层降噪。
- SQLite（WAL）本地库，首次启动自动入库默认规则集/策略版本快照。

## 环境要求

- Node.js 20+（开发机实测 24）
- pnpm 11（`npm i -g pnpm`）
- Chrome 116+（Side Panel 与活跃 WS 保活 Service Worker 需要）

## 快速开始

```bash
pnpm install          # better-sqlite3 等原生模块自动构建（构建许可已在 pnpm-workspace.yaml allowBuilds）
pnpm dev:server       # 启动本地服务（127.0.0.1:8787），首启自动打开 /notify 小窗
```

开发模式（另开终端）：

```bash
pnpm dev:web          # Vite dev server（/api 与 /ui 代理到 8787）
pnpm dev:extension    # WXT watch 模式
```

生产模式：先 `pnpm build:web`，服务端自动托管 `apps/web/dist`，无需单独跑 WebUI。

## 加载浏览器扩展（一次性）

1. `pnpm build:extension`
2. Chrome 打开 `chrome://extensions` → 开启「开发者模式」→ 「加载已解压的扩展程序」
3. 选择目录 `apps/extension/.output/chrome-mv3`
4. 打开 https://debot.ai 并登录（登录态保持在页面，Sidecar 不读取、不存储凭证）
5. 点击工具栏扩展图标打开 Side Panel，确认 WS 已连接（绿色 badge）；默认服务地址 `http://127.0.0.1:8787`，可在 Side Panel 底部修改并保存

## 常用命令

```bash
pnpm typecheck       # 全仓 tsc --noEmit
pnpm test            # rules-engine + simulator-core 单测（纯函数包）
pnpm build:web       # WebUI 产物（apps/web/dist）
pnpm build:extension # 扩展产物（apps/extension/.output/chrome-mv3）
pnpm build           # web + extension 全部构建
```

## 数据与配置

- 默认数据目录：`~/.debot-sidecar/`（数据库、规则/策略 JSON、自定义通知音、日志）
- 覆盖方式：环境变量 `DEBOT_SIDECAR_DATA_DIR=/path/to/dir`
- 运行时配置（通知阈值、保活、富化超时等）：WebUI「设置」页或 `PUT /api/config`，热生效
- 规则集/策略：WebUI「规则」页表单或 JSON 双模式编辑，任何变更产生新版本，可回滚
- 规则/评分/模拟引擎核心均为纯函数，改动可先 `pnpm --filter @debot/rules-engine test` 验证

## 验证清单（验收路径）

1. 服务启动：`pnpm dev:server` 后访问 `http://127.0.0.1:8787/`（WebUI）与 `/api/config`
2. 扩展连通：打开 debot.ai，Side Panel 出现实时信号；断开服务后扩展自动重连
3. 通知：设置页「测试通知」打开 /notify 小窗；等级 ≥ HIGH 弹卡（默认）
4. 静默保活：DeBot 页签保持前台即可；若页面静默超过阈值，扩展自动 reload（L1），持续静默触发告警（L3）
5. 回放与统计：规则页改阈值 → 产生新版本 → 回放页对比新旧版本筛选差异

## 安全边界

- 只读页面与公开行情 API（DexScreener），不调用任何交易/账户接口
- 服务仅监听 127.0.0.1，不对局域网暴露
- 不存储浏览器 Cookie/凭证；登录失效（Cloudflare 挑战）时仅提示用户手动处理
