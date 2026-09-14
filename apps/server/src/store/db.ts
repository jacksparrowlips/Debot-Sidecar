import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";

const MIGRATIONS: string[] = [
  // v1：全量数据模型（SPEC §10 + 差分所需 token_stats + 接口发现 raw_captures）
  `
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at INTEGER NOT NULL,
    dedup_key TEXT NOT NULL,
    token_address TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    chain TEXT,
    symbol TEXT,
    schema_version INTEGER NOT NULL,
    raw_payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_signals_token ON signals(token_address, captured_at);
  CREATE INDEX IF NOT EXISTS idx_signals_captured ON signals(captured_at);

  CREATE TABLE IF NOT EXISTS signal_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER NOT NULL REFERENCES signals(id),
    phase TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    total_score REAL NOT NULL,
    grade TEXT NOT NULL,
    matched_rules TEXT NOT NULL,
    enriched_snapshot TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scores_signal ON signal_scores(signal_id);

  CREATE TABLE IF NOT EXISTS rule_versions (
    version INTEGER PRIMARY KEY,
    snapshot TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS strategy_versions (
    version INTEGER PRIMARY KEY,
    snapshot TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signal_enrichments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER NOT NULL REFERENCES signals(id),
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    fetched_at INTEGER NOT NULL,
    UNIQUE(signal_id, provider_id)
  );

  CREATE TABLE IF NOT EXISTS price_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    ts INTEGER NOT NULL,
    price REAL NOT NULL,
    market_cap REAL,
    source TEXT NOT NULL,
    UNIQUE(token_address, ts, source)
  );
  CREATE INDEX IF NOT EXISTS idx_price_token_ts ON price_points(token_address, ts);

  CREATE TABLE IF NOT EXISTS simulated_trades (
    signal_id INTEGER NOT NULL,
    strategy_version INTEGER NOT NULL,
    entry_at INTEGER,
    entry_price REAL,
    exit_at INTEGER,
    exit_price REAL,
    pnl_sol REAL NOT NULL,
    status TEXT NOT NULL,
    details TEXT NOT NULL,
    PRIMARY KEY(signal_id, strategy_version)
  );

  CREATE TABLE IF NOT EXISTS replay_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time_from INTEGER NOT NULL,
    time_to INTEGER NOT NULL,
    rule_version INTEGER NOT NULL,
    summary TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER NOT NULL,
    grade TEXT NOT NULL,
    notified_at INTEGER NOT NULL,
    click_url TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS token_stats (
    token_address TEXT PRIMARY KEY,
    chain TEXT,
    symbol TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    occurrences INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS raw_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  `,
  // v2：跨链模拟统一按入场时原生币 USD 价格折算，旧 pnl_sol 保留用于兼容历史数据。
  `
  ALTER TABLE simulated_trades ADD COLUMN pnl_usdt REAL;
  ALTER TABLE simulated_trades ADD COLUMN entry_native_price_usd REAL;

  CREATE TABLE native_asset_prices (
    chain TEXT NOT NULL,
    ts INTEGER NOT NULL,
    price_usd REAL NOT NULL,
    PRIMARY KEY(chain, ts)
  );
  CREATE INDEX idx_native_price_chain_ts ON native_asset_prices(chain, ts);
  `,
];

export function openDb(dbFile: string): DB {
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // 迁移版本表须先建（首次运行时 select 才不抛错）
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = db
    .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
    .all()
    .map((r) => r.version);
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.includes(version)) return;
    db.exec(sql);
    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      version,
      Date.now(),
    );
  });
  return db;
}
