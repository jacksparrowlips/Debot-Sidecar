import type { SellEvent, SimulatedTrade, Strategy } from "@debot/shared";

export interface PricePointIn {
  ts: number;
  price: number;
}

export interface SimulateInput {
  signalId: number;
  strategy: Strategy;
  /** 信号时间（epoch ms） */
  signalTime: number;
  /** 该 token 的价格序列（ts 升序；来自 price_points） */
  priceSeries: PricePointIn[];
}

/**
 * 模拟引擎（纯函数，SPEC §7.10）：
 * 对单个信号按策略模板模拟入场/分批出场，输出虚拟 PnL。
 *
 * 成本模型（保守）：买入付滑点+手续费（实际到手 token 少），卖出同扣；
 * PnL 用价格比例计算，与价格单位无关（原生币本金 × 净值变化）。
 */
export function simulateTrade(input: SimulateInput): SimulatedTrade {
  const { signalId, strategy, signalTime, priceSeries } = input;
  const costs = strategy.costs;
  const fee = costs.feePct / 100;
  const slip = costs.slippagePct / 100;
  const entryAt = signalTime + strategy.entry.delaySec * 1000;

  const empty: SimulatedTrade = {
    signalId,
    strategyVersion: strategy.strategyVersion,
    entryAt: null,
    entryPrice: null,
    exitAt: null,
    exitPrice: null,
    pnlNative: 0,
    status: "no_data",
    details: [],
  };

  // 入场价 = entryAt 时刻（含）之后第一个价格点
  const pts = [...priceSeries].sort((a, b) => a.ts - b.ts);
  let startIdx = pts.findIndex((p) => p.ts >= entryAt && p.price > 0);
  if (startIdx === -1) return empty;
  const entryPoint = pts[startIdx]!;
  const entryPrice = entryPoint.price;

  // 净值比：p 为当前 raw 价时，1 SOL 本金买出入再全卖出的净得比例
  const netRatio = (p: number): number => {
    const buy = entryPrice * (1 + slip);
    const sell = p * (1 - slip);
    return ((1 - fee) / buy) * sell * (1 - fee);
  };

  const amountNative = strategy.entry.amountNative;
  let remaining = amountNative; // 剩余本金（所属链原生币计）
  let realized = 0;
  const details: SellEvent[] = [];
  const fired = new Set<string>(); // 每条出场规则至多触发一次（阶梯止盈语义）

  for (let i = startIdx; i < pts.length && remaining > 1e-12; i++) {
    const p = pts[i]!;
    const pnlPct = (netRatio(p.price) - 1) * 100;
    for (let r = 0; r < strategy.exit.length && remaining > 1e-12; r++) {
      const rule = strategy.exit[r]!;
      const key = String(r);
      if (fired.has(key)) continue;
      let hit = false;
      const tp = rule.trigger.pnlPct;
      if (tp !== undefined) {
        // 正阈值=止盈（pnlPct >= tp 触发），负阈值=止损（pnlPct <= tp 触发）
        hit = tp >= 0 ? pnlPct >= tp : pnlPct <= tp;
      }
      if (rule.trigger.holdHours !== undefined && p.ts - entryAt >= rule.trigger.holdHours * 3_600_000) hit = true;
      if (!hit) continue;
      fired.add(key);
      const slice = Math.min(remaining, (remaining * rule.sellPct) / 100);
      if (slice <= 0) continue;
      remaining -= slice;
      const gain = slice * (netRatio(p.price) - 1);
      realized += gain;
      const reason =
        rule.trigger.pnlPct !== undefined ? `pnlPct:${rule.trigger.pnlPct}` : `holdHours:${rule.trigger.holdHours}`;
      details.push({
        ts: p.ts,
        price: p.price,
        sellPct: rule.sellPct,
        reason,
        realizedPnlNative: gain,
      });
    }
  }

  // 浮动盈亏（仍有持仓时按最后可见价标记）
  const last = pts[pts.length - 1]!;
  const floating = remaining > 1e-12 ? remaining * (netRatio(last.price) - 1) : 0;
  const pnlNative = realized + floating;
  const closed = remaining <= 1e-12;

  return {
    signalId,
    strategyVersion: strategy.strategyVersion,
    entryAt,
    entryPrice,
    exitAt: closed && details.length > 0 ? details[details.length - 1]!.ts : null,
    exitPrice: closed && details.length > 0 ? details[details.length - 1]!.price : remaining > 1e-12 ? last.price : null,
    pnlNative,
    status: closed ? "closed" : "open",
    details,
  };
}
