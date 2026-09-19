import {
  P0,
  applyRelevanceTags,
  chainFromUrl,
  classifyCapture,
  parseKlineResponse,
  parseRankResponse,
  parseTokenEntry,
  type CaptureRawMsg,
  type CaptureRecord,
  type ExtToServerMsg,
  type Signal,
  type SignalType,
  type LiveMarketUpdate,
} from "@debot/shared";
import { rememberCardSnapshot, rememberLiveMarket } from "../store/cards.js";
import { observeCapture, observePageHealth } from "./captureMonitor.js";
import { getCtx } from "../context.js";
import { insertPricePoint, insertRawCapture } from "../store/misc.js";
import { getTokenStats, insertSignal, upsertTokenStats } from "../store/signals.js";
import { processSignalEvent } from "./scoring.js";
import { notifyPriceUpdate } from "../simulator/simulator.js";

/** L3 静默告警上次发出时间（节流防刷屏） */
let lastL3AlertAt = 0;

/**
 * 差分器（SPEC §7.2/§7.5）：按 token_address 与历史比对。
 * - 从未见过 / 超过冷却窗口未见 → 信号事件（signals 入库 + 评分管线）
 * - 冷却窗口内 → 刷新：occurrences+1、市值/持有人/流动性快照写 price_points，不生成新信号
 */
function differEntry(entry: Record<string, unknown>, chain: string, capturedAt: number): string {
  const { db, config, tags } = getCtx();
  const signal = parseTokenEntry(entry, capturedAt, chain);
  if (signal.token_address.length === 0) return "缺少地址";
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
    return "冷却期刷新";
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
  return type === "new" ? "新增信号" : "重新出现";
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
export function handleExtMessage(msg: ExtToServerMsg): void {
  const { broadcast } = getCtx();

  if (msg.type === "tab.health") {
    const changed = observePageHealth(msg);
    // L2：Cloudflare 人机验证页（无法自动恢复，P0 实证）→ 直接升级 L3 告警
    if (msg.loginState === "expired") {
      if (!changed) return;
      broadcast({
        type: "alert",
        level: "error",
        message: `DeBot 标签页（#${msg.tabId}）出现 Cloudflare 人机验证，捕获已中断——请到浏览器手动点击完成验证（不自动重登，SPEC §7.8 L2）`,
      });
    } else {
      // L3：信号源静默（rank/kline 停更，扩展按 signalAt 上报真实静默）→ 告警。
      // 心跳 30s 一次，静默期会连续命中：10 分钟最多一条，防 WebUI 通知刷屏
      const threshold = getCtx().config.keepalive.l1SilenceMin * 60_000 * 2;
      if (getCtx().config.keepalive.l1 && msg.signalSilenceMs > threshold && Date.now() - lastL3AlertAt > 10 * 60_000) {
        lastL3AlertAt = Date.now();
        broadcast({
          type: "alert",
          level: "warn",
          message: `信号源已静默 ${Math.round(msg.signalSilenceMs / 60_000)} 分钟（rank 轮询停更）——DeBot 页面可能已离开信号页，或轮询挂死且 L1 自动刷新未能恢复。请回到 DeBot 信号页（SPEC §7.8 L3）`,
        });
      }
    }
    return;
  }

  observeCapture(msg, (record, parsed) => {
    if (msg.type === "capture.raw") processCapture(msg, record, parsed);
  });
}

function processCapture(msg: CaptureRawMsg, record: CaptureRecord, normalized: unknown[]): void {
  const { db } = getCtx();
  if (msg.kind === "ws" && msg.url === "https://debot.ai/api/sidecar/live-market") {
    record.kind = "live-market";
    if (!Array.isArray(msg.data)) throw new Error("实时行情格式错误");
    for (const value of msg.data.slice(0, 500)) {
      if (!value || typeof value !== "object" || typeof value.chain !== "string" || typeof value.token !== "string") continue;
      rememberLiveMarket(value as LiveMarketUpdate, msg.capturedAt);
      normalized.push(value);
    }
    record.results["实时更新"] = normalized.length;
    return;
  }
  const kind = classifyCapture(msg.url, P0.SIGNAL_API_PREFIX);
  record.kind = kind;
  if (kind === "rank") {
    const parsed = parseRankResponse(msg.data);
    if (parsed === null) {
      record.status = "error";
      record.error = "rank 响应结构不匹配";
      // schema 不符：存 raw 待人工介入（前端改版风险，SPEC §12#4）
      insertRawCapture(db, { url: msg.url, captured_at: msg.capturedAt, payload: msg.data });
      return;
    }
    const chain = chainFromUrl(msg.url);
    for (const entry of parsed.entries) {
      const signal = parseTokenEntry(entry, msg.capturedAt, chain);
      rememberCardSnapshot(signal);
      const { raw, ...fields } = signal;
      if (normalized.length < 50) normalized.push(fields);
      if (signal.symbol && !record.symbols.includes(signal.symbol) && record.symbols.length < 50) record.symbols.push(signal.symbol);
      for (const key of ["token_address", "symbol", "price", "market_cap_usd", "liquidity_usd", "holders"] as const) {
        if ((signal[key] === null || signal[key] === "") && !record.missing.includes(key)) record.missing.push(key);
      }
      const result = differEntry(entry, chain, msg.capturedAt);
      record.results[result] = (record.results[result] ?? 0) + 1;
    }
    record.results["解析条目"] = parsed.entries.length;
    notifyPriceUpdate();
  } else if (kind === "kline") {
    const parsed = parseKlineResponse(msg.data);
    if (parsed !== null) {
      record.results["价格点"] = parsed.series.length;
      normalized.push(...parsed.series.slice(0, 50));
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
    } else {
      record.status = "error";
      record.error = "kline 响应结构不匹配";
    }
  } else {
    record.status = "unrecognized";
    // 其余 debot.ai/api/* 与 signal/ 前缀下未知端点：存 raw 不解析（接口发现，§7.1）
    insertRawCapture(db, { url: msg.url, captured_at: msg.capturedAt, payload: msg.data });
  }
}
