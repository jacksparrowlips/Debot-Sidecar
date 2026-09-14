import type { Database as DB } from "better-sqlite3";
import type {
  PriceSource,
  RuleVersionRow,
  Ruleset,
  SellEvent,
  Strategy,
  TradeRow,
  TradeStatus,
} from "@debot/shared";

// ─────────────────────────── rule_versions / strategy_versions ───────────────────────────

export function getRuleVersions(db: DB): RuleVersionRow[] {
  const rows = db
    .prepare("SELECT version, snapshot, created_at FROM rule_versions ORDER BY version DESC")
    .all() as { version: number; snapshot: string; created_at: number }[];
  return rows.map((r) => ({
    version: r.version,
    snapshot: JSON.parse(r.snapshot),
    created_at: r.created_at,
    current: false, // 由调用方标注
  }));
}

export function getRuleVersion(db: DB, version: number): Ruleset | null {
  const r = db.prepare("SELECT snapshot FROM rule_versions WHERE version = ?").get(version) as
    | { snapshot: string }
    | undefined;
  return r ? (JSON.parse(r.snapshot) as Ruleset) : null;
}

export function maxRuleVersion(db: DB): number {
  return ((db.prepare("SELECT MAX(version) AS v FROM rule_versions").get() as { v: number | null }).v ?? 0);
}

export function saveRuleVersion(db: DB, ruleset: Ruleset, createdAt: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO rule_versions (version, snapshot, created_at) VALUES (?, ?, ?)",
  ).run(ruleset.version, JSON.stringify(ruleset), createdAt);
}

export function getStrategyVersions(db: DB): RuleVersionRow[] {
  const rows = db
    .prepare("SELECT version, snapshot, created_at FROM strategy_versions ORDER BY version DESC")
    .all() as { version: number; snapshot: string; created_at: number }[];
  return rows.map((r) => ({
    version: r.version,
    snapshot: JSON.parse(r.snapshot),
    created_at: r.created_at,
    current: false,
  }));
}

export function maxStrategyVersion(db: DB): number {
  return (
    (db.prepare("SELECT MAX(version) AS v FROM strategy_versions").get() as { v: number | null }).v ?? 0
  );
}

export function saveStrategyVersion(db: DB, strategy: Strategy, createdAt: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO strategy_versions (version, snapshot, created_at) VALUES (?, ?, ?)",
  ).run(strategy.strategyVersion, JSON.stringify(strategy), createdAt);
}

// ─────────────────────────── price_points ───────────────────────────

