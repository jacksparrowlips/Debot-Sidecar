// MV3 service worker（SPEC §7.1/§7.8/§7.6.5）：
// - WS 客户端：连接本地 Sidecar /ext，上行捕获（URL+body 指纹去重）与 tab.health
// - 服务广播：notification(≥systemGrade)→系统通知；signal.scored/grade.updated/alert→Side Panel
// - L1：捕获静默超时 → chrome.tabs.reload；L2(CF)→L3 告警由服务/本地通知承担
// - chrome.alarms 每分钟兜底重连（SW 被回收后恢复 WS；活跃 WS 本身保活 SW，Chrome 116+）
// - 配置：启动时拉取 /api/config 的 keepalive 段，每小时刷新

import { browser } from "wxt/browser";
import { DEFAULT_SERVER_PORT, WS_PATH_EXT, mayReloadPage, type ServerBroadcastMsg } from "@debot/shared";

interface CaptureHookPayload {
  kind?: "http" | "ws";
  url: string;
  capturedAt: number;
  observedAt?: number;
  data: unknown;
}

interface KeepaliveCfg {
  l0: boolean;
  l0IntervalMin: number;
  l1: boolean;
  l1SilenceMin: number;
}

const DEFAULT_SERVER_BASE = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;
const RECONNECT_DELAY_MS = 5_000;

let ws: WebSocket | null = null;
let wsWanted = false; // 用户未连接 Sidecar 时避免重连风暴
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let serverBase = DEFAULT_SERVER_BASE;
let keepalive: KeepaliveCfg = { l0: false, l0IntervalMin: 3, l1: true, l1SilenceMin: 3 };
let lastCaptureAt = 0;
let debotTabId: number | null = null;
/** 上报指纹（url+body hash）→ 防同响应体重复转发；SW 回收即清空，无妨 */
const seenFingerprints = new Set<string>();
/** notificationId → 点击跳转 URL */
const clickUrls = new Map<string, string>();
interface PageState { expired: boolean; healthAt: number; captureAt: number; attempted: boolean }
let pages: Record<string, PageState> = {};
const restorePages = browser.storage.session.get("pageHealth").then(st => { pages = (st.pageHealth as Record<string, PageState> | undefined) ?? {}; });
const savePages = () => browser.storage.session.set({ pageHealth: pages });
function publishHealth(): void {
  broadcastToPages({ type: "page-health", expired: Object.values(pages).some(p => p.expired) });
}
async function reportHealth(tabId: number, expired: boolean, url: string): Promise<void> {
  await restorePages;
  const previous = pages[tabId];
  const page = pages[tabId] = { expired, healthAt: Date.now(), captureAt: previous?.captureAt ?? 0, attempted: previous?.attempted ?? false };
  await savePages();
  publishHealth();
  sendToServer({ type: "tab.health", tabId, url, loginState: expired ? "expired" : "ok", signalSilenceMs: page.captureAt ? Date.now() - page.captureAt : 0 });
  if (expired && !previous?.expired) {
    const options = {
      type: "basic" as const, iconUrl: browser.runtime.getURL("/icon/128.png"),
      title: "DeBot 需要人机验证 · 采集已中断",
      message: "自动刷新已停止。点击此通知返回原标签页，手动完成 Cloudflare 验证。",
      priority: 2, requireInteraction: true,
    };
    await browser.notifications.create(`debot-challenge-${tabId}`, options).catch(() => {});
  } else if (!expired && previous?.expired) {
    await browser.notifications.clear(`debot-challenge-${tabId}`);
  }
}
browser.tabs.onRemoved.addListener(tabId => {
  void restorePages.then(async () => { delete pages[tabId]; await savePages(); publishHealth(); });
});

// ─────────────────────────── WS 客户端 ───────────────────────────

function wsUrl(): string {
  return `${serverBase.replace(/^http/, "ws")}${WS_PATH_EXT}`;
}

