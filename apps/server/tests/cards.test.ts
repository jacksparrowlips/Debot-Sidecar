import assert from "node:assert/strict";
import test from "node:test";
import { parseTokenEntry, DEFAULT_CONFIG } from "@debot/shared";
import { openDb } from "../src/store/db.js";
import { insertSignal } from "../src/store/signals.js";
import { insertPricePoint } from "../src/store/misc.js";
import { listSignalCards, rememberCardSnapshot } from "../src/store/cards.js";

test("cards fix the first snapshot, update during cooldown and exclude pre-signal ATH", () => {
  const db = openDb(":memory:");
  const entry = { address: "cards-test", symbol: "TEST", chain: "solana", market_info: { price: 2, mkt_cap: 200, holders: 10 }, pair_summary_info: { liquidity: 20 }, max_price_gain: 999 };
  const add = (raw: typeof entry, ts: number) => insertSignal(db, { captured_at: ts, token_address: raw.address, signal_type: "new", chain: "bsc,solana", symbol: raw.symbol, schema_version: 1, raw });
  try {
    add(entry, 1000);
    const next = { ...entry, market_info: { price: 3, mkt_cap: 300, holders: 15 } };
    add(next, 2000);
    for (const [ts, price] of [[900, 1000], [1000, 2], [1500, 6], [2000, 3]]) insertPricePoint(db, { token_address: entry.address, ts: ts!, price: price!, market_cap: null, source: "rank" });
    rememberCardSnapshot(parseTokenEntry({ ...next, market_info: { price: 4, mkt_cap: 400, holders: 18 } }, 3000, "bsc,solana"));
    let cards = listSignalCards(db, DEFAULT_CONFIG.tokenUrlTemplate);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.chain, "solana");
    assert.equal(cards[0]!.first.price, 2);
    assert.equal(cards[0]!.current.price, 4);
    assert.equal(cards[0]!.current.holders, 18);
    assert.equal(cards[0]!.signalCount, 2);
    assert.equal(cards[0]!.athMultiple, 3);
    assert.ok(cards[0]!.chart.every(p => p.ts >= 1000));
    assert.equal(cards[0]!.averageBuyUsd, null);
    add({ ...entry, chain: "bsc" }, 4000);
    cards = listSignalCards(db, DEFAULT_CONFIG.tokenUrlTemplate);
    assert.equal(cards.length, 2);
    assert.ok(cards.every(c => c.athMultiple === null && c.historyAmbiguous));
    assert.notEqual(cards[0]!.key, cards[1]!.key);
  } finally { db.close(); }
});

test("zero initial price never produces an infinite multiple", () => {
  const db = openDb(":memory:");
  try {
    insertSignal(db, { captured_at: 1000, token_address: "zero", signal_type: "new", chain: "bsc", symbol: "ZERO", schema_version: 1, raw: { address: "zero", market_info: { price: 0 } } });
    assert.equal(listSignalCards(db, DEFAULT_CONFIG.tokenUrlTemplate)[0]!.athMultiple, null);
  } finally { db.close(); }
});

test("cards stay ordered by first signal even when an older card is refreshed", () => {
  const db = openDb(":memory:");
  try {
    const add = (token: string, at: number) =>
      insertSignal(db, { captured_at: at, token_address: token, signal_type: "new", chain: "solana", symbol: token, schema_version: 1, raw: { address: token, chain: "solana", market_info: { price: 1 } } });
    add("older", 1_000);
    add("newer", 2_000);
    add("older", 3_000); // 后续信号只刷新内容，不能把旧卡片重新置顶。
    assert.deepEqual(listSignalCards(db, DEFAULT_CONFIG.tokenUrlTemplate).map(card => card.ca), ["newer", "older"]);
  } finally { db.close(); }
});

test("live prices update outside rank, preserve first baseline and isolate chains", async () => {
  const { rememberLiveMarket } = await import("../src/store/cards.js");
  const db = openDb(":memory:");
  try {
    insertSignal(db, { captured_at: 1000, token_address: "live-test", signal_type: "new", chain: "solana", symbol: "LIVE", schema_version: 1, raw: { address: "live-test", chain: "solana", total_supply: 100000, decimals: 2, market_info: { price: 2, holders: 10 } } });
    rememberLiveMarket({ chain: "solana", token: "live-test", price: 4 }, 2000);
    rememberLiveMarket({ chain: "solana", token: "live-test", holders: 20 }, 2500);
    rememberLiveMarket({ chain: "solana", token: "live-test", price: 3 }, 3000);
    rememberLiveMarket({ chain: "bsc", token: "live-test", price: 100 }, 4000);
    rememberLiveMarket({ chain: "solana", token: "live-test", price: 9 }, 1500);
    const card = listSignalCards(db, DEFAULT_CONFIG.tokenUrlTemplate)[0]!;
    assert.equal(card.first.price, 2);
    assert.equal(card.current.price, 3);
    assert.equal(card.current.marketCap, 3000);
    assert.equal(card.current.holders, 20);
    assert.equal(card.athMultiple, 2);
    assert.equal(card.priceAt, 3000);
    assert.equal(card.chart.at(-1)?.price, 3);
  } finally { db.close(); }
});
