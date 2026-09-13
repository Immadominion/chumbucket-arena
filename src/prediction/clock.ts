/** An injectable clock + sleeper, so every cache/backoff test is deterministic. */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** A hand-cranked clock. `advance()` also releases any sleeper that is now due. */
export class ManualClock implements Clock {
  private t: number;
  private waiters: { at: number; release: () => void }[] = [];

  constructor(start = 1_760_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ at: this.t + ms, release: resolve });
    });
  }

  advance(ms: number): void {
    this.t += ms;
    const due = this.waiters.filter((w) => w.at <= this.t);
    this.waiters = this.waiters.filter((w) => w.at > this.t);
    for (const w of due) w.release();
  }

  /** Release every pending sleeper without moving time (for retry tests). */
  drainSleepers(): void {
    const all = this.waiters;
    this.waiters = [];
    for (const w of all) w.release();
  }

  get pendingSleepers(): number {
    return this.waiters.length;
  }
}
