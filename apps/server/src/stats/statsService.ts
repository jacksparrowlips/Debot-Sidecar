import type { MatchedRule, StatsResult, StatsRow } from "@debot/shared";
import { getCtx } from "../context.js";
import { gainSinceSignal, getTradesForSignals, signalsWithLatestScore } from "../store/misc.js";

/**
 * 质量统计（SPEC §7.11）：聚合维度 等级×规则×时间段×规则版本；
 * 指标 信号数 / 平均最高点涨幅 / 模拟胜率 / 期望 PnL / 最大回撤。
 * 核心目标 = 回答"这套规则赚不赚钱、哪条规则在拖后腿"。
 */
export function computeStats(
  groupBy: "grade" | "rule",
  from: number | null,
  to: number | null,
): StatsResult {
  const { db } = getCtx();
  const now = Date.now();
  const f = from ?? 0;
  const t = to ?? now;
  const rows = signalsWithLatestScore(db, f, t);
  const trades = getTradesForSignals(
    db,
    rows.map((r) => r.id),
  );

  interface Acc {
    count: number;
    gainSum: number;
    gainN: number;
    simN: number;
    winN: number;
    pnlSum: number;
    curve: { entryAt: number; pnl: number }[];
  }
  const groups = new Map<string, Acc>();
  const acc = (key: string): Acc => {
    let a = groups.get(key);
    if (a === undefined) {
      a = { count: 0, gainSum: 0, gainN: 0, simN: 0, winN: 0, pnlSum: 0, curve: [] };
      groups.set(key, a);
    }
    return a;
  };

  for (const row of rows) {
    const trade = trades.get(row.id);
    const gain = gainSinceSignal(db, row.token_address, row.captured_at);
    const gainPct =
      gain !== null && gain.entryPrice > 0 ? ((gain.maxPrice - gain.entryPrice) / gain.entryPrice) * 100 : null;

    const feed = (a: Acc): void => {
      a.count++;
      if (gainPct !== null) {
        a.gainSum += gainPct;
        a.gainN++;
      }
      if (trade !== undefined && (trade.status === "closed" || trade.status === "open")) {
        a.simN++;
        if (trade.pnl_sol > 0) a.winN++;
        a.pnlSum += trade.pnl_sol;
        a.curve.push({ entryAt: trade.entry_at ?? row.captured_at, pnl: trade.pnl_sol });
      }
    };

    if (groupBy === "grade") {
      feed(acc(row.grade));
    } else {
      // rule 维度：命中该规则的信号集合 → "哪条规则在拖后腿"
      const matched = JSON.parse(row.matched_rules) as MatchedRule[];
      if (matched.length === 0) {
        feed(acc("(未命中任何规则)"));
      } else {
        for (const m of matched) feed(acc(m.ruleId));
      }
    }
  }

  const result: StatsRow[] = [];
  for (const [key, a] of groups) {
    result.push({
      key,
      signalCount: a.count,
      avgMaxGainPct: a.gainN > 0 ? Math.round((a.gainSum / a.gainN) * 100) / 100 : null,
      simulatedCount: a.simN,
      winRate: a.simN > 0 ? Math.round((a.winN / a.simN) * 10000) / 100 : null,
      expectedPnlSol: a.simN > 0 ? Math.round((a.pnlSum / a.simN) * 10000) / 10000 : null,
      maxDrawdownSol: maxDrawdown(a.curve),
    });
  }
  result.sort((x, y) => y.signalCount - x.signalCount);
  return { groupBy, from, to, rows: result };
}

/** 最大回撤：按入场时间排序的资金曲线（累计 PnL）峰谷落差 */
function maxDrawdown(curve: { entryAt: number; pnl: number }[]): number | null {
  if (curve.length === 0) return null;
  curve.sort((a, b) => a.entryAt - b.entryAt);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const c of curve) {
    cum += c.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return Math.round(dd * 10000) / 10000;
}
