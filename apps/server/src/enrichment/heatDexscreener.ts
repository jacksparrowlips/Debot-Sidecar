import type { Signal } from "@debot/shared";
import type { EnrichmentProviderImpl } from "./registry.js";
import { RateLimiter } from "../util/rateLimiter.js";

/** DexScreener rate limit：300 req/min → 保守 250ms 串行间隔 */
const limiter = new RateLimiter(250);

/** 内存缓存：同 token 60s 内不重复请求 */
const cache = new Map<string, { at: number; result: Record<string, unknown> }>();
const CACHE_TTL_MS = 60_000;

interface DexPair {
  chainId?: string;
  priceUsd?: string | number;
  liquidity?: { usd?: number };
  txns?: Record<string, { buys?: number; sells?: number }>;
  priceChange?: Record<string, number | string>;
  url?: string;
}

/**
 * heat-dexscreener（P5，默认启用）：
 * 交易次数、流动性、短时价格变化 → 通知内"热度大致统计"区块（§7.7）。
 * 队列 + 缓存 + 遵守 rate limit；失败静默（registry 已捕获）。
 */
export const heatDexscreener: EnrichmentProviderImpl = {
  id: "heat-dexscreener",
  async enrich(signal: Signal): Promise<Record<string, unknown>> {
    const key = signal.token_address;
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

    return limiter.run(async () => {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(key)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`dexscreener ${res.status}`);
      const body = (await res.json()) as { pairs?: DexPair[] };
      const pair = body.pairs?.[0];
      if (pair === undefined) throw new Error("dexscreener: no pair");

      const txns = pair.txns ?? {};
      const sumTxns = (k: string): number | null => {
        const t = txns[k];
        if (t === undefined || t.buys === undefined || t.sells === undefined) return null;
        return Number(t.buys) + Number(t.sells);
      };
      const pct = (k: string): number | null => {
        const v = pair.priceChange?.[k];
        const n = typeof v === "string" ? Number(v) : v;
        return typeof n === "number" && Number.isFinite(n) ? n : null;
      };

      const result: Record<string, unknown> = {
        txns5m: sumTxns("m5"),
        txns1h: sumTxns("h1"),
        txns24h: sumTxns("h24"),
        liquidityUsd: pair.liquidity?.usd !== undefined ? Number(pair.liquidity.usd) : null,
        priceChangeM5: pct("m5"),
        priceChangeH1: pct("h1"),
        priceChangeH24: pct("h24"),
        url: pair.url ?? null,
      };
      cache.set(key, { at: Date.now(), result });
      return result;
    });
  },
};
