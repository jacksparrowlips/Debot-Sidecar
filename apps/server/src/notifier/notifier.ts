import { gradeGte } from "@debot/rules-engine";
import type { ScoreResult, Signal, SignalSummary } from "@debot/shared";
import { getCtx } from "../context.js";
import { insertNotification } from "../store/misc.js";

/**
 * 通知判定（SPEC §7.6）：v2 等级 >= cardGrade → 强通知（WebUI 大卡片）+ notifications 入库；
 * >= systemGrade（可配，null 关闭）→ 追加系统通知兜底（广播内标记，由扩展 chrome.notifications 与 WebUI Notification API 呈现）。
 */
export function maybeNotify(signal: Signal, summary: SignalSummary, score: ScoreResult): void {
  const { config, broadcast } = getCtx();
  const grade = score.grade;
  if (!gradeGte(grade, config.notify.cardGrade)) return;

  const clickUrl = summary.token_url;
  insertNotification(getCtx().db, { signal_id: summary.id, grade, click_url: clickUrl });
  const systemNotify =
    config.notify.systemGrade !== null && gradeGte(grade, config.notify.systemGrade);
  broadcast({ type: "notification", grade, signal: summary, score, systemNotify, clickUrl });
}
