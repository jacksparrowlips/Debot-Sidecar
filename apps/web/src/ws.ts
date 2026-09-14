// WS 客户端（/ui）：单例连接 + 订阅分发 + 自动重连（SPEC §11）
import type { ServerBroadcastMsg } from "@debot/shared";

type Handler = (msg: ServerBroadcastMsg) => void;
type StatusHandler = (connected: boolean) => void;

let ws: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const handlers = new Set<Handler>();
const statusHandlers = new Set<StatusHandler>();

function url(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ui`;
}

function connect(): void {
  if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(url());
  } catch {
    scheduleRetry();
    return;
  }
  ws.onopen = () => {
    statusHandlers.forEach((h) => h(true));
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as ServerBroadcastMsg;
      handlers.forEach((h) => h(msg));
    } catch {
      // 忽略非法帧
    }
  };
  ws.onclose = () => {
    ws = null;
    statusHandlers.forEach((h) => h(false));
    scheduleRetry();
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      // ignore
    }
  };
}

function scheduleRetry(): void {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, 3_000);
}

export function subscribe(handler: Handler): () => void {
  ensureStarted();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function subscribeStatus(handler: StatusHandler): () => void {
  ensureStarted();
  statusHandlers.add(handler);
  handler(ws?.readyState === WebSocket.OPEN);
  return () => {
    statusHandlers.delete(handler);
  };
}

let started = false;
function ensureStarted(): void {
  if (started) return;
  started = true;
  connect();
}
