# @debot/web — Agent Instructions

## Overview

WebUI（Vite + React 18 + antd 5 + react-router-dom 6）：实时信号流、信号历史与详情、规则/标签/策略编辑、通知中心、回放复盘、质量统计、设置，另含 `/notify` 通知小窗。生产构建产物 `dist/` 由服务端（8787）托管。

## Build & Run

```bash
pnpm --filter @debot/web dev        # vite（/api、/ext、/ui 代理到 127.0.0.1:8787）
pnpm --filter @debot/web build      # tsc --noEmit && vite build → dist/
pnpm --filter @debot/web preview    # 预览构建产物
pnpm --filter @debot/web typecheck  # tsc --noEmit
```

`@debot/shared` 经 vite alias 直接指向 TS 源（`../../packages/shared/src/index.ts`），保证 dev/build 一致。无测试，改动靠 typecheck + 验收路径。

## Project Structure

```
src/
├── App.tsx                  # 布局壳（Sider 导航 + 连接状态 + 全局告警）与路由
├── main.tsx                 # 入口
├── api.ts                   # REST 封装
├── ws.ts                    # WS 订阅（subscribe / subscribeStatus）
├── grades.tsx               # 等级徽章
├── notify/NotifyWindow.tsx  # /notify 通知小窗
└── pages/
    ├── Dashboard.tsx        # 实时流（/）
    ├── Signals.tsx          # 信号历史（/signals）
    ├── SignalDetail.tsx     # 信号详情
    ├── Rules.tsx            # 规则与标签（/rules，表单/JSON 双模式）
    ├── Notifications.tsx    # 通知中心（/notifications）
    ├── Replay.tsx          # 回放复盘（/replay）
    ├── Stats.tsx            # 质量统计（/stats）
    └── Settings.tsx         # 设置（/settings）
index.html                   # 应用根 HTML
vite.config.ts               # react 插件 + shared alias + dev 代理
```

## Code Style

- 函数组件 + hooks，返回类型 `JSX.Element`
- antd v5：经 `App as AntApp` 的 `useApp()` 取 notification 等上下文化 API
- UI 文案为中文；WS 状态经 `subscribeStatus` 驱动

```tsx
function Shell(): JSX.Element {
  const [connected, setConnected] = useState(false);
  const { notification } = AntApp.useApp();
  useEffect(() => subscribeStatus(setConnected), []);
```

## Boundaries

- ✅ **Always do:** 与服务端交互只走 `api.ts` / `ws.ts` 既有封装与 `@debot/shared` 契约类型
- ⚠️ **Ask first:** 修改导航结构 / 路由路径（`/notify` 小窗与书签依赖）；antd 大版本升级
- 🚫 **Never do:** 手改 `dist/`（生成产物，由服务端托管）；在前端实现交易相关功能
