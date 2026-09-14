import type {
  CompareOp,
  Condition,
  Grade,
  HistoryCtx,
  MatchedRule,
  Rule,
  Ruleset,
  ScoreResult,
  Signal,
} from "@debot/shared";
import { GRADE_ORDER } from "@debot/shared";

// ─────────────────────────── 字段访问 ───────────────────────────

const OCCURRENCES_RE = /^occurrencesIn(\d+)m$/;

/**
 * 按点分路径取值（含 enriched.<providerId>.*，providerId 带 '-' 不影响分段查找）。
 * isFirstSeen / occurrencesInNm 为历史上下文字段（HistoryCtx）。
 */
export function getField(
  signal: Signal,
  field: string,
  ctx?: HistoryCtx,
): unknown {
  const m = field.match(OCCURRENCES_RE);
  if (m) {
    return ctx?.windows[m[1] ?? ""] ?? 0;
  }
  if (field === "isFirstSeen") {
    return ctx?.isFirstSeen ?? false;
  }
  let cur: unknown = signal;
  for (const seg of field.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ─────────────────────────── 条件求值 ───────────────────────────

function asNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function testCondition(cond: Condition, signal: Signal, ctx?: HistoryCtx): boolean {
  const actual = getField(signal, cond.field, ctx);
  const expected = cond.value;

  switch (cond.op) {
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const a = asNumber(actual);
      const b = asNumber(expected);
      if (a === null || b === null) return false;
      return cond.op === ">" ? a > b : cond.op === ">=" ? a >= b : cond.op === "<" ? a < b : a <= b;
    }
    case "=":
      // null/null 视为相等（字段缺省 = 规则值缺省）；否则深比较
      if (actual === undefined || actual === null) return expected === null || expected === undefined;
      return JSON.stringify(actual) === JSON.stringify(expected);
    case "!=": {
      const eq =
        actual === undefined || actual === null
          ? expected === null || expected === undefined
          : JSON.stringify(actual) === JSON.stringify(expected);
      return !eq;
    }
    case "contains": {
      if (actual === undefined || actual === null) return false;
      if (Array.isArray(actual)) {
        return actual.some((v) => String(v).toLowerCase() === String(expected).toLowerCase());
      }
      return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    }
    case "regex": {
      if (typeof actual !== "string" || typeof expected !== "string") return false;
      try {
        return new RegExp(expected, "i").test(actual);
      } catch {
        return false; // 非法正则：不命中，静默
      }
    }
    case "in": {
      if (!Array.isArray(expected)) return false;
      return expected.some((v) => String(v) === String(actual));
    }
    default:
      return false;
  }
}

// ─────────────────────────── 评分 ───────────────────────────

function gradeFromScore(score: number, t: Ruleset["thresholds"]): Grade {
  if (score >= t.VERY_HIGH) return "VERY_HIGH";
  if (score >= t.HIGH) return "HIGH";
  if (score >= t.MEDIUM) return "MEDIUM";
  return "LOW"; // 低于 LOW 阈值 → LOW（SPEC §7.3）
}

/**
 * 规则引擎（纯函数，SPEC §7.3）：(signal, ruleset, historyCtx) → result。
 * 历史上下文（isFirstSeen、occurrencesInNm）由服务端查询 SQLite 后作为入参传入。
 */
export function evaluate(
  signal: Signal,
  ruleset: Ruleset,
  historyCtx: HistoryCtx = { isFirstSeen: true, windows: {} },
): ScoreResult {
  let score = ruleset.baseScore;
  let rejected = false;
  const matched: MatchedRule[] = [];

  for (const rule of ruleset.rules) {
    if (!testCondition(rule.when, signal, historyCtx)) continue;
    if (rule.action === "reject") {
      matched.push({ ruleId: rule.id, delta: "reject" });
      rejected = true;
      continue; // 记录全部命中明细（复盘可回答"这条为什么被拒"）
    }
    const delta =
      "addScore" in rule.action ? rule.action.addScore : "subScore" in rule.action ? -rule.action.subScore : 0;
    score += delta;
    matched.push({ ruleId: rule.id, delta });
  }

  if (rejected) {
    return { score, grade: "REJECT", matched, ruleVersion: ruleset.version };
  }
  score = Math.max(0, Math.min(100, score));
  return { score, grade: gradeFromScore(score, ruleset.thresholds), matched, ruleVersion: ruleset.version };
}

/** 等级比较：a 是否 >= b（Grade 常量已内置序） */
export function gradeGte(a: Grade, b: Grade): boolean {
  return GRADE_ORDER[a] >= GRADE_ORDER[b];
}
