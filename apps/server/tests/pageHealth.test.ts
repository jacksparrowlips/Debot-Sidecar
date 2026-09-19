import assert from "node:assert/strict";
import test from "node:test";
import { isChallengePage, mayReloadPage, publicMarketUpdates } from "@debot/shared";
import { observePageHealth, captureSnapshot } from "../src/pipeline/captureMonitor.js";

test("recognizes Chinese challenge body even when title is debot.ai", () => {
  assert.equal(isChallengePage("debot.ai", "正在进行安全验证 请验证您是真人", false), true);
  assert.equal(isChallengePage("Just a moment...", "", false), true);
  assert.equal(isChallengePage("DeBot", "", true), true);
  assert.equal(isChallengePage("DeBot", "AI 信号 实时行情", false), false);
});
test("background, discarded, challenged, unknown, navigated-away and already-reloaded tabs never reload", () => {
  const state = { expired: false, active: true, discarded: false, attempted: false, healthAt: 990000, signalAt: 1000, signalUrl: "https://debot.ai/signal", url: "https://debot.ai/signal" };
  assert.equal(mayReloadPage(state, 1000000, 180000), true);
  for (const change of [{ expired: true }, { active: false }, { discarded: true }, { attempted: true }, { healthAt: 0 }, { signalAt: 0 }, { signalUrl: null }, { url: "https://debot.ai/token/detail" }]) assert.equal(mayReloadPage({ ...state, ...change }, 1000000, 180000), false);
});
test("challenge health survives subsequent UI snapshot reads and deduplicates alerts", () => {
  const msg = { type: "tab.health" as const, tabId: 999, url: "https://debot.ai/", loginState: "expired" as const, signalSilenceMs: 2000 };
  assert.equal(observePageHealth(msg), true);
  assert.equal(observePageHealth(msg), false);
  assert.equal(captureSnapshot(1).pageHealth.find(p => p.tabId === 999)?.loginState, "expired");
  observePageHealth({ ...msg, loginState: "ok" });
  assert.equal(captureSnapshot(1).pageHealth.find(p => p.tabId === 999)?.loginState, "ok");
});
test("worker bridge only forwards public market fields", () => {
  assert.deepEqual(publicMarketUpdates({ type: "socket-ack", args: [{ token: "secret" }] }), []);
  assert.deepEqual(publicMarketUpdates({ type: "socket-event", event: "authorization", args: ["secret"] }), []);
  const result = publicMarketUpdates({ type: "socket-event", event: "price-update", args: [[{ chain: "solana", token: "CA", price: "2", secret: "never-forward", liquidity: "3" }]] });
  assert.equal(result[0]?.price, 2);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
