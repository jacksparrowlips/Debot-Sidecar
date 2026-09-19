// MV3 service worker（SPEC §7.1/§7.8/§7.6.5）：
// - WS 客户端：连接本地 Sidecar /ext，上行捕获（URL+body 指纹去重）与 tab.health
// - 服务广播：notification(≥systemGrade)→系统通知；signal.scored/grade.updated/alert→Side Panel
// - L1：捕获静默超时 → chrome.tabs.reload；L2(CF)→L3 告警由服务/本地通知承担
// - chrome.alarms 每分钟兜底重连（SW 被回收后恢复 WS；活跃 WS 本身保活 SW，Chrome 116+）
// - 配置：启动时拉取 /api/config 的 keepalive 段，每分钟随保活 alarm 刷新（设置页开关 ≤1 分钟生效）

import { browser } from "wxt/browser";
import { DEFAULT_SERVER_PORT, P0, WS_PATH_EXT, mayReloadPage, type ServerBroadcastMsg } from "@debot/shared";

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
  /** 音频保活 + 可见性欺骗（与 shared KeepaliveConfig 同步，见 packages/shared/src/types.ts） */
  audio: boolean;
  visibilityHook: boolean;
}

const DEFAULT_SERVER_BASE = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;
const RECONNECT_DELAY_MS = 5_000;

let ws: WebSocket | null = null;
let wsWanted = false; // 用户未连接 Sidecar 时避免重连风暴
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let serverBase = DEFAULT_SERVER_BASE;
let keepalive: KeepaliveCfg = { l0: false, l0IntervalMin: 3, l1: true, l1SilenceMin: 3, audio: true, visibilityHook: true };
let lastCaptureAt = 0;
let debotTabId: number | null = null;
/** 上报指纹（url+body hash）→ 防同响应体重复转发；SW 回收即清空，无妨 */
const seenFingerprints = new Set<string>();
/** notificationId → 点击跳转 URL */
const clickUrls = new Map<string, string>();
/**
 * 通知参数（结构与 browser.notifications.CreateNotificationOptions 兼容）：
 * requireInteraction 为 Chromium 独有字段，wxt 的跨浏览器类型缺此定义，
 * 运行时 Chrome 支持（Win11 上通知常驻，mac 忽略）。
 */
interface ChromeNotifOptions {
  type: "basic";
  iconUrl: string;
  title: string;
  message: string;
  priority: number;
  requireInteraction?: boolean;
}
/** signalAt = 最近一次信号源捕获（SIGNAL_API_PREFIX 下的 http，即 rank/kline）；杂项流量不计入（2026-09-19 实测盲区） */
interface PageState { expired: boolean; healthAt: number; signalAt: number; signalUrl: string | null; attempted: boolean }
let pages: Record<string, PageState> = {};
const restorePages = browser.storage.session.get("pageHealth").then(st => {
  // 旧持久化缺字段时归一化，避免 undefined 参与判定
  const saved = (st.pageHealth as Record<string, Partial<PageState>> | undefined) ?? {};
  pages = {};
  for (const [key, v] of Object.entries(saved)) {
    pages[key] = { expired: !!v.expired, healthAt: v.healthAt ?? 0, signalAt: v.signalAt ?? 0, signalUrl: v.signalUrl ?? null, attempted: !!v.attempted };
  }
});
const savePages = () => browser.storage.session.set({ pageHealth: pages });
function publishHealth(): void {
  broadcastToPages({ type: "page-health", expired: Object.values(pages).some(p => p.expired) });
}
async function reportHealth(tabId: number, expired: boolean, url: string): Promise<void> {
  await restorePages;
  const previous = pages[tabId];
  const page = pages[tabId] = { expired, healthAt: Date.now(), signalAt: previous?.signalAt ?? 0, signalUrl: previous?.signalUrl ?? null, attempted: previous?.attempted ?? false };
  await savePages();
  publishHealth();
  // 信号静默只看信号源捕获时间（rank/kline）；live-market/杂项轮询不计入
  sendToServer({ type: "tab.health", tabId, url, loginState: expired ? "expired" : "ok", signalSilenceMs: page.signalAt > 0 ? Date.now() - page.signalAt : 0 });
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
      for (const [tabId, page] of Object.entries(pages)) sendToServer({ type: "tab.health", tabId: Number(tabId), url: "https://debot.ai/", loginState: page.expired ? "expired" : "unknown", signalSilenceMs: page.signalAt > 0 ? Date.now() - page.signalAt : 0 });
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
      const vh = msg.grade === "VERY_HIGH";
      // VERY_HIGH：🚨 + requireInteraction 常驻（Win11 支持，mac 忽略）；REJECT 聚合：reason 作为正文
      const options: ChromeNotifOptions = {
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title:
          msg.grade === "REJECT"
            ? `已过滤：${msg.signal.symbol}`
            : `${vh ? "🚨 " : ""}[${msg.grade}] ${msg.signal.symbol}（score ${msg.score.score}）`,
        message:
          msg.reason ??
          `${msg.signal.chain}｜命中规则：${msg.score.matched.map((m) => m.ruleId).join(", ") || "（基础分）"}`,
        priority: 2,
        requireInteraction: vh,
      };
      void browser.notifications.create(notifId, options).catch(() => {});
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
        const isSignal = p.kind !== "ws" && p.url.startsWith(P0.SIGNAL_API_PREFIX);
        void restorePages.then(async () => {
          const page = pages[id];
          if (page) {
            // 只有信号源捕获（rank/kline）刷新 signalAt 并重置 reload 尝试；
            // live-market/noticeV2 等杂项不计入——否则静默判定被掩盖，且 reload 后会无限循环
            if (isSignal) { page.signalAt = Date.now(); page.signalUrl = sender.tab?.url ?? null; page.attempted = false; }
            await savePages();
          }
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
  // 每分钟顺带拉取配置：设置页 keepalive 开关 ≤1 分钟生效，并广播给 content script 动态应用
  await refreshConfig();
  await restorePages;
  if (!keepalive.l1) return;
  const tabs = await browser.tabs.query({ url: "https://debot.ai/*" });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const page = pages[tab.id];
    if (!page || !mayReloadPage({ ...page, active: tab.active, discarded: tab.discarded ?? false, url: tab.url ?? "" }, Date.now(), keepalive.l1SilenceMin * 60_000)) continue;
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
  // 点击工具栏图标 → 打开 Sidecar 主页（Side Panel 改由浏览器侧边栏入口打开）
  // WXT AugmentedBrowser 类型未收录 sidePanel 命名空间，此处断言（chrome.sidePanel.setPanelBehavior）
  const sidePanel = (browser as unknown as {
    sidePanel: { setPanelBehavior: (o: { openPanelOnActionClick: boolean }) => Promise<void> };
  }).sidePanel;
  await sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  browser.action.onClicked.addListener(() => {
    void browser.tabs.create({ url: `${serverBase}/` });
  });
  await ensureAlarm();
  connectWs();
  void refreshConfig();
});
