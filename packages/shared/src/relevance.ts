import type { Signal, TagLibrary } from "./types.js";

/**
 * 相关性标签匹配（SPEC §7.4）：
 * DeBot tags 直接映射（binance_alpha 即 BINANCE 现成结构化标签）+ social_info / symbol / name 关键词匹配。
 * 返回命中的标签名列表（CZ / HE_YI / BINANCE …）。
 */
export function applyRelevanceTags(signal: Signal, tagLib: TagLibrary): string[] {
  const text = [
    signal.tags.join(" "),
    signal.social_twitter ?? "",
    signal.social_website ?? "",
    signal.social_description ?? "",
    signal.symbol ?? "",
    signal.name ?? "",
  ]
    .join(" ")
    .toLowerCase();
  if (text.trim().length === 0) return [];

  const hits: string[] = [];
  for (const [tag, keywords] of Object.entries(tagLib)) {
    for (const kw of keywords) {
      if (kw.length > 0 && text.includes(kw.toLowerCase())) {
        hits.push(tag);
        break;
      }
    }
  }
  return hits;
}
