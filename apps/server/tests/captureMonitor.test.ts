import assert from "node:assert/strict";
import test from "node:test";
import { captureDetail, captureSnapshot, observeCapture } from "../src/pipeline/captureMonitor.js";

test("monitor measures response handoff, separates duplicates/errors and bounds previews", () => {
  const capturedAt = Date.now() - 5000;
  const observedAt = Date.now() - 20;
  observeCapture({ type: "capture.raw", source: "hook", kind: "http", url: "https://debot.ai/api/rank?access_token=private", capturedAt, observedAt, data: { access_token: "private", symbol: "TEST" } }, (r, parsed) => {
    r.results["冷却期刷新"] = 1;
    parsed.push({ price: null });
  });
  let state = captureSnapshot(1);
  const row = state.items[0]!;
  assert.ok(row.delayMs! >= 20 && row.delayMs! < 1000);
  assert.equal(row.results["冷却期刷新"], 1);
  assert.ok(!row.url.includes("private"));
  assert.ok(!captureDetail(row.id)!.raw.includes("private"));
  observeCapture({ type: "capture.duplicate", url: row.url, capturedAt }, () => assert.fail("duplicates must not enter processing"));
  assert.equal(captureSnapshot(1).items[0]!.delayMs, null);
  observeCapture({ type: "capture.raw", source: "hook", kind: "http", url: row.url, capturedAt, data: "x".repeat(20000) }, () => { throw new Error("schema mismatch"); });
  state = captureSnapshot(0);
  assert.equal(state.errors, 1);
  assert.equal(state.items[0]!.status, "error");
  assert.equal(captureDetail(state.items[0]!.id)!.truncated, true);
  assert.ok(captureDetail(state.items[0]!.id)!.raw.length <= 16384);
  for (let i = 0; i < 201; i++) observeCapture({ type: "capture.duplicate", url: row.url, capturedAt }, () => {});
  state = captureSnapshot(1);
  assert.equal(state.items.length, 200);
  assert.equal(captureDetail(row.id), undefined);
  assert.equal(state.received, 204);
  assert.equal(state.perMinute, 204);
});
