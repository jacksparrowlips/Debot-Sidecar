# DeBot AI Signal Sidecar — 实现 SPEC

- 日期：2026-09-13
- 交付对象：实现 Agent（自包含规格，无需其他上下文）
- 设计来源：`docs/design-docs/active/2026-09-13-debot-signal-sidecar.md`（本 SPEC 与其内容一致并整合了 2026-09-13 补充需求，实现以本 SPEC 为准）
- 平台：macOS 优先（后续按需移植 Windows）

---

## 0. 实现 Agent 必读守则（硬约束）

1. **仓库现状**：仓库内仅有 `docs/`、`.gitignore`、本 SPEC。从零搭建，无既有代码，不存在"参考现有框架"。
2. **环境事实**：macOS；Node >= 20 LTS；pnpm 包管理器；git 已初始化（main 分支）。
3. **禁止幻觉**：本文所有标注 `【P0 待确认】` 的值（URL、字段、协议），一律用常量占位并集中收口在 `packages/shared/src/p0.ts`（见 §9），**禁止编造真实值**。P0 抓包结果出来后只改这一个文件即可接入。
4. **不确定就问用户**：遇到本 SPEC 未覆盖的实现决策（库选择、字段命名、UI 细节等），向用户提问确认后再动手，禁止猜测。
5. **边界**：不自动交易、不下单、不管钱包、不碰用户凭证、不做自动登录/自动重登；只被动读取浏览器正常产生的数据；不裸调 DeBot 内部 API。全部本地运行（127.0.0.1 + SQLite），不上传任何数据。
6. **工程纪律**：TypeScript strict 模式；每期（§8）完成后须通过该期验收标准并向用户演示/汇报，验收通过才进入下一期；每个阶段独立 commit；`packages/rules-engine` 与模拟引擎为纯函数包，必须有单元测试。
7. **最简实现**（YAGNI）：未标注"预留"的功能不提前实现；"预留"仅指接口与字段占位（§7.7），不写空壳逻辑。

---

## 1. 背景与目标

用户日常使用 DeBot（debot.ai）的 AI Signal 页面获取 memecoin 交易信号。本项目做一个本地 Sidecar：

- 实时捕获浏览器中 DeBot AI Signal 页面产生的信号
- 本地规则过滤、评分、分级（不依赖任何外部 AI/API 做判断）
- 只把值得关注的信号用**强通知**呈现（大卡片、颜色分级、点击跳转）
- 全量记录历史，支持回放复盘、模拟账户收益统计、离最高点收益计算
- 预留接入其他打狗工具数据（TG 喊单数、KOL 买入）的扩展位

**不是**跟单、不是自动交易、不做钱包管理。

## 2. 范围

In scope：

- 捕获：仅 DeBot AI Signal 页面（Chrome/Edge MV3 扩展，hook fetch/XHR/WebSocket 为主、DOM 兜底）
- 规则引擎：任意 Signal 字段条件、关键词、黑白名单、时间窗口去重、人物相关性（CZ/何一/Binance）、加减分、分级（LOW/MEDIUM/HIGH/VERY_HIGH/REJECT）
- 强通知系统（§7.6）与 WebUI 主交互界面（§7.11）
- 数据增强层（§7.7）：热度统计默认实现；telegram-shill / kol-holdings 仅接口预留
- 信号历史、回放、模拟账户（策略模板）、离最高点收益、质量统计
- 页面保活与异常恢复（§7.8）

Out of scope：

- DeBot 站内其他信号流（战壕/聪明钱包等）——架构上可后加，本期不做
- 自动交易/下单/钱包/自动重登
- Windows 支持（但不得引入平台专属依赖，如 osascript）
- 直接调用 DeBot 内部 API（即使抓包看到接口也不调用，坚持被动读取浏览器自身请求）

## 3. 已确认决策（用户已拍板，不得更改）

| 决策点 | 结论 |
|---|---|
| 捕获方案 | Chrome/Edge MV3 扩展（否决 Tampermonkey 与 CDP 方案） |
| 信号范围 | 仅 AI Signal 页面 |
| 收益模拟 | 策略模板（配置化模拟用户习惯操作，自动算 PnL） |
| 技术栈 | 全 TypeScript 单仓（pnpm workspace，扩展+服务+UI 同语言） |
| 保活策略 | 自动刷新 + 模拟鼠标操作，工程化为 L0–L3 分层（§7.8） |
| 强通知 | WebUI 自绘大卡片（面积大于 macOS 系统通知）+ 系统通知兜底；点击跳转该 CA 的 DeBot token 页 |
| 外部数据 | enrichment provider 架构；热度统计默认实现，TG 喊单/KOL 仅预留 |
| 主交互 | localhost WebUI 为主界面，扩展 Side Panel 为轻量展示 |

