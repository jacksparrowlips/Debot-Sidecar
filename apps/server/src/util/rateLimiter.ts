/** 串行队列 + 最小间隔（遵守上游 rate limit，SPEC §12#5） */
export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.chain.then(async () => {
      const wait = this.lastAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      return fn();
    });
    this.chain = job.catch(() => {});
    return job;
  }
}
