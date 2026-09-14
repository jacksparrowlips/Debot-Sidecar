/** Challenge detection is read-only; verification always belongs to the user. */
export function isChallengePage(title: string, body: string, challengeElement: boolean): boolean {
  return challengeElement || /just a moment|正在进行安全验证|请稍候|checking your browser/i.test(title) || /正在进行安全验证|验证您是真人|verify you are human|performing security verification/i.test(body);
}
export function mayReloadPage(state: { expired: boolean; active: boolean; discarded: boolean; healthAt: number; captureAt: number; attempted: boolean }, now: number, threshold: number): boolean {
  return !state.expired && state.active && !state.discarded && !state.attempted && state.healthAt > now - 60_000 && state.captureAt > 0 && now - state.captureAt > threshold;
}
