import type { Database as DB } from "better-sqlite3";
import { parseTokenEntry, renderTokenUrl, type Signal, type SignalCard, type CardMetrics, type Grade, type LiveMarketUpdate } from "@debot/shared";
import { getPriceSeriesSampled } from "./misc.js";

// 当前榜单字段覆盖冷却期刷新；重启后退回已持久化信号快照，并保留该快照时间。
const live = new Map<string, Signal>();
const keyOf = (s: Signal) => JSON.stringify([s.chain, s.token_address]);
export function rememberCardSnapshot(signal: Signal): void {
  if (!signal.token_address || !signal.chain) return;
  const key = keyOf(signal);
  if ((live.get(key)?.captured_at ?? 0) > signal.captured_at) return;
  live.delete(key);
  live.set(key, signal);
  if (live.size > 500) live.delete(live.keys().next().value!);
}
const realtime = new Map<string, { fields: Partial<Record<keyof CardMetrics, { value: number; at: number }>>; peak: number; peakAt: number; chart: { ts: number; price: number }[] }>();
export function rememberLiveMarket(update: LiveMarketUpdate, at: number): void {
  if (!update.chain || !update.token || !Number.isFinite(at)) return;
  const key = JSON.stringify([update.chain, update.token]);
  const state = realtime.get(key) ?? { fields: {}, peak: 0, peakAt: 0, chart: [] };
  for (const field of ["price", "holders", "liquidity", "marketCap"] as const) {
    const value = update[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field === "price" && value === 0) || at < (state.fields[field]?.at ?? 0)) continue;
    state.fields[field] = { value, at };
    if (field === "price") {
      if (value >= state.peak) { state.peak = value; state.peakAt = at; }
      state.chart.push({ ts: at, price: value });
      if (state.chart.length > 80) state.chart.shift();
    }
  }
  realtime.delete(key);
  realtime.set(key, state);
  if (realtime.size > 500) realtime.delete(realtime.keys().next().value!);
}
const metrics = (s: Signal): CardMetrics => ({ price: s.price, marketCap: s.market_cap_usd, holders: s.holders, liquidity: s.liquidity_usd });