export function insertPricePoint(
  db: DB,
  p: { token_address: string; ts: number; price: number; market_cap: number | null; source: PriceSource },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO price_points (token_address, ts, price, market_cap, source) VALUES (?, ?, ?, ?, ?)`,
  ).run(p.token_address, p.ts, p.price, p.market_cap, p.source);
}

export function getPricePoints(
  db: DB,
  token: string,
  from?: number,
  to?: number,
): { ts: number; price: number; source: string }[] {
  const conds: string[] = ["token_address = ?"];
  const args: unknown[] = [token];
  if (from !== undefined) {
    conds.push("ts >= ?");
    args.push(from);
  }
  if (to !== undefined) {
    conds.push("ts <= ?");
    args.push(to);
  }
  const rows = db
    .prepare(
      `SELECT ts, price, source FROM price_points WHERE ${conds.join(" AND ")} ORDER BY ts ASC LIMIT 5000`,
    )
    .all(...args) as { ts: number; price: number; source: string }[];
  return rows;
}

/**
 * 信号后价格序列（降采样上限 maxPoints，供模拟引擎重放；保首末点）。
 * 采样会略过峰值价，模拟止盈触发可能推迟一个采样点——统计口径可接受（成本已保守）。
 */
export function getPriceSeriesSampled(
  db: DB,
  token: string,
  from: number,
  maxPoints = 2000,
): { ts: number; price: number }[] {
  const n =
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM price_points WHERE token_address = ? AND ts >= ?")
        .get(token, from) as { n: number }
    ).n ?? 0;
  if (n <= maxPoints) {
    return db
      .prepare(
        "SELECT ts, price FROM price_points WHERE token_address = ? AND ts >= ? ORDER BY ts ASC",
      )
      .all(token, from) as { ts: number; price: number }[];
  }
  const step = Math.ceil(n / maxPoints);
  const rows = db
    .prepare(
      `SELECT ts, price FROM (
        SELECT ts, price, ROW_NUMBER() OVER (ORDER BY ts) AS rn
        FROM price_points WHERE token_address = ? AND ts >= ?
      ) WHERE rn % ? = 0
      UNION ALL
      SELECT ts, price FROM price_points WHERE token_address = ? AND ts = (
        SELECT MAX(ts) FROM price_points WHERE token_address = ? AND ts >= ?
      )`,
    )
    .all(token, from, step, token, token, from) as { ts: number; price: number }[];
  return rows.sort((a, b) => a.ts - b.ts);
}

/** 信号离最高点收益（价格序列计算）：[入场价, 信号后最高价] */
export function gainSinceSignal(
  db: DB,
  token: string,
  since: number,
): { entryPrice: number; maxPrice: number } | null {
  const entry = db
    .prepare(
      "SELECT price FROM price_points WHERE token_address = ? AND ts >= ? ORDER BY ts ASC LIMIT 1",
    )
    .get(token, since) as { price: number } | undefined;
  if (entry === undefined || entry.price <= 0) return null;
  const max = db
    .prepare("SELECT MAX(price) AS p FROM price_points WHERE token_address = ? AND ts >= ?")
    .get(token, since) as { p: number | null };
  if (max.p === null || max.p <= 0) return null;
  return { entryPrice: entry.price, maxPrice: max.p };
}

// ─────────────────────────── simulated_trades ───────────────────────────

export interface TradeRowInternal extends TradeRow {
  /** 排序/联表辅助 */
  entry_at_ms?: number;
}

export function upsertTrade(
  db: DB,
  t: {
    signal_id: number;
    strategy_version: number;
    entry_at: number | null;
    entry_price: number | null;
    exit_at: number | null;
    exit_price: number | null;
    pnl_sol: number;
    pnl_usdt: number | null;
    entry_native_price_usd: number | null;
    status: TradeStatus;
    details: SellEvent[];
  },
): void {
  db.prepare(
    `INSERT INTO simulated_trades (signal_id, strategy_version, entry_at, entry_price, exit_at, exit_price, pnl_sol, pnl_usdt, entry_native_price_usd, status, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(signal_id, strategy_version) DO UPDATE SET
       entry_at = excluded.entry_at, entry_price = excluded.entry_price, exit_at = excluded.exit_at,
       exit_price = excluded.exit_price, pnl_sol = excluded.pnl_sol, pnl_usdt = excluded.pnl_usdt,
       entry_native_price_usd = excluded.entry_native_price_usd, status = excluded.status, details = excluded.details`,
  ).run(
    t.signal_id,
    t.strategy_version,
    t.entry_at,
    t.entry_price,
    t.exit_at,
    t.exit_price,
    t.pnl_sol,
    t.pnl_usdt,
    t.entry_native_price_usd,
    t.status,
    JSON.stringify(t.details),
  );
}

export function getTrade(db: DB, signalId: number): TradeRow | null {
  const r = db
    .prepare("SELECT * FROM simulated_trades WHERE signal_id = ? ORDER BY strategy_version DESC LIMIT 1")
    .get(signalId) as (Omit<TradeRow, "details"> & { details: string }) | undefined;
  if (r === undefined) return null;
  return { ...r, details: r.details ? JSON.parse(r.details) : [] };
}

export function getTradesForSignals(db: DB, signalIds: number[]): Map<number, TradeRow> {
  const map = new Map<number, TradeRow>();
  if (signalIds.length === 0) return map;
  const ph = signalIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM simulated_trades WHERE signal_id IN (${ph})`)
    .all(...signalIds) as (Omit<TradeRow, "details"> & { details: string })[];
  for (const r of rows) {
    map.set(r.signal_id, { ...r, details: r.details ? JSON.parse(r.details) : [] });
  }
  return map;
}

