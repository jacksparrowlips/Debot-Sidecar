# DeBot AI Signal Sidecar 设计文档

- 日期：2026-09-13
- 状态：待用户复核
- 平台：macOS 优先（后续按需移植 Windows）

## 1. 背景与目标

对 DeBot（debot.ai）AI Signal 页面的信号做**本地二次过滤与分级**，只呈现真正值得关注的信号，并通过模拟账户统计信号质量，形成"规则迭代 → 回放验证 → 收益统计"的闭环。

明确不是什么：

- **不是跟单、不是自动交易**，不做买卖、不管钱包、不碰凭证
- 不自建 DeBot 登录，被动读取浏览器正常产生的数据

## 2. 范围

In scope：

- 捕获：仅 DeBot AI Signal 页面（Chrome/Edge MV3 扩展）
- 过滤/评分/分级：本地规则引擎，全部本地计算，零外部 AI/API
- 去重、时间窗口、黑白名单、关键词、人物相关性（CZ/何一/Binance）
- 信号历史、回放、复盘、模拟账户、离最高点收益统计
- 页面保活与异常恢复
- 强通知系统：大卡片通知（面积大于 macOS 系统通知）、点击跳转该 CA 的 DeBot 页、等级颜色分级、通知含本地分析结果与热度统计（2026-09-13 补充，见 5.11）
- 数据增强层（enrichment）：热度统计默认实现；Telegram 喊单人数、KOL 买入等外部数据源做接口预留（2026-09-13 补充，见 5.12）

Out of scope（本期不做）：

- DeBot 站内其他信号流（战壕/聪明钱包等），架构上可后加
- 自动交易/下单/钱包管理/自动重登
- Windows 支持
- 裸调 DeBot 内部 API（即使 P0 抓包看到，也不直接调用，坚持被动读取）

## 3. 已确认决策

| 决策点 | 结论 |
|---|---|
| 捕获方案 | Chrome/Edge MV3 扩展（否决 Tampermonkey：Side Panel/保活/本地通信短板多） |
| 信号范围 | 仅 AI Signal 页面 |
| 收益模拟 | 策略模板（配置化模拟习惯操作，自动算 PnL） |
| 技术栈 | 全 TypeScript 单仓（扩展+服务+UI 同语言） |
| 保活策略 | 自动刷新 + 模拟鼠标操作保活恢复（本设计细化为分层策略，见 5.6） |
| 强通知（2026-09-13 补充） | WebUI 自绘大卡片通知（面积大于 macOS 系统通知）+ 系统通知兜底；点击跳转该 CA 的 DeBot token 页；内容含颜色分级、本地分析结果、热度统计 |
| 外部数据接入（2026-09-13 补充） | enrichment provider 架构：热度统计默认实现；TG 喊单人数、KOL 持仓仅做接口预留，后续版本接入 |
| 主交互界面（2026-09-13 补充） | localhost WebUI 为主要交互界面（实时信号流/规则编辑/回放统计/通知中心），Side Panel 为浏览器侧轻量展示 |

## 4. 总体架构

```
┌─ 浏览器（Chrome/Edge，用户日常使用）─────────────────────┐
│  DeBot AI Signal 页面（用户正常登录操作）                  │
│    ↑hook fetch/XHR/WS      ↑MutationObserver兜底          │
│  扩展（MV3，薄）：                                          │
│   ├ content script + MAIN world 注入（捕获）               │
│   ├ service worker（转发/保活/登录失效检测）               │
│   └ Side Panel（实时展示分级结果 + 告警）                   │
└──────────────┬ WebSocket → 127.0.0.1:port ───────────────┘
┌─ macOS 本地 Sidecar 服务（胖，规则与数据中枢）───────────────┐
│   ├ 接收网关（WS server，仅绑定 127.0.0.1）                │
│   ├ 规则引擎（过滤+评分+分级，纯函数）                       │
│   ├ 信号历史（去重/时间窗口查询）                            │
│   ├ 相关性标签库（CZ/何一/Binance 预置规则包）               │
│   ├ SQLite（原始信号全量+评分明细+价格+模拟结果）             │
│   ├ 价格追踪器（K线 → 信号后最高点/回撤）                    │
│   ├ 数据增强层（enrichment providers：热度/TG喊单/KOL 预留）│
│   ├ 模拟账户引擎（策略模板 → 每信号虚拟 PnL）                │
│   └ Web UI（localhost）：实时信号流/规则编辑/回放/统计/大卡片通知│
└────────────────────────────────────────────────────────────┘
```

