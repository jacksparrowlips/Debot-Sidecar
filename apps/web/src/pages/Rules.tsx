// 规则与标签（SPEC §7.5）：表单 + JSON 双模式编辑、版本历史与回滚、相关性标签库
import { useEffect, useState } from "react";
import { App as AntApp, Button, Card, Form, Input, InputNumber, Popconfirm, Radio, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import type { CompareOp, Rule, RuleVersionRow, Ruleset, TagLibrary } from "@debot/shared";
import { get, put } from "../api";
import { fmtTime } from "../grades";

const OPS: CompareOp[] = [">", ">=", "<", "<=", "=", "!=", "contains", "regex", "in"];

type RulesResp = { current: Ruleset; versions: RuleVersionRow[] };

function actionText(a: Rule["action"]): string {
  if (a === "reject") return "拒绝（REJECT）";
  if (typeof a === "object") {
    if ("addScore" in a) return `+${a.addScore}`;
    if ("subScore" in a) return `−${a.subScore}`;
  }
  return "?";
}

function RuleCard({ rule, onChange, onRemove }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void }): JSX.Element {
  const actionType = rule.action === "reject" ? "reject" : typeof rule.action === "object" && "addScore" in rule.action ? "add" : "sub";
  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <Space wrap>
        <Input
          style={{ width: 160 }}
          placeholder="规则 id"
          value={rule.id}
          onChange={(e) => onChange({ ...rule, id: e.target.value })}
        />
        <Input
          style={{ width: 260 }}
          placeholder="字段（如 market_cap_usd / enriched.heat-dexscreener.txns24h / occurrencesIn30m）"
          value={rule.when.field}
          onChange={(e) => onChange({ ...rule, when: { ...rule.when, field: e.target.value } })}
        />
        <Select
          style={{ width: 110 }}
          value={rule.when.op}
          options={OPS.map((o) => ({ value: o, label: o }))}
          onChange={(v) => onChange({ ...rule, when: { ...rule.when, op: v } })}
        />
        <Input
          style={{ width: 220 }}
          placeholder='值（"in" 用逗号分隔数组）'
          value={
            rule.when.op === "in" && Array.isArray(rule.when.value)
              ? (rule.when.value as string[]).join(",")
              : String(rule.when.value ?? "")
          }
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...rule, when: { ...rule.when, value: rule.when.op === "in" ? v.split(",").map((x) => x.trim()) : v } });
          }}
        />
        <Radio.Group
          value={actionType}
          onChange={(e) => {
            const t = e.target.value as "reject" | "add" | "sub";
            const action: Rule["action"] = t === "reject" ? "reject" : t === "add" ? { addScore: 20 } : { subScore: 10 };
            onChange({ ...rule, action });
          }}
          options={[
            { value: "reject", label: "拒绝" },
            { value: "add", label: "加分" },
            { value: "sub", label: "减分" },
          ]}
        />
        {rule.action !== "reject" ? (
          <InputNumber
            value={typeof rule.action === "object" && "addScore" in rule.action ? rule.action.addScore : typeof rule.action === "object" && "subScore" in rule.action ? rule.action.subScore : 0}
            onChange={(v) => {
              const prev = rule.action;
              const action: Rule["action"] =
                typeof prev === "object" && "addScore" in prev ? { addScore: v ?? 0 } : { subScore: v ?? 0 };
              onChange({ ...rule, action });
            }}
          />
        ) : null}
        <Button danger icon={<DeleteOutlined />} onClick={onRemove} />
      </Space>
    </Card>
  );
}

