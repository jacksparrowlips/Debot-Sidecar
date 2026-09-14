import { describe, expect, it } from "vitest";
import { evaluate, getField, gradeGte } from "../src/index.js";
import { DEFAULT_RULESET, type HistoryCtx, type Ruleset, type Signal } from "@debot/shared";

function mkSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    token_address: "0xabc",
    symbol: "TEST",
    name: null,
    logo: null,
    decimals: null,
    total_supply: null,
    chain: "bsc",
    launchpad: null,
    token_created_at: null,
    price: 0.001,
    market_cap_usd: 100_000,
    fdv: null,
    holders: 500,
    pct_5m: 10,
    pct_1h: 20,
    pct_24h: null,
    buys: 100,
    sells: 40,
    swaps: 140,
    buy_volume: null,
    sell_volume: null,
    volume: null,
    uniq_wallet_swaps: null,
    uniq_wallet_swaps_1h: null,
    liquidity_usd: 20_000,
    smart_wallets_online: null,
    smart_wallets_total: null,
    tags: [],
    is_honeypot: null,
    is_open_source: null,
    is_ownership_abandoned: null,
    is_pool_locked: null,
    pool_lock_percent: null,
    pool_burn_percent: null,
    buy_tax: null,
    sell_tax: null,
    risk_level: null,
    token_tier: null,
    activity_score: null,
    max_price_gain: null,
    social_twitter: null,
    social_website: null,
    social_description: null,
    dex_name: null,
    pair: null,
    quote_token_symbol: null,
    quote_token_reserve: null,
    owner_address: null,
    relevance_tags: [],
    enriched: {},
    captured_at: Date.now(),
    raw: {},
    ...overrides,
  };
}

const noDupCtx: HistoryCtx = { isFirstSeen: true, windows: { "30": 1 } };

describe("getField", () => {
  it("按点分路径取 Signal 字段", () => {
    const s = mkSignal({ enriched: { "heat-dexscreener": { txns24h: 800 } } });
    expect(getField(s, "market_cap_usd")).toBe(100_000);
    expect(getField(s, "enriched.heat-dexscreener.txns24h")).toBe(800);
    expect(getField(s, "not.a.field")).toBeUndefined();
  });

  it("历史上下文字段：isFirstSeen / occurrencesInNm", () => {
    const s = mkSignal();
    const ctx: HistoryCtx = { isFirstSeen: false, windows: { "30": 3, "60": 7 } };
    expect(getField(s, "isFirstSeen", ctx)).toBe(false);
    expect(getField(s, "occurrencesIn30m", ctx)).toBe(3);
    expect(getField(s, "occurrencesIn60m", ctx)).toBe(7);
    expect(getField(s, "occurrencesIn30m")).toBe(0); // 无 ctx 时 0
  });
});

