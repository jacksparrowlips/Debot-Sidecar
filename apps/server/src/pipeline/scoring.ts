import {
  renderTokenUrl,
  type Grade,
  type HistoryCtx,
  type ScoreResult,
  type Signal,
  type SignalSummary,
  type SignalType,
} from "@debot/shared";
import { evaluate } from "@debot/rules-engine";
import { getCtx } from "../context.js";
import { countSignalEvents, insertScore } from "../store/signals.js";
import { runEnrichments } from "../enrichment/registry.js";
import { maybeNotify } from "../notifier/notifier.js";
import { schedule as scheduleSimulator } from "../simulator/simulator.js";

/** 历史上下文（isFirstSeen 由差分器传入；occurrencesInNm 由管线查询 SQLite 生成，§7.3/§7.5） */
function buildHistoryCtx(token: string, capturedAt: number, isFirstSeen: boolean): HistoryCtx {
  const { db } = getCtx();
  const count = (minutes: number) =>
    countSignalEvents(db, token, capturedAt - minutes * 60_000, capturedAt);
  return {
    isFirstSeen,
    windows: { "30": count(30), "60": count(60) },
  };
}

export function toSummary(
  signal: Signal,
  id: number,
  signalType: SignalType,
  grade: Grade,
  score: number,
): SignalSummary {
  const { config } = getCtx();
  return {
    id,
    captured_at: signal.captured_at,
    token_address: signal.token_address,
    symbol: signal.symbol,
    name: signal.name,
    chain: signal.chain,
    signal_type: signalType,
    grade,
    score,
    price: signal.price,
    market_cap_usd: signal.market_cap_usd,
    liquidity_usd: signal.liquidity_usd,
    holders: signal.holders,
    pct_5m: signal.pct_5m,
    pct_1h: signal.pct_1h,
    pct_24h: signal.pct_24h,
    tags: signal.tags,
    relevance_tags: signal.relevance_tags,
    max_price_gain: signal.max_price_gain,
    token_url: renderTokenUrl(config.tokenUrlTemplate, signal.chain, signal.token_address),
  };
}

/**
 * 评分管线（SPEC §7.2）：
 * 同步评分 v1（基础字段+历史上下文）→ 并行 enrichment → 重评分 v2 →
 * signal_scores 入库（记录 rule_version + 逐条命中明细）→ 通知判定 → WS 广播 → 模拟账户排队
 */
export async function processSignalEvent(
  signal: Signal,
  signalId: number,
  isFirstSeen: boolean,
  signalType: SignalType = "new",
): Promise<void> {
  const { db, ruleset, broadcast } = getCtx();
  const histCtx = buildHistoryCtx(signal.token_address, signal.captured_at, isFirstSeen);

  // ── v1：同步评分，立即广播（P1 验收：页面出信号，侧栏秒级出分级）──
  const v1 = evaluate(signal, ruleset, histCtx);
  insertScore(db, {
    signal_id: signalId,
    phase: "v1",
    rule_version: ruleset.version,
    total_score: v1.score,
    grade: v1.grade,
    matched: v1.matched,
    enrichedSnapshot: null,
  });
  broadcast({ type: "signal.scored", signal: toSummary(signal, signalId, signalType, v1.grade, v1.score), score: v1 });

  // ── enrichment（并行、超时 15s、失败静默，§7.7）──
  const rows = await runEnrichments(signal, signalId);
  const enriched: Record<string, Record<string, unknown>> = {};
  for (const r of rows) {
    if (r.status === "ok" && r.result !== null) {
      enriched[r.provider_id] = r.result as Record<string, unknown>;
    }
  }

  // ── v2：enriched.* 参与重评分 ──
  const signal2: Signal = { ...signal, enriched };
  const v2 = evaluate(signal2, ruleset, histCtx);
  insertScore(db, {
    signal_id: signalId,
    phase: "v2",
    rule_version: ruleset.version,
    total_score: v2.score,
    grade: v2.grade,
    matched: v2.matched,
    enrichedSnapshot: enriched,
  });
  if (v2.grade !== v1.grade || v2.score !== v1.score) {
    broadcast({
      type: "grade.updated",
      signalId,
      signal: toSummary(signal2, signalId, signalType, v2.grade, v2.score),
      score: v2,
    });
  }

  // ── 通知判定（v2 等级 >= 用户阈值 → 强通知，§7.6）──
  maybeNotify(signal2, toSummary(signal2, signalId, signalType, v2.grade, v2.score), v2);

  // ── 模拟账户（非 REJECT 信号，§7.10）──
  if (v2.grade !== "REJECT") scheduleSimulator(signalId);
}
