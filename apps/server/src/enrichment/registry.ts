import type { EnrichmentRow, Signal } from "@debot/shared";
import { getCtx } from "../context.js";
import { upsertEnrichment } from "../store/signals.js";
import { heatDexscreener } from "./heatDexscreener.js";

/** Provider 实现（enabled/超时由注册表统一控制，§7.7） */
export interface EnrichmentProviderImpl {
  id: string;
  enrich(signal: Signal): Promise<Record<string, unknown>>;
}

/** Provider 注册表：heat-dexscreener 默认实现；telegram-shill / kol-holdings 仅预留（不实现） */
const PROVIDERS: EnrichmentProviderImpl[] = [heatDexscreener];

/** 设置页 provider 清单（含预留项展示） */
export const PROVIDER_INFOS = [
  { id: "heat-dexscreener", description: "DexScreener 免费热度：交易次数/流动性/短时价格变化（通知热度区块）" },
  { id: "price-tracker", description: "价格追踪：被动 rank/kline 序列 + 离开榜单后 DexScreener 补价" },
  { id: "telegram-shill", description: "TG 喊单人数（预留，数据源接入时实现）", reserved: true },
  { id: "kol-holdings", description: "KOL 是否买入（预留，数据源接入时实现）", reserved: true },
] as const;

/**
 * 并行触发 enabled providers（默认超时 15s，失败静默不阻塞管线，§7.2/§7.7）。
 * 结果挂载 signal.enriched.<id>.* 并入库 signal_enrichments。
 */
export async function runEnrichments(signal: Signal, signalId: number): Promise<EnrichmentRow[]> {
  const { config } = getCtx();
  const enabled = PROVIDERS.filter((p) => config.enrichment.providers[p.id] === true);
  if (enabled.length === 0) return [];
  const timeoutMs = config.enrichment.timeoutSec * 1000;
  const fetchedAt = Date.now();

  const rows = await Promise.all(
    enabled.map(async (p): Promise<EnrichmentRow> => {
      try {
        const result = await Promise.race([
          p.enrich(signal),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (result === null) {
          return { provider_id: p.id, status: "timeout" as const, result: null, fetched_at: fetchedAt };
        }
        return { provider_id: p.id, status: "ok" as const, result, fetched_at: fetchedAt };
      } catch {
        return { provider_id: p.id, status: "failed" as const, result: null, fetched_at: fetchedAt };
      }
    }),
  );

  for (const r of rows) {
    upsertEnrichment(getCtx().db, {
      signal_id: signalId,
      provider_id: r.provider_id,
      status: r.status,
      result: r.result,
      fetched_at: r.fetched_at,
    });
  }
  return rows;
}