## 4. 总体架构

```
┌─ 浏览器（Chrome/Edge，用户日常使用）─────────────────────┐
│  DeBot AI Signal 页面（用户正常登录操作）                  │
│    ↑hook fetch/XHR/WS      ↑MutationObserver兜底          │
│  扩展（MV3，薄）：                                          │
│   ├ content script + MAIN world 注入（捕获）               │
│   ├ service worker（转发/保活/登录失效检测）               │
│   └ Side Panel（实时分级展示 + 告警）                       │
└──────────────┬ WebSocket → 127.0.0.1:port ───────────────┘
┌─ macOS 本地 Sidecar 服务（胖，规则与数据中枢）───────────────┐
│   ├ WS 网关（仅 127.0.0.1）+ REST API（WebUI 用）           │
│   ├ capture-parser（raw → 统一 Signal，schema 版本化）      │
│   ├ 规则引擎（过滤+评分+分级，纯函数）                       │
│   ├ 信号历史（去重/时间窗口）                               │
│   ├ 相关性标签库（CZ/何一/Binance）                         │
│   ├ 数据增强层（enrichment providers）                     │
│   ├ 通知器（推送 WebUI/Side Panel + 触发系统通知）           │
│   ├ 价格追踪 / 模拟账户 / 回放 / 统计                       │
│   ├ SQLite（全量数据）                                     │
│   └ WebUI 静态资源 host                                    │
└────────────────────────────────────────────────────────────┘
```

核心原则：**薄扩展、胖服务**。

- 扩展只做捕获 + 转发 + 展示，业务逻辑零承载
- 规则引擎为纯函数包：实时评分与历史回放复用同一份代码（回放 = 同一引擎重放历史信号），这是复盘可信度的根基
- **数据层全存、呈现层降噪**：所有信号（含 REJECT）全量入库，等级只决定呈现强度，丢弃原始数据 = 回放失效

## 5. 项目结构

```
apps/
├── extension/          # MV3 扩展（WXT 框架）
│   ├── src/
│   │   ├── injected/   # MAIN world 注入：hook fetch/XHR/WS
│   │   ├── content/    # content script：postMessage 桥 + DOM 兜底 + L0 保活
│   │   ├── worker/     # service worker：WS 客户端、转发、alarms、tabs 监控
│   │   └── sidepanel/  # Side Panel UI
│   └── wxt.config.ts
├── server/             # 本地服务（Node + Fastify + @fastify/websocket）
│   └── src/
│       ├── gateway/    # WS 网关 + REST API
│       ├── pipeline/   # 信号处理管线（评分→enrichment→重评分→通知）
│       ├── notifier/   # 通知器
│       ├── price/      # 价格追踪（price-tracker provider 宿主）
│       ├── simulator/  # 模拟账户
│       ├── replay/     # 回放器
│       └── store/      # SQLite 访问层（better-sqlite3）
└── web/                # WebUI（Vite + React）
    └── src/
        ├── pages/      # dashboard / signals / rules / notifications / replay / stats / settings
        └── ws/         # WS 客户端 + 大卡片通知窗口
packages/
├── shared/             # 全链路类型 + P0 占位常量（src/p0.ts）+ WS/REST 契约类型
├── rules-engine/       # 规则引擎（纯函数，可单测）
└── simulator-core/     # 模拟引擎（纯函数，可单测）
```

依赖关系：`apps/*` → `packages/*`；`rules-engine`/`simulator-core` 不依赖任何 app。

## 6. 技术选型（已定，可直接采用）

- Monorepo：pnpm workspace；TS strict 全仓
- 扩展：WXT（如与需求冲突可换 @crxjs/vite-plugin，需先问用户）
- 服务：Node + Fastify + @fastify/websocket；SQLite 用 better-sqlite3（同步 API）
- WebUI：Vite + React（UI 细节库由实现 agent 提出并让用户确认，如无偏好可用 Tailwind + shadcn 风格）
- 扩展 ↔ 服务、服务 ↔ WebUI：均 WebSocket（127.0.0.1）；WebUI ↔ 服务数据读写走 REST
- 测试：Vitest（rules-engine / simulator-core 必测）

## 7. 组件规格

### 7.1 捕获层（扩展）

