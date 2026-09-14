import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Badge, Layout, Menu, Typography, App as AntApp } from "antd";
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
          <Badge
            status={connected ? "success" : "error"}
            text={connected ? "已连接 Sidecar" : "未连接 Sidecar"}
          />
        </Header>
        <Content style={{ padding: 16, overflow: "auto" }}>
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
