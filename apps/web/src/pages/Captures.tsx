import { useEffect, useState } from "react";
import { Alert, Button, Card, Drawer, Space, Statistic, Table, Tag, Typography } from "antd";
import type { CaptureDetail, CaptureRecord, CaptureSnapshot } from "@debot/shared";
import { get } from "../api";

const status = { processed: "已处理", duplicate: "重复响应", unrecognized: "未知接口 · 已存原始数据", error: "处理失败" };
const time = (n: number) => new Date(n).toLocaleTimeString("zh-CN", { hour12: false }) + `.${String(n % 1000).padStart(3, "0")}`;
export default function Captures(): JSX.Element {
  const [snapshot, setSnapshot] = useState<CaptureSnapshot>();
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [detail, setDetail] = useState<CaptureDetail>();
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    if (paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await get<CaptureSnapshot>("/api/captures");
        if (!stopped) { setSnapshot(next); setError(""); }
      } catch (e) { if (!stopped) setError(String(e)); }
      finally { if (!stopped) timer = setTimeout(refresh, 1000); }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [paused]);
  const age = snapshot?.lastReceivedAt == null ? null : Math.floor((snapshot.now - snapshot.lastReceivedAt) / 1000);
  const open = async (row: CaptureRecord) => {
    setDetailError("");
    try { setDetail(await get<CaptureDetail>(`/api/captures/${row.id}`)); }
    catch (e) { setDetailError(String(e)); }
  };
  return <Space direction="vertical" size="middle" style={{ width: "100%" }}>
    <Space style={{ width: "100%", justifyContent: "space-between" }}>
      <Typography.Title level={3} style={{ margin: 0 }}>捕获监控</Typography.Title>
      <Button onClick={() => setPaused(!paused)}>{paused ? "继续刷新" : "暂停查看"}</Button>
    </Space>
    <Typography.Text type="secondary">每秒刷新；最近 200 条驻留内存，服务重启清空。这里展示已到达 Sidecar 的响应，不能据此保证上游没有漏报。</Typography.Text>
    {error && <Alert type="error" showIcon message="监控服务不可达，以下为旧数据" description={error} />}
    {paused && <Alert type="info" message="画面已暂停；后台仍继续捕获，指标为暂停时快照。" />}
    {detailError && <Alert type="warning" message={detailError} closable onClose={() => setDetailError("")} />}
    <Space wrap align="start">
      <Card size="small"><Statistic title="扩展 → Sidecar" value={error ? "状态未知" : snapshot ? snapshot.extensionConnections > 0 ? "已连接" : "未连接" : "查询中"} /></Card>
      <Card size="small"><Statistic title="最后接收距今" value={age === null ? "尚未收到" : `${age} 秒`} /></Card>
      <Card size="small"><Statistic title="最近 60 秒接收" value={snapshot?.perMinute ?? "—"} /></Card>
      <Card size="small"><Statistic title="本次启动接收总数" value={snapshot?.received ?? "—"} /></Card>
      <Card size="small"><Statistic title="本次启动处理失败" value={snapshot?.errors ?? "—"} /></Card>
    </Space>
    {!error && snapshot && (age === null || age > 60) && <Alert type="warning" showIcon message={age === null ? "还没有收到捕获数据，请打开或刷新 DeBot 信号页。" : "超过 60 秒未收到数据，请检查 DeBot 页面是否仍在刷新。"} />}
    <Typography.Text type="secondary">延时＝页面响应捕获至本地接收，不含上游产生信号及请求耗时。旧版扩展无统一时间戳时显示“未知”。缺失字段提示不等于捕获丢包。</Typography.Text>
    <Table<CaptureRecord> rowKey="id" size="small" loading={!snapshot && !error} dataSource={snapshot?.items ?? []} scroll={{ x: 1100 }} pagination={{ pageSize: 20 }} columns={[
      { title: "接收时间", dataIndex: "receivedAt", width: 120, render: time },
      { title: "来源接口", dataIndex: "url", width: 240, ellipsis: true },
      { title: "币种", dataIndex: "symbols", width: 180, render: (v: string[]) => v.join(", ") || "—" },
      { title: "本地延时", dataIndex: "delayMs", width: 100, render: (v: number | null) => v === null ? "未知" : `${v} ms` },
      { title: "处理结果", render: (_, r) => <><Tag color={r.status === "error" ? "red" : r.status === "processed" ? "green" : "default"}>{status[r.status]}</Tag><div>{Object.entries(r.results).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>{r.error}</> },
      { title: "字段检查", render: (_, r) => r.missing.length ? <Typography.Text type="warning">缺少 {r.missing.join(", ")}</Typography.Text> : "—" },
      { title: "数据", width: 70, render: (_, r) => <Button size="small" onClick={() => void open(r)}>查看</Button> },
    ]} locale={{ emptyText: "尚无捕获记录" }} />
    <Drawer title="捕获数据详情" width={760} open={!!detail} onClose={() => setDetail(undefined)}>
      {detail && <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text>{detail.url}</Typography.Text>
        <Typography.Text>响应捕获：{detail.observedAt === null ? "未知（旧版扩展）" : time(detail.observedAt)} · 接收：{time(detail.receivedAt)} · 本地延时：{detail.delayMs === null ? "未知" : `${detail.delayMs} ms`}</Typography.Text>
        <Typography.Text type="secondary">解析字段最多展示前 50 项；原始数据与解析文本各限 16,384 字符；常见凭据字段已隐藏。</Typography.Text>
        {detail.truncated && <Alert type="warning" message="数据较大，以下仅展示截断预览。" />}
        <Typography.Title level={5}>解析字段</Typography.Title><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.parsed}</pre>
        <Typography.Title level={5}>原始响应</Typography.Title><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.raw}</pre>
      </Space>}
    </Drawer>
  </Space>;
}
