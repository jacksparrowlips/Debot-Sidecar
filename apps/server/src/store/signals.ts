import type { Database as DB } from "better-sqlite3";
import type {
  EnrichmentRow,
  Grade,
  MatchedRule,
  ScoreRow,
  SignalType,
  TokenStats,
} from "@debot/shared";

// ─────────────────────────── signals ───────────────────────────

export interface SignalRow {
  id: number;
  captured_at: number;
  dedup_key: string;
  token_address: string;
  signal_type: SignalType;
  chain: string | null;
  symbol: string | null;
  schema_version: number;
  raw_payload: string;
}

export function insertSignal(
  db: DB,
  s: {
    captured_at: number;
    token_address: string;
    signal_type: SignalType;
    chain: string;
    symbol: string;
    schema_version: number;
    raw: unknown;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO signals (captured_at, dedup_key, token_address, signal_type, chain, symbol, schema_version, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.captured_at,
      s.token_address,
      s.token_address,
      s.signal_type,
      s.chain,
      s.symbol,
      s.schema_version,
      JSON.stringify(s.raw),
    );
  return Number(r.lastInsertRowid);
}

export function getSignal(db: DB, id: number): SignalRow | null {
  return (
    (db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRow | undefined) ?? null
  );
}

export interface SignalsFilter {
  grade?: string | null;
  from?: number | null;
  to?: number | null;
  q?: string | null;
  page: number;
  pageSize: number;
}

/** 列表查询：join 最新评分（v2 优先，否则 v1） */
const LATEST_SCORE_CTE = `
  WITH latest AS (
    SELECT signal_id, phase, rule_version, total_score, grade, matched_rules, enriched_snapshot,
           ROW_NUMBER() OVER (PARTITION BY signal_id ORDER BY CASE phase WHEN 'v2' THEN 0 ELSE 1 END, id DESC) AS rn
    FROM signal_scores
  )
`;

export type SignalWithScore = SignalRow & {
  total_score: number;
  grade: Grade;
  rule_version: number;
};

export function querySignals(db: DB, f: SignalsFilter): { total: number; items: SignalWithScore[] } {
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  if (f.grade) {
    where.push("l.grade = @grade");
    args.grade = f.grade;
  }
  if (f.from) {
    where.push("s.captured_at >= @from");
    args.from = f.from;
  }
  if (f.to) {
    where.push("s.captured_at <= @to");
    args.to = f.to;
  }
  if (f.q) {
    where.push("(s.token_address LIKE @q OR s.symbol LIKE @q)");
    args.q = `%${f.q}%`;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total =
    (
      db
        .prepare(
          `${LATEST_SCORE_CTE} SELECT COUNT(*) AS n FROM signals s JOIN latest l ON l.signal_id = s.id AND l.rn = 1 ${whereSql}`,
        )
        .get(args) as { n: number }
    ).n ?? 0;
  const items = db
    .prepare(
      `${LATEST_SCORE_CTE}
       SELECT s.*, l.total_score, l.grade, l.rule_version
       FROM signals s JOIN latest l ON l.signal_id = s.id AND l.rn = 1
       ${whereSql}
       ORDER BY s.captured_at DESC, s.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...args, limit: f.pageSize, offset: (f.page - 1) * f.pageSize }) as SignalWithScore[];
  return { total, items };
}

export function countSignalEvents(db: DB, token: string, from: number, to: number): number {
  return (
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM signals WHERE token_address = ? AND captured_at >= ? AND captured_at <= ?",
        )
        .get(token, from, to) as { n: number }
    ).n ?? 0
  );
}

export function firstSeenAt(db: DB, token: string): number | null {
  const r = db
    .prepare("SELECT MIN(captured_at) AS t FROM signals WHERE token_address = ?")
    .get(token) as { t: number | null };
  return r.t ?? null;
}

export function getSignalsInRange(db: DB, from: number, to: number): SignalRow[] {
  return db
    .prepare("SELECT * FROM signals WHERE captured_at >= ? AND captured_at <= ? ORDER BY captured_at ASC, id ASC")
    .all(from, to) as SignalRow[];
}

// ─────────────────────────── signal_scores ───────────────────────────

export function insertScore(
  db: DB,
  s: {
    signal_id: number;
    phase: "v1" | "v2";
    rule_version: number;
    total_score: number;
    grade: Grade;
    matched: MatchedRule[];
    enrichedSnapshot: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO signal_scores (signal_id, phase, rule_version, total_score, grade, matched_rules, enriched_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.signal_id,
    s.phase,
    s.rule_version,
    s.total_score,
    s.grade,
    JSON.stringify(s.matched),
    s.enrichedSnapshot === null ? null : JSON.stringify(s.enrichedSnapshot),
  );
}

export function getScores(db: DB, signalId: number): ScoreRow[] {
  const rows = db
    .prepare("SELECT * FROM signal_scores WHERE signal_id = ? ORDER BY id ASC")
    .all(signalId) as (Omit<ScoreRow, "matched_rules" | "enriched_snapshot"> & {
    matched_rules: string;
    enriched_snapshot: string | null;
  })[];
  return rows.map((r) => ({
    phase: r.phase as ScoreRow["phase"],
    rule_version: r.rule_version,
    total_score: r.total_score,
    grade: r.grade,
    matched_rules: r.matched_rules ? JSON.parse(r.matched_rules) : [],
    enriched_snapshot: r.enriched_snapshot ? JSON.parse(r.enriched_snapshot) : null,
  }));
}

// ─────────────────────────── signal_enrichments ───────────────────────────

export function upsertEnrichment(
  db: DB,
  s: { signal_id: number; provider_id: string; status: string; result: unknown; fetched_at: number },
): void {
  db.prepare(
    `INSERT INTO signal_enrichments (signal_id, provider_id, status, result, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(signal_id, provider_id) DO UPDATE SET status = excluded.status, result = excluded.result, fetched_at = excluded.fetched_at`,
  ).run(s.signal_id, s.provider_id, s.status, s.result === null ? null : JSON.stringify(s.result), s.fetched_at);
}

export function getEnrichments(db: DB, signalId: number): EnrichmentRow[] {
  const rows = db
    .prepare("SELECT provider_id, status, result, fetched_at FROM signal_enrichments WHERE signal_id = ?")
    .all(signalId) as (Omit<EnrichmentRow, "result"> & { result: string | null })[];
  return rows.map((r) => ({
    provider_id: r.provider_id,
    status: r.status as EnrichmentRow["status"],
    result: r.result ? JSON.parse(r.result) : null,
    fetched_at: r.fetched_at,
  }));
}

// ─────────────────────────── token_stats（差分器状态，§7.5） ───────────────────────────

export function getTokenStats(db: DB, token: string): TokenStats | null {
  return (db.prepare("SELECT * FROM token_stats WHERE token_address = ?").get(token) as TokenStats | undefined) ?? null;
}

export function upsertTokenStats(db: DB, s: TokenStats): void {
  db.prepare(
    `INSERT INTO token_stats (token_address, chain, symbol, first_seen, last_seen, occurrences)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_address) DO UPDATE SET chain = excluded.chain, symbol = excluded.symbol,
       last_seen = excluded.last_seen, occurrences = excluded.occurrences`,
  ).run(s.token_address, s.chain, s.symbol, s.first_seen, s.last_seen, s.occurrences);
}

/** 离开榜单的 token（近 N 天内出现过但已静默超过 M 分钟）—— price-tracker 补价目标 */
export function staleTokens(db: DB, silenceMs: number, windowMs: number, limit = 100): string[] {
  const now = Date.now();
  return (
    db
      .prepare(
        `SELECT token_address FROM token_stats
         WHERE last_seen <= ? AND first_seen >= ? AND occurrences > 0
         ORDER BY last_seen DESC LIMIT ?`,
      )
      .all(now - silenceMs, now - windowMs, limit) as { token_address: string }[]
  ).map((r) => r.token_address);
}