// ─────────────────────────── replay_runs ───────────────────────────

export interface ReplayRunRow {
  id: number;
  time_from: number;
  time_to: number;
  rule_version: number;
  summary: string;
  details: string | null;
  created_at: number;
}

export function insertReplayRun(db: DB, r: Omit<ReplayRunRow, "id">): number {
  const res = db
    .prepare(
      "INSERT INTO replay_runs (time_from, time_to, rule_version, summary, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(r.time_from, r.time_to, r.rule_version, r.summary, r.details, r.created_at);
  return Number(res.lastInsertRowid);
}

export function listReplayRuns(db: DB, limit = 50): ReplayRunRow[] {
  return db
    .prepare("SELECT * FROM replay_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as ReplayRunRow[];
}

export function getReplayRun(db: DB, id: number): ReplayRunRow | null {
  return (db.prepare("SELECT * FROM replay_runs WHERE id = ?").get(id) as ReplayRunRow | undefined) ?? null;
}

// ─────────────────────────── notifications ───────────────────────────

export interface NotificationRow {
  id: number;
  signal_id: number;
  grade: string;
  notified_at: number;
  click_url: string;
}

export function insertNotification(
  db: DB,
  n: { signal_id: number; grade: string; click_url: string },
): number {
  const res = db
    .prepare("INSERT INTO notifications (signal_id, grade, notified_at, click_url) VALUES (?, ?, ?, ?)")
    .run(n.signal_id, n.grade, Date.now(), n.click_url);
  return Number(res.lastInsertRowid);
}

export interface NotificationListRow extends NotificationRow {
  symbol: string | null;
  token_address: string | null;
  chain: string | null;
}

export function listNotifications(db: DB, limit = 100): NotificationListRow[] {
  return (
    db
      .prepare(
        `SELECT n.*, s.symbol, s.token_address, s.chain
         FROM notifications n JOIN signals s ON s.id = n.signal_id
         ORDER BY n.notified_at DESC LIMIT ?`,
      )
      .all(limit) as NotificationListRow[]
  );
}

// ─────────────────────────── raw_captures（接口发现，§7.1） ───────────────────────────

export function insertRawCapture(db: DB, r: { url: string; captured_at: number; payload: unknown }): void {
  db.prepare("INSERT INTO raw_captures (url, captured_at, payload) VALUES (?, ?, ?)").run(
    r.url,
    r.captured_at,
    JSON.stringify(r.payload),
  );
}

// ─────────────────────────── 统计辅助 ───────────────────────────

/** 窗口内信号 + 最新评分（供 stats/replay 联表） */
export function signalsWithLatestScore(
  db: DB,
  from: number,
  to: number,
): { id: number; captured_at: number; token_address: string; symbol: string | null; grade: string; total_score: number; matched_rules: string; raw_payload: string }[] {
  return (
    db.prepare(
      `WITH latest AS (
        SELECT signal_id, phase, total_score, grade, matched_rules,
               ROW_NUMBER() OVER (PARTITION BY signal_id ORDER BY CASE phase WHEN 'v2' THEN 0 ELSE 1 END, id DESC) AS rn
        FROM signal_scores)
      SELECT s.id, s.captured_at, s.token_address, s.symbol, s.raw_payload, l.grade, l.total_score, l.matched_rules
      FROM signals s JOIN latest l ON l.signal_id = s.id AND l.rn = 1
      WHERE s.captured_at >= ? AND s.captured_at <= ?
      ORDER BY s.captured_at ASC`,
    ).all(from, to) as {
    id: number;
    captured_at: number;
    token_address: string;
    symbol: string | null;
    grade: string;
    total_score: number;
    matched_rules: string;
    raw_payload: string;
  }[]
  );
}
