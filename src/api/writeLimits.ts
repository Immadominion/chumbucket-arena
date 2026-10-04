/**
 * Write rate limits for every mutation the BFF serves (B2).
 *
 * Three token buckets, each a burst then a steady refill:
 *
 *   ip       per client address. Generous, because a mobile carrier puts many
 *            people behind one address.
 *   session  per bearer credential (sha-256 of the token, never the token).
 *            Only the holder of a session can spend its bucket, so nobody can
 *            lock someone else out by naming them.
 *   user     per canonical person, charged by routes that have already
 *            resolved one from a verified session (see `chargeUser`).
 *
 * In-process, like the rest of this single-replica service (prod readiness
 * m6). Key count is bounded; the oldest keys are dropped first.
 *
 * Mutations that read rather than write (the token-in-body lookups) are
 * exempt — they are mutations only so a credential never sits in a URL.
 */

import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import type { AppConfig } from "../config.ts";

export interface BucketSpec {
  capacity: number;
  /** ms to refill one token */
  refillMs: number;
}

export interface WriteLimitConfig {
  ip: BucketSpec;
  session: BucketSpec;
  user: BucketSpec;
  maxKeys: number;
}

export type WriteScope = "ip" | "session" | "user";

/**
 * Mutations that change nothing a person asked for: reads, and the status
 * re-checks the app polls while something settles (they may advance a
 * ledger row to what the venue or chain already proves, as
 * pantaTrading.order does). Polling them must never spend the budget real
 * writes need. deposits.quote stays charged: each one is a call to Crossmint
 * the person triggers by typing, and the budget is its throttle.
 */
export const READ_ONLY_MUTATIONS: ReadonlySet<string> = new Set([
  "auth.whoami",
  // Settings → Sign-in methods: the list, and what a link would do
  "auth.signInMethods",
  "auth.previewSignInLink",
  // add a friend: "is this them?" — a lookup, with its own per-person limit
  // (src/trust/config.ts "people.find")
  "people.find",
  "pantaTrading.status",
  "pantaTrading.order",
  "pantaTrading.forCall",
  // money: positions, an own call's latest order, a win claim's status
  "pantaTrading.positions",
  "pantaTrading.callOrder",
  "pantaTrading.claim",
  // deposits: availability, a wallet's balance, one order's live status
  "deposits.status",
  "deposits.balance",
  "deposits.order",
  // create-market: re-check a publishing market against Panta and the chain
  "marketCreation.refreshPublish",
  // wallets: whether the SOL top-up is on, and what a wallet would need.
  // solTopUp.order stays charged (each is a Jupiter quote); execute is a write.
  "solTopUp.status",
  "solTopUp.plan",
]);

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Per-minute rates from env, with defaults sized for a person on a phone. */
export function resolveWriteLimitConfig(env: Record<string, string | undefined> = process.env): WriteLimitConfig {
  const perMinute = (burst: number, rate: number): BucketSpec => ({ capacity: burst, refillMs: 60_000 / rate });
  return {
    ip: perMinute(num(env.WRITE_LIMIT_IP_BURST, 240), num(env.WRITE_LIMIT_IP_PER_MIN, 240)),
    session: perMinute(num(env.WRITE_LIMIT_SESSION_BURST, 40), num(env.WRITE_LIMIT_SESSION_PER_MIN, 40)),
    user: perMinute(num(env.WRITE_LIMIT_USER_BURST, 30), num(env.WRITE_LIMIT_USER_PER_MIN, 30)),
    maxKeys: num(env.WRITE_LIMIT_MAX_KEYS, 50_000),
  };
}

interface Bucket {
  tokens: number;
  at: number;
}

export class WriteLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: WriteLimitConfig) {}

  /** Spend one token. Returns the wait in ms when the bucket is empty. */
  take(scope: WriteScope, key: string, now: number = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const spec = this.config[scope];
    const id = `${scope}:${key}`;
    const prior = this.buckets.get(id);
    const tokens = prior ? Math.min(spec.capacity, prior.tokens + (now - prior.at) / spec.refillMs) : spec.capacity;
    // Re-insert so Map order is least-recently-used first.
    this.buckets.delete(id);
    if (tokens < 1) {
      this.buckets.set(id, { tokens, at: now });
      return { ok: false, retryAfterMs: Math.ceil((1 - tokens) * spec.refillMs) };
    }
    this.buckets.set(id, { tokens: tokens - 1, at: now });
    while (this.buckets.size > this.config.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return { ok: true };
  }

  get size(): number {
    return this.buckets.size;
  }
}

export const sessionKey = (credential: string): string =>
  createHash("sha256").update(credential).digest("hex").slice(0, 32);

export function tooMany(retryAfterMs: number): TRPCError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: `That's a lot of changes at once. Try again in ${seconds}s.`,
  });
}

let LIMITERS = new WeakMap<AppConfig, WriteLimiter>();

export function writeLimiterFor(config: AppConfig): WriteLimiter {
  let l = LIMITERS.get(config);
  if (!l) {
    l = new WriteLimiter(resolveWriteLimitConfig());
    LIMITERS.set(config, l);
  }
  return l;
}

/** Test seam. */
export function setWriteLimiter(config: AppConfig, limiter: WriteLimiter): void {
  LIMITERS.set(config, limiter);
}

export function resetWriteLimiters(): void {
  LIMITERS = new WeakMap<AppConfig, WriteLimiter>();
}

/** Charge a resolved canonical person's bucket, or throw TOO_MANY_REQUESTS. */
export function chargeUser(config: AppConfig, userId: string): void {
  const r = writeLimiterFor(config).take("user", userId);
  if (!r.ok) throw tooMany(r.retryAfterMs);
}

/** The per-request charge every mutation pays: its address and its session. */
export function chargeRequest(
  config: AppConfig,
  path: string,
  ctx: { clientIp?: string; supabaseAccessToken?: string; legacyCredential?: string },
): void {
  if (READ_ONLY_MUTATIONS.has(path)) return;
  const limiter = writeLimiterFor(config);
  if (ctx.clientIp) {
    const r = limiter.take("ip", ctx.clientIp);
    if (!r.ok) throw tooMany(r.retryAfterMs);
  }
  const credential = ctx.supabaseAccessToken ?? ctx.legacyCredential;
  if (credential) {
    const r = limiter.take("session", sessionKey(credential));
    if (!r.ok) throw tooMany(r.retryAfterMs);
  }
}