function connectWs(): void {
  if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  wsWanted = true;
  sock.onopen = () => {
    void refreshConfig();
    void restorePages.then(() => {
      for (const [tabId, page] of Object.entries(pages)) sendToServer({ type: "tab.health", tabId: Number(tabId), url: "https://debot.ai/", loginState: page.expired ? "expired" : "unknown", signalSilenceMs: page.captureAt ? Date.now() - page.captureAt : 0 });
    });
    broadcastToPages({ type: "ws-status", connected: true });
  };
  sock.onmessage = (ev) => {
    try {
      handleBroadcast(JSON.parse(String(ev.data)) as ServerBroadcastMsg);
    } catch {
      // 忽略非法帧
    }
  };
  sock.onclose = () => {
    ws = null;
    broadcastToPages({ type: "ws-status", connected: false });
    scheduleReconnect();
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {
      // ignore
    }
  };
}

function scheduleReconnect(): void {
  if (!wsWanted || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, RECONNECT_DELAY_MS);
}

function sendToServer(msg: unknown): void {
  if (ws !== null && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─────────────────────────── 服务广播处理 ───────────────────────────

function handleBroadcast(msg: ServerBroadcastMsg): void {
  if (msg.type === "notification") {
    if (msg.systemNotify) {
      const notifId = `debot-${msg.signal.id}-${Date.now()}`;
      clickUrls.set(notifId, msg.clickUrl);
      void browser.notifications
        .create(notifId, {
          type: "basic",
          iconUrl: browser.runtime.getURL("/icon/128.png"),
          title: `[${msg.grade}] ${msg.signal.symbol}（score ${msg.score.score}）`,
          message: `${msg.signal.chain}｜命中规则：${msg.score.matched.map((m) => m.ruleId).join(", ") || "（基础分）"}`,
          priority: 2,
        })
        .catch(() => {});
    }
  }
  broadcastToPages({ type: "ws-broadcast", msg });
}

/** 转发给扩展页面（Side Panel 等） */
function broadcastToPages(payload: unknown): void {
  void browser.runtime.sendMessage(payload).catch(() => {});
}

browser.notifications.onClicked.addListener((notifId) => {
  if (notifId.startsWith("debot-challenge-")) {
    const tabId = Number(notifId.slice("debot-challenge-".length));
    void browser.tabs.update(tabId, { active: true }).then(tab => {
      if (tab.windowId !== undefined) return browser.windows.update(tab.windowId, { focused: true });
    }).catch(() => {});
    return;
  }
  const url = clickUrls.get(notifId);
  clickUrls.delete(notifId);
  if (url !== undefined) void browser.tabs.create({ url });
});

// ─────────────────────────── 扩展内消息（content/sidepanel → SW） ───────────────────────────

browser.runtime.onMessage.addListener((msg: unknown, sender: { tab?: { id?: number; url?: string } }) => {
  const m = msg as { type?: string; payload?: CaptureHookPayload; loginState?: string };
  switch (m?.type) {
    case "capture": {
      const p = m.payload;
      if (p === undefined || typeof p.url !== "string" || p.data === undefined) return;
      lastCaptureAt = Date.now();
      if (sender.tab?.id !== undefined) {
        const id = sender.tab.id;
        void restorePages.then(async () => {
          const page = pages[id];
          if (page) { page.captureAt = Date.now(); page.attempted = false; await savePages(); }
        });
      }
      void browser.storage.local.set({ lastCaptureAt });
      const finger = `${p.url}|${JSON.stringify(p.data)}`;
      if (p.kind !== "ws" && seenFingerprints.has(finger)) {
        sendToServer({ type: "capture.duplicate", url: p.url, capturedAt: p.capturedAt, observedAt: p.observedAt });
        return;
      } // 同响应体仅上报诊断元数据，不重复处理
      seenFingerprints.add(finger);
      if (seenFingerprints.size > 512) {
        const first = seenFingerprints.values().next().value;
        if (first !== undefined) seenFingerprints.delete(first);
      }
      if (sender.tab?.id !== undefined) debotTabId = sender.tab.id;
      sendToServer({
        type: "capture.raw",
        source: "hook",
        url: p.url,
        capturedAt: p.capturedAt,
        observedAt: p.observedAt,
        kind: p.kind === "ws" ? "ws" : "http",
        data: p.data,
      });
      return;
    }
    case "health": {
      if (sender.tab?.id !== undefined && m.loginState !== "unknown") void reportHealth(sender.tab.id, m.loginState === "expired", sender.tab.url ?? "");
      return;
    }
    case "get-keepalive": {
      // ponytail: webextension-polyfill（Chrome/Edge）onMessage 只有返回 Promise 才回传响应；
      // 同步返回普通对象会被视作"无响应"直接关闭通道，调用方 sendMessage 变 reject。
      return Promise.resolve(keepalive);
    }
    case "get-ws-status": {
      // Side Panel 打开时拉取当前连接快照（打开前 SW 已连接的场合没有新广播）
      return restorePages.then(() => ({ connected: ws !== null && ws.readyState === WebSocket.OPEN, expired: Object.values(pages).some(p => p.expired) }));
    }
    case "set-server": {
      // Side Panel 修改 Sidecar 地址：立即重连
      const v = (msg as { serverBase?: string }).serverBase;
      if (typeof v === "string" && v.length > 0) {
        serverBase = v;
        void browser.storage.local.set({ serverBase: v });
        try {
          ws?.close();
        } catch {
          // ignore
        }
        ws = null;
        connectWs();
      }
      return;
    }
    default:
      return;
  }
});

// ─────────────────────────── L1 静默自动刷新 + 兜底重连 ───────────────────────────

async function ensureAlarm(): Promise<void> {
  await browser.alarms.clear("keepalive");
  await browser.alarms.create("keepalive", { periodInMinutes: 1 });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return;
  void onKeepaliveTick();
});

async function onKeepaliveTick(): Promise<void> {
  // WS 断开兜底重连（SW 被回收后 alarm 唤醒执行到此处）
  connectWs();
  await restorePages;
  if (!keepalive.l1) return;
  const tabs = await browser.tabs.query({ url: "https://debot.ai/*" });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const page = pages[tab.id];
    if (!page || !mayReloadPage({ ...page, active: tab.active, discarded: tab.discarded ?? false }, Date.now(), keepalive.l1SilenceMin * 60_000)) continue;
    // One recovery attempt per silence episode, persisted across worker restarts.
    page.attempted = true;
    await savePages();
    await browser.tabs.reload(tab.id).catch(() => {});
  }
}

// ─────────────────────────── 配置拉取 ───────────────────────────

async function refreshConfig(): Promise<void> {
  try {
    const res = await fetch(`${serverBase}/api/config`);
    if (!res.ok) return;
    const cfg = (await res.json()) as { keepalive?: KeepaliveCfg };
    if (cfg.keepalive !== undefined) {
      keepalive = { ...keepalive, ...cfg.keepalive };
      broadcastToPages({ type: "keepalive-config", keepalive });
    }
  } catch {
    // Sidecar 未启动：由重连与告警机制覆盖
  }
}

// ─────────────────────────── 启动 ───────────────────────────

export default defineBackground(async () => {
  const st = await browser.storage.local.get(["serverBase", "lastCaptureAt"]);
  if (typeof st.serverBase === "string" && st.serverBase.length > 0) serverBase = st.serverBase;
  if (typeof st.lastCaptureAt === "number") lastCaptureAt = st.lastCaptureAt;
  await ensureAlarm();
  connectWs();
  void refreshConfig();
  // 每小时刷新一次配置（keepalive 开关变更）
  setInterval(() => void refreshConfig(), 60 * 60_000);
});
