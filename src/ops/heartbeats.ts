/**
 * Worker heartbeats — the evidence `/ready` reads.
 *
 * Each background loop (market/result sync, the engine tick, the on-chain
 * keeper, the reconciler) registers once with the interval it is meant to run
 * at, then reports every run. `/ready` turns that into "is this loop alive and
 * succeeding", without the loop having to know anything about HTTP.
 *
 * Only fixed failure codes are kept, never an error message or a provider
 * response body: this state is served publicly.
 */

export interface HeartbeatSpec {
  /** How often the loop is scheduled. */
  intervalMs: number;
  /** Whether `/ready` should fail when this loop goes stale. */
  required: boolean;
}

export interface HeartbeatState extends HeartbeatSpec {
  name: string;
  registeredAt: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** A fixed code such as "DURABILITY_OR_WORKER_FAILURE"; never a message. */
  lastFailureCode: string | null;
  consecutiveFailures: number;
}

export type HeartbeatStatus = "ok" | "starting" | "stale" | "failing";

export interface HeartbeatReport {
  name: string;
  required: boolean;
  status: HeartbeatStatus;
  intervalMs: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
  consecutiveFailures: number;
}

/** A loop is stale after missing this many scheduled successes. */
export const STALE_AFTER_INTERVALS = 3;
/** ...and failing after this many failures in a row. */
export const FAILING_AFTER_FAILURES = 3;

const CODE = /^[A-Z0-9_]{1,64}$/;

export class Heartbeats {
  private readonly loops = new Map<string, HeartbeatState>();

  constructor(private readonly now: () => number = Date.now) {}

  register(name: string, spec: HeartbeatSpec): void {
    if (this.loops.has(name)) return;
    this.loops.set(name, {
      name,
      ...spec,
      registeredAt: this.now(),
      lastRunAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      consecutiveFailures: 0,
    });
  }

  success(name: string): void {
    const s = this.loops.get(name);
    if (!s) return;
    const t = this.now();
    s.lastRunAt = t;
    s.lastSuccessAt = t;
    s.consecutiveFailures = 0;
  }

  failure(name: string, code: string): void {
    const s = this.loops.get(name);
    if (!s) return;
    const t = this.now();
    s.lastRunAt = t;
    s.lastFailureAt = t;
    s.lastFailureCode = CODE.test(code) ? code : "UNCLASSIFIED";
    s.consecutiveFailures += 1;
  }

  /** Wraps one run of a loop: a resolved run is a success, a throw a failure. */
  async run<T>(name: string, fn: () => Promise<T>, failureCode: (err: unknown) => string): Promise<T> {
    try {
      const out = await fn();
      this.success(name);
      return out;
    } catch (err) {
      this.failure(name, failureCode(err));
      throw err;
    }
  }

  report(): HeartbeatReport[] {
    const t = this.now();
    return [...this.loops.values()].map((s) => ({
      name: s.name,
      required: s.required,
      status: statusOf(s, t),
      intervalMs: s.intervalMs,
      lastRunAt: s.lastRunAt,
      lastSuccessAt: s.lastSuccessAt,
      lastFailureAt: s.lastFailureAt,
      lastFailureCode: s.lastFailureCode,
      consecutiveFailures: s.consecutiveFailures,
    }));
  }
}

function statusOf(s: HeartbeatState, now: number): HeartbeatStatus {
  const window = s.intervalMs * STALE_AFTER_INTERVALS;
  if (s.consecutiveFailures >= FAILING_AFTER_FAILURES) return "failing";
  if (s.lastSuccessAt === null) {
    return now - s.registeredAt <= window ? "starting" : "stale";
  }
  return now - s.lastSuccessAt <= window ? "ok" : "stale";
}

/** The process-wide registry used by src/index.ts and /ready. */
export const heartbeats = new Heartbeats();
