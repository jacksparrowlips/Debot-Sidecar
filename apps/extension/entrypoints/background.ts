// MV3 service worker（SPEC §7.1/§7.8/§7.6.5）：
// - WS 客户端：连接本地 Sidecar /ext，上行捕获（URL+body 指纹去重）与 tab.health
// - 服务广播：notification(≥systemGrade)→系统通知；signal.scored/grade.updated/alert→Side Panel
// - L1：捕获静默超时 → chrome.tabs.reload；L2(CF)→L3 告警由服务/本地通知承担
// - chrome.alarms 每分钟兜底重连（SW 被回收后恢复 WS；活跃 WS 本身保活 SW，Chrome 116+）
// - 配置：启动时拉取 /api/config 的 keepalive 段，每小时刷新

import { browser } from "wxt/browser";
import { DEFAULT_SERVER_PORT, WS_PATH_EXT, type ServerBroadcastMsg } from "@debot/shared";

interface CaptureHookPayload {
  url: string;
  capturedAt: number;
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
      void browser.storage.local.set({ lastCaptureAt });
      const finger = `${p.url}|${JSON.stringify(p.data)}`;
      if (seenFingerprints.has(finger)) return; // 同响应体已转发
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
        kind: "http",
        data: p.data,
      });
      return;
    }
    case "health": {
      // 心跳/登录态：汇总静默时长后转发服务（服务侧做 L2/L3 告警判定）
      const tabId = sender.tab?.id ?? debotTabId ?? -1;
      const silenceMs = Math.max(0, Date.now() - lastCaptureAt);
      sendToServer({
        type: "tab.health",
        tabId,
        url: sender.tab?.url ?? "",
        signalSilenceMs: silenceMs,
        loginState: m.loginState === "expired" ? "expired" : m.loginState === "unknown" ? "unknown" : "ok",
      });
      return;
    }
    case "get-keepalive": {
      return keepalive;
    }
    case "get-ws-status": {
      // Side Panel 打开时拉取当前连接快照（打开前 SW 已连接的场合没有新广播）
      return { connected: ws !== null && ws.readyState === WebSocket.OPEN };
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
  if (!keepalive.l1 || lastCaptureAt === 0) return;
  const silenceMs = Date.now() - lastCaptureAt;
  const threshold = keepalive.l1SilenceMin * 60_000;
  if (silenceMs > threshold) {
    // L1：静默超时自动刷新 DeBot 标签页（用户可能长期未看页面，§7.8）
    const tabs = await browser.tabs.query({ url: "https://debot.ai/*" });
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        await browser.tabs.reload(tab.id).catch(() => {});
      }
    }
    if (silenceMs > threshold * 2) {
      // L3：reload 仍未恢复 → 本地系统通知（服务端 tab.health 同步广播 WebUI alert）
      void browser.notifications
        .create(`debot-alert-${Date.now()}`, {
          type: "basic",
          iconUrl: browser.runtime.getURL("/icon/128.png"),
          title: "DeBot Sidecar：捕获静默超时",
          message: `已静默 ${Math.round(silenceMs / 60_000)} 分钟，L1 自动刷新未恢复——请检查 DeBot 标签页`,
          priority: 2,
        })
        .catch(() => {});
    }
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
