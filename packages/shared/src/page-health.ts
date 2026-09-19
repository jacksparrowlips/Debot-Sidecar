/** Challenge detection is read-only; verification always belongs to the user. */
export function isChallengePage(title: string, body: string, challengeElement: boolean): boolean {
  return challengeElement || /just a moment|正在进行安全验证|请稍候|checking your browser/i.test(title) || /正在进行安全验证|验证您是真人|verify you are human|performing security verification/i.test(body);
}
/**
 * L1 自动刷新判定（SPEC §7.8）：只看「信号源捕获」静默，不看任意捕获。
 * live-market WS 帧与全站杂项轮询（noticeV2 等）会永远刷新 captureAt，
 * 把它们计入会掩盖信号页停更（2026-09-19 实测：rank 静默 16 分钟，L1/告警均未触发）。
 * 仅当 tab 仍停在当初捕获信号的 URL（页面轮询挂死）时 reload；
 * 用户已导航离开信号页（url ≠ signalUrl）则不打断，交由服务端 L3 告警提醒。
 */
export function mayReloadPage(state: { expired: boolean; active: boolean; discarded: boolean; healthAt: number; signalAt: number; attempted: boolean; url: string; signalUrl: string | null }, now: number, threshold: number): boolean {
  return !state.expired && state.active && !state.discarded && !state.attempted && state.healthAt > now - 60_000 && state.signalAt > 0 && now - state.signalAt > threshold && state.signalUrl !== null && state.url === state.signalUrl;
}
