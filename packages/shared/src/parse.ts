import type { Signal } from "./types.js";

// ─────────────────────────── capture-parser（v1 = activity/rank 结构，附录 A） ───────────────────────────

export type CaptureKind = "rank" | "kline" | "unknown-signal" | "other-api";

/** 按 URL 判定捕获类型（SIGNAL_API_PREFIX 之外均按 other-api 存 raw 不解析） */
export function classifyCapture(url: string, signalApiPrefix: string): CaptureKind {
  let path: string;
  try {
    path = new URL(url, signalApiPrefix).pathname;
  } catch {
    return "other-api";
  }
  const prefix = new URL(signalApiPrefix).pathname; // /api/community/signal/
  if (path === `${prefix}channel/activity/rank`) return "rank";
  if (path === `${prefix}channel/token/kline`) return "kline";
  if (path.startsWith(prefix)) return "unknown-signal";
  return "other-api";
}

/** rank 请求的 chain 查询参数（页面级链筛选，存为信号属性） */
export function chainFromUrl(url: string): string {
  try {
    return new URL(url, "https://debot.ai").searchParams.get("chain") ?? "";
  } catch {
    return "";
  }
}

// ─────────────────────────── 防御式取值 helpers ───────────────────────────

function rec(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

function at(x: unknown, path: string): unknown {
  let cur: unknown = x;
  for (const seg of path.split(".")) {
    const r = rec(cur);
    if (r === null) return undefined;
    cur = r[seg];
  }
  return cur;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function str(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

function bool(x: unknown): boolean | null {
  // safe_info.goplux.* 以 -1 表示未知 → null
  if (typeof x === "number") return x === -1 ? null : x !== 0;
  if (typeof x === "boolean") return x;
  return null;
}

function strArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}

// ─────────────────────────── rank 响应解析 ───────────────────────────

export interface RankParseResult {
  entries: Record<string, unknown>[];
}

/** `{ code, description, data: TokenEntry[] }`；code:0 = 成功；结构不符返回 null（静默告警人工介入，SPEC §12#4） */
export function parseRankResponse(data: unknown): RankParseResult | null {
  const root = rec(data);
  if (root === null || root["code"] !== 0) return null;
  const d = root["data"];
  if (!Array.isArray(d)) return null;
  return { entries: d.filter((e): e is Record<string, unknown> => rec(e) !== null) };
}

/** TokenEntry → 统一 Signal（附录 A 字段映射表，全量字段宽松取值） */
export function parseTokenEntry(
  entry: Record<string, unknown>,
  capturedAt: number,
  chain: string,
): Signal {
  const market = at(entry, "market_info") ?? {};
  return {
    token_address: str(at(entry, "token_address")) ?? str(at(entry, "address")) ?? "",
    symbol: str(at(entry, "symbol")) ?? "",
    name: str(at(entry, "name")),
    logo: str(at(entry, "logo")),
    decimals: num(at(entry, "decimals")),
    total_supply: num(at(entry, "total_supply")),
    chain: str(entry["chain"]) ?? (chain.includes(",") ? "" : chain),
    launchpad: str(at(entry, "launchpad")),
    token_created_at: num(at(entry, "creation_timestamp")),
    price: num(at(market, "price")),
    market_cap_usd: num(at(market, "mkt_cap")),
    fdv: num(at(market, "fdv")),
    holders: num(at(market, "holders")),
    pct_5m: num(at(market, "percent_5m")),
    pct_1h: num(at(market, "percent_1h")),
    pct_24h: num(at(market, "percent_24h")),
    buys: num(at(market, "buys")),
    sells: num(at(market, "sells")),
    swaps: num(at(market, "swaps")),
    buy_volume: num(at(market, "buy_volume")),
    sell_volume: num(at(market, "sell_volume")),
    volume: num(at(market, "volume")),
    uniq_wallet_swaps: num(at(market, "uniq_wallet_swaps")),
    uniq_wallet_swaps_1h: num(at(market, "uniq_wallet_swaps_1h")),
    liquidity_usd: num(at(entry, "pair_summary_info.liquidity")),
    smart_wallets_online: num(at(entry, "smart_wallet_online_count")),
    smart_wallets_total: num(at(entry, "smart_wallet_total_count")),
    tags: strArray(at(entry, "tags")),
    is_honeypot: bool(at(entry, "safe_info.goplus.is_honeypot")),
    is_open_source: bool(at(entry, "safe_info.goplus.is_open_source")),
    is_ownership_abandoned: bool(at(entry, "safe_info.goplus.is_ownership_abandoned")),
    is_pool_locked: bool(at(entry, "safe_info.goplus.is_pool_locked")),
    pool_lock_percent: num(at(entry, "safe_info.goplus.pool_lock_percent")),
    pool_burn_percent: num(at(entry, "safe_info.goplus.pool_burn_percent")),
    buy_tax: num(at(entry, "safe_info.goplus.buy_tax")),
    sell_tax: num(at(entry, "safe_info.goplus.sell_tax")),
    risk_level: str(at(entry, "risk_level")),
    token_tier: str(at(entry, "token_tier")),
    activity_score: num(at(entry, "activity_score")),
    max_price_gain: num(at(entry, "max_price_gain")),
    social_twitter: str(at(entry, "social_info.twitter")),
    social_website: str(at(entry, "social_info.website")),
    social_description: str(at(entry, "social_info.description")),
    dex_name: str(at(entry, "dex.dex_name")),
    pair: str(at(entry, "dex.pair")),
    quote_token_symbol: str(at(entry, "dex.base_token.symbol")),
    quote_token_reserve: num(at(entry, "dex.base_token.reserve")),
    owner_address: str(at(entry, "safe_info.debot.owner_address")),
    relevance_tags: [],
    enriched: {},
    captured_at: capturedAt,
    raw: entry,
  };
}

// ─────────────────────────── kline 响应解析 ───────────────────────────

export interface KlineParseResult {
  /** kline: { <CA>: { <unix秒>: 价格 } }，ts 统一转 epoch ms */
  series: { token_address: string; ts: number; price: number }[];
}

export function parseKlineResponse(data: unknown): KlineParseResult | null {
  const root = rec(data);
  if (root === null || root["code"] !== 0) return null;
  const kline = rec(at(root, "data.kline"));
  if (kline === null) return null;
  const series: { token_address: string; ts: number; price: number }[] = [];
  for (const [ca, points] of Object.entries(kline)) {
    const p = rec(points);
    if (p === null) continue;
    for (const [sec, price] of Object.entries(p)) {
      const ts = Number(sec);
      const pr = num(price);
      if (Number.isFinite(ts) && ts > 0 && pr !== null) {
        series.push({ token_address: ca, ts: ts * 1000, price: pr });
      }
    }
  }
  return { series };
}
