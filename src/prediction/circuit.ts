/**
 * Circuit breaker (contracts §4). Stops hammering a venue that is already down,
 * and — just as important — stops a schema change from being retried thousands
 * of times while every one of those attempts refuses to write anything.
 *
 * CLOSED --(failureThreshold consecutive faults)--> OPEN
 * OPEN   --(resetAfterMs elapsed)--------------->  HALF_OPEN
 * HALF_OPEN --(a success)---------------------->  CLOSED
 * HALF_OPEN --(a fault)------------------------>  OPEN (timer restarts)
 */

import { systemClock, type Clock } from "./clock.ts";
import { VenueError, isVenueError } from "./errors.ts";
import type { VenueId } from "./types.ts";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitOptions {
  failureThreshold: number;
  resetAfterMs: number;
  /** Trial calls allowed while HALF_OPEN. */
  halfOpenMaxCalls: number;
  clock?: Clock;
  venue?: VenueId;
  name?: string;
}

export const DEFAULT_CIRCUIT: Omit<CircuitOptions, "clock" | "venue" | "name"> = {
  failureThreshold: 5,
  resetAfterMs: 30_000,
  halfOpenMaxCalls: 1,
};

export class CircuitBreaker {
  private s: CircuitState = "CLOSED";
  private consecutiveFaults = 0;
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private readonly clock: Clock;
  readonly name: string;
  readonly venue: VenueId | undefined;
  readonly opts: Omit<CircuitOptions, "clock" | "venue" | "name">;
  /** Observability: how many times the breaker has tripped this process. */
  trips = 0;

  constructor(opts: Partial<CircuitOptions> = {}) {
    this.clock = opts.clock ?? systemClock;
    this.name = opts.name ?? "venue";
    this.venue = opts.venue;
    this.opts = {
      failureThreshold: opts.failureThreshold ?? DEFAULT_CIRCUIT.failureThreshold,
      resetAfterMs: opts.resetAfterMs ?? DEFAULT_CIRCUIT.resetAfterMs,
      halfOpenMaxCalls: opts.halfOpenMaxCalls ?? DEFAULT_CIRCUIT.halfOpenMaxCalls,
    };
  }

  /** Current state, after applying any due OPEN → HALF_OPEN transition. */
  get state(): CircuitState {
    if (this.s === "OPEN" && this.clock.now() - this.openedAt >= this.opts.resetAfterMs) {
      this.s = "HALF_OPEN";
      this.halfOpenInFlight = 0;
    }
    return this.s;
  }

  get failures(): number {
    return this.consecutiveFaults;
  }

  /** Milliseconds until the breaker will next admit a trial call. */
  retryAfterMs(): number {
    if (this.state !== "OPEN") return 0;
    return Math.max(0, this.opts.resetAfterMs - (this.clock.now() - this.openedAt));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === "OPEN") {
      throw new VenueError("CIRCUIT_OPEN", `${this.name}: circuit is open — not calling the venue`, {
        ...(this.venue ? { venue: this.venue } : {}),
        details: { state, failures: this.consecutiveFaults },
        retryAfterMs: this.retryAfterMs(),
      });
    }
    if (state === "HALF_OPEN" && this.halfOpenInFlight >= this.opts.halfOpenMaxCalls) {
      throw new VenueError("CIRCUIT_OPEN", `${this.name}: circuit is half-open and already probing`, {
        ...(this.venue ? { venue: this.venue } : {}),
        details: { state, failures: this.consecutiveFaults },
        retryAfterMs: this.retryAfterMs(),
      });
    }
    if (state === "HALF_OPEN") this.halfOpenInFlight++;

    try {
      const out = await fn();
      this.onSuccess();
      return out;
    } catch (err) {
      this.onError(err);
      throw err;
    } finally {
      if (state === "HALF_OPEN" && this.halfOpenInFlight > 0) this.halfOpenInFlight--;
    }
  }

  private onSuccess(): void {
    this.consecutiveFaults = 0;
    this.s = "CLOSED";
    this.halfOpenInFlight = 0;
  }

  private onError(err: unknown): void {
    // A 404 or our own bad request says nothing about the venue's health.
    if (isVenueError(err) && !err.countsAsCircuitFault) return;
    this.consecutiveFaults++;
    if (this.s === "HALF_OPEN" || this.consecutiveFaults >= this.opts.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    if (this.s !== "OPEN") this.trips++;
    this.s = "OPEN";
    this.openedAt = this.clock.now();
  }

  /** Test/ops escape hatch. */
  reset(): void {
    this.s = "CLOSED";
    this.consecutiveFaults = 0;
    this.halfOpenInFlight = 0;
  }
}