export default function Rules(): JSX.Element {
  const { message } = AntApp.useApp();
  const [ruleset, setRuleset] = useState<Ruleset | null>(null);
  const [versions, setVersions] = useState<RuleVersionRow[]>([]);
  const [tags, setTags] = useState<TagLibrary>({});
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");

  const reload = (): void => {
    void get<RulesResp>("/api/rules").then((r) => {
      setRuleset(r.current);
      setVersions(r.versions);
      setJsonText(JSON.stringify(r.current, null, 2));
    });
    void get<TagLibrary>("/api/tags").then(setTags);
  };
  useEffect(reload, []);

  const save = (rs: Ruleset): void => {
    void put<{ version: number }>("/api/rules", rs)
      .then((res) => {
        void message.success(`已保存（版本 v${res.version}），立即生效于后续信号`);
        reload();
      })
      .catch((e: Error) => void message.error(`保存失败：${e.message}`));
  };

  if (ruleset === null) return <Typography.Text>加载中…</Typography.Text>;

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <Typography.Text strong>当前规则版本 v{ruleset.version}</Typography.Text>
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value as "form" | "json")} options={[{ value: "form", label: "表单模式" }, { value: "json", label: "JSON 模式" }]} />
        <Button
          type="primary"
          onClick={() => {
            if (mode === "form") save(ruleset);
            else {
              try {
                save(JSON.parse(jsonText) as Ruleset);
              } catch {
                void message.error("JSON 解析失败");
              }
            }
          }}
        >
          保存（生成新版本）
        </Button>
      </div>

      <Tabs
        items={[
          {
            key: "rules",
            label: "规则集",
            children:
              mode === "json" ? (
                <Input.TextArea rows={22} value={jsonText} onChange={(e) => setJsonText(e.target.value)} style={{ fontFamily: "monospace", fontSize: 12 }} />
              ) : (
                <div>
                  <Space style={{ marginBottom: 12 }}>
                    <span>基础分</span>
                    <InputNumber value={ruleset.baseScore} onChange={(v) => setRuleset({ ...ruleset, baseScore: v ?? 0 })} />
                    {(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"] as const).map((k) => (
                      <span key={k}>
                        {k}≥
                        <InputNumber
                          value={ruleset.thresholds[k]}
                          onChange={(v) => setRuleset({ ...ruleset, thresholds: { ...ruleset.thresholds, [k]: v ?? 0 } })}
                        />
                      </span>
                    ))}
                  </Space>
                  {ruleset.rules.map((r, i) => (
                    <RuleCard
                      key={`${r.id}-${i}`}
                      rule={r}
                      onChange={(nr) => setRuleset({ ...ruleset, rules: ruleset.rules.map((x, j) => (j === i ? nr : x)) })}
                      onRemove={() => setRuleset({ ...ruleset, rules: ruleset.rules.filter((_, j) => j !== i) })}
                    />
                  ))}
                  <Button
                    icon={<PlusOutlined />}
                    onClick={() =>
                      setRuleset({
                        ...ruleset,
                        rules: [...ruleset.rules, { id: `rule-${Date.now()}`, when: { field: "", op: ">", value: 0 }, action: { addScore: 10 } }],
                      })
                    }
                  >
                    新增规则
                  </Button>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
                    历史上下文字段：isFirstSeen（= / != true）、occurrencesIn30m / occurrencesIn60m（&gt; N）；增强字段：enriched.&lt;providerId&gt;.*（如 enriched.heat-dexscreener.txns24h）
                  </Typography.Paragraph>
                </div>
              ),
          },
          {
            key: "tags",
            label: "相关性标签库",
            children: (
              <div style={{ maxWidth: 560 }}>
                {Object.entries(tags).map(([key, words]) => (
                  <Card key={key} size="small" style={{ marginBottom: 8 }} title={key} extra={<Button danger size="small" icon={<DeleteOutlined />} onClick={() => { const next = { ...tags }; delete next[key]; setTags(next); }} />}>
                    <Input
                      value={words.join(", ")}
                      placeholder="逗号分隔关键词"
                      onChange={(e) => setTags({ ...tags, [key]: e.target.value.split(",").map((x) => x.trim()).filter((x) => x.length > 0) })}
                    />
                  </Card>
                ))}
                <Space>
                  <Button
                    icon={<PlusOutlined />}
                    onClick={() => {
                      const name = window.prompt("新标签组名称（如 CZ / 何一）");
                      if (name !== null && name.trim().length > 0) setTags({ ...tags, [name.trim()]: [] });
                    }}
                  >
                    新增标签组
                  </Button>
                  <Button
                    type="primary"
                    onClick={() => {
                      void put("/api/tags", tags)
                        .then(() => void message.success("标签库已保存，立即生效"))
                        .catch((e: Error) => void message.error(`保存失败：${e.message}`));
                    }}
                  >
                    保存标签库
                  </Button>
                </Space>
              </div>
            ),
          },
          {
            key: "versions",
            label: "版本历史",
            children: (
              <Table
                rowKey="version"
                size="small"
                dataSource={versions}
                pagination={{ pageSize: 10 }}
                columns={[
                  { title: "版本", dataIndex: "version", width: 80, render: (v: number) => <b>v{v}</b> },
                  { title: "保存时间", dataIndex: "created_at", width: 170, render: fmtTime },
                  { title: "规则数", width: 80, render: (_: unknown, r: RuleVersionRow) => ((r.snapshot as Ruleset).rules?.length ?? 0) },
                  {
                    title: "",
                    render: (_: unknown, r: RuleVersionRow) =>
                      r.current ? (
                        <Tag color="green">当前</Tag>
                      ) : (
                        <Popconfirm title={`回滚到 v${r.version}？`} onConfirm={() => save(r.snapshot as Ruleset)}>
                          <Button size="small">回滚到此版本</Button>
                        </Popconfirm>
                      ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
