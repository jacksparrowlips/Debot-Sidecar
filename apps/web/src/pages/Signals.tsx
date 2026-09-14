// 信号历史（SPEC §7.5）：分页 + 等级/时间/关键词筛选
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DatePicker, Input, Select, Table, Typography } from "antd";
import type { SignalSummary, SignalsPage } from "@debot/shared";
import { get } from "../api";
import { GRADES, GradeTag, fmtPct, fmtTime, fmtUsd } from "../grades";

const { RangePicker } = DatePicker;

export default function Signals(): JSX.Element {
  const [data, setData] = useState<SignalsPage | null>(null);
  const [page, setPage] = useState(1);
  const [grade, setGrade] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const [range, setRange] = useState<[number, number] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (grade !== undefined) params.set("grade", grade);
    if (q.length > 0) params.set("q", q);
    if (range !== null) {
      params.set("from", String(range[0]));
      params.set("to", String(range[1]));
    }
    setLoading(true);
    void get<SignalsPage>(`/api/signals?${params.toString()}`)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, grade, q, range]);

  const columns = [
    { title: "时间", dataIndex: "captured_at", width: 150, render: fmtTime },
    { title: "等级", dataIndex: "grade", width: 100, render: (g: string) => <GradeTag grade={g} /> },
    { title: "类型", dataIndex: "signal_type", width: 80, render: (t: string) => (t === "new" ? "新" : "重出") },
    {
      title: "Token",
      dataIndex: "symbol",
      render: (_: unknown, r: SignalSummary) => <Link to={`/signals/${r.id}`}>{r.symbol}</Link>,
    },
    { title: "链", dataIndex: "chain", width: 70 },
    { title: "分数", dataIndex: "score", width: 70, render: (v: number) => <b>{v}</b> },
    { title: "市值", dataIndex: "market_cap_usd", width: 90, render: fmtUsd },
    { title: "峰值涨幅", dataIndex: "max_price_gain", width: 90, render: (v: number | null) => fmtPct(v === null ? null : v * 100) },
  ];

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Select
          allowClear
          placeholder="等级"
          style={{ width: 120 }}
          value={grade}
          onChange={(v) => {
            setPage(1);
            setGrade(v);
          }}
          options={GRADES.map((g) => ({ value: g, label: g }))}
        />
        <RangePicker
          showTime
          onChange={(vals) => {
            setPage(1);
            setRange(vals !== null && vals[0] !== null && vals[1] !== null ? [vals[0].valueOf(), vals[1].valueOf()] : null);
          }}
        />
        <Input.Search
          placeholder="symbol / 名称 / CA"
          allowClear
          style={{ width: 220 }}
          onSearch={(v) => {
            setPage(1);
            setQ(v.trim());
          }}
        />
      </div>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={data?.items ?? []}
        columns={columns}
        pagination={{
          current: page,
          pageSize: 20,
          total: data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        全量留存（含 REJECT），呈现层降噪（SPEC §4）
      </Typography.Text>
    </div>
  );
}
