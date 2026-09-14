import assert from "node:assert/strict";
import test from "node:test";
import { chainFromUrl, classifyCapture, P0, DEFAULT_CONFIG, DEFAULT_RULESET, DEFAULT_STRATEGY, DEFAULT_TAG_LIBRARY } from "@debot/shared";
import { openDb } from "../src/store/db.js";
import { setContext } from "../src/context.js";
import { resolvePaths } from "../src/config/paths.js";
import { handleExtMessage } from "../src/pipeline/handleCapture.js";
import { captureSnapshot } from "../src/pipeline/captureMonitor.js";

test("relative API URLs classify correctly and malformed ranks are visible in monitor", () => {
  const url = "/api/community/signal/channel/activity/rank?chain=bsc";
  assert.equal(classifyCapture(url, P0.SIGNAL_API_PREFIX), "rank");
  assert.equal(classifyCapture(`https://debot.ai${url}`, P0.SIGNAL_API_PREFIX), "rank");
  assert.equal(chainFromUrl(url), "bsc");
  const db = openDb(":memory:");
  setContext({ db, paths: resolvePaths(), config: DEFAULT_CONFIG, ruleset: DEFAULT_RULESET, strategy: DEFAULT_STRATEGY, tags: DEFAULT_TAG_LIBRARY, broadcast: () => {} });
  try {
    handleExtMessage({ type: "capture.raw", source: "hook", kind: "http", url, capturedAt: Date.now(), data: { code: 0, data: {} } });
    const row = captureSnapshot(1).items[0]!;
    assert.equal(row.kind, "rank");
    assert.equal(row.status, "error");
    assert.match(row.error!, /结构不匹配/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM raw_captures").get() as { n: number }).n, 1);
  } finally { db.close(); }
});