核心架构决策：**薄扩展、胖本地服务**。

- 规则引擎、历史、回放、模拟全在本地服务；扩展只做捕获+转发+展示
- 理由 1：去重/时间窗口需要持久历史状态（SQLite）
- 理由 2：**回放 = 同一个规则引擎重放历史信号**，实时过滤与复盘复用同一份代码，保证复盘所见与当时实时所见一致，这是复盘可信度的根基
- 理由 3：规则编辑/统计报表等重 UI 放本地 Web UI，不受扩展 UI 限制

## 5. 子系统设计

### 5.1 捕获层（扩展）

双通道，防御性设计：

- **主通道**：MAIN world hook。重写 `window.fetch` / `XMLHttpRequest` / `WebSocket`，读取 DeBot 页面自己请求得到的结构化响应（Fetch/XHR/WS 均覆盖）。content script（isolated world）与注入脚本（MAIN world）经 `window.postMessage` 桥接
- **兜底通道**：DOM MutationObserver 监听信号列表容器，解析渲染后的信号节点。仅当主通道拿不到数据时启用，避免与 DeBot 前端结构强耦合

通道选择在 P0 抓包后定稿：主通道可用则兜底通道仅保留实现位（YAGNI：不提前实现）。

扩展不处理业务逻辑，捕获到的原始事件去重后（按请求/消息指纹）经 WS 推给本地服务。

### 5.2 规则引擎与信号分级

规则 DSL（JSON 文件存储，示意，字段名以 P0 实际信号结构为准）：

```json
{
  "version": 1,
  "baseScore": 50,
  "thresholds": { "LOW": 60, "MEDIUM": 70, "HIGH": 85, "VERY_HIGH": 95 },
  "rules": [
    { "id": "mcap-too-high", "when": { "field": "marketCapUsd", "op": ">", "value": 5000000 }, "action": "reject" },
    { "id": "liq-too-low",   "when": { "field": "liquidityUsd", "op": "<", "value": 5000 },   "action": "reject" },
    { "id": "cz-related",   "when": { "field": "tags", "op": "contains", "value": "CZ" },    "action": { "addScore": 20 } },
    { "id": "dup-30m",      "when": { "field": "occurrencesIn30m", "op": ">", "value": 2 },  "action": "reject" },
    { "id": "first-seen",   "when": { "field": "isFirstSeen", "op": "=", "value": true },    "action": { "addScore": 10 } }
  ]
}
```

要点：

- 条件支持：任意 Signal 字段比较、正则关键词、黑白名单（地址/符号）、时间窗口出现次数、相关性标签
- 动作支持：`reject`（直接出局）、`addScore` / `subScore`
- 累计分对照阈值 → LOW / MEDIUM / HIGH / VERY HIGH；命中 reject 规则 → REJECT
- **数据层全存、呈现层降噪**：所有信号（含 REJECT）全量入库；等级只决定呈现方式（VERY HIGH 弹通知，LOW 静默列表，REJECT 折叠）。原始数据全保留是回放的前提
- **规则版本化**：每次评分记录规则版本号 + 逐条命中明细（ruleId / delta），复盘可回答"这条为什么是 HIGH"
- 规则引擎为纯函数包（输入：signal + 规则 + 历史上下文；输出：分数/等级/命中明细），便于单测与回放复用

### 5.3 人物相关性（CZ/何一/Binance）

不单造子系统 = **预置规则包 + 标签库**：

