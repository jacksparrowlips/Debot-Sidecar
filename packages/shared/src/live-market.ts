/** Only public market fields cross the worker bridge; never forward auth/ack events. */
export interface LiveMarketUpdate {
  chain: string;
  token: string;
  price?: number;
  holders?: number;
  liquidity?: number;
  marketCap?: number;
}
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const number = (v: unknown): number | undefined => (typeof v === "number" || typeof v === "string" && v.trim() !== "") && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined;
export function publicMarketUpdates(message: unknown): LiveMarketUpdate[] {
  const m = object(message);
  if (!m || m.type !== "socket-event" || !Array.isArray(m.args)) return [];
  const entries = m.event === "price-update" && Array.isArray(m.args[0]) ? m.args[0] : m.event === "community-signal-channel" ? [m.args[0]] : [];
  return entries.slice(0, 500).flatMap((value: unknown) => {
    const v = object(value);
    if (!v || typeof v.chain !== "string" || typeof v.token !== "string" || !v.chain || !v.token) return [];
    const update: LiveMarketUpdate = { chain: v.chain, token: v.token };
    if (m.event === "price-update") {
      update.price = number(v.price);
      update.liquidity = number(v.liquidity);
      update.holders = number(v.holders);
      update.marketCap = number(v.market_cap ?? v.mkt_cap);
    } else if (v.event_type === "holder_count") update.holders = number(v.data);
    return Object.values(update).some(x => typeof x === "number") ? [update] : [];
  });
}
