// Side Panel（SPEC §7.8）：实时分级列表 + 告警 + Sidecar 连接状态/地址设置。
// 消息源：SW 转发的 ws-broadcast / ws-status；初始列表走 REST。

import { browser } from "wxt/browser";
import type { ServerBroadcastMsg, SignalSummary } from "@debot/shared";

interface SigItem {
  id: number;
  symbol: string;
  chain: string;
  grade: string;
  score: number;
  captured_at: number;
  signal_type: string;
  matched: string[];
  token_url: string;
}

const $signals = document.querySelector<HTMLDivElement>("#signals")!;
const $badge = document.querySelector<HTMLSpanElement>("#ws-badge")!;
const $alert = document.querySelector<HTMLDivElement>("#alert-banner")!;
const $serverUrl = document.querySelector<HTMLInputElement>("#server-url")!;
const $saveServer = document.querySelector<HTMLButtonElement>("#save-server")!;

let serverBase = "http://127.0.0.1:8787";
let items: SigItem[] = [];
let connected = false;
let expired = false;
function renderHealth(): void {
  $badge.textContent = expired ? "需人机验证" : connected ? "本地已连接" : "本地未连接";
  $badge.className = `badge ${connected && !expired ? "on" : "off"}`;
  if (expired) { $alert.textContent = "DeBot 采集已中断，请回到原标签页手动完成人机验证。自动刷新已停止。"; $alert.className = "alert error"; }
  else if ($alert.textContent?.includes("人机验证")) { $alert.textContent = ""; $alert.className = "alert"; }
}
const monitor = document.querySelector<HTMLAnchorElement>("#capture-monitor")!;

// ─────────────────────────── 渲染 ───────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function render(): void {
  $signals.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无信号——打开 DeBot AI Signal 页面后自动捕获";
    $signals.append(empty);
    return;
  }
  for (const it of items.slice(0, 50)) {
    const a = document.createElement("a");
    a.className = "sig";
    a.href = it.token_url;
    a.target = "_blank";
    a.rel = "noopener";

    const top = document.createElement("div");
    top.className = "sig-top";
    const sym = document.createElement("span");
    sym.className = "sig-symbol";
    sym.textContent = `${it.symbol}${it.signal_type === "resurface" ? " ↻" : ""}`;
    const grade = document.createElement("span");
    grade.className = `sig-grade ${it.grade}`;
    grade.textContent = it.grade;
    const score = document.createElement("span");
    score.className = "sig-score";
    score.textContent = `${it.score} 分 · ${fmtTime(it.captured_at)}`;
    top.append(sym, grade, score);

    const meta = document.createElement("div");
    meta.className = "sig-meta";
    const chain = document.createElement("span");
    chain.textContent = it.chain;
    meta.append(chain);
    if (it.matched.length > 0) {
      const m = document.createElement("span");
      m.textContent = `规则：${it.matched.join(", ")}`;
      meta.append(m);
    }

    a.append(top, meta);
    $signals.append(a);
  }
}

function upsert(summary: SignalSummary, score: number, matched: string[]): void {
  const next: SigItem = {
    id: summary.id,
    symbol: summary.symbol,
    chain: summary.chain,
    grade: summary.grade,
    score,
    captured_at: summary.captured_at,
    signal_type: summary.signal_type,
    matched,
    token_url: summary.token_url,
  };
  const idx = items.findIndex((x) => x.id === next.id);
  if (idx >= 0) items[idx] = next;
  else items.unshift(next);
  items = items.slice(0, 100);
  render();
}

// ─────────────────────────── 消息 ───────────────────────────

browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as
    | { type: "ws-broadcast"; msg: ServerBroadcastMsg }
    | { type: "ws-status"; connected: boolean }
    | { type: "page-health"; expired: boolean }
    | { type: "keepalive-config" }
    | undefined;
  if (m === undefined) return;
  if (m.type === "page-health") { expired = m.expired; renderHealth(); return; }
  if (m.type === "ws-status") {
    connected = m.connected; renderHealth();
    return;
  }
  if (m.type !== "ws-broadcast") return;
  const b = m.msg;
  if (b.type === "alert") {
    $alert.textContent = b.message;
    $alert.className = `alert ${b.level}`;
    return;
  }
  if (b.type === "signal.scored" || b.type === "grade.updated" || b.type === "notification") {
    upsert(b.signal, b.score.score, b.score.matched.map((x) => x.ruleId));
  }
});

// ─────────────────────────── 初始化 ───────────────────────────

async function loadInitial(): Promise<void> {
  try {
    const res = await fetch(`${serverBase}/api/signals?pageSize=30`);
    if (!res.ok) return;
    const page = (await res.json()) as {
      items: (SignalSummary & { rule_version: number })[];
    };
    items = page.items.map((s) => ({
      id: s.id,
      symbol: s.symbol,
      chain: s.chain,
      grade: s.grade,
      score: s.score,
      captured_at: s.captured_at,
      signal_type: s.signal_type,
      matched: [],
      token_url: s.token_url,
    }));
    render();
  } catch {
    // Sidecar 未启动：保持空态提示
  }
}

void (async () => {
  const st = await browser.storage.local.get("serverBase");
  if (typeof st.serverBase === "string" && st.serverBase.length > 0) {
    serverBase = st.serverBase;
    $serverUrl.value = serverBase;
  } else {
    $serverUrl.value = serverBase;
  }
  monitor.href = `${serverBase}/captures`;
  // 询问 SW 当前 WS 连接状态（打开前 SW 已连接的场合没有新广播，需拉快照）
  try {
    const r = (await browser.runtime.sendMessage({ type: "get-ws-status" })) as
      | { connected: boolean; expired: boolean }
      | undefined;
    connected = r?.connected ?? false; expired = r?.expired ?? false; renderHealth();
  } catch {
    // SW 未就绪：保持初始渲染
  }
  await loadInitial();
})();

$saveServer.addEventListener("click", () => {
  const v = $serverUrl.value.trim().replace(/\/+$/, "");
  if (v.length === 0) return;
  serverBase = v;
  monitor.href = `${serverBase}/captures`;
  void browser.storage.local.set({ serverBase: v });
  void browser.runtime.sendMessage({ type: "set-server", serverBase: v }).catch(() => {});
});