- 标签库 JSON：人物别名/X handle（CZ、Changpeng Zhao、cz_binance、何一、Yi He、Binance 等），用户可编辑
- 应用方式：信号文本/关联人物字段命中关键词 → 打标签；若 P0 确认信号 payload 自带"关联人物/项目"结构化字段，则直接映射
- 标签作为规则条件引用（如：含 CZ 标签 +20 分，无任何相关人物 −10 分）

### 5.4 去重与信号历史

- 信号身份 `dedup_key = token合约地址 + 信号类型`（粒度以 P0 实际结构确认）
- SQLite 记录 first_seen / last_seen；时间窗口（如 30 分钟内出现次数）由规则引擎查询历史表计算
- 首次出现加分、重复扣分、超限 reject —— 均为普通规则条件，不单写逻辑

### 5.5 存储（SQLite）

库文件 `~/.debot-sidecar/sidecar.db`（路径可配）。表结构草案：

| 表 | 用途 | 关键列 |
|---|---|---|
| signals | 原始信号全量 | id, captured_at, dedup_key, token_address, raw_payload(JSON) |
| signal_scores | 评分明细 | signal_id, rule_version, total_score, grade, matched_rules(JSON) |
| rule_versions | 规则快照 | version, snapshot(JSON), created_at |
| price_points | 价格序列 | token_address, ts, price, market_cap, source |
| simulated_trades | 模拟结果 | signal_id, strategy_version, entry/exit 价格与时间, pnl, status |
| replay_runs | 回放记录 | id, time_range, rule_version, summary(JSON) |

### 5.6 页面保活与状态监控（分层恢复）

用户要求"自动刷新，或保底模拟鼠标操作恢复"，工程化为先轻后重的分层策略：

| 层 | 触发 | 动作 |
|---|---|---|
| L0 活跃度模拟 | 常态，可配间隔（如 2–5 分钟） | content script 定时向页面派发 mousemove/scroll 合成事件，防止页面因"长时间无操作"挂起/降级 |
| L1 静默自动刷新 | 信号/网络活动静默超时（chrome.alarms 检测，阈值可配） | 自动 reload DeBot 标签页，恢复捕获 |
| L2 登录失效处置 | 检测到跳转登录页 / 请求 401 | 先自动 reload 一次；仍失效则升级 L3（不做自动重登） |
| L3 告警 | L2 无效 | Side Panel 高亮 + 系统通知，等待用户人工处理 |

说明与风险：

- L0 合成事件 `isTrusted=false`，若 DeBot 用 isTrusted 判定活跃则无效 —— **P0 实测验证，失败则 L0 降级为可选项，以 L1 为主**
- MV3 service worker 空闲会被回收：与本地服务的 WS 活跃连接可保活（Chrome 116+），`chrome.alarms` 兜底重连
- 自动刷新有打断用户页面操作的可能：刷新动作限定在"静默超时"（用户长期不看该页才可能触发），并提供配置开关

### 5.7 价格追踪与离最高点收益

优先级：

1. **DeBot 自带字段**：已核实公开页面信号带 ATH 与倍数（如 `ATH $498K`、`18x`）。若 hook 到的 payload 自带 → 直接用，零额外请求
2. **第三方 K 线**：DexScreener / GeckoTerminal 免费 API，拉信号后 1h/4h/24h 窗口 K 线，计算"信号时刻市值 → 窗口内最高市值"倍数与回撤
3. 拉不到数据（死币/超低流动性）→ 标记"数据缺失"，不进统计分母

工程约束：批量队列 + 结果缓存 + 遵守上游 rate limit。

### 5.8 模拟账户（策略模板）

策略模板 JSON（示意）：

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

- 对每个未 REJECT 信号按模板模拟入场/出场（分批止盈/止损/超时市价离场），记录虚拟 PnL
- 成本默认保守值（meme 币滑点大），可配
- 策略模板版本化，与规则版本区分，便于分别归因

### 5.9 回放与复盘

- 回放器：选时间范围 → 将该窗口原始信号按时间序重喂当前规则引擎 → 逐条输出评分轨迹与命中明细
- 改完规则再回放：每次回放记录 replay_run（时间范围 + 规则版本 + 结果摘要），支持新旧版本对比
- 复盘界面（Web UI）：信号列表 + 命中明细 + 事后价格轨迹图（信号点 → 最高点 → 回撤）+ 模拟 PnL

