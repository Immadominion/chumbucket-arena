/**
 * Per-person write limits: a sliding log of timestamps per (action, key),
 * checked against every window configured for that action.
 *
 * In-process on purpose, like `src/engine/RateLimiter.ts`: the calls BFF runs
 * as ONE Railway replica (the social store mirror already assumes that). If
 * it ever scales out, these counters move to shared storage with the mirror.
 *
 * A refused request does not consume budget, so a person who waits the time
 * the message names is let through.
 */

import { TrustError } from "./errors.ts";
import type { RateLimitedAction, RateLimits } from "./config.ts";

const COPY: Record<RateLimitedAction, string> = {
  "calls.create": "You're making calls very quickly.",
  "calls.respond": "You're responding to calls very quickly.",
  "people.follow": "You're following and unfollowing very quickly.",
  "trust.report": "You've sent a lot of reports in a short time.",
  "trust.relation": "You're blocking and muting very quickly.",
  "account.export": "You've exported your data several times already.",
  "deletion.request": "We've already received deletion requests for this contact.",
  "deletion.global": "We're receiving a lot of deletion requests right now.",
};

function wait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

export class WriteRateLimiter {
  private readonly log = new Map<string, number[]>();
  private readonly longest: Map<RateLimitedAction, number>;

  constructor(
    private readonly limits: RateLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.longest = new Map(
      (Object.keys(limits) as RateLimitedAction[]).map((a) => [a, Math.max(0, ...limits[a].map((w) => w.windowMs))]),
    );
  }

  /**
   * Charge one write for `key` (a canonical user id, or a contact for the web
   * form). Throws TRUST_RATE_LIMITED with the wait in words when any window
   * is full.
   */
  charge(action: RateLimitedAction, key: string): void {
    const windows = this.limits[action];
    if (!windows?.length) return;
    const now = this.now();
    const id = `${action}\u0000${key}`;
    const horizon = now - (this.longest.get(action) ?? 0);
    const times = (this.log.get(id) ?? []).filter((t) => t > horizon);

    let retryAfterMs = 0;
    for (const w of windows) {
      const inWindow = times.filter((t) => t > now - w.windowMs);
      if (inWindow.length >= w.limit) {
        const oldest = inWindow[inWindow.length - w.limit] ?? now;
        retryAfterMs = Math.max(retryAfterMs, oldest + w.windowMs - now);
      }
    }
    if (retryAfterMs > 0) {
      this.log.set(id, times);
      throw new TrustError("TRUST_RATE_LIMITED", `${COPY[action]} Try again in ${wait(retryAfterMs)}.`, {
        action,
        retryAfterMs,
      });
    }
    times.push(now);
    this.log.set(id, times);
    if (this.log.size > 50_000) this.sweep(now);
  }

  /** Drop keys with nothing left in any window, so memory stays bounded. */
  private sweep(now: number): void {
    for (const [id, times] of this.log) {
      const action = id.slice(0, id.indexOf("\u0000")) as RateLimitedAction;
      const horizon = now - (this.longest.get(action) ?? 0);
      if (!times.some((t) => t > horizon)) this.log.delete(id);
    }
  }
}