- **主通道（P0 已实证可行）**：`src/injected` 以 `<script>` 注入 MAIN world，包装 `window.fetch`（以 `response.clone()` 读取响应体，不消费原流，页面逻辑零感知）与 `XMLHttpRequest`；若后续发现 SSE/WS 接口则一并包装。经 `window.postMessage` 发给 content script，content script 转发 service worker，SW 去指纹（url+body hash）后 WS 推给服务
- **URL 白名单**：上报 `https://debot.ai/api/community/signal/` 前缀请求（已实测端点均在此前缀下：`activity/rank` 轮询与 `token/kline`，见附录 A）；其余 `debot.ai/api/*` 存 raw 不解析（用于发现新接口）。查询参数 `request_id` 为追踪 UUID，忽略；`chain` 参数存为信号属性（页面级链筛选）
- **兜底通道**（DOM）：主通道已实证可用，DOM 通道降为不实现（仅保留目录位）
- content script matches：`https://debot.ai/*`（P0 已确认页面：`https://debot.ai/?chain=bsc`）
- host_permissions：`https://debot.ai/*` + `http://127.0.0.1/*`（WS 连本地服务）

### 7.2 本地服务与信号处理管线

管线（单信号流经顺序）：

```
WS 收到 capture.raw
→ capture-parser：按 signal schema（版本化，v1 = activity/rank 结构，见附录 A）解析 raw → 统一 Signal
→ 差分器（differ）：按 `token_address` 与历史比对——
   历史从未见过 → 新信号事件（signals 表入库，raw_payload 全量保留）
   超过冷却窗口（可配，默认 10min）未见 → 再次触发信号事件（occurrences 累计）
   冷却窗口内已见 → 刷新：occurrences+1、更新市值/持有人/流动性快照（写 price_points），不生成新信号
   差分器使管道在"全量轮询"与"新信号专用接口"两种取数方式下均可工作
   新信号先行线索（P0 实证）：页面弹出全新信号时，最先发起 `token/kline?...&tokens=<新CA>` 请求（附录 A）；
   完整信号字段仍以 activity/rank 差分为权威（kline 响应仅含价格序列，P1 验证 rank 是否随新信号纳入新 token）
→ 同步评分 v1（规则引擎：基础字段 + 历史上下文：isFirstSeen/occurrencesIn(Nm)）
→ 并行触发 enabled enrichment providers（默认超时 15s，失败静默）
→ 重评分 v2（enriched.* 字段参与）
→ signal_scores 入库（记录 rule_version + 逐条命中明细）
→ 通知判定：v2 等级 >= 用户阈值 → 通知器触发强通知（§7.6）
→ WS 广播给 WebUI（signal.scored / grade.updated）与扩展 Side Panel
→ 异步排队：price-tracker、simulator
   （价格数据全部被动捕获：rank 轮询响应的 market_info.price 按轮询频率——用户实测数秒一次——写入
   price_points；新信号弹出时 kline 响应回填近期 5s 间隔价格序列；零主动请求，详见 §7.9 与附录 A）
```

### 7.3 规则引擎（packages/rules-engine）

规则 DSL（JSON 文件 `~/.debot-sidecar/rules.json`，示意，字段名以 P0 实际结构为准）：

```json
{
  "version": 1,
  "baseScore": 50,
  "thresholds": { "LOW": 60, "MEDIUM": 70, "HIGH": 85, "VERY_HIGH": 95 },
  "rules": [
    { "id": "mcap-too-high", "when": { "field": "marketCapUsd", "op": ">", "value": 5000000 }, "action": "reject" },
    { "id": "liq-too-low",   "when": { "field": "liquidityUsd", "op": "<", "value": 5000 },    "action": "reject" },
    { "id": "cz-related",    "when": { "field": "tags", "op": "contains", "value": "CZ" },     "action": { "addScore": 20 } },
    { "id": "dup-30m",       "when": { "field": "occurrencesIn30m", "op": ">", "value": 2 },    "action": "reject" },
    { "id": "first-seen",    "when": { "field": "isFirstSeen", "op": "=", "value": true },     "action": { "addScore": 10 } },
    { "id": "tg-shill",      "when": { "field": "enriched.telegram.shillCount", "op": ">", "value": 5 }, "action": { "addScore": 10 } }
  ]
}
```

- 条件：字段比较（`> >= < <= = != contains regex in`）；字段可引用 `enriched.<providerId>.*`
- 动作：`reject` / `{ "addScore": n }` / `{ "subScore": n }`
- 分级：命中任一 reject → REJECT；否则累计分对照 thresholds（低于 LOW 阈值 → LOW）
- 输出：`{ score, grade, matched: [{ ruleId, delta }] }`
- 纯函数：`(signal, ruleset, historyCtx) → result`；历史上下文（isFirstSeen、occurrencesInNm）由服务端查询 SQLite 后作为入参传入，引擎自身不碰存储
- 规则版本化：保存规则即生成新 version 快照入库；评分记录引用 version

