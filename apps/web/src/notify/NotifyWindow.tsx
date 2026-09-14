// /notify 通知小窗（SPEC §7.6.1-7.6.5）：
// - 大卡片：等级色边框、CA 一键复制、命中规则明细、相关性标签、热度区块（enrichment 异步补全）
// - 点击卡片跳 token 页；声音（内置蜂鸣/自定义 /sounds/）；系统通知兜底（Notification API）
// - 通知风暴限速：1 分钟内第 6 条起降级为侧边计数，点击展开
// - 常驻至用户关闭（无自动消失）
import { useEffect, useRef, useState } from "react";
import { ConfigProvider, theme } from "antd";
import type { NotificationMsg, ScoreResult, SignalDetail, SignalSummary, SidecarConfig } from "@debot/shared";
import { subscribe } from "../ws";
import { get } from "../api";
import { GRADE_META, fmtTime, fmtUsd } from "../grades";
import "./notify.css";

interface QueuedCard {
  key: string;
  grade: string;
  signal: SignalSummary;
  score: ScoreResult;
  clickUrl: string;
}

const STORM_WINDOW_MS = 60_000;
const STORM_LIMIT = 5;

function playSound(cfg: SidecarConfig["notify"]["sound"]): void {
  if (!cfg.enabled) return;
  if (cfg.file !== null && cfg.file.length > 0) {
    const audio = new Audio(`/sounds/${cfg.file}`);
    audio.volume = cfg.volume;
    void audio.play().catch(() => {});
    return;
  }
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = cfg.volume * 0.3;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    void ctx.close();
  } catch {
    // 无用户手势前 AudioContext 可能被拦截：系统通知已兜底
  }
}

interface HeatData {
  txns24h: number | null;
  liquidityUsd: number | null;
}

/** 热度区块：fetch 信号详情取 enrichment（获取中/失败态） */
function HeatBlock({ signalId }: { signalId: number }): JSX.Element {
  const [state, setState] = useState<"loading" | "failed" | "ok">("loading");
  const [heat, setHeat] = useState<HeatData>({ txns24h: null, liquidityUsd: null });

  useEffect(() => {
    let alive = true;
    void get<SignalDetail>(`/api/signals/${signalId}`)
      .then((d) => {
        if (!alive) return;
        const row = d.enrichments.find((e) => e.provider_id === "heat-dexscreener" && e.status === "ok");
        if (row === undefined) {
          setState("failed");
          return;
        }
        const r = row.result as { txns24h?: number; liquidityUsd?: number } | null;
        setHeat({ txns24h: r?.txns24h ?? null, liquidityUsd: r?.liquidityUsd ?? null });
        setState("ok");
      })
      .catch(() => alive && setState("failed"));
    return () => {
      alive = false;
    };
  }, [signalId]);

  if (state === "loading") return <div className="nq-heat">热度获取中…</div>;
  if (state === "failed") return <div className="nq-heat nq-dim">热度数据获取失败（DexScreener 未响应）</div>;
  return (
    <div className="nq-heat">
      24h 交易 {heat.txns24h?.toLocaleString() ?? "—"} ｜ 流动性 {fmtUsd(heat.liquidityUsd)}
    </div>
  );
}

function Card({ item, onDismiss, isDark }: { item: QueuedCard; onDismiss: () => void; isDark: boolean }): JSX.Element {
  const meta = GRADE_META[item.grade as keyof typeof GRADE_META] ?? GRADE_META.LOW;
  const s = item.signal;
  return (
    <div
      className="nq-card"
      style={{ borderColor: meta.color, boxShadow: item.grade === "VERY_HIGH" ? `0 0 24px ${meta.color}66` : undefined }}
      onClick={() => window.open(item.clickUrl, "_blank", "noopener")}
    >
      <div className="nq-head">
        <span className="nq-symbol">{s.symbol}</span>
        <span className="nq-grade" style={{ color: meta.color, background: meta.bg }}>
          {item.grade}
        </span>
        <span className="nq-score">{item.score.score} 分</span>
        <button
          className="nq-close"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          ×
        </button>
      </div>
      <div
        className="nq-ca"
        title={s.token_address}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(s.token_address);
        }}
      >
        {s.token_address}
      </div>
      <div className="nq-meta">
        {s.chain} ｜ {fmtTime(s.captured_at)} ｜ 市值 {fmtUsd(s.market_cap_usd)} ｜ 流动性 {fmtUsd(s.liquidity_usd)}
      </div>
      <div className="nq-rules">
        {item.score.matched.length === 0 ? (
          <span className="nq-dim">命中规则：（仅基础分）</span>
        ) : (
          item.score.matched.map((m) => (
            <span key={m.ruleId} className="nq-rule">
              {m.ruleId} {m.delta === "reject" ? "→拒绝" : m.delta >= 0 ? `+${m.delta}` : `−${m.delta}`}
            </span>
          ))
        )}
        {s.relevance_tags.map((t) => (
          <span key={t} className="nq-tag">
            #{t}
          </span>
        ))}
      </div>
      <HeatBlock signalId={s.id} />
      <div className="nq-foot">点击卡片打开 DeBot token 页 ｜ 点 CA 复制</div>
      {isDark ? null : null}
    </div>
  );
}

