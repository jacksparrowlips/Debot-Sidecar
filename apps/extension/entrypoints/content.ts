// content script（isolated world，SPEC §7.1/§7.8）：
// 1) 注入 MAIN world hook 脚本并桥接其 postMessage → service worker
// 2) L2 检测：Cloudflare 人机验证页（P0 候选 title "Just a moment…"，P1 实测定稿）
// 3) 保活：音频保活（防 Chromium 后台定时器节流）+ 可见性欺骗（MAIN world）+ L0 合成事件
// 4) 心跳上报（供 SW 汇总 tab.health）

import { browser } from "wxt/browser";
import { P0, isChallengePage, type KeepaliveConfig } from "@debot/shared";

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

    // ── 保活：音频 + 可见性欺骗 + L0 合成事件（加载时 get-keepalive 拉取；SW 每分钟 refreshConfig 后广播动态生效）──
    let audioCtx: AudioContext | null = null;
    let oscillator: OscillatorNode | null = null;
    /** 音频保活：极低音量正弦波让页面 audible → 豁免 Chromium 后台定时器节流/冻结
     *  （Edge「始终保持活跃」白名单只防冻结、不防约 1 次/分钟的节流）。
     *  autoplay 策略：AudioContext 创建后可能 suspended，挂一次性手势（pointerdown/keydown）resume 解锁 */
    function setAudio(on: boolean): void {
      if (on) {
        if (audioCtx !== null) return; // 已在运行
        try {
          audioCtx = new AudioContext();
          oscillator = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          gain.gain.value = 0.001; // 人耳不可闻；audible 判定看音频输出流是否活跃，不看能量
          oscillator.connect(gain).connect(audioCtx.destination);
          oscillator.start();
          void audioCtx.resume().catch(() => {}); // 页面已有用户激活时直接生效
          document.addEventListener("pointerdown", () => void audioCtx?.resume().catch(() => {}), { once: true });
          document.addEventListener("keydown", () => void audioCtx?.resume().catch(() => {}), { once: true });
        } catch {
          try { void audioCtx?.close(); } catch { /* ignore */ }
          audioCtx = null;
          oscillator = null;
        }
      } else {
        try { oscillator?.stop(); } catch { /* ignore */ }
        try { void audioCtx?.close(); } catch { /* ignore */ }
        audioCtx = null;
        oscillator = null;
      }
    }

    /** 通知 MAIN world hook 安装/还原可见性欺骗（injected 默认先装，配置为关时在此还原） */
    function postVisibilityHook(on: boolean): void {
      window.postMessage({ source: "debot-sidecar-content", visibilityHook: on }, window.location.origin);
    }

    let l0Timer: ReturnType<typeof setInterval> | null = null;
    /** L0 合成事件（默认关，P0 isTrusted 有效性未定稿） */
    function setL0(on: boolean, intervalMin: number): void {
      if (l0Timer !== null) {
        clearInterval(l0Timer);
        l0Timer = null;
      }
      if (!on) return;
      l0Timer = setInterval(() => {
        const x = Math.floor(Math.random() * window.innerWidth);
        const y = Math.floor(Math.random() * window.innerHeight);
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
        window.scrollBy(0, 8);
        window.scrollBy(0, -8);
      }, Math.max(1, intervalMin) * 60_000);
    }

    function applyKeepalive(cfg: KeepaliveConfig | undefined): void {
      if (cfg === undefined) return;
      setAudio(cfg.audio !== false); // 字段缺省视为开（默认开语义，兼容旧版 server 下发的配置）
      postVisibilityHook(cfg.visibilityHook !== false);
      setL0(cfg.l0 === true, cfg.l0IntervalMin);
    }

    void browser.runtime
      .sendMessage({ type: "get-keepalive" })
      .then((cfg) => applyKeepalive(cfg as KeepaliveConfig | undefined))
      .catch(() => {});
    // SW 每分钟 refreshConfig 后广播：设置页开关 ≤1 分钟动态生效（无需刷新 DeBot 页面）
    browser.runtime.onMessage.addListener((msg: unknown) => {
      const m = msg as { type?: string; keepalive?: KeepaliveConfig } | null;
      if (m?.type === "keepalive-config") applyKeepalive(m.keepalive);
    });
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
