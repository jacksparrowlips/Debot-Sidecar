// 信号详情（SPEC §7.5）：概览 / v1-v2 评分对比 / enrichment / 价格轨迹 / 模拟交易 / 原始 JSON
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Descriptions, Table, Tabs, Tag, Typography, message } from "antd";
import { CopyOutlined, LeftOutlined } from "@ant-design/icons";
import type { MatchedRule, ScoreRow, SignalDetail } from "@debot/shared";
import { get } from "../api";
import { GradeTag, fmtNum, fmtPct, fmtTime } from "../grades";

function PriceChart({ points }: { points: { ts: number; price: number }[] }): JSX.Element {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const W = 800;
    const H = 220;
    const ps = points.filter((p) => p.price > 0);
    if (ps.length < 2) return null;
    const min = Math.min(...ps.map((p) => p.price));
    const max = Math.max(...ps.map((p) => p.price));
    const span = max - min || max || 1;
    const t0 = ps[0]!.ts;
    const t1 = ps[ps.length - 1]!.ts;
    const tSpan = t1 - t0 || 1;
    const d = ps
      .map((p, i) => `${i === 0 ? "M" : "L"}${((p.ts - t0) / tSpan) * W},${H - ((p.price - min) / span) * H}`)
      .join(" ");
    return { d, W, H, min, max };
  }, [points]);
  if (path === null) return <Typography.Text type="secondary">价格点不足</Typography.Text>;
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${path.W} ${path.H}`} style={{ background: "#fafafa", borderRadius: 8 }}>
        <path d={path.d} fill="none" stroke="#1677ff" strokeWidth={2} />
      </svg>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        低 {fmtNum(path.min, 10)} ～ 高 {fmtNum(path.max, 10)}
      </Typography.Text>
    </div>
  );
}

function ScoresTable({ scores }: { scores: ScoreRow[] }): JSX.Element {
  const columns = [
    { title: "阶段", dataIndex: "phase", width: 70 },
    { title: "规则版本", dataIndex: "rule_version", width: 90 },
    { title: "总分", dataIndex: "total_score", width: 80, render: (v: number) => <b>{v}</b> },
    { title: "等级", dataIndex: "grade", width: 110, render: (g: string) => <GradeTag grade={g} /> },
    {
      title: "命中规则",
      dataIndex: "matched_rules",
      render: (m: unknown) => {
        const rules = (m ?? []) as MatchedRule[];
        if (rules.length === 0) return <Typography.Text type="secondary">（仅基础分）</Typography.Text>;
        return (
          <>
            {rules.map((r) => (
              <Tag key={r.ruleId} color={r.delta === "reject" ? "red" : "blue"}>
                {r.ruleId} {r.delta === "reject" ? "→ 拒绝" : `+${r.delta}`}
              </Tag>
            ))}
          </>
        );
      },
    },
  ];
  return <Table rowKey={(r) => r.phase} size="small" dataSource={scores} columns={columns} pagination={false} />;
}

export default function SignalDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [detail, setDetail] = useState<SignalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void get<SignalDetail>(`/api/signals/${id}`)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error !== null) return <Typography.Text type="danger">{error}</Typography.Text>;
  if (detail === null) return <Typography.Text>加载中…</Typography.Text>;
  const s = detail.summary;

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <Button icon={<LeftOutlined />} onClick={() => nav("/signals")} />
        <Typography.Title level={4} style={{ margin: 0 }}>
          {s.symbol}
        </Typography.Title>
        <GradeTag grade={s.grade} />
        <Tag>{s.signal_type === "new" ? "新信号" : "重出"}</Tag>
        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={() => {
            void navigator.clipboard.writeText(s.token_address).then(() => void message.success("CA 已复制"));
          }}
        >
          复制 CA
        </Button>
      </div>

      <Tabs
        items={[
          {
            key: "overview",
            label: "概览",
            children: (
              <Descriptions column={2} size="small" bordered>
                <Descriptions.Item label="时间">{fmtTime(s.captured_at)}</Descriptions.Item>
                <Descriptions.Item label="链">{s.chain}</Descriptions.Item>
                <Descriptions.Item label="分数">{s.score}</Descriptions.Item>
                <Descriptions.Item label="价格">{fmtNum(s.price, 10)}</Descriptions.Item>
                <Descriptions.Item label="市值（USD）">{fmtNum(s.market_cap_usd, 0)}</Descriptions.Item>
                <Descriptions.Item label="流动性（USD）">{fmtNum(s.liquidity_usd, 0)}</Descriptions.Item>
                <Descriptions.Item label="持有人">{fmtNum(s.holders, 0)}</Descriptions.Item>
                <Descriptions.Item label="峰值涨幅">{fmtPct(s.max_price_gain === null ? null : s.max_price_gain * 100)}</Descriptions.Item>
                <Descriptions.Item label="5m/1h/24h 涨幅">
                  {fmtPct(s.pct_5m)} / {fmtPct(s.pct_1h)} / {fmtPct(s.pct_24h)}
                </Descriptions.Item>
                <Descriptions.Item label="标签">
                  {s.tags.map((t) => <Tag key={t}>{t}</Tag>)}
                  {s.relevance_tags.map((t) => <Tag key={t} color="blue">{t}</Tag>)}
                </Descriptions.Item>
                <Descriptions.Item label="CA" span={2}>
                  <Typography.Text copyable style={{ fontSize: 12 }}>{s.token_address}</Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="DeBot 页面" span={2}>
                  <a href={s.token_url} target="_blank" rel="noopener">{s.token_url}</a>
                </Descriptions.Item>
              </Descriptions>
            ),
          },
          {
            key: "scores",
            label: "评分对比",
            children: (
              <div>
                <Typography.Paragraph type="secondary">
                  v1 = 捕获即评（同步广播）；v2 = enrichment 补全后重评（规则版本一致）
                </Typography.Paragraph>
                <ScoresTable scores={detail.scores} />
              </div>
            ),
          },
          {
            key: "enrich",
            label: "Enrichment",
            children:
              detail.enrichments.length === 0 ? (
                <Typography.Text type="secondary">暂无增强数据</Typography.Text>
              ) : (
                detail.enrichments.map((e) => (
                  <div key={e.provider_id} style={{ marginBottom: 12 }}>
                    <Typography.Text strong>{e.provider_id}</Typography.Text>{" "}
                    <Tag color={e.status === "ok" ? "green" : e.status === "timeout" ? "orange" : "red"}>
                      {e.status}
                    </Tag>
                    <pre style={{ background: "#fafafa", padding: 8, borderRadius: 6, fontSize: 12, maxHeight: 240, overflow: "auto" }}>
                      {JSON.stringify(e.result ?? {}, null, 2)}
                    </pre>
                  </div>
                ))
              ),
          },
          {
            key: "price",
            label: `价格轨迹（${detail.price_points.length} 点）`,
            children: <PriceChart points={detail.price_points} />,
          },
          {
            key: "trade",
            label: "模拟交易",
            children:
              detail.trade === null ? (
                <Typography.Text type="secondary">无（REJECT 信号不模拟入场）</Typography.Text>
              ) : (
                <Descriptions column={2} size="small" bordered>
                  <Descriptions.Item label="策略版本">{detail.trade.strategy_version}</Descriptions.Item>
                  <Descriptions.Item label="状态">{detail.trade.status}</Descriptions.Item>
                  <Descriptions.Item label="入场">{fmtTime(detail.trade.entry_at)}</Descriptions.Item>
                  <Descriptions.Item label="入场价">{fmtNum(detail.trade.entry_price, 10)}</Descriptions.Item>
                  <Descriptions.Item label="出场">{detail.trade.exit_at === null ? "持仓中" : fmtTime(detail.trade.exit_at)}</Descriptions.Item>
                  <Descriptions.Item label="出场价">{fmtNum(detail.trade.exit_price, 10)}</Descriptions.Item>
                  <Descriptions.Item label="PnL（USDT）">
                    <span style={{ color: detail.trade.pnl_usdt === null || detail.trade.pnl_usdt >= 0 ? "#52c41a" : "#ff4d4f", fontWeight: 700 }}>
                      {detail.trade.pnl_usdt === null ? "历史原生币价格缺失" : detail.trade.pnl_usdt.toFixed(4)}
                    </span>
                  </Descriptions.Item>
                  <Descriptions.Item label="卖出明细">
                    {detail.trade.details.map((d, i) => (
                      <Tag key={i}>
                        {new Date(d.ts).toLocaleTimeString()} 卖 {d.sellPct}% @ {fmtNum(d.price, 10)}（{d.reason}）
                      </Tag>
                    ))}
                  </Descriptions.Item>
                </Descriptions>
              ),
          },
          {
            key: "raw",
            label: "原始 JSON",
            children: (
              <pre style={{ background: "#fafafa", padding: 8, borderRadius: 6, fontSize: 12, maxHeight: 400, overflow: "auto" }}>
                {JSON.stringify(detail.raw, null, 2)}
              </pre>
            ),
          },
        ]}
      />
    </div>
  );
}
