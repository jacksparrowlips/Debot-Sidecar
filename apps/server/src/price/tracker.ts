import { getCtx } from "../context.js";
import { insertPricePoint } from "../store/misc.js";
import { staleTokens } from "../store/signals.js";
import { notifyPriceUpdate } from "../simulator/simulator.js";
import { RateLimiter } from "../util/rateLimiter.js";

/**
 * price-tracker（§7.7 P5 / §7.9 优先级 3）：
 * 被动序列（rank 轮询 + kline 回填）已在管线写入 price_points；
 * 本后台任务仅作补充——token 离开页面展示列表（静默 >30min）且近 7 天出现过时，
 * 周期性经 DexScreener 拉当前价补长窗口数据；死币无数据不写（data_missing 由消费侧标记）。
 */
const SCAN_INTERVAL_MS = 10 * 60_000;
const SILENCE_MS = 30 * 60_000;
const WINDOW_MS = 7 * 24 * 60 * 60_000;
const limiter = new RateLimiter(250);

async function fetchDexPrice(token: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pairs?: { priceUsd?: string | number }[] };
    const p = body.pairs?.[0]?.priceUsd;
    if (p === undefined) return null;
    const n = typeof p === "string" ? Number(p) : p;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null; // 死币/超时：静默
  }
}

export async function scanOnce(): Promise<number> {
  const { db, config } = getCtx();
  if (config.enrichment.providers["price-tracker"] !== true) return 0;
  const tokens = staleTokens(db, SILENCE_MS, WINDOW_MS);
  let written = 0;
  for (const token of tokens) {
    const price = await limiter.run(() => fetchDexPrice(token));
    if (price === null) continue;
    insertPricePoint(db, {
      token_address: token,
      ts: Date.now(),
      price,
      market_cap: null,
      source: "dexscreener",
    });
    written++;
  }
  if (written > 0) notifyPriceUpdate();
  return written;
}

export function startPriceTracker(): void {
  const t = setInterval(() => {
    void scanOnce().catch(() => {});
  }, SCAN_INTERVAL_MS);
  t.unref?.();
}