export function listSignalCards(db: DB, tokenTemplate: string): SignalCard[] {
  // raw.chain 同时修正旧记录将多链查询参数当作单币链名的情况，不改写历史数据。
  const rows = db.prepare(`
    WITH normalized AS (
      SELECT *, COALESCE(json_extract(raw_payload, '$.chain'), CASE WHEN instr(chain, ',') = 0 THEN chain ELSE '' END) AS card_chain
      FROM signals
    ), grouped AS (
      SELECT card_chain, token_address, MIN(id) AS first_id, MAX(id) AS last_id, COUNT(*) AS signal_count
      FROM normalized WHERE card_chain != '' GROUP BY card_chain, token_address
      ORDER BY first_id DESC LIMIT 100
    )
    SELECT g.*, f.raw_payload AS first_raw, f.captured_at AS first_at,
      l.raw_payload AS last_raw, l.captured_at AS last_at,
      (SELECT grade FROM signal_scores WHERE signal_id = g.last_id ORDER BY CASE phase WHEN 'v2' THEN 0 ELSE 1 END, id DESC LIMIT 1) AS grade,
      (SELECT total_score FROM signal_scores WHERE signal_id = g.last_id ORDER BY CASE phase WHEN 'v2' THEN 0 ELSE 1 END, id DESC LIMIT 1) AS score,
      (SELECT COUNT(DISTINCT card_chain) FROM normalized n WHERE n.token_address = g.token_address) AS chain_count
    FROM grouped g JOIN signals f ON f.id = g.first_id JOIN signals l ON l.id = g.last_id
  `).all() as { card_chain: string; token_address: string; first_id: number; last_id: number; signal_count: number; first_raw: string; last_raw: string; first_at: number; last_at: number; grade: Grade | null; score: number | null; chain_count: number }[];
  const peakQuery = db.prepare("SELECT MAX(price) AS peak FROM price_points WHERE token_address = ? AND ts >= ? AND price > 0");
  const latestQuery = db.prepare("SELECT ts, price FROM price_points WHERE token_address = ? AND ts >= ? AND price > 0 ORDER BY ts DESC, id DESC LIMIT 1");
  return rows.map(row => {
    const first = parseTokenEntry(JSON.parse(row.first_raw), row.first_at, row.card_chain);
    const saved = parseTokenEntry(JSON.parse(row.last_raw), row.last_at, row.card_chain);
    const cached = live.get(keyOf(first));
    const current = cached && cached.captured_at >= saved.captured_at ? cached : saved;
    // 旧价格表没有链维度；同 CA 多链时不使用它，避免串链制造虚假 ATH。
    const ambiguous = row.chain_count > 1;
    const peak = ambiguous ? null : (peakQuery.get(row.token_address, row.first_at) as { peak: number | null }).peak;
    const latest = ambiguous ? undefined : latestQuery.get(row.token_address, row.first_at) as { ts: number; price: number } | undefined;
    const prices = [first.price, current.price, peak].filter((p): p is number => p !== null && Number.isFinite(p) && p > 0);
    const chart = ambiguous ? [] : getPriceSeriesSampled(db, row.token_address, row.first_at, 80).filter(p => p.price > 0);
    const firstMetrics = metrics(first);
    const currentMetrics = metrics(current);
    if (latest && latest.ts >= current.captured_at) currentMetrics.price = latest.price;
    const stream = realtime.get(keyOf(first));
    let priceAt = Math.max(current.captured_at, latest?.ts ?? 0);
    if (stream) {
      for (const field of ["price", "holders", "liquidity", "marketCap"] as const) {
        const patch = stream.fields[field];
        if (patch && patch.at >= (field === "price" ? priceAt : current.captured_at)) currentMetrics[field] = patch.value;
      }
      const tick = stream.fields.price;
      if (tick && tick.at >= priceAt) {
        priceAt = tick.at;
        // DeBot uses supply / decimals for current market cap as well.
        if (current.total_supply !== null && current.decimals !== null && !stream.fields.marketCap) {
          const cap = tick.value * current.total_supply / 10 ** current.decimals;
          if (Number.isFinite(cap)) currentMetrics.marketCap = cap;
        }
      }
      if (!ambiguous) {
        if (stream.peakAt >= first.captured_at) prices.push(stream.peak);
        chart.push(...stream.chart.filter(p => p.ts >= first.captured_at && p.ts > (chart.at(-1)?.ts ?? 0)));
      }
    }
    return {
      key: keyOf(first), signalId: row.last_id, chain: first.chain, ca: first.token_address,
      symbol: current.symbol, name: current.name, logo: current.logo,
      tokenUrl: renderTokenUrl(tokenTemplate, first.chain, first.token_address),
      firstAt: row.first_at, updatedAt: current.captured_at, priceAt,
      createdAt: current.token_created_at === null ? null : current.token_created_at < 1e12 ? current.token_created_at * 1000 : current.token_created_at,
      signalCount: row.signal_count, grade: row.grade ?? "LOW", score: row.score ?? 0,
      first: firstMetrics, current: currentMetrics,
      athMultiple: !ambiguous && first.price !== null && first.price > 0 && prices.length ? Math.max(...prices) / first.price : null,
      chart: chart.length ? chart : first.price !== null && first.price > 0 ? [{ ts: row.first_at, price: first.price }] : [],
      historyAmbiguous: ambiguous, smartWallets: current.smart_wallets_online,
      averageBuyUsd: null, // 当前 rank 协议没有同时买入均额，禁止用成交额/交易次数冒充。
      safety: { honeypot: current.is_honeypot, openSource: current.is_open_source, abandoned: current.is_ownership_abandoned, locked: current.is_pool_locked },
    };
  });
}
