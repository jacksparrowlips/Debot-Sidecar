import { publicMarketUpdates } from "@debot/shared";
// MAIN world 注入（SPEC §7.1）：hook fetch / XHR，response.clone() 读响应体不消费原流，
// 页面逻辑零感知；仅上报 debot.ai/api/*（服务端再按 signal/ 前缀与未知端点分类）。
// 发现 SSE/WS 接口时在此一并包装（当前 P0 实证为 REST 明文 JSON 轮询）。

const BRIDGE_SOURCE = "debot-sidecar-hook";

interface HookPayload {
  url: string;
  kind?: "http" | "ws";
  capturedAt: number;
  observedAt?: number;
  data: unknown;
}

function isDebotApi(rawUrl: unknown): boolean {
  try {
    const u = new URL(String(rawUrl), window.location.origin);
    return u.host === "debot.ai" && u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function post(payload: HookPayload): void {
  window.postMessage({ source: BRIDGE_SOURCE, payload: { ...payload, observedAt: Date.now() } }, window.location.origin);
}

export default defineUnlistedScript(() => {
  // ── 可见性欺骗（keepalive.visibilityHook，默认开）──
  // Edge「始终保持活跃」白名单只防冻结（sleeping tabs），不防 Chromium 后台定时器节流，
  // 且页面自身常按 document.hidden 停轮询 → 后台标签页数据静止。在页面 JS 运行前覆盖为"始终可见"
  // （含 L1 静默 reload 发生在后台时，页面加载即自查 document.hidden 的场景）；
  // content script 拿到配置后经 postMessage 通知还原。
  const CONTENT_SOURCE = "debot-sidecar-content";
  function setVisibilityHook(on: boolean): void {
    if (on) {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    } else {
      // 移除实例属性 → 回落 Document.prototype 原生 getter
      delete (document as { hidden?: unknown }).hidden;
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  }
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data as { source?: unknown; visibilityHook?: unknown } | null;
    if (data === null || data.source !== CONTENT_SOURCE) return;
    setVisibilityHook(data.visibilityHook === true);
  });
  setVisibilityHook(true);

  // Observe the page's existing SharedWorker connection without changing subscriptions.
  if (typeof window.SharedWorker === "function") {
    window.SharedWorker = new Proxy(window.SharedWorker, {
      construct(Target, args) {
        const worker = Reflect.construct(Target, args) as SharedWorker;
        try {
          const url = new URL(String(args[0]), location.href);
          if (url.origin === location.origin && /\/sharedSocketWorker-[^/]+\.js$/.test(url.pathname)) {
            worker.port.addEventListener("message", event => {
              const data = publicMarketUpdates(event.data);
              if (data.length) post({ url: "https://debot.ai/api/sidecar/live-market", kind: "ws", capturedAt: Date.now(), data });
            });
          }
        } catch { /* Observation must never interfere with the page. */ }
        return worker;
      },
    });
  }
  // ── fetch hook ──
  const origFetch = window.fetch;
  window.fetch = function hookedFetch(...args: Parameters<typeof fetch>) {
    const input = args[0];
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const capturedAt = Date.now();
    return origFetch.apply(this, args).then((res) => {
      if (isDebotApi(url)) {
        try {
          const clone = res.clone(); // 不消费原流
          void clone
            .json()
            .then((data) => post({ url, capturedAt, data }))
            .catch(() => {});
        } catch {
          // ignore
        }
      }
      return res;
    });
  };

  // ── XHR hook ──
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function hookedOpen(
    this: XMLHttpRequest & { __debotUrl?: string },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__debotUrl = String(url);
    // @ts-expect-error 透传任意重载参数
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function hookedSend(
    this: XMLHttpRequest & { __debotUrl?: string },
    ...args: Parameters<typeof origSend>
  ) {
    const xhr = this;
    xhr.addEventListener("load", () => {
      try {
        const url = xhr.__debotUrl;
        if (!isDebotApi(url)) return;
        const text = xhr.responseText;
        if (text.length === 0) return;
        post({ url: String(url), capturedAt: Date.now(), data: JSON.parse(text) });
      } catch {
        // 非 JSON / 已读响应体：静默
      }
    });
    return origSend.apply(this, args);
  };
});