### 7.4 相关性标签库（CZ/何一/Binance）

- `~/.debot-sidecar/tags.json`：`{ "CZ": ["CZ", "Changpeng Zhao", "cz_binance"], "HE_YI": ["何一", "Yi He"], "BINANCE": ["Binance", "币安"] }`，用户可编辑（WebUI 设置页）
- 应用（P0 已确认 payload 自带 `tags[]`，已见 `binance_alpha`）：相关性优先直接映射 DeBot tags + `social_info`（twitter/description/website）关键词匹配；`binance_alpha` 即 Binance 相关的现成结构化标签；CZ/何一仍走关键词标签库
- 仅是规则条件的输入（预置规则包随附），不是独立子系统

### 7.5 去重与历史

- `dedup_key = token 合约地址`（P0 已确认接口按 address 组织；新信号专用接口确认后再考虑细化粒度）
- SQLite 存 first_seen / last_seen / 出现次数；时间窗口出现次数由管线查询历史表生成 `occurrencesInNm` 字段供规则引用

### 7.6 强通知系统（用户重点需求）

**要求**：通知面积大于 macOS 右侧系统通知、可自定义、点击直接跳转该 CA 的 DeBot token 页、内容含本地过滤分析结果 + 明显颜色分级 + 热度大致统计。

实现：

1. **主通道：WebUI 大卡片通知窗口**
   - 服务触发通知事件 → WS 推 WebUI → WebUI 打开（或复用已打开的）**通知小窗**（`window.open`，`【可配】` 默认约 480×420、屏幕右上）
   - 卡片内容：等级色边框/背景（LOW 灰 / MEDIUM 黄 / HIGH 橙 / VERY_HIGH 红金，主题可配）、Token 符号、CA（点击复制）、等级徽标、评分、命中规则摘要（每条规则一行：ruleId + 加减分）、热度统计区块（enriched.heat-* 数据，未就绪显示"获取中/失败"）
   - **点击卡片主体 → 打开该 CA 的 DeBot token 页**：URL 模板 `tokenUrlTemplate`（P0 已定稿 `https://debot.ai/token/{chain}/246559_{ca}`，见附录 A；用户确认下划线前数字固定不变；`{chain}`/`{ca}` 取自信号属性）
   - 声音提醒：可开关，支持用户自定义音频文件与音量
2. **兜底：系统通知**（Web Notification API / 扩展 chrome.notifications）：面积小但可穿透，可关
3. **触发条件可配**：默认 `>= HIGH` 触发大卡片、`>= VERY_HIGH` 追加系统通知
4. **通知中心**（WebUI 页面）：历史通知列表，防漏看
5. 服务启动时若 WebUI 未开，自动打开通知窗口页；WebUI 不在前台时依赖兜底系统通知

### 7.7 数据增强层（enrichment providers）

```ts
interface EnrichmentProvider {
  id: string;            // e.g. "heat-dexscreener"
  enabled: boolean;      // 用户开关（WebUI 设置页）
  enrich(signal: SignalCtx): Promise<EnrichmentResult>; // 失败静默，不阻塞管线
}
```

- 结果挂载 `signal.enriched.<id>.*`，规则条件可直接引用（评分时序见 §7.2）
- Provider 注册表 + 用户开关 + 超时控制（默认 15s）
- 清单：

| id | 状态 | 说明 |
|---|---|---|
| `heat-dexscreener` | **P5 实现**（默认启用） | DexScreener 免费 API：交易次数、流动性、价格短时变化 → 通知内"热度大致统计"区块；队列 + 缓存 + 遵守 rate limit |
| `telegram-shill` | **仅预留**（不实现） | 查询该 CA 的 TG 喊单人数；未来接入外部工具数据；只在 Provider 类型、注册表、设置页占位与文档中预留 |
| `kol-holdings` | **仅预留**（不实现） | 用户在 DeBot 监控的 KOL 是否买入该 CA；数据源（DeBot 监控页面 hook 或链上查询）接入时再定 |
| `price-tracker` | **P5 实现** | 价格追踪（§7.9）并入同一架构 |

### 7.8 保活与状态监控（L0–L3 分层）

