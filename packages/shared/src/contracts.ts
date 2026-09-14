import type {
  Grade,
  ScoreResult,
  SellEvent,
  SignalType,
  TradeStatus,
  EnrichmentProviderMeta,
} from "./types.js";

// ─────────────────────────── WS：扩展 → 服务 ───────────────────────────

/** hook 捕获的原始请求（SPEC §11） */
export interface CaptureRawMsg {
  type: "capture.raw";
  source: "hook" | "dom";
  url: string;
  capturedAt: number;
  kind: "http" | "ws";
  observedAt?: number;
  data: unknown;
}

export interface TabHealthMsg {
  type: "tab.health";
  tabId: number;
  url: string;
  signalSilenceMs: number;
  loginState: "ok" | "unknown" | "expired";
}

export interface CaptureDuplicateMsg {
  type: "capture.duplicate";
  url: string;
  capturedAt: number;
  observedAt?: number;
}

export type ExtToServerMsg = CaptureRawMsg | CaptureDuplicateMsg | TabHealthMsg;

// ─────────────────────────── WS：服务 → WebUI / 扩展 SW（广播） ───────────────────────────

export interface SignalSummary {
  id: number;
  captured_at: number;
  token_address: string;
  symbol: string;
  name: string | null;
  chain: string;
  signal_type: SignalType;
  grade: Grade;
  score: number;
  price: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  holders: number | null;
  pct_5m: number | null;
  pct_1h: number | null;
  pct_24h: number | null;
  tags: string[];
  relevance_tags: string[];
  max_price_gain: number | null;
  token_url: string;
}

export interface SignalScoredMsg {
  type: "signal.scored";
  signal: SignalSummary;
  score: ScoreResult;
}

export interface GradeUpdatedMsg {
  type: "grade.updated";
  signalId: number;
  signal: SignalSummary;
  score: ScoreResult;
}

export interface NotificationMsg {
  type: "notification";
  grade: Grade;
  signal: SignalSummary;
  score: ScoreResult;
  /** 是否需要系统通知兜底（等级 >= systemGrade） */
  systemNotify: boolean;
  clickUrl: string;
}

export interface AlertMsg {
  type: "alert";
  level: "warn" | "error";
  message: string;
}

export type ServerBroadcastMsg =
  | SignalScoredMsg
  | GradeUpdatedMsg
  | NotificationMsg
  | AlertMsg;

// ─────────────────────────── REST：请求 / 响应 ───────────────────────────

export interface SignalsQuery {
  grade?: string;
  from?: number;
  to?: number;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ScoreRow {
  phase: "v1" | "v2";
  rule_version: number;
  total_score: number;
  grade: Grade;
  matched_rules: unknown;
  enriched_snapshot: unknown;
}

export interface EnrichmentRow {
  provider_id: string;
  status: "ok" | "failed" | "timeout";
  result: unknown;
  fetched_at: number;
}

export interface TradeRow {
  signal_id: number;
  strategy_version: number;
  entry_at: number | null;
  entry_price: number | null;
  exit_at: number | null;
  exit_price: number | null;
  pnl_sol: number;
  /** 入场时按所属链原生币 USD 价格换算的 PnL；无法取得历史价格时为 null。 */
  pnl_usdt: number | null;
  entry_native_price_usd: number | null;
  status: TradeStatus;
  details: SellEvent[];
}

export interface SignalDetail {
  summary: SignalSummary;
  raw: unknown;
  scores: ScoreRow[];
  enrichments: EnrichmentRow[];
  price_points: { ts: number; price: number; source: string }[];
  trade: TradeRow | null;
}

export interface SignalsPage {
  total: number;
  page: number;
  pageSize: number;
  items: SignalSummary[];
}

export interface RuleVersionRow {
  version: number;
  snapshot: unknown;
  created_at: number;
  current: boolean;
}

export interface StatsRow {
  key: string;
  signalCount: number;
  /** 平均最高点涨幅（%，max_price_gain×100） */
  avgMaxGainPct: number | null;
  simulatedCount: number;
  winRate: number | null;
  expectedPnlUsdt: number | null;
  maxDrawdownUsdt: number | null;
}

export interface StatsResult {
  groupBy: "grade" | "rule";
  from: number | null;
  to: number | null;
  rows: StatsRow[];
}

export interface ReplayDetail {
  id: number;
  time_from: number;
  time_to: number;
  rule_version: number;
  summary: {
    count: number;
    grades: Record<string, number>;
    avgScore: number;
    simulatedWinRate: number | null;
  };
  created_at: number;
}

export interface ReplayRunDetail extends ReplayDetail {
  items: {
    signalId: number;
    token_address: string;
    symbol: string;
    captured_at: number;
    grade: Grade;
    score: number;
    matched: unknown;
  }[];
}

export interface ProviderInfo extends EnrichmentProviderMeta {
  description: string;
}

/** 实时流卡片：同链同 CA 固定首次捕获起点，ATH 仅统计起点后的已记录价格。 */
export interface SignalCard {
  key: string;
  signalId: number;
  chain: string;
  ca: string;
  symbol: string;
  name: string | null;
  logo: string | null;
  tokenUrl: string;
  firstAt: number;
  updatedAt: number;
  priceAt: number;
  createdAt: number | null;
  signalCount: number;
  grade: Grade;
  score: number;
  first: CardMetrics;
  current: CardMetrics;
  athMultiple: number | null;
  chart: { ts: number; price: number }[];
  historyAmbiguous: boolean;
  smartWallets: number | null;
  averageBuyUsd: number | null;
  safety: { honeypot: boolean | null; openSource: boolean | null; abandoned: boolean | null; locked: boolean | null };
}
export interface CardMetrics {
  price: number | null;
  marketCap: number | null;
  holders: number | null;
  liquidity: number | null;
}
