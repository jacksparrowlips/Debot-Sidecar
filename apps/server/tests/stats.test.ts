import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, DEFAULT_RULESET, DEFAULT_STRATEGY, DEFAULT_TAG_LIBRARY } from "@debot/shared";
import { resolvePaths } from "../src/config/paths.js";
import { setContext } from "../src/context.js";
import { computeStats } from "../src/stats/statsService.js";
import { openDb } from "../src/store/db.js";
import { upsertTrade } from "../src/store/misc.js";
import { insertScore, insertSignal } from "../src/store/signals.js";

test("quality stats aggregate USDT PnL rather than mixed native coins", () => {
  const db = openDb(":memory:");
  try {
    setContext({
      db,
      paths: resolvePaths("/tmp/debot-stats-test"),
      config: DEFAULT_CONFIG,
      ruleset: DEFAULT_RULESET,
      tags: DEFAULT_TAG_LIBRARY,
      strategy: DEFAULT_STRATEGY,
      broadcast: () => {},
    });
    const add = (token: string, at: number, pnlUsdt: number) => {
      const id = insertSignal(db, { captured_at: at, token_address: token, signal_type: "new", chain: "bsc", symbol: token, schema_version: 1, raw: {} });
      insertScore(db, { signal_id: id, phase: "v1", rule_version: 1, total_score: 80, grade: "HIGH", matched: [], enrichedSnapshot: null });
      upsertTrade(db, { signal_id: id, strategy_version: 1, entry_at: at, entry_price: 1, exit_at: at + 1, exit_price: 1, pnl_sol: 999, pnl_usdt: pnlUsdt, entry_native_price_usd: 600, status: "closed", details: [] });
    };
    add("bnb-profit", 1_000, 12);
    add("sol-loss", 2_000, -4);
    const row = computeStats("grade", null, null).rows[0]!;
    assert.equal(row.simulatedCount, 2);
    assert.equal(row.expectedPnlUsdt, 4);
    assert.equal(row.maxDrawdownUsdt, 4);
  } finally {
    db.close();
  }
});
