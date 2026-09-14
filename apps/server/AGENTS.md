# @debot/server — Agent Instructions

## Overview

本地服务端（Fastify + better-sqlite3，仅监听 `127.0.0.1:8787`）：信号差分、规则评分分级、富化、通知、回放复盘、统计、模拟账户与价格追踪；生产模式托管 `apps/web/dist` 并提供 `/notify` 通知小窗。WS 端点：扩展 `/ext`、WebUI `/ui`。

## Build & Run

```bash
pnpm --filter @debot/server dev        # tsx watch src/index.ts（改代码自动重启）
pnpm --filter @debot/server start      # tsx src/index.ts（无 watch）
pnpm --filter @debot/server typecheck  # tsc --noEmit
```

启动顺序（`src/index.ts`）：resolvePaths → ensureDirs → openDb → loadConfig → 首启落默认规则/策略并入库版本快照（幂等）→ setContext → registerWs / registerRest → startPriceTracker / startSimulatorLoop → listen 127.0.0.1 → 自动打开 /notify 小窗。

## Testing

```bash
pnpm --filter @debot/server test                              # tsx --test tests/*.test.ts
pnpm --filter @debot/server exec tsx --test tests/ws.test.ts  # 单文件
```

框架 node:test（tsx 加载器），现有 `tests/ws.test.ts`。涉及 WS/REST 行为的改动应在此扩展用例。

## Project Structure

```
src/
├── index.ts              # 入口（初始化顺序、优雅关闭）
├── context.ts            # 全局 AppContext（setContext / getCtx）
├── config/               # paths.ts 数据目录解析；loader.ts 配置/规则/标签/策略加载 + 首启默认值
├── gateway/              # rest.ts（REST /api/*）、ws.ts（/ext /ui 广播）
├── pipeline/             # handleCapture.ts 差分+富化+评分主流程；scoring.ts
├── enrichment/           # registry.ts、heatDexscreener.ts（公开行情，只读）
├── notifier/             # notifier.ts 系统通知 + 通知中心
├── price/tracker.ts      # 价格补抓
├── replay/replayer.ts    # 历史回放（按规则版本）
├── simulator/simulator.ts # 模拟账户重算循环
├── stats/statsService.ts # 质量统计
├── store/                # db.ts（SQLite WAL）、signals.ts、misc.ts（规则/策略版本快照）
└── util/                 # open.ts 自动开浏览器、rateLimiter.ts
tests/
└── ws.test.ts
```

主要 REST 路由（`src/gateway/rest.ts`）：`GET /api/signals(/:id)`、`GET/PUT /api/rules`、`GET/PUT /api/tags`、`GET/PUT /api/strategies`、`GET /api/stats`、`POST /api/replay`、`GET /api/replays(/:id)`、`GET/PUT /api/config`、`GET /api/notifications`、`POST /api/sounds`。

## Code Style

- 相对导入带 `.js` 后缀：`import { registerWs } from "./gateway/ws.js"`
- 全局上下文经 `context.ts` 存取（构造期 `setContext`，运行期 `getCtx`）
- 数据目录 `~/.debot-sidecar/`（`DEBOT_SIDECAR_DATA_DIR` 覆盖）：`sidecar.db`（WAL）、`rules.json` / `tags.json` / `strategy.json` / `config.json`、`sounds/`
- 规则/策略任何变更产生新版本快照（版本化，可回滚/回放）

```ts
const ruleset = loadRuleset(paths);
if (ruleset.version > maxRuleVersion(db)) saveRuleVersion(db, ruleset, Date.now());
setContext({ db, paths, config, ruleset, tags, strategy, broadcast });
```

## Boundaries

- ✅ **Always do:** 契约类型从 `@debot/shared` 引用；数据全存（含 REJECT），降噪放呈现层；错误处理防数据丢失
- ⚠️ **Ask first:** SQLite 表结构变更；better-sqlite3 升级（原生模块，受 allowBuilds 约束）；WS/REST 契约变更（先改 shared/contracts.ts）
- 🚫 **Never do:** 监听 127.0.0.1 之外的地址；调用交易/账户接口；存储 Cookie/凭证；绕过版本快照直接改历史规则版本