describe("evaluate", () => {
  it("基础分 50 + first-seen +10 = 60，恰达 LOW 阈值 → LOW", () => {
    const rs: Ruleset = {
      version: 1,
      baseScore: 50,
      thresholds: { LOW: 60, MEDIUM: 70, HIGH: 85, VERY_HIGH: 95 },
      rules: [
        { id: "first-seen", when: { field: "isFirstSeen", op: "=", value: true }, action: { addScore: 10 } },
      ],
    };
    const r = evaluate(mkSignal(), rs, { isFirstSeen: true, windows: {} });
    expect(r.score).toBe(60);
    expect(r.grade).toBe("LOW"); // 低于 LOW 阈值(60)? 60 >= 60 → LOW 本身就是兜底，60 不达 MEDIUM
    expect(r.matched).toEqual([{ ruleId: "first-seen", delta: 10 }]);
  });

  it("命中 reject → REJECT 且记录命中明细", () => {
    const rs: Ruleset = {
      version: 2,
      baseScore: 50,
      thresholds: { LOW: 60, MEDIUM: 70, HIGH: 85, VERY_HIGH: 95 },
      rules: [
        { id: "mcap-too-high", when: { field: "market_cap_usd", op: ">", value: 5_000_000 }, action: "reject" },
      ],
    };
    const r = evaluate(mkSignal({ market_cap_usd: 9_000_000 }), rs, noDupCtx);
    expect(r.grade).toBe("REJECT");
    expect(r.matched).toEqual([{ ruleId: "mcap-too-high", delta: "reject" }]);
  });

  it("阈值分界：>=85 → HIGH，>=95 → VERY_HIGH", () => {
    const rs: Ruleset = {
      version: 1,
      baseScore: 90,
      thresholds: { LOW: 60, MEDIUM: 70, HIGH: 85, VERY_HIGH: 95 },
      rules: [],
    };
    expect(evaluate(mkSignal(), rs, noDupCtx).grade).toBe("HIGH");
    const rs95: Ruleset = { ...rs, baseScore: 95 };
    expect(evaluate(mkSignal(), rs95, noDupCtx).grade).toBe("VERY_HIGH");
  });

  it("操作符：contains（数组，大小写不敏感）、in（白名单）、regex", () => {
    const rs: Ruleset = {
      version: 1,
      baseScore: 50,
      thresholds: { LOW: 60, MEDIUM: 70, HIGH: 85, VERY_HIGH: 95 },
      rules: [
        { id: "a", when: { field: "tags", op: "contains", value: "binance_alpha" }, action: { addScore: 10 } },
        { id: "b", when: { field: "token_address", op: "in", value: ["0xabc", "0xdef"] }, action: { addScore: 10 } },
        { id: "c", when: { field: "social_twitter", op: "regex", value: "cz.*" }, action: { addScore: 10 } },
      ],
    };
    const s = mkSignal({ tags: ["BINANCE_ALPHA"], social_twitter: "cz_binance" });
    const r = evaluate(s, rs, noDupCtx);
    expect(r.score).toBe(80);
    expect(r.matched.map((m) => m.ruleId)).toEqual(["a", "b", "c"]);
  });

  it("occurrencesIn30m > 2 → reject（重复信号去重）", () => {
    const rs: Ruleset = {
      version: 1,
      baseScore: 50,
      thresholds: { LOW: 60, MEDIUM: 70, HIGH: 85, VERY_HIGH: 95 },
      rules: [
        { id: "dup-30m", when: { field: "occurrencesIn30m", op: ">", value: 2 }, action: "reject" },
      ],
    };
    const hot = evaluate(mkSignal(), rs, { isFirstSeen: false, windows: { "30": 3 } });
    expect(hot.grade).toBe("REJECT");
    const cool = evaluate(mkSignal(), rs, { isFirstSeen: false, windows: { "30": 2 } });
    expect(cool.grade).not.toBe("REJECT");
  });

  it("缺字段：数值比较不命中、!= 命中（null ≠ 具体值）", () => {
    const rs: Ruleset = {
      version: 1,
      baseScore: 50,
      thresholds: { LOW: 60, MEDIUM: 70, HIGH: 85, VERY_HIGH: 95 },
      rules: [
        { id: "a", when: { field: "is_honeypot", op: ">", value: 0 }, action: { addScore: 10 } },
        { id: "b", when: { field: "risk_level", op: "!=", value: "low" }, action: { addScore: 10 } },
      ],
    };
    const r = evaluate(mkSignal(), rs, noDupCtx); // is_honeypot=null, risk_level=null
    expect(r.matched.map((m) => m.ruleId)).toEqual(["b"]);
  });

  it("subScore 扣分", () => {
    const rs: Ruleset = {
      version: 1,
      baseScore: 70,
      thresholds: { LOW: 60, MEDIUM: 70, HIGH: 85, VERY_HIGH: 95 },
      rules: [
        { id: "r", when: { field: "sells", op: ">", value: 0 }, action: { subScore: 15 } },
      ],
    };
    const r = evaluate(mkSignal(), rs, noDupCtx);
    expect(r.score).toBe(55);
  });

  it("预置规则包：CZ 相关 +20 + first-seen +10 = 80 → MEDIUM", () => {
    const s = mkSignal({ relevance_tags: ["CZ"] });
    const r = evaluate(s, DEFAULT_RULESET, { isFirstSeen: true, windows: { "30": 1 } });
    expect(r.matched.map((m) => m.ruleId)).toContain("cz-related");
    expect(r.score).toBe(80);
    expect(r.grade).toBe("MEDIUM");
  });
});

describe("gradeGte", () => {
  it("等级序：HIGH >= HIGH、HIGH >= MEDIUM、MEDIUM >= HIGH 为 false", () => {
    expect(gradeGte("HIGH", "HIGH")).toBe(true);
    expect(gradeGte("HIGH", "MEDIUM")).toBe(true);
    expect(gradeGte("MEDIUM", "HIGH")).toBe(false);
    expect(gradeGte("REJECT", "LOW")).toBe(false);
    expect(gradeGte("VERY_HIGH", "HIGH")).toBe(true);
  });
});
