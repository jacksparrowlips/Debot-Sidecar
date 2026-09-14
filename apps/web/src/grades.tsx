// 等级元数据与格式化工具（SPEC §7.4：等级色贯穿全 UI）
import type { Grade } from "@debot/shared";
import { Tag } from "antd";

export const GRADE_META: Record<Grade, { label: string; color: string; bg: string }> = {
  REJECT: { label: "拒绝", color: "#6b7280", bg: "rgba(107,114,128,0.14)" },
  LOW: { label: "低", color: "#9aa4b2", bg: "rgba(154,164,178,0.14)" },
  MEDIUM: { label: "中", color: "#f5c518", bg: "rgba(245,197,24,0.14)" },
  HIGH: { label: "高", color: "#ff9f43", bg: "rgba(255,159,67,0.14)" },
  VERY_HIGH: { label: "极高", color: "#ff4d4f", bg: "rgba(255,77,79,0.16)" },
};

export const GRADES: Grade[] = ["REJECT", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"];

export function GradeTag({ grade }: { grade: string }): JSX.Element {
  const meta = GRADE_META[grade as Grade] ?? GRADE_META.LOW;
  return (
    <Tag style={{ color: meta.color, background: meta.bg, borderColor: meta.color, fontWeight: 700 }}>
      {grade}
    </Tag>
  );
}

export function fmtTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
    2,
    "0",
  )}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(1)}%`;
}
