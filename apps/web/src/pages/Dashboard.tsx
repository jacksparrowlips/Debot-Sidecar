// 实时流（SPEC §7.4）：WS 推送插入/更新 + 等级筛选
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Table, Tag, Typography } from "antd";
import type { SignalSummary, ServerBroadcastMsg } from "@debot/shared";
import { subscribe } from "../ws";
import { get } from "../api";
import { GRADES, GradeTag, fmtNum, fmtPct, fmtTime, fmtUsd } from "../grades";

export default function Dashboard(): JSX.Element {
  const [rows, setRows] = useState<SignalSummary[]>([]);
  const [gradeFilter, setGradeFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void get<import("@debot/shared").SignalsPage>("/api/signals?pageSize=50")
      .then((p) => setRows(p.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(
    () =>
      subscribe((msg: ServerBroadcastMsg) => {
        if (msg.type === "signal.scored") {
          setRows((prev) => [msg.signal, ...prev.filter((r) => r.id !== msg.signal.id)].slice(0, 200));
        } else if (msg.type === "grade.updated" || msg.type === "notification") {
          setRows((prev) => prev.map((r) => (r.id === msg.signal.id ? msg.signal : r)));
        }
      }),
    [],
  );

  const filtered = useMemo(
    () => (gradeFilter === "all" ? rows : rows.filter((r) => r.grade === gradeFilter)),
    [rows, gradeFilter],
  );

  const columns = [
    { title: "时间", dataIndex: "captured_at", width: 90, render: (v: number) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(v).slice(5)}</Typography.Text> },
    { title: "等级", dataIndex: "grade", width: 100, render: (g: string) => <GradeTag grade={g} /> },
    {
      title: "Token",
      dataIndex: "symbol",
      width: 130,
      render: (_: unknown, r: SignalSummary) => (
        <span>
          <Link to={`/signals/${r.id}`}>{r.symbol}</Link>
          {r.signal_type === "resurface" ? <Tag style={{ marginLeft: 6 }}>重出</Tag> : null}
        </span>
      ),
    },
    { title: "链", dataIndex: "chain", width: 70 },
    { title: "分数", dataIndex: "score", width: 70, render: (v: number) => <b>{v}</b> },
    { title: "市值", dataIndex: "market_cap_usd", width: 90, render: fmtUsd },
    { title: "流动性", dataIndex: "liquidity_usd", width: 90, render: fmtUsd },
    { title: "24h 涨幅", dataIndex: "pct_24h", width: 90, render: fmtPct },
    { title: "峰值涨幅", dataIndex: "max_price_gain", width: 90, render: (v: number | null) => fmtPct(v === null ? null : v * 100) },
    {
      title: "标签",
      dataIndex: "relevance_tags",
      render: (tags: string[]) => (
        <>
          {tags.map((t) => (
            <Tag key={t} color="blue">{t}</Tag>
          ))}
        </>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Tag.CheckableTag checked={gradeFilter === "all"} onChange={() => setGradeFilter("all")}>
          全部
        </Tag.CheckableTag>
        {GRADES.map((g) => (
          <Tag.CheckableTag key={g} checked={gradeFilter === g} onChange={() => setGradeFilter(g)}>
            {g}
          </Tag.CheckableTag>
        ))}
        <Typography.Text type="secondary" style={{ marginLeft: "auto", fontSize: 12 }}>
          实时推送（新信号置顶）；{fmtNum(filtered.length, 0)} 条
        </Typography.Text>
      </div>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={filtered}
        columns={columns}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        onRow={(r) => ({ onClick: () => window.open(`/signals/${r.id}`, "_self") })}
      />
    </div>
  );
}
