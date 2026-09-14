// 通知中心（SPEC §7.6.4）：历史通知列表，防漏看；未读红点（前端本地记录）
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Table, Tag } from "antd";
import { get } from "../api";
import { GradeTag, fmtTime } from "../grades";

interface NotifRow {
  id: number;
  signal_id: number;
  grade: string;
  notified_at: number;
  click_url: string;
  symbol: string | null;
  token_address: string | null;
  chain: string | null;
}

const LAST_READ_KEY = "debot-notify-last-read";

export default function Notifications(): JSX.Element {
  const [rows, setRows] = useState<NotifRow[]>([]);
  const [lastRead, setLastRead] = useState<number>(() => {
    const v = window.localStorage.getItem(LAST_READ_KEY);
    return v === null ? 0 : Number(v);
  });

  useEffect(() => {
    void get<NotifRow[]>("/api/notifications").then(setRows).catch(() => {});
  }, []);

  const unread = rows.filter((r) => r.notified_at > lastRead).length;
  const markRead = (): void => {
    const now = Date.now();
    window.localStorage.setItem(LAST_READ_KEY, String(now));
    setLastRead(now);
  };

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
        <Badge count={unread} offset={[-2, 0]}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>历史通知</span>
        </Badge>
        <a onClick={markRead} style={{ fontSize: 12 }}>全部标为已读</a>
      </div>
      <Table
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        rowClassName={(r) => (r.notified_at > lastRead ? "" : "opacity: 0.55")}
        columns={[
          {
            title: "",
            width: 30,
            render: (_: unknown, r: NotifRow) =>
              r.notified_at > lastRead ? <Tag color="red">新</Tag> : null,
          },
          { title: "时间", dataIndex: "notified_at", width: 170, render: fmtTime },
          { title: "等级", dataIndex: "grade", width: 110, render: (g: string) => <GradeTag grade={g} /> },
          {
            title: "Token",
            render: (_: unknown, r: NotifRow) => (
              <Link to={`/signals/${r.signal_id}`}>{r.symbol ?? r.token_address?.slice(0, 8)}</Link>
            ),
          },
          { title: "链", dataIndex: "chain", width: 70 },
          {
            title: "DeBot",
            width: 80,
            render: (_: unknown, r: NotifRow) => (
              <a href={r.click_url} target="_blank" rel="noopener">打开 ↗</a>
            ),
          },
        ]}
      />
    </div>
  );
}