| 层 | 触发 | 动作 |
|---|---|---|
| L0 活跃度模拟 | 常态定时（可配 2–5 分钟） | content script 向页面派发合成 mousemove/scroll 事件，防页面因"长时间无操作"挂起 |
| L1 静默自动刷新 | 信号/网络活动静默超时（chrome.alarms 检测，阈值可配） | 自动 reload DeBot 标签页 |
| L2 登录/风控失效处置 | 页面被替换为 Cloudflare 人机验证页（P0 实证，见附录 A；需鼠标点击通过） | 无法自动恢复（验证点击不可自动化，且不做自动重登）→ 直接升级 L3 |
| L3 告警 | L2 升级 / 静默超时未恢复 | Side Panel 高亮 + 系统通知 + WebUI alert，提示用户到浏览器点击完成 Cloudflare 验证（P0 用户已确认接受手动点击） |

- L0 合成事件 `isTrusted=false`，DeBot 若据此判定活跃则无效 → **P0 实测**；无效则 L0 转为可选项，以 L1 为主（配置开关保留）
- MV3 SW 回收问题：与本地服务的活跃 WS 连接保活（Chrome 116+），`chrome.alarms` 兜底重连
- 全层提供配置开关（WebUI 设置页）

### 7.9 价格追踪与离最高点收益

优先级：

1. DeBot 自带字段（P0 已实证）：信号 payload 自带 `max_price_gain`（信号后最大涨幅），且随 rank 轮询实时更新（用户实测数秒一次，附录 A）——**单位换算已确认：数值 ×100 = 页面百分比（8.561333 → 856%）**；"基价倍数 vs 涨幅"语义 P1 用同一 token 的 kline 峰值对照一次定稿（收口 `MAX_PRICE_GAIN_UNIT`）
2. 被动价格序列（P0 实证，零额外请求）：rank 轮询响应的 `market_info.price` 按轮询频率写入 price_points；新信号弹出时 `token/kline` 响应回填近期 5s 间隔价格序列（附录 A）
3. 第三方 K 线（DexScreener / GeckoTerminal 免费 API）：仅作补充——token 离开页面展示列表后的长窗口（1h/4h/24h）数据
4. 无数据（死币/超低流动性）→ 标记 `data_missing`，不进统计分母

### 7.10 模拟账户（策略模板）

`~/.debot-sidecar/strategy.json`（示意）：

```json
{
  "strategyVersion": 1,
  "initialCapitalSol": 10,
  "entry": { "delaySec": 10, "amountSol": 0.5 },
  "exit": [
    { "trigger": { "pnlPct": 50 },  "sellPct": 50 },
    { "trigger": { "pnlPct": -30 }, "sellPct": 100 },
    { "trigger": { "holdHours": 24 }, "sellPct": 100 }
  ],
  "costs": { "slippagePct": 5, "feePct": 1 }
}
```

- 对每个非 REJECT 信号按模板模拟入场/出场，记录虚拟 PnL（价格序列来自 price-tracker）
- 成本默认保守值可配；策略模板版本化（与规则版本分开，便于分别归因）

### 7.11 回放、统计与 WebUI

**回放器**：选时间范围（+可选规则版本）→ 该窗口原始信号按时间序重喂规则引擎（含已存 enrichment 数据与历史上下文重建）→ 逐条输出评分与命中明细；每次回放记录 `replay_run`，支持新旧规则版本对比。

**统计**（聚合维度：等级 × 规则 × 时间段 × 规则版本；指标：信号数、平均最高点倍数、模拟胜率、期望 PnL、最大回撤）：核心目标 = 回答"这套规则赚不赚钱、哪条规则在拖后腿"。

**WebUI 页面**（`http://127.0.0.1:<port>`）：

| 页面 | 内容 |
|---|---|
| Dashboard | 实时信号流（WS 推送，等级色卡片，等级筛选） |
| 信号详情 | 原始 payload、评分命中明细、enrichment 数据、价格轨迹图（P5 后）、模拟 PnL |
| 规则编辑器 | 可视化编辑 + JSON 双模式；保存即新版本；随附相关性标签库编辑 |
| 通知中心 | 历史通知列表 |
| 回放 | 时间范围选择 + 回放执行 + 版本对比视图 |
| 统计 | 分级/规则/时间聚合报表 |
| 设置 | 通知自定义（阈值/尺寸/位置/声音/主题）、provider 开关、保活 L0–L3 配置、tokenUrlTemplate、数据目录路径 |

## 8. 分期里程碑与验收（每期验收通过才进下一期）

