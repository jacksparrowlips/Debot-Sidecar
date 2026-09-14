// 回放复盘（SPEC §7.7）：时间窗 + 规则版本 → 重放打分；runs 历史与两版本对比
import { useEffect, useState } from "react";
import { Button, Card, Col, DatePicker, Descriptions, Row, Select, Space, Table, Typography } from "antd";
import type { ReplayDetail, ReplayRunDetail, RuleVersionRow } from "@debot/shared";
import { get, post } from "../api";
import { fmtTime } from "../grades";

const { RangePicker } = DatePicker;

function RunSummary({ run, title }: { run: ReplayDetail | null; title: string }): JSX.Element {
  return (
    <Card size="small" title={title}>
      {run === null ? (
        <Typography.Text type="secondary">—</Typography.Text>
      ) : (
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="时间窗">
            {fmtTime(run.time_from)} ~ {fmtTime(run.time_to)}
          </Descriptions.Item>
          <Descriptions.Item label="规则版本">v{run.rule_version}</Descriptions.Item>
          <Descriptions.Item label="信号数">{run.summary.count}</Descriptions.Item>
          <Descriptions.Item label="分级分布">
            {Object.entries(run.summary.grades)
              .map(([g, n]) => `${g}:${n}`)
              .join("  ") || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="平均分">{run.summary.avgScore.toFixed(1)}</Descriptions.Item>
          <Descriptions.Item label="模拟胜率">
            {run.summary.simulatedWinRate === null ? "—" : `${(run.summary.simulatedWinRate * 100).toFixed(1)}%`}
          </Descriptions.Item>
        </Descriptions>
      )}
    </Card>
  );
}

export default function Replay(): JSX.Element {
  const [runs, setRuns] = useState<ReplayDetail[]>([]);
  const [ruleVersions, setRuleVersions] = useState<RuleVersionRow[]>([]);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [ruleVersion, setRuleVersion] = useState<number | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [compareA, setCompareA] = useState<number | null>(null);
  const [compareB, setCompareB] = useState<number | null>(null);
  const [detailA, setDetailA] = useState<ReplayDetail | null>(null);
  const [detailB, setDetailB] = useState<ReplayDetail | null>(null);

  const reload = (): void => {
    void get<ReplayDetail[]>("/api/replays").then(setRuns);
    void get<{ versions: RuleVersionRow[] }>("/api/rules").then((r) => setRuleVersions(r.versions));
  };
  useEffect(reload, []);

  const run = (): void => {
    if (range === null) return;
    setRunning(true);
    void post<ReplayRunDetail>("/api/replay", {
      from: range[0],
      to: range[1],
      ruleVersion,
    })
      .then(() => reload())
      .catch(() => {})
      .finally(() => setRunning(false));
  };

  const loadCompare = (): void => {
    const a = runs.find((r) => r.id === compareA) ?? null;
    const b = runs.find((r) => r.id === compareB) ?? null;
    setDetailA(a);
    setDetailB(b);
  };

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }} title="执行回放（同一引擎重放历史信号）">
        <Space wrap>
          <RangePicker
            showTime
            onChange={(vals) =>
              setRange(vals !== null && vals[0] !== null && vals[1] !== null ? [vals[0].valueOf(), vals[1].valueOf()] : null)
            }
          />
          <Select
            allowClear
            placeholder="规则版本（默认当前）"
            style={{ width: 160 }}
            value={ruleVersion}
            onChange={setRuleVersion}
            options={ruleVersions.map((v) => ({ value: v.version, label: `v${v.version}${v.current ? "（当前）" : ""}` }))}
          />
          <Button type="primary" loading={running} disabled={range === null} onClick={run}>
            执行回放
          </Button>
        </Space>
      </Card>

      <Card size="small" style={{ marginBottom: 12 }} title="两版本对比（A/B 选择的 run）">
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            placeholder="run A"
            style={{ width: 200 }}
            value={compareA}
            onChange={setCompareA}
            options={runs.map((r) => ({ value: r.id, label: `#${r.id} v${r.rule_version} · ${new Date(r.created_at).toLocaleString()}` }))}
          />
          <Select
            placeholder="run B"
            style={{ width: 200 }}
            value={compareB}
            onChange={setCompareB}
            options={runs.map((r) => ({ value: r.id, label: `#${r.id} v${r.rule_version} · ${new Date(r.created_at).toLocaleString()}` }))}
          />
          <Button disabled={compareA === null || compareB === null} onClick={loadCompare}>
            对比
          </Button>
        </Space>
        <Row gutter={12}>
          <Col span={12}><RunSummary run={detailA} title="A" /></Col>
          <Col span={12}><RunSummary run={detailB} title="B" /></Col>
        </Row>
      </Card>

      <Table
        rowKey="id"
        size="small"
        dataSource={runs}
        pagination={{ pageSize: 10 }}
        columns={[
          { title: "#", dataIndex: "id", width: 60 },
          { title: "执行时间", dataIndex: "created_at", width: 170, render: fmtTime },
          { title: "时间窗", render: (_: unknown, r: ReplayDetail) => `${fmtTime(r.time_from)} ~ ${fmtTime(r.time_to)}` },
          { title: "规则版本", dataIndex: "rule_version", width: 90, render: (v: number) => `v${v}` },
          { title: "信号数", dataIndex: "summary", width: 90, render: (s: ReplayDetail["summary"]) => s.count },
          {
            title: "分级分布",
            render: (_: unknown, r: ReplayDetail) =>
              Object.entries(r.summary.grades).map(([g, n]) => `${g}:${n}`).join("  ") || "—",
          },
        ]}
      />
    </div>
  );
}
