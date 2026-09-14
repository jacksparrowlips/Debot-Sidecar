import type { P0 } from "./p0.js";

// ─────────────────────────── 等级 ───────────────────────────

export type Grade = "REJECT" | "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

export const GRADE_ORDER: Record<Grade, number> = {
  REJECT: -1,
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  VERY_HIGH: 3,
};

// ─────────────────────────── 统一 Signal（v1 schema，附录 A 字段映射表） ───────────────────────────

/**
 * 统一信号结构（v1 = activity/rank 的 TokenEntry 结构，SPEC 附录 A）。
 * 所有字段可空：DeBot 原始字段可能缺失；-1（safe_info 未知）归一为 null。
 */
export interface Signal {
  token_address: string;
  symbol: string;
  name: string | null;
  logo: string | null;
  decimals: number | null;
  total_supply: number | null;
  /** 页面级链筛选（rank 请求 chain 参数） */
  chain: string;
  launchpad: string | null;
  /** Token 年龄 = now − token_created_at（creation_timestamp，unix 秒） */
  token_created_at: number | null;
  price: number | null;
  market_cap_usd: number | null;
  fdv: number | null;
  holders: number | null;
  pct_5m: number | null;
  pct_1h: number | null;
  pct_24h: number | null;
  buys: number | null;
  sells: number | null;
  swaps: number | null;
  buy_volume: number | null;
  sell_volume: number | null;
  volume: number | null;
  uniq_wallet_swaps: number | null;
  uniq_wallet_swaps_1h: number | null;
  liquidity_usd: number | null;
  smart_wallets_online: number | null;
  smart_wallets_total: number | null;
  tags: string[];
  is_honeypot: boolean | null;
  is_open_source: boolean | null;
  is_ownership_abandoned: boolean | null;
  is_pool_locked: boolean | null;
  pool_lock_percent: number | null;
  pool_burn_percent: number | null;
  buy_tax: number | null;
  sell_tax: number | null;
  risk_level: string | null;
  token_tier: string | null;
  activity_score: number | null;
  /** 数值×100=页面百分比（8.561333→856%），随 rank 轮询实时更新 */
  max_price_gain: number | null;
  social_twitter: string | null;
  social_website: string | null;
  social_description: string | null;
  dex_name: string | null;
  pair: string | null;
  quote_token_symbol: string | null;
  quote_token_reserve: number | null;
  owner_address: string | null;
  /** 相关性标签库匹配结果（CZ / HE_YI / BINANCE …） */
  relevance_tags: string[];
  /** enrichment 结果挂载：signal.enriched.<providerId>.* */
  enriched: Record<string, Record<string, unknown>>;
  /** 捕获时间（epoch ms） */
  captured_at: number;
  /** 原始 TokenEntry 全量（回放与排查用） */
  raw: unknown;
}

// ─────────────────────────── 规则 DSL ───────────────────────────

export type CompareOp =
  | ">"
  | ">="
  | "<"
  | "<="
  | "="
  | "!="
  | "contains"
  | "regex"
  | "in";

export interface Condition {
  /** 任意 Signal 字段（含 enriched.<providerId>.*）；isFirstSeen / occurrencesInNm 为历史上下文字段 */
  field: string;
  op: CompareOp;
  value: unknown;
}

export type Action = "reject" | { addScore: number } | { subScore: number };

export interface Rule {
  id: string;
  when: Condition;
  action: Action;
}

export interface Thresholds {
  LOW: number;
  MEDIUM: number;
  HIGH: number;
  VERY_HIGH: number;
}

export interface Ruleset {
  version: number;
  baseScore: number;
  thresholds: Thresholds;
  rules: Rule[];
}

/** 规则引擎历史上下文（由服务端查询 SQLite 后作为入参传入，引擎自身不碰存储） */
export interface HistoryCtx {
  isFirstSeen: boolean;
  /** key = 窗口分钟数（如 "30"）；规则字段 occurrencesIn30m 从此取 */
  windows: Record<string, number>;
}

export interface MatchedRule {
  ruleId: string;
  /** 加减分值；"reject" = 命中拒绝规则 */
  delta: number | "reject";
}

