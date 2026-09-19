import { gradeGte } from "@debot/rules-engine";
import type { ScoreResult, Signal, SignalSummary } from "@debot/shared";
import { getCtx } from "../context.js";
import { insertNotification } from "../store/misc.js";

/**
 * REJECT 聚合系统通知（SPEC §7.6 降噪，2026-09-19 拍板）：
 * 60s 滚动窗口内每满 3 条 REJECT 触发一条汇总系统通知（systemNotify=true），
 * 其余 REJECT 仅广播灰卡轻通知（不占强通知风暴配额、不入 notifications 库）。
 * # ponytail: 常量硬编码；要调频率再升级为 NotifyConfig 字段
 */
const REJECT_WINDOW_MS = 60_000;
const REJECT_NOTIFY_EVERY = 3;
let rejectTimestamps: number[] = [];

/** REJECT 一句话原因：优先命中拒绝规则，否则总分未达 LOW 线 */
function rejectReason(score: ScoreResult): string {
  const rejected = score.matched.filter((m) => m.delta === "reject");
  if (rejected.length > 0) return `命中拒绝规则：${rejected.map((m) => m.ruleId).join("、")}`;
  return `总分 ${score.score} 未达 LOW 线 ${getCtx().ruleset.thresholds.LOW}`;
}

/**
 * 通知判定（SPEC §7.6）：v2 等级 >= cardGrade → 强通知（WebUI 大卡片）+ notifications 入库；
 * >= systemGrade（可配，null 关闭）→ 追加系统通知兜底（广播内标记，由扩展 chrome.notifications 与 WebUI Notification API 呈现）。
 * REJECT → 灰卡轻通知 + 聚合系统通知（响铃即通知：被过滤也告知原因）。
 */
export function maybeNotify(signal: Signal, summary: SignalSummary, score: ScoreResult): void {
  const { config, broadcast } = getCtx();
  const grade = score.grade;

  // ── REJECT：灰卡轻通知 + 60s 窗口聚合系统通知（不占强通知配额） ──
  if (grade === "REJECT") {
    const now = Date.now();
    rejectTimestamps = rejectTimestamps.filter((t) => now - t < REJECT_WINDOW_MS);
    rejectTimestamps.push(now);
    const systemNotify = rejectTimestamps.length % REJECT_NOTIFY_EVERY === 0;
    const reason =
      rejectReason(score) + (systemNotify ? `（近 1 分钟已过滤 ${rejectTimestamps.length} 条）` : "");
    broadcast({
      type: "notification",
      grade,
      signal: summary,
      score,
      systemNotify,
      clickUrl: summary.token_url,
      reason,
    });
    return;
  }

  if (!gradeGte(grade, config.notify.cardGrade)) return;

  const clickUrl = summary.token_url;
  insertNotification(getCtx().db, { signal_id: summary.id, grade, click_url: clickUrl });
  const systemNotify =
    config.notify.systemGrade !== null && gradeGte(grade, config.notify.systemGrade);
  broadcast({ type: "notification", grade, signal: summary, score, systemNotify, clickUrl });
}
