// 设置（SPEC §7.6）：通知（阈值/尺寸/位置/声音）、enrichment providers、保活 L0-L3、模板
import { useEffect, useState } from "react";
import { App as AntApp, Button, Card, Form, Input, InputNumber, Radio, Select, Slider, Space, Switch, Upload } from "antd";
import type { Grade, ProviderInfo, SidecarConfig } from "@debot/shared";
import { get, post, put } from "../api";
import { openNotifyWindow } from "../App";

type ConfigResp = SidecarConfig & { providers: ProviderInfo[] };
const GRADE_OPTS = (["REJECT", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"] as Grade[]).map((g) => ({ value: g, label: g }));

function playBeep(volume: number, file: string | null): void {
  if (file !== null && file.length > 0) {
    const audio = new Audio(`/sounds/${file}`);
    audio.volume = volume;
    void audio.play().catch(() => {});
    return;
  }
  // 内置提示音：WebAudio 蜂鸣
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.value = volume * 0.3;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
  void ctx.close();
}

export default function Settings(): JSX.Element {
  const { message } = AntApp.useApp();
  const [cfg, setCfg] = useState<ConfigResp | null>(null);

  useEffect(() => {
    void get<ConfigResp>("/api/config").then(setCfg).catch(() => {});
  }, []);

  if (cfg === null) return <span>加载中…</span>;
  const setNotify = (patch: Partial<SidecarConfig["notify"]>): void =>
    setCfg({ ...cfg, notify: { ...cfg.notify, ...patch } });

  const save = (): void => {
    void put("/api/config", cfg)
      .then(() => void message.success("已保存并热更新生效（端口/数据目录除外）"))
      .catch((e: Error) => void message.error(`保存失败：${e.message}`));
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <Form layout="vertical">
        <Card size="small" title="通知" style={{ marginBottom: 12 }}>
          <Space wrap size="large">
            <Form.Item label="大卡片等级 ≥" style={{ marginBottom: 0 }}>
              <Select
                style={{ width: 130 }}
                value={cfg.notify.cardGrade}
                onChange={(v) => setNotify({ cardGrade: v })}
                options={GRADE_OPTS}
              />
            </Form.Item>
            <Form.Item label="系统通知等级 ≥（null 关闭）" style={{ marginBottom: 0 }}>
              <Select
                style={{ width: 160 }}
                allowClear
                value={cfg.notify.systemGrade ?? undefined}
                onChange={(v) => setNotify({ systemGrade: v ?? null })}
                options={GRADE_OPTS}
              />
            </Form.Item>
            <Form.Item label="小窗尺寸（宽×高）" style={{ marginBottom: 0 }}>
              <Space>
                <InputNumber min={320} max={800} value={cfg.notify.size[0]} onChange={(v) => setNotify({ size: [v ?? 480, cfg.notify.size[1]] })} />
                ×
                <InputNumber min={280} max={900} value={cfg.notify.size[1]} onChange={(v) => setNotify({ size: [cfg.notify.size[0], v ?? 420] })} />
              </Space>
            </Form.Item>
            <Form.Item label="位置" style={{ marginBottom: 0 }}>
              <Radio.Group
                value={cfg.notify.position}
                onChange={(e) => setNotify({ position: e.target.value })}
                options={[
                  { value: "top-right", label: "右上" },
                  { value: "top-left", label: "左上" },
                  { value: "bottom-right", label: "右下" },
                  { value: "bottom-left", label: "左下" },
                ]}
              />
            </Form.Item>
            <Form.Item label="主题" style={{ marginBottom: 0 }}>
              <Radio.Group
                value={cfg.notify.theme}
                onChange={(e) => setNotify({ theme: e.target.value })}
                options={[
                  { value: "dark", label: "深色" },
                  { value: "light", label: "浅色" },
                ]}
              />
            </Form.Item>
          </Space>
          <Space wrap size="large" style={{ marginTop: 12 }}>
            <Form.Item label="提示音" style={{ marginBottom: 0 }}>
              <Space>
                <Switch
                  checked={cfg.notify.sound.enabled}
                  onChange={(v) => setNotify({ sound: { ...cfg.notify.sound, enabled: v } })}
                />
                <Slider
                  style={{ width: 120 }}
                  min={0}
                  max={1}
                  step={0.05}
                  value={cfg.notify.sound.volume}
                  onChange={(v) => setNotify({ sound: { ...cfg.notify.sound, volume: v } })}
                />
                <Button size="small" onClick={() => playBeep(cfg.notify.sound.volume, cfg.notify.sound.file)}>
                  试听
                </Button>
                <Upload
                  accept="audio/*"
                  showUploadList={false}
                  customRequest={async (opt) => {
                    const file = opt.file as File;
                    const buf = new Uint8Array(await file.arrayBuffer());
                    let bin = "";
                    for (const b of buf) bin += String.fromCharCode(b);
                    try {
                      await post("/api/sounds", { name: file.name, base64: btoa(bin) });
                      setNotify({ sound: { ...cfg.notify.sound, file: file.name } });
                      void message.success(`已上传 ${file.name}（保存后生效）`);
                    } catch (e) {
                      void message.error(`上传失败：${(e as Error).message}`);
                    }
                  }}
                >
                  <Button size="small">上传自定义音频</Button>
                </Upload>
                {cfg.notify.sound.file !== null ? <span style={{ fontSize: 12 }}>当前：{cfg.notify.sound.file}</span> : null}
              </Space>
            </Form.Item>
            <Form.Item label="通知测试" style={{ marginBottom: 0 }}>
              <Button onClick={openNotifyWindow}>打开通知小窗</Button>
            </Form.Item>
          </Space>
        </Card>

        <Card size="small" title="数据增强（enrichment）" style={{ marginBottom: 12 }}>
          <Space wrap>
            <Form.Item label="单 provider 超时（秒）" style={{ marginBottom: 0 }}>
              <InputNumber
                min={3}
                max={60}
                value={cfg.enrichment.timeoutSec}
                onChange={(v) => setCfg({ ...cfg, enrichment: { ...cfg.enrichment, timeoutSec: v ?? 15 } })}
              />
            </Form.Item>
            {cfg.providers.map((p) => (
              <Form.Item key={p.id} label={p.description} style={{ marginBottom: 0 }} extra={p.reserved ? "预留（未实现）" : undefined}>
                <Switch
                  disabled={p.reserved}
                  checked={cfg.enrichment.providers[p.id] === true}
                  onChange={(v) =>
                    setCfg({
                      ...cfg,
                      enrichment: { ...cfg.enrichment, providers: { ...cfg.enrichment.providers, [p.id]: v } },
                    })
                  }
                />
              </Form.Item>
            ))}
          </Space>
        </Card>

        <Card size="small" title="保活（L0-L3）" style={{ marginBottom: 12 }}>
          <Space wrap size="large">
            <Form.Item label="L0 合成事件（P0 有效性未定稿，默认关）" style={{ marginBottom: 0 }}>
              <Space>
                <Switch
                  checked={cfg.keepalive.l0}
                  onChange={(v) => setCfg({ ...cfg, keepalive: { ...cfg.keepalive, l0: v } })}
                />
                <InputNumber
                  min={1}
                  max={30}
                  addonAfter="分钟"
                  value={cfg.keepalive.l0IntervalMin}
                  onChange={(v) => setCfg({ ...cfg, keepalive: { ...cfg.keepalive, l0IntervalMin: v ?? 3 } })}
                />
              </Space>
            </Form.Item>
            <Form.Item label="L1 静默自动刷新" style={{ marginBottom: 0 }}>
              <Space>
                <Switch
                  checked={cfg.keepalive.l1}
                  onChange={(v) => setCfg({ ...cfg, keepalive: { ...cfg.keepalive, l1: v } })}
                />
                <InputNumber
                  min={1}
                  max={120}
                  addonAfter="分钟静默"
                  value={cfg.keepalive.l1SilenceMin}
                  onChange={(v) => setCfg({ ...cfg, keepalive: { ...cfg.keepalive, l1SilenceMin: v ?? 3 } })}
                />
              </Space>
            </Form.Item>
            <Form.Item label="音频保活（防后台节流）" style={{ marginBottom: 0 }}>
              <Switch
                checked={cfg.keepalive.audio}
                onChange={(v) => setCfg({ ...cfg, keepalive: { ...cfg.keepalive, audio: v } })}
              />
            </Form.Item>
            <Form.Item label="可见性欺骗（visibility hook）" style={{ marginBottom: 0 }}>
              <Switch
                checked={cfg.keepalive.visibilityHook}
                onChange={(v) => setCfg({ ...cfg, keepalive: { ...cfg.keepalive, visibilityHook: v } })}
              />
            </Form.Item>
            <span style={{ fontSize: 12, color: "#999" }}>
              L2（CF 挑战页检测）/ L3（告警升级）随扩展常开；音频保活需在 DeBot 页面点一次解锁自动播放（生效标志：标签页出现
              🔊）；开关变更约 1 分钟内生效
            </span>
          </Space>
        </Card>

        <Card size="small" title="杂项" style={{ marginBottom: 12 }}>
          <Space wrap size="large">
            <Form.Item label="差分器冷却窗口（分钟）" style={{ marginBottom: 0 }}>
              <InputNumber
                min={1}
                max={240}
                value={cfg.cooldownMin}
                onChange={(v) => setCfg({ ...cfg, cooldownMin: v ?? 10 })}
              />
            </Form.Item>
            <Form.Item label="Token 页 URL 模板" style={{ marginBottom: 0 }}>
              <Input
                style={{ width: 420 }}
                value={cfg.tokenUrlTemplate}
                onChange={(e) => setCfg({ ...cfg, tokenUrlTemplate: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="端口（重启生效）" style={{ marginBottom: 0 }}>
              <InputNumber disabled value={cfg.port} />
            </Form.Item>
            <Form.Item label="数据目录（重启生效）" style={{ marginBottom: 0 }}>
              <Input disabled style={{ width: 260 }} value={cfg.dataDir} />
            </Form.Item>
          </Space>
        </Card>

        <Button type="primary" onClick={save}>保存全部</Button>
      </Form>
    </div>
  );
}
