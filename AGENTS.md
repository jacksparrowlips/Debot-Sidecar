# DeBot Signal Sidecar — Agent Instructions

## Overview

DeBot AI Signal（debot.ai）信号的本地 Sidecar：浏览器扩展**被动捕获**页面信号 → 本地服务过滤/分级/富化 → WebUI 实时呈现、复盘与统计。pnpm monorepo（ESM + TypeScript strict）。**只做信号处理，不做自动交易，不接触任何账户凭证。**

## Build & Run

```bash
pnpm install          # 安装依赖（better-sqlite3 等原生模块构建许可见 pnpm-workspace.yaml allowBuilds）
pnpm dev:server       # 启动本地服务（127.0.0.1:8787），首启自动打开 /notify 小窗
pnpm dev:web          # Vite dev server（/api、/ext、/ui 代理到 8787）
pnpm dev:extension    # WXT watch 模式
pnpm build            # 全部构建（pnpm -r build：web + extension）
pnpm build:web        # WebUI 产物（apps/web/dist）
pnpm build:extension  # 扩展产物（apps/extension/extension-build/chrome-mv3）
pnpm typecheck        # 全仓 tsc --noEmit
```

环境要求：Node 20+、pnpm 11、Chrome 116+（Side Panel 与活跃 WS 保活 Service Worker）。生产模式先 `pnpm build:web`，服务端自动托管 `apps/web/dist`，无需单独跑 WebUI。

## Testing

```bash
pnpm test                                   # pnpm -r test：以下三包全跑
pnpm --filter @debot/rules-engine test      # 规则引擎（vitest run）
pnpm --filter @debot/simulator-core test    # 模拟引擎（vitest run）
pnpm --filter @debot/server test            # 服务端（tsx --test tests/*.test.ts）
```

- `packages/rules-engine`、`packages/simulator-core`：Vitest 纯函数单测（`tests/*.test.ts`）
- `apps/server`：node:test（`tests/ws.test.ts`）
- `packages/shared`、`apps/web`、`apps/extension`：无测试，靠 `pnpm typecheck` + README「验证清单」验收路径
- 提交前：`pnpm typecheck && pnpm test` 必须通过

## Project Structure

```
packages/
  shared/          # 零依赖共享内核：P0 常量、Signal 契约、DeBot 解析（禁 Node API）
  rules-engine/    # 规则 DSL 求值 + 规则集校验（纯函数，Vitest）
  simulator-core/  # 模拟交易引擎（纯函数，Vitest）
apps/
  extension/       # Chrome MV3 扩展（WXT）：MAIN world hook → content 桥 → SW WS 客户端 + Side Panel
  server/          # Fastify + better-sqlite3：差分/评分/富化/通知/回放/统计/模拟账户/价格追踪
  web/             # Vite + React 18 + antd 5：WebUI + /notify 通知小窗
docs/
  design-docs/active/   # 设计文档
  debug-notes/           # 排查交接笔记（按日期命名）
SPEC.md           # 需求规格（权威，代码注释按 § 章节引用）
```

- 单一端口 `127.0.0.1:8787`：REST `/api/*`、扩展 WS `/ext`、WebUI WS `/ui`、WebUI `/`、通知小窗 `/notify`
- 数据全存（含 REJECT），降噪在呈现层
- 数据目录 `~/.debot-sidecar/`（SQLite WAL 库 + rules/tags/strategy/config JSON + 自定义通知音），环境变量 `DEBOT_SIDECAR_DATA_DIR` 覆盖

## Code Style

- TypeScript strict（`tsconfig.base.json`：ES2022、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`moduleResolution: bundler`）
- 类型导入一律 `import type { ... }`；ESM 相对导入带 `.js` 后缀（如 `./config/loader.js`）
- 中文注释并引用 SPEC 章节（如 `SPEC §7.10`）；分节注释用 `// ─── 标题 ───`
- 常量 SCREAMING_SNAKE_CASE；rules-engine / simulator-core 为纯函数包，禁止 I/O

```ts
/** 服务数据目录与文件名（~/.debot-sidecar，SPEC §10；环境变量 DEBOT_SIDECAR_DATA_DIR 覆盖） */
export const DATA_DIR_ENV = "DEBOT_SIDECAR_DATA_DIR";
export const DB_FILE_NAME = "sidecar.db";
```

## Boundaries

- ✅ **Always do:** 提交前跑 `pnpm typecheck && pnpm test`；规则/模拟引擎改动必须带 Vitest 用例；WS/REST 契约改动从 `packages/shared/src/contracts.ts` 出发双端同步
- ⚠️ **Ask first:** 新增依赖（原生模块还需改 `pnpm-workspace.yaml` allowBuilds）；修改 SQLite 表结构；修改规则 DSL 语义；修改 WS/REST 契约
- 🚫 **Never do:** 实现任何自动交易、读取/存储账户凭证或 Cookie；把服务暴露到 127.0.0.1 之外；手改生成产物（`node_modules/`、`apps/web/dist/`、`apps/extension/extension-build/`、`.wxt/`）；违反 SPEC §0 实现守则与 §3 已拍板决策

## Documentation

- 需求规格（权威）：`SPEC.md` — §0 实现守则、§3 已确认决策、§7 组件规格、§10 数据模型、§11 WS/REST 契约
- 设计文档：`docs/design-docs/active/2026-09-13-debot-signal-sidecar.md`
- 排查笔记：`docs/debug-notes/`（按 `YYYY-MM-DD-主题.md` 命名）