export interface ScoreResult {
  score: number;
  grade: Grade;
  matched: MatchedRule[];
  ruleVersion: number;
}

// ─────────────────────────── 相关性标签库 ───────────────────────────

/** { "CZ": ["CZ", "Changpeng Zhao", "cz_binance"], ... }，用户可编辑 */
export type TagLibrary = Record<string, string[]>;

// ─────────────────────────── 策略模板（模拟账户） ───────────────────────────

export interface ExitRule {
  trigger: {
    /** 盈亏百分比（正为止盈、负为止损） */
    pnlPct?: number;
    /** 持仓超时（小时） */
    holdHours?: number;
  };
  /** 卖出仓位百分比（相对当前持仓） */
  sellPct: number;
}

export interface Strategy {
  strategyVersion: number;
  /** 每条链按其原生币记账；统计时以入场时美元价格换算为 USDT。 */
  initialCapitalNative: number;
  entry: {
    delaySec: number;
    amountNative: number;
  };
  exit: ExitRule[];
  costs: {
    slippagePct: number;
    feePct: number;
  };
}

export type TradeStatus = "closed" | "open" | "no_data";

export interface SellEvent {
  ts: number;
  price: number;
  sellPct: number;
  reason: string;
  realizedPnlNative: number;
}

export interface SimulatedTrade {
  signalId: number;
  strategyVersion: number;
  entryAt: number | null;
  entryPrice: number | null;
  exitAt: number | null;
  exitPrice: number | null;
  /** 原生币数量盈亏，仅为兼容旧存储；跨链聚合不得使用。 */
  pnlNative: number;
  status: TradeStatus;
  /** 分批出场明细 */
  details: SellEvent[];
}

// ─────────────────────────── 价格点 ───────────────────────────

export type PriceSource = "rank" | "kline" | "dexscreener";

export interface PricePoint {
  token_address: string;
  ts: number;
  price: number;
  market_cap: number | null;
  source: PriceSource;
}

// ─────────────────────────── enrichment ───────────────────────────

export interface EnrichmentResult {
  [key: string]: unknown;
}

export interface EnrichmentProviderMeta {
  id: string;
  enabled: boolean;
  /** 仅预留（无实现）的 provider：设置页展示"预留"状态 */
  reserved?: boolean;
}

// ─────────────────────────── 运行配置 ───────────────────────────

export interface NotifyConfig {
  /** 触发 WebUI 大卡片的最低等级 */
  cardGrade: Grade;
  /** 追加系统通知的最低等级（可选，null = 关闭系统通知） */
  systemGrade: Grade | null;
  /** 小窗尺寸 [宽, 高]（px） */
  size: [number, number];
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  sound: {
    enabled: boolean;
    volume: number;
    /** 自定义音频文件名（存 ~/.debot-sidecar/sounds/），null = 内置提示音 */
    file: string | null;
  };
  theme: "dark" | "light";
}

export interface KeepaliveConfig {
  /** L0 合成事件（P0 有效性未定稿，默认关闭；实测有效后可开启） */
  l0: boolean;
  l0IntervalMin: number;
  l1: boolean;
  /** 信号/网络活动静默超时（分钟），超过后自动刷新 DeBot 标签页 */
  l1SilenceMin: number;
}

export interface SidecarConfig {
  port: number;
  /** 数据目录（默认 ~/.debot-sidecar，环境变量 DEBOT_SIDECAR_DATA_DIR 覆盖；修改需重启） */
  dataDir: string;
  /** 差分器冷却窗口（分钟）：窗口内重复出现只刷新不生成新信号 */
  cooldownMin: number;
  notify: NotifyConfig;
  enrichment: {
    timeoutSec: number;
    providers: Record<string, boolean>;
  };
  keepalive: KeepaliveConfig;
  /** 通知/信号点击跳转 token 页 URL 模板（P0 定稿） */
  tokenUrlTemplate: string;
}

// ─────────────────────────── 杂项 ───────────────────────────

export type SignalType = "new" | "resurface";

export interface TokenStats {
  token_address: string;
  chain: string | null;
  symbol: string | null;
  first_seen: number;
  last_seen: number;
  /** 总出现次数（含冷却窗口内刷新） */
  occurrences: number;
}

export type { P0 };