export default function NotifyWindow(): JSX.Element {
  const [cards, setCards] = useState<QueuedCard[]>([]);
  const [stormCount, setStormCount] = useState(0);
  const [cfg, setCfg] = useState<SidecarConfig["notify"] | null>(null);
  const stormTimestamps = useRef<number[]>([]);

  // 拉取配置：窗口尺寸/位置 + 声音
  useEffect(() => {
    void get<SidecarConfig>("/api/config")
      .then((c) => {
        setCfg(c.notify);
        try {
          window.resizeTo(c.notify.size[0], c.notify.size[1]);
          const [w, h] = c.notify.size;
          const pos = c.notify.position;
          const x = pos.endsWith("right") ? window.screen.availWidth - w - 12 : 12;
          const y = pos.startsWith("top") ? 0 : window.screen.availHeight - h - 12;
          window.moveTo(x, y);
        } catch {
          // 浏览器可能拒绝自定位：window.open 特性串兜底
        }
      })
      .catch(() => {});
  }, []);

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type !== "notification") return;
        const n = msg as NotificationMsg;

        // 通知风暴限速（§7.6.2）：窗口期内第 6 条起降级为计数
        const now = Date.now();
        stormTimestamps.current = stormTimestamps.current.filter((t) => now - t < STORM_WINDOW_MS);
        stormTimestamps.current.push(now);
        if (stormTimestamps.current.length > STORM_LIMIT) {
          setStormCount((c) => c + 1);
          return;
        }

        setCards((prev) =>
          [
            { key: `n-${n.signal.id}-${now}`, grade: n.grade, signal: n.signal, score: n.score, clickUrl: n.clickUrl },
            ...prev,
          ].slice(0, 20),
        );

        playSound(cfg?.sound ?? { enabled: true, volume: 0.6, file: null });

        // 系统通知兜底（扩展 SW 的 chrome.notifications 是第二通道，这里覆盖纯浏览器场景）
        if (n.systemNotify && "Notification" in window && Notification.permission === "granted") {
          new Notification(`[${n.grade}] ${n.signal.symbol}`, {
            body: `${n.signal.chain}｜${n.score.score} 分`,
            tag: `debot-${n.signal.id}`,
          }).onclick = () => window.open(n.clickUrl, "_blank", "noopener");
        } else if (n.systemNotify && "Notification" in window && Notification.permission === "default") {
          void Notification.requestPermission();
        }
      }),
    [cfg],
  );

  const isDark = cfg?.theme !== "light";
  const visible = stormCount > 0 && cards.length === 0 ? [] : cards;

  return (
    <ConfigProvider theme={isDark ? { algorithm: theme.darkAlgorithm } : undefined}>
      <div className="nq-root" data-theme={isDark ? "dark" : "light"}>
        {visible.length === 0 && stormCount === 0 ? (
          <div className="nq-idle">通知小窗待命中（≥卡片阈值的信号将在此弹出）</div>
        ) : null}
        {visible.map((c) => (
          <Card key={c.key} item={c} isDark={isDark} onDismiss={() => setCards((prev) => prev.filter((x) => x.key !== c.key))} />
        ))}
        {stormCount > 0 ? (
          <div className="nq-storm" onClick={() => setStormCount(0)}>
            通知密集（{stormCount} 条被限速折叠）——点击查看
          </div>
        ) : null}
      </div>
    </ConfigProvider>
  );
}
