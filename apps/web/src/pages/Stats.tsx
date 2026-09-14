// 质量统计（SPEC §7.7）：按等级/规则分组，真实结果对照（平均峰值涨幅、模拟胜率、期望 PnL、最大回撤）
import { useEffect, useState } from "react";
import { DatePicker, Progress, Radio, Table, Typography } from "antd";
import type { StatsResult, StatsRow } from "@debot/shared";
import { get } from "../api";
import { fmtNum, fmtPct } from "../grades";

const { RangePicker } = DatePicker;

export default function Stats(): JSX.Element {
  const [groupBy, setGroupBy] = useState<"grade" | "rule">("grade");
  const [range, setRange] = useState<[number, number] | null>(null);
  const [data, setData] = useState<StatsResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ groupBy });
    if (range !== null) {
      params.set("from", String(range[0]));
      params.set("to", String(range[1]));
    }
    setLoading(true);
    void get<StatsResult>(`/api/stats?${params.toString()}`)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [groupBy, range]);

  const maxCount = Math.max(1, ...(data?.rows.map((r) => r.signalCount) ?? [1]));

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Radio.Group
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as "grade" | "rule")}
          options={[
            { value: "grade", label: "按等级" },
            { value: "rule", label: "按命中规则" },
          ]}
        />
        <RangePicker
          showTime
          onChange={(vals) =>
            setRange(vals !== null && vals[0] !== null && vals[1] !== null ? [vals[0].valueOf(), vals[1].valueOf()] : null)
          }
        />
      </div>
      <Table<StatsRow>
        rowKey="key"
        size="small"
        loading={loading}
        dataSource={data?.rows ?? []}
        pagination={false}
        columns={[
          { title: data === null ? "" : data.groupBy === "grade" ? "等级" : "规则", dataIndex: "key", width: 220 },
          {
            title: "信号数",
            dataIndex: "signalCount",
            width: 160,
            render: (v: number) => <Progress percent={(v / maxCount) * 100} size="small" format={() => String(v)} />,
          },
          { title: "平均峰值涨幅", dataIndex: "avgMaxGainPct", width: 120, render: (v: number | null) => fmtPct(v) },
          { title: "模拟数", dataIndex: "simulatedCount", width: 90 },
          { title: "模拟胜率", dataIndex: "winRate", width: 100, render: (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`) },
          {
            title: "期望 PnL（SOL）",
            dataIndex: "expectedPnlSol",
            width: 130,
            render: (v: number | null) => (
              <span style={{ color: v === null ? undefined : v >= 0 ? "#52c41a" : "#ff4d4f", fontWeight: 600 }}>
                {v === null ? "—" : fmtNum(v, 4)}
              </span>
            ),
          },
          { title: "最大回撤（SOL）", dataIndex: "maxDrawdownSol", width: 130, render: (v: number | null) => (v === null ? "—" : fmtNum(v, 4)) },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        峰值涨幅取信号后价格序列最高点（rank/kline/DexScreener 合并序列）；模拟胜率/期望 PnL 由策略模板回放（成本模型：双边滑点+手续费）
      </Typography.Paragraph>
    </div>
  );
}
