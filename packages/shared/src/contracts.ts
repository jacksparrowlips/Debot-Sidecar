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
  data: unknown;
}

export interface TabHealthMsg {
  type: "tab.health";
  tabId: number;
  url: string;
  signalSilenceMs: number;
  loginState: "ok" | "unknown" | "expired";
}

export type ExtToServerMsg = CaptureRawMsg | TabHealthMsg;

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
  expectedPnlSol: number | null;
  maxDrawdownSol: number | null;
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
