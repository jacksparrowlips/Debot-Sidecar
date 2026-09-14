// MAIN world 注入（SPEC §7.1）：hook fetch / XHR，response.clone() 读响应体不消费原流，
// 页面逻辑零感知；仅上报 debot.ai/api/*（服务端再按 signal/ 前缀与未知端点分类）。
// 发现 SSE/WS 接口时在此一并包装（当前 P0 实证为 REST 明文 JSON 轮询）。

const BRIDGE_SOURCE = "debot-sidecar-hook";

interface HookPayload {
  url: string;
  capturedAt: number;
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
  window.postMessage({ source: BRIDGE_SOURCE, payload }, window.location.origin);
}

export default defineUnlistedScript(() => {
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
