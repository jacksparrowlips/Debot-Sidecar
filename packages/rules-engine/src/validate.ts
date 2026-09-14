import type { Rule, Ruleset, CompareOp } from "@debot/shared";

const OPS: CompareOp[] = [">", ">=", "<", "<=", "=", "!=", "contains", "regex", "in"];

/**
 * 规则集校验（WebUI JSON 模式保存前调用）。返回错误信息；null = 合法。
 */
export function validateRuleset(rs: unknown): string | null {
  if (rs === null || typeof rs !== "object") return "ruleset 必须是对象";
  const r = rs as Partial<Ruleset>;
  if (typeof r.baseScore !== "number") return "baseScore 必须是数字";
  const t = r.thresholds;
  if (t === null || typeof t !== "object") return "thresholds 缺失";
  const lo = t.LOW;
  const mid = t.MEDIUM;
  const hi = t.HIGH;
  const vh = t.VERY_HIGH;
  if (
    typeof lo !== "number" ||
    typeof mid !== "number" ||
    typeof hi !== "number" ||
    typeof vh !== "number"
  ) {
    return "thresholds.LOW/MEDIUM/HIGH/VERY_HIGH 必须全是数字";
  }
  if (!(lo <= mid && mid <= hi && hi <= vh)) return "thresholds 必须递增（LOW ≤ MEDIUM ≤ HIGH ≤ VERY_HIGH）";
  if (!Array.isArray(r.rules)) return "rules 必须是数组";
  for (let i = 0; i < r.rules.length; i++) {
    const rule: Partial<Rule> = (r.rules[i] ?? {}) as Partial<Rule>;
    const at = `rules[${i}]`;
    if (typeof rule.id !== "string" || rule.id.length === 0) return `${at}.id 必须是非空字符串`;
    const when = rule.when;
    if (when === null || typeof when !== "object") return `${at}.when 必须是对象`;
    if (typeof when.field !== "string" || when.field.length === 0) return `${at}.when.field 必须是非空字符串`;
    if (!OPS.includes(when.op as CompareOp)) return `${at}.when.op 非法（${OPS.join(" / ")}）`;
    if (!("value" in when)) return `${at}.when.value 缺失`;
    const a = rule.action;
    if (a === "reject") continue;
    if (a === null || typeof a !== "object") return `${at}.action 非法（reject | {addScore} | {subScore}）`;
    if ("addScore" in a && typeof (a as { addScore?: unknown }).addScore === "number") continue;
    if ("subScore" in a && typeof (a as { subScore?: unknown }).subScore === "number") continue;
    return `${at}.action 非法（reject | {addScore} | {subScore}）`;
  }
  return null;
}
