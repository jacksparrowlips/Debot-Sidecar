import { describe, expect, it } from "vitest";
import { simulateTrade } from "../src/index.js";
import type { Strategy } from "@debot/shared";

const MIN = 60_000;

function strategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    strategyVersion: 1,
    initialCapitalNative: 10,
    entry: { delaySec: 10, amountNative: 0.5 },
    exit: [
      { trigger: { pnlPct: 50 }, sellPct: 50 },
      { trigger: { pnlPct: -30 }, sellPct: 100 },
      { trigger: { holdHours: 24 }, sellPct: 100 },
    ],
    costs: { slippagePct: 0, feePct: 0 }, // 单测先零成本验证纯价格逻辑
    ...overrides,
  };
}

const t0 = 1_700_000_000_000;

describe("simulateTrade", () => {
  it("无入场后数据 → no_data，不进统计分母", () => {
    const r = simulateTrade({
      signalId: 1,
      strategy: strategy(),
      signalTime: t0,
      priceSeries: [{ ts: t0 - 1000, price: 1 }],
    });
    expect(r.status).toBe("no_data");
    expect(r.entryAt).toBeNull();
  });

  it("止盈分批：+50% 卖一半，随后 +100% 触发后清仓（每条规则仅一次）", () => {
    const series = [
      { ts: t0 + 10_000, price: 1 }, // 入场（delaySec=10）
      { ts: t0 + 60_000, price: 1.5 }, // +50% → 卖 50%
      { ts: t0 + 120_000, price: 2 }, // +100%（已触发过 pnlPct:50，不再卖）
      { ts: t0 + 180_000, price: 0.5 }, // -50%（含成本后相对入场仍为负？入场 1，0.5 → -50% ≤ -30% → 全卖）
    ];
    const r = simulateTrade({ signalId: 1, strategy: strategy(), signalTime: t0, priceSeries: series });
    expect(r.status).toBe("closed");
    expect(r.entryPrice).toBe(1);
    expect(r.details.length).toBe(2);
    expect(r.details[0]?.reason).toBe("pnlPct:50");
    // 第二批卖出：止损（相对入场净 -50% <= -30%）
    expect(r.details[1]?.reason).toBe("pnlPct:-30");
    // 0 成本：一半本金 +50%、另一半 -50% → 总盈亏 = 0
    expect(r.pnlNative).toBeCloseTo(0, 8);
  });

  it("超时清仓：holdHours 触发全卖", () => {
    const series = [
      { ts: t0 + 10_000, price: 1 },
      { ts: t0 + 10_000 + 24 * 3_600_000, price: 1.1 },
    ];
    const r = simulateTrade({ signalId: 1, strategy: strategy(), signalTime: t0, priceSeries: series });
    expect(r.status).toBe("closed");
    expect(r.details[0]?.reason).toBe("holdHours:24");
    expect(r.pnlNative).toBeCloseTo(0.05, 8); // 0.5 原生币 × 10%
  });

  it("数据枯竭仍持仓 → open，浮动 PnL 按最后价标记", () => {
    const series = [
      { ts: t0 + 10_000, price: 1 },
      { ts: t0 + 70_000, price: 1.4 }, // +40%：不触发任何规则（<50%）
    ];
    const r = simulateTrade({ signalId: 1, strategy: strategy(), signalTime: t0, priceSeries: series });
    expect(r.status).toBe("open");
    expect(r.exitAt).toBeNull();
    expect(r.pnlNative).toBeCloseTo(0.2, 8); // 0.5 × 40%
  });

  it("成本：滑点+手续费压低净收益", () => {
    const series = [
      { ts: t0 + 10_000, price: 1 },
      { ts: t0 + 2 * 3_600_000, price: 1 }, // 价格不变，超时清仓
    ];
    const noCost = simulateTrade({
      signalId: 1,
      strategy: strategy(),
      signalTime: t0,
      priceSeries: series,
    });
    const withCost = simulateTrade({
      signalId: 1,
      strategy: strategy({ costs: { slippagePct: 5, feePct: 1 } }),
      signalTime: t0,
      priceSeries: series,
    });
    expect(noCost.pnlNative).toBeCloseTo(0, 8);
    // 5% 滑点双边 + 1% 手续费双边：净比例 = 0.99^2 × 0.95/(1.05) ≈ 0.8878 → 亏
    // 序列仅 2 小时且价格不变：无规则命中（-11.2% 未达 -30% 止损），持仓 open、details 为空
    expect(withCost.pnlNative).toBeLessThan(0);
    expect(withCost.status).toBe("open");
    expect(withCost.details).toHaveLength(0);
  });

  it("入场价取 entryAt 之后首个点，忽略入场前价格", () => {
    const series = [
      { ts: t0, price: 999 }, // 信号时点（早于入场 delay）
      { ts: t0 + 10_000, price: 2 }, // 入场
      { ts: t0 + 10_000 + 25 * 3_600_000, price: 2.6 },
    ];
    const r = simulateTrade({ signalId: 1, strategy: strategy(), signalTime: t0, priceSeries: series });
    expect(r.entryPrice).toBe(2);
    expect(r.pnlNative).toBeCloseTo(0.15, 8); // 0.5 × +30%
  });
});
