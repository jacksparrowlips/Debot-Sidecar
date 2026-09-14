import { P0 } from "./p0.js";
import type { Ruleset, Strategy, TagLibrary, SidecarConfig } from "./types.js";

/** 预置规则包（SPEC §7.3 示例 + 附录 A 统一字段名；含相关性预置包，§7.4） */
export const DEFAULT_RULESET: Ruleset = {
  version: 1,
  baseScore: 50,
  thresholds: { LOW: 60, MEDIUM: 70, HIGH: 85, VERY_HIGH: 95 },
  rules: [
    {
      id: "mcap-too-high",
      when: { field: "market_cap_usd", op: ">", value: 5_000_000 },
      action: "reject",
    },
    {
      id: "liq-too-low",
      when: { field: "liquidity_usd", op: "<", value: 5_000 },
      action: "reject",
    },
    {
      id: "honeypot",
      when: { field: "is_honeypot", op: "=", value: true },
      action: "reject",
    },
    {
      id: "dup-30m",
      when: { field: "occurrencesIn30m", op: ">", value: 2 },
      action: "reject",
    },
    {
      id: "cz-related",
      when: { field: "relevance_tags", op: "contains", value: "CZ" },
      action: { addScore: 20 },
    },
    {
      id: "he-yi-related",
      when: { field: "relevance_tags", op: "contains", value: "HE_YI" },
      action: { addScore: 15 },
    },
    {
      id: "binance-related",
      when: { field: "relevance_tags", op: "contains", value: "BINANCE" },
      action: { addScore: 15 },
    },
    {
      id: "first-seen",
      when: { field: "isFirstSeen", op: "=", value: true },
      action: { addScore: 10 },
    },
    {
      id: "heat-txns-24h",
      when: { field: "enriched.heat-dexscreener.txns24h", op: ">", value: 500 },
      action: { addScore: 5 },
    },
  ],
};

/** 相关性标签库（SPEC §7.4；binance_alpha 为 DeBot tags 现成结构化标签） */
export const DEFAULT_TAG_LIBRARY: TagLibrary = {
  CZ: ["CZ", "Changpeng Zhao", "cz_binance"],
  HE_YI: ["何一", "Yi He"],
  BINANCE: ["Binance", "币安", "binance_alpha"],
};

/** 默认策略模板（SPEC §7.10 示意） */
export const DEFAULT_STRATEGY: Strategy = {
  strategyVersion: 1,
  initialCapitalNative: 10,
  entry: { delaySec: 10, amountNative: 0.5 },
  exit: [
    { trigger: { pnlPct: 50 }, sellPct: 50 },
    { trigger: { pnlPct: -30 }, sellPct: 100 },
    { trigger: { holdHours: 24 }, sellPct: 100 },
  ],
  costs: { slippagePct: 5, feePct: 1 },
};

/** 默认配置（dataDir 由服务端 loader 展开；端口 8787 用户已确认） */
export const DEFAULT_CONFIG: SidecarConfig = {
  port: 8787,
  dataDir: "~/.debot-sidecar",
  cooldownMin: 10,
  notify: {
    cardGrade: "HIGH",
    systemGrade: "VERY_HIGH",
    size: [480, 420],
    position: "top-right",
    sound: { enabled: true, volume: 0.8, file: null },
    theme: "dark",
  },
  enrichment: {
    timeoutSec: 15,
    providers: {
      "heat-dexscreener": true,
      "price-tracker": true,
      // 仅预留（不实现）：telegram-shill / kol-holdings（SPEC §7.7）
      "telegram-shill": false,
      "kol-holdings": false,
    },
  },
  keepalive: {
    // L0 合成事件 isTrusted 有效性 P0 未定稿（唯一剩余项）→ 默认关闭，实测有效后开启
    l0: false,
    l0IntervalMin: 3,
    l1: true,
    l1SilenceMin: 3,
  },
  tokenUrlTemplate: P0.TOKEN_URL_TEMPLATE,
};

/** 渲染 token 详情页 URL（通知/卡片点击跳转） */
export function renderTokenUrl(template: string, chain: string, ca: string): string {
  return template.replaceAll("{chain}", chain).replaceAll("{ca}", ca);
}
