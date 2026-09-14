import {
  P0,
  applyRelevanceTags,
  chainFromUrl,
  classifyCapture,
  parseKlineResponse,
  parseRankResponse,
  parseTokenEntry,
  type CaptureRawMsg,
  type Signal,
  type SignalType,
  type TabHealthMsg,
} from "@debot/shared";
import { getCtx } from "../context.js";
import { insertPricePoint, insertRawCapture } from "../store/misc.js";
import { getTokenStats, insertSignal, upsertTokenStats } from "../store/signals.js";
import { processSignalEvent } from "./scoring.js";
import { notifyPriceUpdate } from "../simulator/simulator.js";

/**
 * 差分器（SPEC §7.2/§7.5）：按 token_address 与历史比对。
 * - 从未见过 / 超过冷却窗口未见 → 信号事件（signals 入库 + 评分管线）
 * - 冷却窗口内 → 刷新：occurrences+1、市值/持有人/流动性快照写 price_points，不生成新信号
 */
function differEntry(entry: Record<string, unknown>, chain: string, capturedAt: number): void {
  const { db, config, tags } = getCtx();
  const signal = parseTokenEntry(entry, capturedAt, chain);
  if (signal.token_address.length === 0) return;
  signal.relevance_tags = applyRelevanceTags(signal, tags);

  writePriceSnapshot(signal);

  const stats = getTokenStats(db, signal.token_address);
  const cooldownMs = config.cooldownMin * 60_000;
  let type: SignalType;
  if (stats === null) {
    type = "new";
    upsertTokenStats(db, {
      token_address: signal.token_address,
      chain: signal.chain,
      symbol: signal.symbol,
      first_seen: capturedAt,
      last_seen: capturedAt,
      occurrences: 1,
    });
  } else if (capturedAt - stats.last_seen > cooldownMs) {
    type = "resurface";
    upsertTokenStats(db, {
      ...stats,
      chain: signal.chain,
      symbol: signal.symbol,
      last_seen: capturedAt,
      occurrences: stats.occurrences + 1,
    });
  } else {
    // 冷却窗口内刷新：不生成新信号
    upsertTokenStats(db, {
      ...stats,
      chain: signal.chain,
      symbol: signal.symbol,
      last_seen: capturedAt,
      occurrences: stats.occurrences + 1,
    });
    return;
  }

  const signalId = insertSignal(db, {
    captured_at: capturedAt,
    token_address: signal.token_address,
    signal_type: type,
    chain: signal.chain,
    symbol: signal.symbol,
    schema_version: P0.SIGNAL_SCHEMA_VERSION,
    raw: signal.raw,
  });
  // 评分管线异步推进（v1 立即广播，enrichment 最长 15s 不阻塞后续捕获）
  void processSignalEvent(signal, signalId, type === "new", type);
}

/** rank 轮询快照 → price_points（market_info.price，按轮询频率写入，§7.9） */
function writePriceSnapshot(signal: Signal): void {
  if (signal.price === null || signal.price <= 0) return;
  insertPricePoint(getCtx().db, {
    token_address: signal.token_address,
    ts: signal.captured_at,
    price: signal.price,
    market_cap: signal.market_cap_usd,
    source: "rank",
  });
}

/** WS 上行入口：capture.raw → 分类解析；tab.health → 登录失效告警 */
export function handleExtMessage(msg: CaptureRawMsg | TabHealthMsg): void {
  const { db, broadcast } = getCtx();

  if (msg.type === "tab.health") {
    // L2：Cloudflare 人机验证页（无法自动恢复，P0 实证）→ 直接升级 L3 告警
    if (msg.loginState === "expired") {
      broadcast({
        type: "alert",
        level: "error",
        message: `DeBot 标签页（#${msg.tabId}）出现 Cloudflare 人机验证，捕获已中断——请到浏览器手动点击完成验证（不自动重登，SPEC §7.8 L2）`,
      });
    } else {
      // L3：L1 已 reload 但捕获静默仍未恢复（silence > 2×l1SilenceMin）→ 告警升级
      const threshold = getCtx().config.keepalive.l1SilenceMin * 60_000 * 2;
      if (getCtx().config.keepalive.l1 && msg.signalSilenceMs > threshold) {
        broadcast({
          type: "alert",
          level: "warn",
          message: `捕获已静默 ${Math.round(msg.signalSilenceMs / 60_000)} 分钟，L1 自动刷新未能恢复——请检查 DeBot 标签页（SPEC §7.8 L3）`,
        });
      }
    }
    return;
  }

  const kind = classifyCapture(msg.url, P0.SIGNAL_API_PREFIX);
  if (kind === "rank") {
    const parsed = parseRankResponse(msg.data);
    if (parsed === null) {
      // schema 不符：存 raw 待人工介入（前端改版风险，SPEC §12#4）
      insertRawCapture(db, { url: msg.url, captured_at: msg.capturedAt, payload: msg.data });
      return;
    }
    const chain = chainFromUrl(msg.url);
    for (const entry of parsed.entries) differEntry(entry, chain, msg.capturedAt);
    notifyPriceUpdate();
  } else if (kind === "kline") {
    const parsed = parseKlineResponse(msg.data);
    if (parsed !== null) {
      for (const p of parsed.series) {
        insertPricePoint(db, {
          token_address: p.token_address,
          ts: p.ts,
          price: p.price,
          market_cap: null,
          source: "kline",
        });
      }
      notifyPriceUpdate();
    }
  } else {
    // 其余 debot.ai/api/* 与 signal/ 前缀下未知端点：存 raw 不解析（接口发现，§7.1）
    insertRawCapture(db, { url: msg.url, captured_at: msg.capturedAt, payload: msg.data });
  }
}
