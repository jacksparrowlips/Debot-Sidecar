import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Empty, Input, Space, Spin, Tag, Typography } from "antd";
import type { SignalCard } from "@debot/shared";
import { get } from "../api";
import { GRADES, GradeTag, fmtNum, fmtTime, fmtUsd } from "../grades";
import "./signal-cards.css";

/** 无限滚动每批渲染张数：初始只渲染最新 30 张，触底再加载，避免全量渲染上百张卡片 */
const PAGE_SIZE = 30;

const price = (v: number | null) => v === null ? "—" : `$${v.toLocaleString("en-US", { maximumSignificantDigits: 5 })}`;
const elapsed = (timestamp: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};
function Metric({ label, from, to, format = fmtUsd }: { label: string; from: number | null; to: number | null; format?: (v: number | null) => string }): JSX.Element {
  const delta = from === null || to === null ? 0 : to - from;
  return <div className="signal-metric"><span>{label}</span><span>{format(from)}</span><span className="signal-arrow">→</span><strong className={delta > 0 ? "rise" : delta < 0 ? "fall" : ""}>{format(to)} {delta > 0 ? "↑" : delta < 0 ? "↓" : ""}</strong></div>;
}
function Sparkline({ card }: { card: SignalCard }): JSX.Element {
  const points = card.chart;
  if (points.length < 2) return <div className="signal-chart-empty">等待价格序列</div>;
  const min = Math.min(...points.map(p => p.price));
  const max = Math.max(...points.map(p => p.price));
  const start = points[0]!.ts;
  const duration = points[points.length - 1]!.ts - start;
  const line = points.map((p, i) => `${duration > 0 ? 3 + (p.ts - start) / duration * 214 : 3 + i / (points.length - 1) * 214},${max === min ? 32 : 59 - (p.price - min) / (max - min) * 54}`).join(" ");
  return <svg className="signal-chart" viewBox="0 0 220 64" role="img" aria-label={`${card.symbol} 首次捕获后的价格走势`}><title>信号起点后的已记录价格（采样展示）</title><line x1="0" x2="220" y1="62" y2="62" stroke="#253332" /><polyline points={line} fill="none" stroke="#00d6a0" strokeWidth="2" strokeLinejoin="round" /></svg>;
}
function Card({ card, now }: { card: SignalCard; now: number }): JSX.Element {
  const [copyMessage, setCopyMessage] = useState("");
  const stale = now - card.updatedAt > 60_000;
  const copy = async () => {
    try { await navigator.clipboard.writeText(card.ca); setCopyMessage("已复制"); }
    catch { setCopyMessage("复制失败，请选中地址复制"); }
  };
  return <article className="signal-card" aria-label={`${card.symbol} ${card.chain} 信号卡片`}>
    <div className="signal-card-top">
      <span className="signal-count" title="Sidecar 记录的信号事件数，不含冷却期刷新">{card.signalCount}</span>
      <div className="signal-safety">
        {card.safety.honeypot === true && <span className="fall">⚠ 貔貅</span>}
        {card.safety.openSource !== null && <span>{card.safety.openSource ? "✓ 开源" : "未开源"}</span>}
        {card.safety.abandoned !== null && <span>{card.safety.abandoned ? "✓ 弃权" : "未弃权"}</span>}
        {card.safety.locked !== null && <span>{card.safety.locked ? "✓ 锁池" : "未锁池"}</span>}
      </div>
      <time title={`首次捕获 ${fmtTime(card.firstAt)}`}>{fmtTime(card.firstAt).slice(11)}</time>
    </div>
    <div className="signal-card-body">
      <div className="signal-card-hero">
        <div className="signal-token">
          <div className="signal-token-heading">
            {card.logo && /^https?:\/\//.test(card.logo) ? <img src={card.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.visibility = "hidden"; }} /> : <div className="signal-avatar">{card.symbol.slice(0, 1) || "?"}</div>}
            <div><a className="signal-symbol" href={card.tokenUrl} target="_blank" rel="noopener noreferrer">{card.symbol || "未命名"} ↗</a><div className="signal-name" title={card.name ?? ""}>{card.name ?? "—"}</div></div>
          </div>
          <div className="signal-token-meta"><span className="signal-chain">{card.chain}</span><span>{card.createdAt === null ? "创建时间未知" : `${elapsed(card.createdAt, now)} 前创建`}</span></div>
          <button className="signal-ca" onClick={() => void copy()} title={`${card.ca}（点击复制）`}>{card.ca.slice(0, 7)}…{card.ca.slice(-6)} ⧉</button>
          <span className="signal-copy" role="status">{copyMessage}</span>
          <div className="signal-links"><Link to={`/signals/${card.signalId}`}>信号详情 ↗</Link><GradeTag grade={card.grade} /><span>{card.score} 分</span></div>
        </div>
        <div className="signal-performance">
          <span className="signal-ath-label" title="首次捕获之后最高已记录价格 ÷ 首次捕获价格；并非发行以来的历史 ATH">起点后 ATH</span>
          <strong className="signal-ath">{card.athMultiple === null ? "—" : `${Number(card.athMultiple.toFixed(2))}x`}</strong>
          <Sparkline card={card} />
        </div>
      </div>
      <div className="signal-wallets"><span>▣ <strong>{card.smartWallets ?? "—"} 个聪明钱包</strong> 在线</span><span title="当前榜单响应未提供同时买入的平均金额">平均买入金额 {fmtUsd(card.averageBuyUsd)}</span></div>
      <div className="signal-metrics">
        <Metric label="市值" from={card.first.marketCap} to={card.current.marketCap} />
        <Metric label="持有人" from={card.first.holders} to={card.current.holders} format={v => fmtNum(v, 0)} />
        <Metric label="价格" from={card.first.price} to={card.current.price} format={price} />
        <Metric label="流动性" from={card.first.liquidity} to={card.current.liquidity} />
      </div>
      <div className="signal-card-foot"><span>首次捕获 → 当前快照</span><span className={stale ? "signal-stale" : ""}>快照 {elapsed(card.updatedAt, now)} 前 · 价格 {elapsed(card.priceAt, now)} 前</span></div>
      {card.historyAmbiguous && <div className="signal-stale">同 CA 存在多条链，旧价格历史无法区分，暂不计算 ATH。</div>}
    </div>
  </article>;
}
export default function Dashboard(): JSX.Element {
  const [rows, setRows] = useState<SignalCard[]>([]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [visible, setVisible] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const data = await get<SignalCard[]>("/api/signal-cards"); if (!stopped) { setRows(data); setError(""); } }
      catch (e) { if (!stopped) setError(String(e)); }
      finally { if (!stopped) { setLoaded(true); setNow(Date.now()); timer = setTimeout(refresh, 2000); } }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const q = query.trim().toLowerCase();
  const filtered = rows.filter(r => (filter === "all" || r.grade === filter) && (!q || `${r.symbol} ${r.ca} ${r.chain} ${r.name ?? ""}`.toLowerCase().includes(q)));
  const shown = filtered.slice(0, visible);
  // 触底增量渲染：哨兵进入视口即多渲染一批。新信号插入顶部时依赖浏览器原生 scroll anchoring 防跳动
  // ponytail: 上限是「渲染截断」；若卡片量级再上一个台阶（数千张），升级为虚拟滚动（react-window）
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) setVisible(v => v + PAGE_SIZE);
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible, filtered.length]);
  return <div className="signal-feed">
    <div className="signal-feed-heading"><div><Typography.Title level={3} style={{ margin: 0 }}>实时信号</Typography.Title><Typography.Text type="secondary">一个 CA，一张卡片 · 同链聚合 · 每 2 秒刷新</Typography.Text></div><Link to="/captures"><Button>捕获监控 ↗</Button></Link></div>
    <div className="signal-feed-toolbar"><Space wrap><Tag.CheckableTag checked={filter === "all"} onChange={() => { setFilter("all"); setVisible(PAGE_SIZE); }}>全部</Tag.CheckableTag>{GRADES.map(g => <Tag.CheckableTag key={g} checked={filter === g} onChange={() => { setFilter(g); setVisible(PAGE_SIZE); }}>{g}</Tag.CheckableTag>)}</Space><Input aria-label="搜索币名、CA 或链" placeholder="搜索币名 / CA / 链" allowClear value={query} onChange={e => { setQuery(e.target.value); setVisible(PAGE_SIZE); }} style={{ width: 230 }} /></div>
    <div className="signal-feed-note">显示最近 100 个币中的 {filtered.length} 个。ATH 按首次捕获后的已记录价格计算；缺失字段显示 —。聪明钱包为在线人数，非已验证的同时买入人数。</div>
    {error && <Alert type="error" showIcon message="更新失败，当前显示的是旧快照" description={error} />}
    <div className="signal-feed-scroll">
      {!loaded ? <Spin /> : filtered.length === 0 ? <Empty description="暂无匹配信号，打开 DeBot 信号页后自动捕获" /> : <>
        <div className="signal-card-grid">{shown.map(card => <Card key={card.key} card={card} now={now} />)}</div>
        {visible < filtered.length
          ? <div ref={sentinelRef} className="signal-feed-more">已显示 {shown.length} / {filtered.length} 张 · 下拉到底自动加载</div>
          : <div className="signal-feed-more">已显示全部 {filtered.length} 张</div>}
      </>}
    </div>
  </div>;
}