### 5.10 质量统计

聚合维度：等级 × 规则 × 时间段 × 规则版本。指标：信号数、平均最高点倍数、模拟胜率、期望 PnL、最大回撤。

核心闭环：规则命中明细 + 模拟 PnL 关联 → "哪条规则在拖后腿" → 改规则 → 回放对比 → 统计验证。

### 5.11 强通知系统（2026-09-13 补充）

要求：通知面积大于 macOS 右侧系统通知、支持自定义、点击直接跳转该 CA 的 DeBot 页、内容含本地过滤分析结果、明显颜色分级、热度统计。

通道设计：

| 通道 | 形态 | 说明 |
|---|---|---|
| 主：WebUI 大卡片通知窗口 | 自绘通知卡片，尺寸/位置可配（默认约 480×420，大于 macOS 系统通知） | 等级色边框/背景（LOW 灰 / MEDIUM 黄 / HIGH 橙 / VERY HIGH 红金，主题可配）；内容：CA（可复制）、Token 符号、等级徽标、评分、命中规则摘要、热度统计区块；点击卡片 → 打开该 CA 的 DeBot token 页 |
| 兜底：系统通知 | Web Notification API / chrome.notifications | 面积小但可穿透（WebUI 不在前台时兜底），可关 |

- 声音提醒：可开关，支持自定义音频文件
- 触发条件可配：默认 `grade >= HIGH` 触发大卡片，`>= VERY_HIGH` 追加系统通知
- 通知等待 enrichment（默认超时 15s）：保证"热度统计"在通知内可见；超时则热度区块显示"获取中/失败"
- 跳转 URL 模板可配：默认占位 `https://debot.ai/token/{ca}`，**P0 用实际 token 详情页 URL 校准**
- WebUI 通知中心：历史通知列表，防漏看

### 5.12 数据增强层（enrichment providers，2026-09-13 补充）

为后续接入其他打狗工具数据做逻辑预留，统一为 provider 架构：

```ts
interface EnrichmentProvider {
  id: string;            // e.g. "heat-dexscreener"
  enabled: boolean;      // 用户开关
  enrich(signal: SignalCtx): Promise<EnrichmentResult>; // 失败静默，不阻塞主流程
}
```

- 评分时序：同步评分（基础字段+历史）→ 并行触发 enabled providers（带超时）→ 到齐/超时后重评分 → 若等级达通知阈值发强通知（见 5.11）
- 结果以 `signal.enriched.<providerId>.*` 挂载，**规则条件可直接引用**（如 `enriched.telegram.shillCount > 5 → +10`）
- 首批与预留：

| Provider | 状态 | 说明 |
|---|---|---|
| heat-dexscreener（默认） | P5 实现 | DexScreener 免费 API：交易次数、流动性、价格变化 → "热度大致统计"，即 5.11 通知内热度区块的数据源 |
| telegram-shill | 仅预留接口 | 查询该 CA 的 Telegram 喊单人数（外部工具，后续版本接入） |
| kol-holdings | 仅预留接口 | 用户在 DeBot 监控的 KOL 钱包是否买入该 CA；数据源（DeBot 监控页面 hook 或链上查询）接入时再定，不预先实现 |
| price-tracker | P5 实现 | 5.7 价格追踪并入同一 provider 架构 |

## 6. 技术栈与项目结构

全 TS 单仓（pnpm workspace）：

```
apps/
├── extension/     # MV3 扩展（WXT 框架，默认；可换 @crxjs）
├── server/       # 本地服务：Node + Fastify(ws)
└── web/          # 主交互 UI：实时信号流/规则编辑/回放复盘/统计/通知中心/设置：Vite + React（默认）
packages/
├── rules-engine/ # 规则引擎（纯函数）
└── shared/       # Signal/Grade/Rule 全链路类型
```

- Web UI 前端框架默认 React，实现阶段如需调整再定
- SQLite 驱动：better-sqlite3（同步 API，单机场景简单可靠）
- 通信：扩展 ↔ 服务走 WS（127.0.0.1），比 Native Messaging 少一层 host manifest 注册，服务可独立常驻

