// content script（isolated world，SPEC §7.1/§7.8）：
// 1) 注入 MAIN world hook 脚本并桥接其 postMessage → service worker
// 2) L2 检测：Cloudflare 人机验证页（P0 候选 title "Just a moment…"，P1 实测定稿）
// 3) L0 保活：合成 mousemove/scroll（默认关，P0 isTrusted 有效性未定稿）
// 4) 心跳上报（供 SW 汇总 tab.health）

import { browser } from "wxt/browser";
import { P0, isChallengePage } from "@debot/shared";

const BRIDGE_SOURCE = "debot-sidecar-hook";

export default defineContentScript({
  matches: [P0.AI_SIGNAL_URL_MATCH],
  runAt: "document_start", // hook 必须先于页面首个请求注入
  main() {
    try { injectHookScript(); } catch { /* Health detection must also work on challenge pages. */ }
    window.addEventListener("message", (ev) => {
      if (ev.source !== window) return;
      const data = ev.data as { source?: unknown; payload?: unknown } | null;
      if (data === null || data.source !== BRIDGE_SOURCE) return;
      void browser.runtime.sendMessage({ type: "capture", payload: data.payload }).catch(() => {});
    });

    // ── L2：CF 挑战页检测（title 特征，变化时上报）──
    let lastExpired: boolean | null = null;
    const checkLogin = (): void => {
      const title = document.title ?? "";
      const expired = isChallengePage(title, document.body?.innerText.slice(0, 8000) ?? "", document.querySelector('#challenge-running, #challenge-stage, form#challenge-form, iframe[src*="challenges.cloudflare.com"]') !== null);
      if (document.readyState === "loading" && !expired) return;
      if (expired !== lastExpired) {
        lastExpired = expired;
        void browser.runtime
          .sendMessage({ type: "health", loginState: expired ? "expired" : "ok" })
          .catch(() => {});
      }
    };
    setInterval(checkLogin, 5_000);
    checkLogin();
    document.addEventListener("DOMContentLoaded", checkLogin);
    document.addEventListener("visibilitychange", checkLogin);

    // ── 心跳：SW 汇总静默时长与登录态转发服务（§7.8）──
    setInterval(() => {
      void browser.runtime
        .sendMessage({ type: "health", loginState: lastExpired === true ? "expired" : lastExpired === false ? "ok" : "unknown" })
        .catch(() => {});
    }, 30_000);

    // ── L0：合成事件（默认关；P0 静置实测有效后由设置页开启）──
    let l0Timer: ReturnType<typeof setInterval> | null = null;
    void browser.runtime
      .sendMessage({ type: "get-keepalive" })
      .then((cfg) => {
        const keepalive = cfg as { l0: boolean; l0IntervalMin: number } | undefined;
        if (keepalive?.l0 === true) {
          l0Timer = setInterval(() => {
            const x = Math.floor(Math.random() * window.innerWidth);
            const y = Math.floor(Math.random() * window.innerHeight);
            document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
            window.scrollBy(0, 8);
            window.scrollBy(0, -8);
          }, Math.max(1, keepalive.l0IntervalMin) * 60_000);
        }
      })
      .catch(() => {});
  },
});

/** DOM 注入 MAIN world 脚本（src 由 web_accessible_resources 暴露） */
function injectHookScript(): void {
  if (document.getElementById("debot-sidecar-injected") !== null) return;
  const script = document.createElement("script");
  script.id = "debot-sidecar-injected";
  script.src = browser.runtime.getURL("/injected.js");
  script.async = false;
  (document.head ?? document.documentElement).prepend(script);
}
