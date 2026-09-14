import type { Database as DB } from "better-sqlite3";

/** 链名 → CoinGecko 原生资产 ID。未知链不臆测价格，Pnl 会保持缺失。 */
const COIN_BY_CHAIN: Record<string, string> = {
  solana: "solana",
  bsc: "binancecoin",
  "binance-smart-chain": "binancecoin",
  ethereum: "ethereum",
  eth: "ethereum",
  base: "ethereum",
  arbitrum: "ethereum",
  optimism: "ethereum",
  polygon: "matic-network",
  avalanche: "avalanche-2",
  avax: "avalanche-2",
};
const CACHE_WINDOW_MS = 6 * 60 * 60_000;

function chainKey(chain: string): string {
  return chain.trim().toLowerCase();
}

/**
 * 返回最接近入场时刻的原生币 USD 价格。历史数据按链缓存，避免同批回放重复请求。
 * CoinGecko 不可用或不支持该链时返回 null，调用方不得用其他链价格替代。
 */
export async function nativeAssetPriceUsd(db: DB, chain: string, at: number): Promise<number | null> {
  const key = chainKey(chain);
  const coin = COIN_BY_CHAIN[key];
  if (coin === undefined) return null;
  const cached = db
    .prepare(
      `SELECT price_usd FROM native_asset_prices
       WHERE chain = ? AND ts BETWEEN ? AND ?
       ORDER BY ABS(ts - ?) LIMIT 1`,
    )
    .get(key, at - CACHE_WINDOW_MS, at + CACHE_WINDOW_MS, at) as { price_usd: number } | undefined;
  if (cached !== undefined) return cached.price_usd;

  try {
    const from = Math.floor((at - 60 * 60_000) / 1000);
    const to = Math.ceil((at + 60 * 60_000) / 1000);
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coin}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { prices?: unknown };
    const prices = Array.isArray(body.prices)
      ? body.prices.filter((p): p is [number, number] =>
          Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" && p[1] > 0,
        )
      : [];
    if (prices.length === 0) return null;
    const [ts, price] = prices.reduce((best, point) => (Math.abs(point[0] - at) < Math.abs(best[0] - at) ? point : best));
    db.prepare("INSERT OR REPLACE INTO native_asset_prices (chain, ts, price_usd) VALUES (?, ?, ?)").run(key, ts, price);
    return price;
  } catch {
    return null;
  }
}
