import type { CaptureDetail, CaptureRawMsg, CaptureRecord, CaptureSnapshot, ExtToServerMsg } from "@debot/shared";

const pageHealth = new Map<number, { tabId: number; loginState: "ok" | "expired" | "unknown"; receivedAt: number }>();
export function observePageHealth(msg: Extract<ExtToServerMsg, { type: "tab.health" }>): boolean {
  const changed = pageHealth.get(msg.tabId)?.loginState !== msg.loginState;
  pageHealth.set(msg.tabId, { tabId: msg.tabId, loginState: msg.loginState, receivedAt: Date.now() });
  if (pageHealth.size > 100) pageHealth.delete(pageHealth.keys().next().value!);
  return changed;
}
const startedAt = Date.now();
let sequence = 0;
let errors = 0;
let lastReceivedAt: number | null = null;
/** 最近一次信号源捕获（rank/kline）接收时间；与 lastReceivedAt（含 live-market/杂项）区分 */
let lastSignalAt: number | null = null;
const records: CaptureDetail[] = [];
const arrivals: number[] = [];
const LIMIT = 200;
const TEXT_LIMIT = 16_384;

// 诊断数据仅驻留内存；单条文本有上限，并隐藏常见凭据字段。
function preview(value: unknown): string {
  return JSON.stringify(value, (key, v) => /authorization|cookie|password|secret|access.?token|refresh.?token|api.?key/i.test(key) ? "[已隐藏]" : v, 2) ?? "null";
}
function safeUrl(url: string): string {
  try { const u = new URL(url, "https://debot.ai"); return `${u.origin}${u.pathname}`; }
  catch { return "（无效 URL）"; }
}
export function observeCapture(
  msg: Exclude<ExtToServerMsg, { type: "tab.health" }>,
  process: (record: CaptureRecord, parsed: unknown[]) => void,
): void {
  const now = Date.now();
  lastReceivedAt = now;
  arrivals.push(now);
  while (arrivals.length && arrivals[0]! < now - 60_000) arrivals.shift();
  const observed = msg.observedAt;
  const record: CaptureRecord = {
    id: ++sequence, url: safeUrl(msg.url), kind: "unknown", capturedAt: msg.capturedAt,
    observedAt: typeof observed === "number" && Number.isFinite(observed) ? observed : null,
    receivedAt: now, delayMs: typeof observed === "number" && Number.isFinite(observed) && observed <= now ? now - observed : null,
    status: msg.type === "capture.duplicate" ? "duplicate" : "processed",
    results: {}, missing: [], symbols: [],
  };
  const parsed: unknown[] = [];
  try { if (msg.type !== "capture.duplicate") process(record, parsed); }
  catch (err) { record.status = "error"; record.error = err instanceof Error ? err.message : "处理失败"; }
  // 信号源判定在 process 内已写入 record.kind（rank/kline = 信号页在供数；live-market/other-api 不算）
  if (record.kind === "rank" || record.kind === "kline") lastSignalAt = now;
  if (record.status === "error") errors++;
  const raw = msg.type === "capture.raw" ? preview((msg as CaptureRawMsg).data) : "重复响应仅上报元数据；原始数据请查看此前记录。";
  const normalized = preview(parsed);
  records.unshift({ ...record, raw: raw.slice(0, TEXT_LIMIT), parsed: normalized.slice(0, TEXT_LIMIT), truncated: raw.length > TEXT_LIMIT || normalized.length > TEXT_LIMIT });
  records.length = Math.min(records.length, LIMIT);
}
export function captureSnapshot(extensionConnections: number): CaptureSnapshot {
  const now = Date.now();
  while (arrivals.length && arrivals[0]! < now - 60_000) arrivals.shift();
  return { pageHealth: [...pageHealth.values()].filter(p => now - p.receivedAt < 120_000), startedAt, now, extensionConnections, lastReceivedAt, lastSignalAt, received: sequence, errors,
    perMinute: arrivals.length, items: records.map(({ raw, parsed, truncated, ...record }) => record) };
}
export function captureDetail(id: number): CaptureDetail | undefined { return records.find(r => r.id === id); }
