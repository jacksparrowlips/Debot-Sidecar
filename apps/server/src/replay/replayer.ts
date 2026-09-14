import {
  applyRelevanceTags,
  parseTokenEntry,
  type HistoryCtx,
  type Ruleset,
} from "@debot/shared";
import { evaluate } from "@debot/rules-engine";
import { getCtx } from "../context.js";
import {
  countSignalEvents,
  firstSeenAt,
  getEnrichments,
  getSignalsInRange,
  type SignalRow,
} from "../store/signals.js";
import {
  getRuleVersion,
  getTradesForSignals,
  insertReplayRun,
  listReplayRuns,
  getReplayRun,
  type ReplayRunRow,
} from "../store/misc.js";
import { toSummary } from "../pipeline/scoring.js";
import type { ReplayDetail, ReplayRunDetail } from "@debot/shared";

/**
 * 回放器（SPEC §7.11）：选时间范围（+可选规则版本）→ 该窗口原始信号按时间序重喂规则引擎
 * （含已存 enrichment 数据与历史上下文重建）→ 逐条输出评分与命中明细；记录 replay_run 支持版本对比。
 */
function rebuildSignal(row: SignalRow, tagsLib: Parameters<typeof applyRelevanceTags>[1]) {
  const raw = JSON.parse(row.raw_payload) as Record<string, unknown>;
  const signal = parseTokenEntry(raw, row.captured_at, row.chain ?? "");
  signal.relevance_tags = applyRelevanceTags(signal, tagsLib);
  // 已存 enrichment 快照重放（当时的真实增强数据）
  for (const e of getEnrichments(getCtx().db, row.id)) {
    if (e.status === "ok" && e.result !== null) {
      signal.enriched[e.provider_id] = e.result as Record<string, unknown>;
    }
  }
  return signal;
}

function rebuildCtx(row: SignalRow): HistoryCtx {
  const { db } = getCtx();
  // isFirstSeen：该 token 全库首次出现时间 == 此条（当时视角重建）
  const first = firstSeenAt(db, row.token_address);
  const count = (m: number) =>
    countSignalEvents(db, row.token_address, row.captured_at - m * 60_000, row.captured_at);
  return {
    isFirstSeen: first !== null && first >= row.captured_at,
    windows: { "30": count(30), "60": count(60) },
  };
}

export function runReplay(from: number, to: number, ruleVersion?: number): ReplayRunDetail {
  const { db, ruleset, tags } = getCtx();
  const rs: Ruleset | null =
    ruleVersion !== undefined ? getRuleVersion(db, ruleVersion) : ruleset;
  if (rs === null) throw new Error(`规则版本 ${ruleVersion} 不存在`);
  if (rs.rules === undefined || !Array.isArray(rs.rules)) throw new Error("规则快照损坏");

  const rows = getSignalsInRange(db, from, to);
  const trades = getTradesForSignals(db, rows.map((r) => r.id));

  const grades: Record<string, number> = {};
  let scoreSum = 0;
  let winN = 0;
  let closedN = 0;
  const items: ReplayRunDetail["items"] = [];

  for (const row of rows) {
    const signal = rebuildSignal(row, tags);
    const ctx = rebuildCtx(row);
    const result = evaluate(signal, rs, ctx);
    grades[result.grade] = (grades[result.grade] ?? 0) + 1;
    scoreSum += result.score;
    const trade = trades.get(row.id);
    if (trade !== undefined && trade.pnl_usdt !== null && (trade.status === "closed" || trade.status === "open")) {
      closedN++;
      if (trade.pnl_usdt > 0) winN++;
    }
    items.push({
      signalId: row.id,
      token_address: row.token_address,
      symbol: row.symbol ?? signal.symbol,
      captured_at: row.captured_at,
      grade: result.grade,
      score: result.score,
      matched: result.matched,
    });
  }

  const summary = {
    count: rows.length,
    grades,
    avgScore: rows.length > 0 ? Math.round((scoreSum / rows.length) * 100) / 100 : 0,
    simulatedWinRate: closedN > 0 ? Math.round((winN / closedN) * 10000) / 100 : null,
  };

  const id = insertReplayRun(db, {
    time_from: from,
    time_to: to,
    rule_version: rs.version,
    summary: JSON.stringify(summary),
    details: JSON.stringify(items),
    created_at: Date.now(),
  });
  return { id, time_from: from, time_to: to, rule_version: rs.version, summary, created_at: Date.now(), items };
}

export function listReplays(): ReplayDetail[] {
  return listReplayRuns(getCtx().db).map(toDetail);
}

export function getReplay(id: number): ReplayRunDetail | null {
  const row = getReplayRun(getCtx().db, id);
  if (row === null) return null;
  const summary = JSON.parse(row.summary) as ReplayDetail["summary"];
  const items = row.details !== null ? (JSON.parse(row.details) as ReplayRunDetail["items"]) : [];
  return { ...toDetail(row), summary, items };
}

function toDetail(row: ReplayRunRow): ReplayDetail {
  return {
    id: row.id,
    time_from: row.time_from,
    time_to: row.time_to,
    rule_version: row.rule_version,
    summary: JSON.parse(row.summary) as ReplayDetail["summary"],
    created_at: row.created_at,
  };
}