| 期 | 内容 | 验收标准 |
|---|---|---|
| **P0 事实研究** | 用户配合 DevTools 抓包，产出《DeBot 数据接口事实清单》并填入 `packages/shared/src/p0.ts` 与本 SPEC 附录 | 捕获通道定稿、Signal schema 定稿、URL 模板定稿、L0 可行性结论 |
| **P1 MVP 管道** | 扩展 hook → WS → SQLite → 3–5 条初始规则 → Side Panel 展示分级 + 基础系统通知 | 页面出信号，侧栏秒级出分级 |
| **P2 规则系统 + WebUI** | 完整规则引擎 + WebUI（Dashboard + 规则编辑器）+ 去重/时间窗口 + 相关性预置包 + enrichment 接口 | 全部规则能力可用，WebUI 实时看信号 |
| **P3 强通知** | 大卡片通知窗口 + 声音 + 自定义 + 跳转 DeBot + 系统通知兜底 + 保活 L1/L2 | HIGH 信号触发大卡片，点击跳转 token 页 |
| **P4 保活完备** | L0–L3 全量 + 设置页 | 页面挂起 1 分钟内完成恢复或告警 |
| **P5 价格 + 热度** | price-tracker + heat-dexscreener → 最高点倍数 + 通知热度区块 | 信号自动回填收益倍数，通知含热度 |
| **P6 复盘模拟** | 回放器 + 模拟账户 + 统计报表 | 能回答"这套规则赚不赚钱" |

注意：P1 必须等 P0 完成才能开始（schema 未定稿无法写 parser）；脚手架（monorepo 搭建、CI、类型骨架）可在 P0 期间先行。

## 9. P0 占位与事实依赖（收口：`packages/shared/src/p0.ts`）

```ts
// 已证实事实与待确认值集中于此，实现不得编造待确认值
export const P0 = {
  // ── 已证实（2026-09-13/14 实测抓包，附录 A；rank 轮询频率：数秒一次，max_price_gain 随之实时更新）──
  AI_SIGNAL_PAGE_URL: "https://debot.ai/?chain=bsc",            // 页面地址（chain 为页面级筛选）
  AI_SIGNAL_URL_MATCH: "https://debot.ai/*",                   // content script match pattern
  SIGNAL_API_PREFIX: "https://debot.ai/api/community/signal/", // hook 白名单前缀（rank 轮询 + token/kline 均在此前缀下）
  SIGNAL_SCHEMA_VERSION: 1,                                     // v1 = activity/rank 结构（附录 A）
  DEDUP_KEY_GRANULARITY: "token_address",                      // 按 address 差分
  NEW_SIGNAL_HINT_ENDPOINT: "/api/community/signal/channel/token/kline", // 新信号弹出时最先请求的端点（先行线索；完整字段仍以 rank 差分为权威）
  MAX_PRICE_GAIN_UNIT: "pct" as "x" | "pct",                   // 数值×100=页面百分比（8.561333→856%）；"基价倍数/涨幅"语义 P1 以 kline 峰值对照定稿
  LOGIN_FAIL_MODE: "cloudflare_challenge",                     // 登录/风控失效=Cloudflare 人机验证页（需用户点击，附录 A）
  TOKEN_URL_TEMPLATE: "https://debot.ai/token/{chain}/246559_{ca}", // token 详情页（2026-09-14 用户确认：下划线前数字固定为 246559；{chain}/{ca} 取自信号属性）
  // ── 待确认 ──
  LOGIN_FAIL_SIGNATURES: [] as string[],                       // CF 挑战页 DOM/标题特征（候选：title "Just a moment…"，P1 实测定稿）
  L0_IS_TRUSTED_EFFECTIVE: null as boolean | null,             // L0 合成事件是否有效（静置 30 分钟实测）
} as const;
```

P0 抓包操作清单（进度更新 2026-09-14）：

1. ~~信号请求协议与响应结构~~ ✅ REST 明文 JSON 轮询（附录 A）
2. ~~信号字段全表~~ ✅ 附录 A 字段映射表
3. ~~新信号弹出的接口~~ ✅（2026-09-14）：新信号弹出时最先请求 `token/kline?...&tokens=<新CA>`（先行线索 + 价格序列回填）；完整信号字段仍以 rank 差分为权威，P1 验证 rank 是否随新信号纳入新 token
4. ~~登录失效表现~~ ✅（2026-09-14）：被替换为 Cloudflare 人机验证页，需鼠标点击通过（L2 直接升 L3 告警，用户手动验证）
5. **待办**：页面静置 30 分钟验证活跃度检测（L0 可行性）——唯一剩余项
6. ~~token 详情页 URL~~ ✅ 定稿（2026-09-14）：`https://debot.ai/token/{chain}/246559_{ca}`（用户确认下划线前数字固定不变）
7. ~~max_price_gain 单位~~ ✅（2026-09-14）：数值×100=页面百分比（8.561333→856%）；⬜ "基价倍数 vs 涨幅"语义 P1 用 kline 峰值对照一次定稿；另确认其随 rank 轮询（数秒一次）实时更新