## 7. 分期计划（每期结束可用）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| P0 事实研究 | 用户配合 DevTools 抓包（清单见 8） | 《DeBot 数据接口事实清单》定稿，捕获通道定稿 |
| P1 MVP 管道 | 扩展 hook → WS → SQLite → 数条初始规则 → Side Panel 展示分级 + 基础系统通知 | 页面出信号，侧栏秒级出分级 |
| P2 规则系统 + WebUI | 完整规则引擎 + WebUI（规则编辑器 + 实时信号流）+ 去重/时间窗口 + 相关性预置包 + enrichment 接口 | 全部规则能力可用，WebUI 实时看信号 |
| P3 强通知系统 | WebUI 大卡片通知 + 声音 + 自定义 + 跳转 DeBot + 系统通知兜底 + 基础保活（L1/L2） | HIGH 级信号触发大卡片，点击跳转 token 页 |
| P4 保活完备 | L0–L3 分层恢复全量 | 页面挂起 1 分钟内完成恢复或告警 |
| P5 价格+热度 | price-tracker 与 heat-dexscreener provider → 最高点倍数 + 通知热度区块 | 信号自动回填收益倍数，通知含热度 |
| P6 复盘模拟 | 回放器 + 模拟账户 + 质量统计 | 能回答"这套规则赚不赚钱" |

## 8. P0 抓包清单（需用户配合，产出事实清单）

前提：用户提供 AI Signal 页面 URL + 正常登录的浏览器。

1. 打开 AI Signal 页面 → DevTools Network（过滤 XHR/Fetch/WS），让页面运行 10–15 分钟
2. 记录：信号相关请求的 URL / method / 协议（REST 轮询 / SSE / WebSocket）/ 频率 / 响应结构
3. 导出 HAR 或截图信号 payload，整理**信号字段全表**（市值、流动性、持有人、Token 年龄、关联人物、ATH/倍数是否自带）
4. 观察登录失效表现：URL 跳转？401？token 过期行为
5. 页面静置 30 分钟：是否有活跃度检测（验证 L0 可行性）
6. 确认信号身份粒度：同 token 不同类型信号如何区分
7. 确认 DeBot token 详情页 URL 格式（强通知跳转模板用）：从任一信号点进 token 页，记录 URL 规则

## 9. 风险与待确认事实

| # | 风险/事实缺口 | 应对 |
|---|---|---|
| 1 | AI Signal 数据协议未知（REST/WS/加密） | P0 抓包定稿；hook 不到则启用 DOM 兜底通道 |
| 2 | L0 合成事件 isTrusted 风险 | P0 实测；无效则 L0 为可选、L1 为主 |
| 3 | 信号是否自带 ATH/倍数/PnL 字段 | P0 确认；不自带走第三方 K 线 |
| 4 | DeBot 前端改版导致 hook/DOM 失效 | 通道产物带 schema 版本；异常时告警 |
| 5 | 第三方 K 线 rate limit 与死币无数据 | 队列+缓存；数据缺失不进统计分母 |
| 6 | 反爬风控升级影响被动读取 | 被动读取浏览器自身请求，不额外发起；异常告警人工介入 |
| 7 | AI Signal 是否需要付费订阅 | P0 由用户确认账号状态 |
| 8 | 强通知大卡片依赖 WebUI 窗口已打开 | 服务启动时自动打开通知窗口；系统通知兜底穿透；通知中心列表防漏看 |
| 9 | enrichment 上游（DexScreener 等）rate limit | 失败静默 + 缓存 + 队列；通知显示"获取中/失败"不阻塞 |

## 10. 边界与原则

- 只读浏览器正常产生的数据；不裸调 DeBot 内部 API；不碰用户凭证、不做自动重登
- 不自动交易、不管钱包；模拟仅是统计
- 全部本地（SQLite + localhost），不上传
- macOS 优先：不使用平台专属 API（osascript 等），后续 Windows 仅处理路径/自启动差异
