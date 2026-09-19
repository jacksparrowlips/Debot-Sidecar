import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Alert, Badge, Button, Layout, Menu, Typography, App as AntApp } from "antd";
import {
  BellOutlined,
  DashboardOutlined,
  HistoryOutlined,
  LineChartOutlined,
  MenuOutlined,
  NotificationOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { subscribe, subscribeStatus } from "./ws";
import { get } from "./api";
import type { CaptureSnapshot } from "@debot/shared";
import Captures from "./pages/Captures";
import Dashboard from "./pages/Dashboard";
import Signals from "./pages/Signals";
import SignalDetail from "./pages/SignalDetail";
import Rules from "./pages/Rules";
import Notifications from "./pages/Notifications";
import Replay from "./pages/Replay";
import Stats from "./pages/Stats";
import Settings from "./pages/Settings";
import NotifyWindow from "./notify/NotifyWindow";

const { Sider, Header, Content } = Layout;

/** 主布局壳：侧边导航 + 连接状态 + 全局 alert */
function Shell(): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [capture, setCapture] = useState<CaptureSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void get<CaptureSnapshot>("/api/captures").then(v => { if (!cancelled) setCapture(v); }).catch(() => { if (!cancelled) setCapture(null); }); };
    refresh(); const timer = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const challenge = capture?.pageHealth.some(p => p.loginState === "expired") ?? false;
  // 供数判定只看信号源（rank/kline → lastSignalAt）；live-market/noticeV2 等杂项会让 lastReceivedAt 永远新鲜（2026-09-19 实测盲区）
  const signalFresh = !!capture && capture.lastSignalAt !== null && capture.now - capture.lastSignalAt < 60_000;
  const silenceMin = capture?.lastSignalAt != null ? Math.floor((capture.now - capture.lastSignalAt) / 60_000) : null;
  const { notification } = AntApp.useApp();

  useEffect(() => subscribeStatus(setConnected), []);

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type === "alert") {
          notification[msg.level === "error" ? "error" : "warning"]({
            message: "Sidecar 告警",
            description: msg.message,
            duration: null,
          });
        }
      }),
    [notification],
  );

  const items = [
    { key: "dashboard", icon: <DashboardOutlined />, label: <NavLink to="/">实时流</NavLink> },
    { key: "captures", icon: <DashboardOutlined />, label: <NavLink to="/captures">捕获监控</NavLink> },
    { key: "signals", icon: <ThunderboltOutlined />, label: <NavLink to="/signals">信号历史</NavLink> },
    { key: "rules", icon: <MenuOutlined />, label: <NavLink to="/rules">规则与标签</NavLink> },
    { key: "notifications", icon: <BellOutlined />, label: <NavLink to="/notifications">通知中心</NavLink> },
    { key: "replay", icon: <HistoryOutlined />, label: <NavLink to="/replay">回放复盘</NavLink> },
    { key: "stats", icon: <LineChartOutlined />, label: <NavLink to="/stats">质量统计</NavLink> },
    { key: "settings", icon: <SettingOutlined />, label: <NavLink to="/settings">设置</NavLink> },
  ];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="dark" width={200}>
        <div style={{ padding: "16px 16px 8px" }}>
          <Typography.Title level={5} style={{ color: "#fff", margin: 0 }}>
            DeBot Sidecar
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            过滤 · 分级 · 复盘（非自动交易）
          </Typography.Text>
        </div>
        <Menu theme="dark" mode="inline" items={items} selectable={false} />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            paddingInline: 24,
            borderBottom: "1px solid #f0f0f0",
          }}
        >
          <Button
            size="small"
            icon={<NotificationOutlined />}
            style={{ marginRight: 24 }}
            onClick={openNotifyWindow}
          >
            通知小窗
          </Button>
          <Badge style={{ marginRight: 24 }} status={challenge ? "error" : signalFresh ? "success" : "warning"} text={challenge ? "DeBot 需要人机验证 · 采集中断" : signalFresh ? "DeBot 正在供数" : silenceMin !== null ? `信号源静默 ${silenceMin} 分钟 · DeBot 页面可能不在信号页` : "未确认信号源供数"} />
          <Badge
            status={connected ? "success" : "error"}
            text={connected ? "已连接 Sidecar" : "未连接 Sidecar"}
          />
        </Header>
        <Content style={{ padding: 16, overflow: "auto" }}>
          {challenge && <Alert type="error" showIcon style={{ marginBottom: 16 }} message="DeBot 需要手动完成人机验证，采集已中断" description="自动刷新已停止。请返回 DeBot 原标签页完成验证；下面的卡片可能是旧数据。" />}
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App(): JSX.Element {
  const location = useLocation();
  // /notify 为独立小窗：不进入主布局
  if (location.pathname === "/notify") return <NotifyWindow />;

  return (
    <Routes>
      <Route path="/notify" element={<NotifyWindow />} />
      <Route path="/" element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="captures" element={<Captures />} />
        <Route path="signals" element={<Signals />} />
        <Route path="signals/:id" element={<SignalDetail />} />
        <Route path="rules" element={<Rules />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="replay" element={<Replay />} />
        <Route path="stats" element={<Stats />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** 给 Settings 等页面复用：打开通知小窗 */
export function openNotifyWindow(): void {
  window.open("/notify", "debot-notify", "width=480,height=420");
}
