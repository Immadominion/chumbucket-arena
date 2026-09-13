/**
 * Exponential backoff with full jitter (contracts §4).
 *
 * Only genuinely transient faults are retried. A VENUE_SCHEMA error is retried
 * ZERO times — replaying a parse failure cannot make the payload parse, and the
 * point of failing loudly is to be seen, not to be smeared across 5 attempts.
 */

import { systemClock, type Clock } from "./clock.ts";
import { isVenueError } from "./errors.ts";

export interface RetryOptions {
  attempts: number; // total attempts, including the first
  baseDelayMs: number;
  maxDelayMs: number;
  clock?: Clock;
  /** [0,1). Injected in tests to make delays exact. */
  random?: () => number;
  /** Observability hook. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export const DEFAULT_RETRY: Omit<RetryOptions, "clock" | "random" | "onRetry"> = {
  attempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

/** Uncapped exponential step, then clamp: base * 2^(attempt-1), capped at max. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, exp);
}

const isRetryable = (e: unknown): boolean => isVenueError(e) && e.retryable;

export async function retry<T>(fn: () => Promise<T>, opts: Partial<RetryOptions> = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_RETRY.attempts;
  const base = opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const max = opts.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      const ceiling = backoffDelay(attempt, base, max);
      // Full jitter, but never shorter than an upstream Retry-After.
      const jittered = Math.floor(random() * ceiling);
      const retryAfter = isVenueError(err) ? (err.retryAfterMs ?? 0) : 0;
      const delayMs = Math.max(jittered, retryAfter);
      opts.onRetry?.({ attempt, delayMs, error: err });
      await clock.sleep(delayMs);
    }
  }
  throw lastError;
}