## 10. 数据模型（SQLite：`~/.debot-sidecar/sidecar.db`，路径可配）

| 表 | 关键列 |
|---|---|
| signals | id, captured_at, dedup_key, token_address, signal_type, raw_payload(JSON), schema_version |
| signal_scores | signal_id, rule_version, total_score, grade, matched_rules(JSON), enriched_snapshot(JSON) |
| rule_versions | version, snapshot(JSON), created_at |
| strategy_versions | version, snapshot(JSON), created_at |
| signal_enrichments | signal_id, provider_id, result(JSON), fetched_at, status |
| price_points | token_address, ts, price, market_cap, source |
| simulated_trades | signal_id, strategy_version, entry_at, entry_price, exit_at, exit_price, pnl_sol, status |
| replay_runs | id, time_from, time_to, rule_version, summary(JSON), created_at |
| notifications | id, signal_id, grade, notified_at, click_url |

## 11. WS / REST 契约（`packages/shared/src/contracts.ts` 定型，双端共享类型）

**WS：扩展 → 服务**

```ts
{ type: "capture.raw", source: "hook" | "dom", url: string, capturedAt: number, kind: "http" | "ws", data: unknown }
{ type: "tab.health", tabId: number, url: string, signalSilenceMs: number, loginState: "ok" | "unknown" | "expired" }
```

**WS：服务 → WebUI / 扩展 SW（广播）**

```ts
{ type: "signal.scored", signal: SignalSummary, score: ScoreResult }
{ type: "grade.updated", signalId: string, score: ScoreResult }        // enrichment 后等级变化
{ type: "notification", grade: Grade, signal: SignalSummary }          // 触发强通知
{ type: "alert", level: "warn" | "error", message: string }            // 保活/健康告警
```

**REST（WebUI → 服务，Fastify）**

```
GET    /api/signals?grade&from&to&q&page
GET    /api/signals/:id                // 详情：raw + scores + enrichments + price + simulation
GET    /api/rules                      // 当前规则 + 历史版本
PUT    /api/rules                      // 保存（生成新版本）
GET    /api/strategies  PUT /api/strategies
GET    /api/stats?groupBy=grade|rule&from&to
POST   /api/replay { from, to, ruleVersion? }
GET    /api/replays  GET /api/replays/:id
GET    /api/config   PUT /api/config    // 通知/provider/保活/模板/路径等设置
GET    /api/notifications
```

## 12. 风险与应对

| # | 风险 | 应对 |
|---|---|---|
| 1 | ~~数据协议未知~~ ✅ 已证实明文 JSON REST（附录 A） | DOM 兜底通道降为不实现 |
| 2 | L0 isTrusted 无效 | P0 实测；无效则 L0 可选、L1 为主 |
| 3 | ~~信号不带涨幅字段~~ ✅ 自带 max_price_gain（随 rank 轮询实时更新） | 单位换算已确认（×100=百分比，§9）；"倍数/涨幅"语义 P1 kline 对照定稿；第三方 K 线降为长窗口补充 |
| 4 | DeBot 前端改版 | capture schema 版本化 + 静默告警人工介入 |
| 5 | 上游 rate limit / 死币无数据 | 队列+缓存；data_missing 不进统计分母 |
| 6 | 反爬风控升级 | 被动读取、不额外发请求；异常告警 |
| 7 | 大卡片依赖 WebUI 窗口开着 | 启动自动开窗 + 系统通知兜底 + 通知中心 |
| 8 | AI Signal 需付费订阅 | P0 由用户确认账号状态 |

## 13. 交付与协作

- 实现节奏：按 §8 分期，每期完成即向用户演示验收；验收通过 commit 并打 tag（`p1-mvp` 等）
- 遇决策空白：先问用户，再实现（守则 §0.4）
- 文档：README（启动方式：`pnpm dev:server` / `pnpm dev:extension` / `pnpm dev:web` 等）、每期交付说明

---

## 附录 A：DeBot 信号接口实测事实（2026-09-13，用户 DevTools 抓包）

**接口样例**（AI Signal 页面实测，明文 JSON REST 轮询）：

```
GET https://debot.ai/api/community/signal/channel/activity/rank
    ?request_id=<uuid>&chain=robinhood&limit=10&duration=5m
```

