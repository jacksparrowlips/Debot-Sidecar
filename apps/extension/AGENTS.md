# @debot/extension — Agent Instructions

## Overview

Chrome MV3 扩展（WXT 构建），「薄捕获层」：MAIN world hook 被动捕获 debot.ai 页面 fetch/XHR → content 桥 → Service Worker WS 客户端转发本地 Sidecar，并承担系统通知、Side Panel 与保活（L1 静默自动 reload）。SPEC §4：薄扩展、胖服务——业务逻辑不进扩展。

## Build & Run

```bash
pnpm --filter @debot/extension dev        # wxt watch 模式
pnpm --filter @debot/extension build      # wxt build → extension-build/chrome-mv3
pnpm --filter @debot/extension typecheck  # wxt prepare && tsc --noEmit
```

加载（一次性）：`chrome://extensions` 开启开发者模式 → 「加载解压缩的扩展」选 `apps/extension/extension-build/chrome-mv3`（Edge 用 `edge://extensions`）。产物目录故意不用 WXT 默认 `.output/`——macOS 文件选择器隐藏点开头目录，Edge 加载时找不到。无测试，改动靠 typecheck + Side Panel 实连验收。

## Project Structure

```
entrypoints/
├── background.ts      # MV3 SW：WS 客户端连 /ext、chrome.alarms 每分钟兜底重连、L1 静默 reload、系统通知
├── content.ts         # content script：页面 ↔ SW 桥
├── injected.ts        # MAIN world 注入：fetch/XHR hook（web_accessible_resources 暴露给页面）
└── sidepanel/         # Side Panel（index.html + 原生 TS/CSS，无框架）：连接状态、服务地址配置
wxt.config.ts          # outDir=extension-build、manifest（permissions / host_permissions / side_panel）
public/icon/           # 图标
```

## Code Style

- 浏览器 API 经 `import { browser } from "wxt/browser"`
- SW 模块级可丢状态注释明确（如 `seenFingerprints`：「SW 回收即清空，无妨」）
- 常量 SCREAMING_SNAKE_CASE；中文注释引用 SPEC（§7.1 / §7.8 / §7.6.5）

```ts
const DEFAULT_SERVER_BASE = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;
const RECONNECT_DELAY_MS = 5_000;
```

## Boundaries

- ✅ **Always do:** 捕获只读转发（URL+body 指纹去重）；断线走既有 `scheduleReconnect` 重连；未连接时避免重连风暴（`wsWanted`）
- ⚠️ **Ask first:** 修改 manifest（permissions / host_permissions / web_accessible_resources）；修改与 Sidecar 的 WS 消息契约（应改 `@debot/shared` contracts 并双端同步）
- 🚫 **Never do:** 读取/存储登录凭证或 Cookie；在扩展内做信号过滤/评分/富化（应在服务端）；手改 `extension-build/`、`.wxt/`（生成产物）
