/**
 * Per-wallet, per-endpoint token-bucket rate limiter, plus a global daily ceiling
 * on paid LLM calls. Every endpoint a player can use to trigger an Anthropic
 * request — chat, verdict, pre-bet read — gets its own bucket: a small burst for
 * natural use, then a slow refill that throttles a spam loop down to a trickle.
 * The global counter is the backstop: even a Sybil swarm of fresh wallets can't
 * push total model calls past `globalDailyCap` in one UTC day.
 *
 * State is in-process — correct for a single instance (one Railway service). If
 * this ever scales horizontally, move the buckets + daily counter to shared
 * storage (e.g. Redis) so the limits hold across instances.
 */

import { fail } from "../domain/errors.ts";

export interface BucketSpec {
  /** Max tokens — the burst an idle wallet can spend back-to-back. */
  capacity: number;
  /** Milliseconds to refill one token. Sustained rate = 1 request / refillMs. */
  refillMs: number;
}

export type LlmEndpoint = "chat" | "verdict" | "preBetRead";

export interface RateLimitConfig {
  chat: BucketSpec;
  verdict: BucketSpec;
  preBetRead: BucketSpec;
  /** Hard ceiling on total paid LLM calls per UTC day across all wallets. */
  globalDailyCap: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>(); // key: `${endpoint}:${wallet}`
  private dayKey = "";
  private dayCount = 0;

  constructor(private readonly config: RateLimitConfig) {}

  /**
   * Charge one token for `wallet` on `endpoint`, to be called immediately before
   * the model request. Throws RATE_LIMITED (→ HTTP 429) when the wallet's bucket
   * is empty or the global daily cap is reached; the global budget is only
   * consumed when the request is actually allowed through.
   */
  charge(endpoint: LlmEndpoint, wallet: string, now: number = Date.now()): void {
    const spec = this.config[endpoint];
    const key = `${endpoint}:${wallet}`;
    const b = this.buckets.get(key) ?? { tokens: spec.capacity, lastRefillMs: now };
    // Continuous refill: add the tokens that have accrued since we last looked.
    const refilled = Math.min(spec.capacity, b.tokens + (now - b.lastRefillMs) / spec.refillMs);

    // Roll the global counter to a fresh UTC day before checking it.
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.dayCount = 0;
    }

    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, lastRefillMs: now }); // bank the partial refill
      const waitMs = Math.ceil((1 - refilled) * spec.refillMs);
      fail("RATE_LIMITED", `Easy — the Gaffer needs a breather. Try again in ${Math.ceil(waitMs / 1000)}s.`, {
        retryAfterMs: waitMs,
      });
    }
    if (this.dayCount >= this.config.globalDailyCap) {
      fail("RATE_LIMITED", "The Gaffer has taken all the calls he can today — back tomorrow.", { scope: "global" });
    }

    // Both gates passed → commit the spend.
    this.buckets.set(key, { tokens: refilled - 1, lastRefillMs: now });
    this.dayCount += 1;
  }
}