- 响应包装：`{ code, description, data: TokenEntry[] }`；`code: 0` = 成功
- `request_id` 为请求追踪 UUID（忽略）；`chain` 为页面级链筛选（页面 URL 如 `https://debot.ai/?chain=bsc`）
- 用户观察（2026-09-14 补充）：此接口定时刷新页面已展示信号的市值/持有人等行情，**轮询频率为数秒一次**；`max_price_gain` 随每次轮询响应实时更新

**token/kline 端点（2026-09-14 实测：新信号弹出时最先发起的请求）**：

```
GET https://debot.ai/api/community/signal/channel/token/kline
    ?request_id=<uuid>&chain=solana&tokens=<新CA>
```

- 响应：`{ code: 0, description, data: { interval: { <CA>: 5 }, kline: { <CA>: { <unix秒>: 价格 } } } }`
- `interval` = 5（秒）；kline 为该 token 的 5 秒间隔价格序列（新信号弹出即回填近期序列）
- 意义：① 新信号先行线索（此前未见过的 token 出现在 kline 请求的 `tokens` 参数中）；② 价格序列被动数据源（与 rank 轮询的 `market_info.price` 共同构成 price_points，零主动请求）

**TokenEntry 字段映射表（v1 schema：统一 Signal 字段 ← DeBot 来源）**：

| 统一 Signal 字段 | DeBot 来源 | 备注 |
|---|---|---|
| token_address / symbol / name / logo / decimals / total_supply | 同名 | |
| chain | chain | 页面链筛选 |
| launchpad | launchpad | pons_v2 / long / "" |
| token_created_at | creation_timestamp | Token 年龄 = now − ts |
| price / market_cap_usd / fdv | market_info.price / mkt_cap / fdv | |
| holders | market_info.holders | |
| pct_5m / pct_1h / pct_24h | market_info.percent_5m / percent_1h / percent_24h | |
| buys / sells / swaps / buy_volume / sell_volume / volume | market_info.* | |
| uniq_wallet_swaps / uniq_wallet_swaps_1h | market_info.* | |
| liquidity_usd | pair_summary_info.liquidity | |
| smart_wallets_online / smart_wallets_total | smart_wallet_online_count / smart_wallet_total_count | |
| tags | tags[] | 已实测值：binance_alpha、pons_v2、uniswapv4、long |
| is_honeypot / is_open_source / is_ownership_abandoned / is_pool_locked / pool_lock_percent / pool_burn_percent / buy_tax / sell_tax | safe_info.goplus.* | -1 = 未知 |
| risk_level / token_tier / activity_score / max_price_gain | 同名 | max_price_gain 单位待校准（§9） |
| social_twitter / social_website / social_description | social_info.twitter / website / description | 关键词与相关性规则输入 |
| dex_name / pair / quote_token_symbol / quote_token_reserve | dex.dex_name / pair / base_token.symbol / base_token.reserve | |
| owner_address | safe_info.debot.owner_address | 部分条目存在 |

**对规则引擎的意义**：市值/流动性/持有人/Token 年龄/买卖比/聪明钱包数/蜜罐与税率/DeBot tags（`binance_alpha` 即 Binance 相关）/社交描述关键词/DeBot 自评（token_tier / activity_score / risk_level）全部可直接作为规则条件；`max_price_gain` 即"信号离最高点收益"的自带数据源。

**补充实测事实（2026-09-14）**：

1. **max_price_gain 单位**：数值 ×100 = 页面百分比（用户确认：8.561333 即 856%）。"基价倍数"（8.56 倍 = 价格×8.56）还是"涨幅"（+856%）的语义差异，P1 用同一 token 的 kline 峰值对照一次定稿（信号价 p0、峰值 pMax：倍数语义=pMax/p0，涨幅语义=(pMax−p0)/p0）
2. **token 详情页 URL 格式**（通知点击跳转模板，已定稿）：
   - Solana：`https://debot.ai/token/solana/246559_8eaTKu3hpJwaLQbsVbUjAVt1CPCvwP3PfYHP8k5Ypump`
   - BSC：`https://debot.ai/token/bsc/246559_0x113d68c8cca4fe5ba25f49c00784079d168e7777`
   - 模式：`https://debot.ai/token/{chain}/246559_{ca}`（2026-09-14 用户确认：下划线前数字固定为 246559，不随 token 变化；`{chain}`/`{ca}` 直接取自信号属性）
3. **登录/风控失效表现**：页面被替换为 **Cloudflare 人机验证页**（需鼠标点击、由 Cloudflare 综合评判机器人/真人），非 URL 跳转或 401——无法自动恢复，保活 L2 直接升级 L3 告警（§7.8），由用户手动点击通过
