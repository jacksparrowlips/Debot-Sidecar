# @debot/shared — Agent Instructions

## Overview

零依赖共享内核，同一份代码跑在浏览器扩展 SW、Node 服务端、WebUI 三端：P0 事实收口、常量、核心类型、WS/REST 契约、DeBot 响应解析、相关性判定与默认规则/策略/配置。

## Build & Run

```bash
pnpm --filter @debot/shared typecheck   # tsc --noEmit
```

无构建步骤：`package.json` 的 `exports` 直接指向 TS 源 `./src/index.ts`，由各端（Vite / WXT / tsx）直接消费。无测试，改动以 typecheck + 下游包测试为准。

## Project Structure

```
src/
├── p0.ts         # P0 占位与事实收口（SPEC §9）
├── constants.ts  # 数据目录/文件名、WS 路径等常量（SPEC §10）
├── types.ts      # Signal 等核心类型
├── contracts.ts  # WS/REST 消息契约，双端共享（SPEC §11）
├── parse.ts      # DeBot 页面响应解析
├── relevance.ts  # 信号相关性判定
├── defaults.ts   # 默认规则集/策略/配置
└── index.ts      # 统一 re-export（带 .js 后缀）
```

## Code Style

- 零依赖、零 Node API（禁 `fs`/`path`/`process` 等——本包同时跑在扩展与浏览器环境里）
- 类型导入 `import type`；中文 JSDoc 注明 SPEC 章节
- 常量 SCREAMING_SNAKE_CASE：

```ts
/** WS 路径：扩展连接 /ext，WebUI 连接 /ui */
export const WS_PATH_EXT = "/ext";
export const WS_PATH_UI = "/ui";
```

## Boundaries

- ✅ **Always do:** 新类型/契约先写在本包再供各端引用；改完跑 `pnpm --filter @debot/shared typecheck`
- ⚠️ **Ask first:** 修改 `Signal`、广播消息、`SidecarConfig` 等契约类型（三端同时受影响，需同步改完再提交）
- 🚫 **Never do:** 引入任何第三方依赖或 Node 专属 API；各端绕过 `index.ts` 从深路径引用内部文件
