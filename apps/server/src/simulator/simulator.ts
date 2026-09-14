import { simulateTrade } from "@debot/simulator-core";
import type { Database as DB } from "better-sqlite3";
import { getCtx } from "../context.js";
import { getPriceSeriesSampled, upsertTrade } from "../store/misc.js";

/**
 * 模拟账户（SPEC §7.10）：对每个非 REJECT 信号按策略模板模拟入场/出场。
 * 信号与价格是流式到达的（入场 delaySec 后才有价格），因此采用"挂起重算"模型：
 * 价格更新（rank/kline/dexscreener 写入）→ debounce 触发；每 5min 兜底重算一次。
 * 重算 = 同一 simulator-core 纯函数重放全部价格序列（实时模拟与回放复用同一份代码）。
 */

const RETRY_WINDOW_MS = 48 * 60 * 60_000; // no_data 超 48h 放弃（死币，不进统计分母）
const BATCH_LIMIT = 200;
const DEBOUNCE_MS = 3_000;

let pending = false;
let timer: ReturnType<typeof setTimeout> | null = null;

interface PendingRow {
  id: number;
  token_address: string;
  captured_at: number;
}

function queryPending(db: DB, strategyVersion: number): PendingRow[] {
  return (
    db.prepare(
      `WITH latest AS (
        SELECT signal_id, grade,
               ROW_NUMBER() OVER (PARTITION BY signal_id ORDER BY CASE phase WHEN 'v2' THEN 0 ELSE 1 END, id DESC) AS rn
        FROM signal_scores)
      SELECT s.id, s.token_address, s.captured_at
      FROM signals s
      JOIN latest l ON l.signal_id = s.id AND l.rn = 1
      LEFT JOIN simulated_trades st ON st.signal_id = s.id AND st.strategy_version = ?
      WHERE l.grade != 'REJECT'
        AND (st.signal_id IS NULL
             OR st.status = 'open'
             OR (st.status = 'no_data' AND s.captured_at >= ?))
      ORDER BY s.captured_at DESC
      LIMIT ?`,
    ).all(strategyVersion, Date.now() - RETRY_WINDOW_MS, BATCH_LIMIT) as PendingRow[]
  );
}

async function runOnce(): Promise<void> {
  pending = false;
  const { db, strategy } = getCtx();
  const rows = queryPending(db, strategy.strategyVersion);
  for (const row of rows) {
    const series = getPriceSeriesSampled(db, row.token_address, row.captured_at, 2000);
    const trade = simulateTrade({
      signalId: row.id,
      strategy,
      signalTime: row.captured_at,
      priceSeries: series,
    });
    // SimulatedTrade（camelCase）→ 存储行（snake_case）
    upsertTrade(db, {
      signal_id: trade.signalId,
      strategy_version: trade.strategyVersion,
      entry_at: trade.entryAt,
      entry_price: trade.entryPrice,
      exit_at: trade.exitAt,
      exit_price: trade.exitPrice,
      pnl_sol: trade.pnlSol,
      status: trade.status,
      details: trade.details,
    });
  }
}

/** 新信号（非 REJECT）入队 */
export function schedule(_signalId: number): void {
  // 统一走 debounce 批处理（_signalId 仅语义标记：差分器调用点）
  if (pending) return;
  pending = true;
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void runOnce().catch(() => {});
  }, DEBOUNCE_MS);
}

/** 价格数据更新（rank/kline/dexscreener 写入后）触发重算（可能推进 open 状态出场） */
export function notifyPriceUpdate(): void {
  schedule(0);
}

export function startSimulatorLoop(): void {
  const t = setInterval(() => {
    void runOnce().catch(() => {});
  }, 5 * 60_000);
  t.unref?.();
}
