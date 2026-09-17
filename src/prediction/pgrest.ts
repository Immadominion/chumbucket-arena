/**
 * PostgREST plumbing + a serial write queue, shared by the two Supabase-backed
 * stores in this repo (`src/prediction/supabaseStore.ts`,
 * `src/calls/supabaseStore.ts`).
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * `src/social/SocialStore.ts` already carries ~35 lines of dependency-free
 * PostgREST plumbing (`rpc()` / `getRows()` / `headers()` / `decode()`) with an
 * injectable `fetchImpl`. That pattern is COPIED here rather than imported:
 * `src/social/**` is owned by the integration/arena side (contracts §6), and a
 * store for the pivot tables must not reach into it or edit it. The shape below
 * is deliberately recognisable as the same thing.
 *
 * WHAT IT ADDS OVER THAT PATTERN
 *
 *  1. TABLE WRITES, not just RPC. The pivot tables (§5) are default-deny with
 *     NO write policy for anon/authenticated and `GRANT ALL ... TO service_role`;
 *     there is no RPC to call, so the BFF writes rows directly as the service
 *     role. Upsert = `Prefer: resolution=merge-duplicates` + `?on_conflict=`.
 *  2. A TYPED ERROR that keeps the Postgres SQLSTATE. Every trigger in the
 *     pivot migrations raises `ERRCODE = 'raise_exception'` (SQLSTATE P0001),
 *     and every CHECK violation is 23514. Keeping the code is what lets a
 *     caller tell "the database refused this on principle" apart from "the
 *     network blinked".
 *  3. REDACTION ON EVERY PATH. The service-role key is registered with
 *     `src/prediction/redact.ts` at construction, and every error message and
 *     detail is scrubbed on the way out. §4's rule for the venue API key is the
 *     same rule for this key, and it is stronger here: this key bypasses RLS.
 *     The key is NEVER placed in a URL or a query parameter — only in the
 *     `apikey`/`Authorization` headers — so it cannot leak through a logged URL.
 *  4. A SERIAL WRITE QUEUE. `CallsStore` and `PredictionStore` are SYNCHRONOUS
 *     interfaces (see the note at the top of `supabaseStore.ts`), so a durable
 *     implementation has to apply the row to an in-process mirror and write
 *     Postgres behind it. The queue is strictly FIFO and SHARED between the two
 *     stores, because the pivot schema has real foreign keys across them:
 *     `calls.market_id -> venue_markets.id` and
 *     `calls.snapshot_id -> market_snapshots.id`. Two independent queues could
 *     write a call before the market it references and the FK would reject it.
 */

import { createHash } from "node:crypto";
import { systemClock, type Clock } from "./clock.ts";
import { redactDeep, redactSecrets, registerSecret } from "./redact.ts";

export interface PgrestConfig {
  supabaseUrl: string;
  /** Service-role key. Registered for redaction; never logged, never in a URL. */
  serviceRoleKey: string;
}

/** The subset of `fetch` these stores use. Injected by every test. */
export type FetchImpl = typeof fetch;

export interface PgrestErrorInit {
  status?: number;
  /** Postgres SQLSTATE, when PostgREST reported one. */
  sqlState?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * A PostgREST failure. `sqlState` is the Postgres SQLSTATE when there was one:
 *
 *   P0001 — `RAISE EXCEPTION` from one of the pivot triggers (immutability,
 *           append-only, the FILLED transition guard, the result derivation).
 *   23514 — CHECK violation (venue allowlist, evidence-required, FILLED shape).
 *   23505 — unique violation (one live call per user per market, one original
 *           resolution per market, one order per idempotency key).
 *   23503 — foreign-key violation (a call whose market is not persisted yet).
 *   22P02 — invalid input syntax (e.g. a non-UUID id offered to a UUID column).
 */
export class PgrestError extends Error {
  readonly status: number | undefined;
  readonly sqlState: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, init: PgrestErrorInit = {}) {
    super(redactSecrets(message));
    this.name = "PgrestError";
    this.status = init.status;
    this.sqlState = init.sqlState;
    this.details = init.details ? redactDeep(init.details) : undefined;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  /** True when the database refused the row on principle: retrying cannot help. */
  get refusedByDatabase(): boolean {
    if (this.sqlState && /^(P0001|23514|23503|23514|22P02|23502)$/.test(this.sqlState)) return true;
    return this.status !== undefined && this.status >= 400 && this.status < 500 && this.status !== 429;
  }

  /** A unique violation, which for every pivot table means "already written". */
  get duplicate(): boolean {
    return this.sqlState === "23505" || this.status === 409;
  }
}

export const isPgrestError = (e: unknown): e is PgrestError => e instanceof PgrestError;

export interface UpsertOptions {
  /** Columns of the unique index to merge on, e.g. "venue,venue_market_id". */
  onConflict?: string;
  /** `true` -> `resolution=ignore-duplicates`; otherwise merge-duplicates. */
  ignoreDuplicates?: boolean;
  /** Ask for the written rows back. Default: minimal (nothing). */
  returning?: boolean;
}

/**
 * One PostgREST client, acting as the service role. Structure and method
 * shapes copied from `SocialStore`'s `rpc`/`getRows`/`headers`/`decode`.
 */
export class Pgrest {
  private readonly restBase: string;

  constructor(
    private readonly cfg: PgrestConfig,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {
    this.restBase = `${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
    // Registered the moment it is held, so it can never escape through an
    // error, a log line or a response body — the §4 rule for the venue key,
    // applied to the key that bypasses RLS.
    registerSecret(cfg.serviceRoleKey);
  }

  async select<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const res = await this.fetchImpl(`${this.restBase}/${table}?${params.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
    return (await this.decode<T[]>(res, `select ${table}`)) ?? [];
  }

  async insert<T = unknown>(table: string, rows: unknown[], opts: UpsertOptions = {}): Promise<T[]> {
    if (rows.length === 0) return [];
    const qs = opts.onConflict ? `?on_conflict=${encodeURIComponent(opts.onConflict)}` : "";
    const prefer = [
      opts.returning ? "return=representation" : "return=minimal",
      ...(opts.onConflict || opts.ignoreDuplicates
        ? [opts.ignoreDuplicates ? "resolution=ignore-duplicates" : "resolution=merge-duplicates"]
        : []),
    ].join(",");
    const res = await this.fetchImpl(`${this.restBase}/${table}${qs}`, {
      method: "POST",
      headers: this.headers({ prefer }),
      body: JSON.stringify(rows),
    });
    return (await this.decode<T[]>(res, `insert ${table}`)) ?? [];
  }

  async patch<T = unknown>(
    table: string,
    params: URLSearchParams,
    body: Record<string, unknown>,
    opts: { returning?: boolean } = {},
  ): Promise<T[]> {
    const res = await this.fetchImpl(`${this.restBase}/${table}?${params.toString()}`, {
      method: "PATCH",
      headers: this.headers({ prefer: opts.returning ? "return=representation" : "return=minimal" }),
      body: JSON.stringify(body),
    });
    return (await this.decode<T[]>(res, `patch ${table}`)) ?? [];
  }

  async remove(table: string, params: URLSearchParams): Promise<void> {
    const res = await this.fetchImpl(`${this.restBase}/${table}?${params.toString()}`, {
      method: "DELETE",
      headers: this.headers({ prefer: "return=minimal" }),
    });
    await this.decode<unknown>(res, `delete ${table}`);
  }

  async rpc<T>(name: string, body: Record<string, unknown>): Promise<T | undefined> {
    const res = await this.fetchImpl(`${this.restBase}/rpc/${name}`, {
      method: "POST",
      headers: this.headers({ prefer: "return=representation" }),
      body: JSON.stringify(body),
    });
    return this.decode<T>(res, `rpc/${name}`);
  }

  /** The key travels in headers only — never in a URL, a query string or a body. */
  private headers(extra?: { prefer?: string }): Record<string, string> {
    return {
      apikey: this.cfg.serviceRoleKey,
      Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(extra?.prefer ? { Prefer: extra.prefer } : {}),
    };
  }

  private async decode<T>(res: Response, label: string): Promise<T | undefined> {
    const text = await res.text();
    if (!res.ok) {
      const parsed = parseErrorBody(text);
      throw new PgrestError(
        `[pgrest] ${label} HTTP ${res.status}${parsed.code ? ` (${parsed.code})` : ""}: ${parsed.message}`,
        {
          status: res.status,
          ...(parsed.code ? { sqlState: parsed.code } : {}),
          details: { label, ...(parsed.detail ? { detail: parsed.detail } : {}) },
        },
      );
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new PgrestError(`[pgrest] ${label}: response was not JSON`, { cause: err, details: { label } });
    }
  }
}

/** PostgREST error bodies are `{message, details, hint, code}`. Be tolerant. */
function parseErrorBody(text: string): { message: string; code?: string; detail?: string } {
  if (!text) return { message: "(empty body)" };
  try {
    const body = JSON.parse(text) as { message?: unknown; code?: unknown; details?: unknown };
    const out: { message: string; code?: string; detail?: string } = {
      message: typeof body.message === "string" ? body.message : text,
    };
    if (typeof body.code === "string") out.code = body.code;
    if (typeof body.details === "string") out.detail = body.details;
    return out;
  } catch {
    return { message: text };
  }
}

// ── the serial write queue ───────────────────────────────────────────────────

export interface WriteFailure {
  /** What was being written, e.g. `insert calls/<id>`. Never carries a secret. */
  label: string;
  at: number;
  message: string;
  /** True when Postgres refused the row on principle rather than transiently. */
  refused: boolean;
  sqlState: string | undefined;
}

export interface WriteQueueOptions {
  clock?: Clock;
  /** Called once per failure. Default: a redacted single-line console.error. */
  onFailure?: (f: WriteFailure) => void;
  /** Ring-buffer bound on remembered failures. */
  maxFailures?: number;
}

/**
 * A strictly FIFO write queue. One instance is shared by both Supabase stores
 * for one app, so the cross-table foreign keys in the pivot schema
 * (`calls.market_id`, `calls.snapshot_id`, `call_results.market_resolution_id`)
 * are always written parent-first.
 *
 * A failure NEVER silently disappears: it is recorded, counted, surfaced
 * through `failures`, reported by `onFailure`, and re-raised by the owning
 * store's `flush()`. Nothing here retries a row the database refused on
 * principle — the brief is to fix the write, not to hammer the constraint.
 */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;
  private accepted = 0;
  private completed = 0;
  private readonly fails: WriteFailure[] = [];
  private readonly clock: Clock;
  private readonly maxFailures: number;
  private readonly onFailure: (f: WriteFailure) => void;

  constructor(opts: WriteQueueOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.maxFailures = opts.maxFailures ?? 200;
    this.onFailure =
      opts.onFailure ??
      ((f) => {
        // One line, already redacted by PgrestError's constructor.
        console.error(`[persist] ${f.label} FAILED (${f.refused ? "refused" : "transient"}): ${f.message}`);
      });
  }

  /** Enqueue a write. Returns immediately; ordering is guaranteed. */
  push(label: string, fn: () => Promise<void>): void {
    this.depth++;
    this.accepted++;
    this.tail = this.tail.then(async () => {
      try {
        await fn();
      } catch (err) {
        this.record(label, err);
      } finally {
        this.depth--;
        this.completed++;
      }
    });
  }

  get pending(): number {
    return this.depth;
  }

  get acceptedWrites(): number {
    return this.accepted;
  }

  get completedWrites(): number {
    return this.completed;
  }

  get failures(): readonly WriteFailure[] {
    return this.fails;
  }

  /**
   * Forget the recorded failures. ONLY a successful re-hydration may call this:
   * re-reading Postgres is what removes the divergence the failures recorded,
   * so clearing them at any other moment would be hiding a real disagreement.
   */
  clearFailures(): void {
    this.fails.length = 0;
  }

  /** Wait for everything queued so far, including writes queued BY those writes. */
  async drain(): Promise<void> {
    // A job may enqueue another job (a lookup followed by an insert), which
    // replaces `tail`. Loop until the depth actually reaches zero.
    for (let guard = 0; guard < 10_000; guard++) {
      const settling = this.tail;
      await settling;
      if (this.depth === 0 && settling === this.tail) return;
    }
    throw new Error("[persist] write queue did not drain: a write is enqueueing writes without end");
  }

  private record(label: string, err: unknown): void {
    const pg = isPgrestError(err) ? err : null;
    const failure: WriteFailure = {
      label,
      at: this.clock.now(),
      message: redactSecrets(err instanceof Error ? err.message : String(err)),
      refused: pg ? pg.refusedByDatabase : false,
      sqlState: pg?.sqlState,
    };
    this.fails.push(failure);
    if (this.fails.length > this.maxFailures) this.fails.splice(0, this.fails.length - this.maxFailures);
    this.onFailure(failure);
  }
}

/** The aggregate error a store's `flush()` raises when writes were refused. */
export function writeFailureError(failures: readonly WriteFailure[]): Error {
  const lines = failures.map((f) => ` - ${f.label}${f.sqlState ? ` [${f.sqlState}]` : ""}: ${f.message}`);
  return new Error(
    `[persist] ${failures.length} durable write(s) failed and the mirror is now ahead of Postgres. ` +
      `Restarting re-hydrates from Postgres, which is the repair.\n${lines.join("\n")}`,
  );
}

// ── timestamps and numbers on the wire ───────────────────────────────────────
//
// Every timestamp in the frozen vocabulary (§3) is unix MILLISECONDS, integer,
// UTC. Every timestamp in the schema is TIMESTAMPTZ. These are the only two
// places that conversion happens.

/** unix ms -> an ISO-8601 instant PostgREST will store in a TIMESTAMPTZ. */
export const toTimestamptz = (ms: number): string => new Date(ms).toISOString();

export const toTimestamptzOrNull = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : toTimestamptz(ms);

/** TIMESTAMPTZ -> unix ms. Throws rather than guessing on an unparseable value. */
export function fromTimestamptz(v: unknown, what: string): number {
  const ms = parseTimestamptz(v);
  if (ms === null) throw new PgrestError(`[pgrest] ${what}: unparseable timestamp`, { details: { what } });
  return ms;
}

export function parseTimestamptz(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * PostgREST renders `numeric` as a JSON number, but a cast in `select`
 * (`col::text`) renders it as a string. Accept both and never coerce a
 * non-number into 0.
 */
export function parseNumeric(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Money is integer base units as a decimal string, never a float (§3). */
export function parseBaseUnits(v: unknown, fallback = "0"): string {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return v;
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  if (typeof v === "string") {
    // NUMERIC(38,0) selected without a ::text cast can arrive as "1500000.0".
    const m = /^(-?\d+)(?:\.0+)?$/.exec(v);
    if (m?.[1]) return m[1];
  }
  return fallback;
}

// ── deterministic ids ────────────────────────────────────────────────────────
//
// Both stores need UUIDs that are a FUNCTION of the thing being stored, so that
// re-running a sync hits the same row instead of creating a second one. This is
// the same construction `marketUuid()` in ./types.ts uses (UUIDv5 over a name),
// re-implemented here rather than by editing that frozen file.

const PIVOT_NAMESPACE = "3f1b2c5a-9d44-4c7e-8a10-6b2f0d8e41c9";

export function uuidV5(name: string, namespace: string = PIVOT_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deliberately a plain boolean, not a `v is string` guard: narrowing a
 *  `string` argument down to `never` in the else branch helps nobody. */
export const isUuid = (v: unknown): boolean => typeof v === "string" && UUID_RE.test(v);

/**
 * The UUID for one `market_snapshots` row.
 *
 * It is derived from EXACTLY the three columns the table's
 * `UNIQUE (market_id, observed_at, source)` index is built on, and from exactly
 * the three fields `CallsService.snapshotIdOf()` builds its own opaque
 * `snap:<market>:<observedAt>:<source>` handle from. That is what lets
 * `SupabaseCallsStore` turn a call's in-memory `snapshotId` into the real
 * `market_snapshots.id` its `calls.snapshot_id` FK needs, with no lookup and no
 * change to `CallsService`.
 */
export const snapshotUuid = (marketId: string, observedAt: number, source: string): string =>
  uuidV5(`snapshot:${marketId}:${observedAt}:${source}`);

/** The inverse of `CallsService.snapshotIdOf()`, for the FK translation above. */
export function snapshotUuidFromHandle(handle: string): string | null {
  if (isUuid(handle)) return handle;
  // `snap:<marketId>:<observedAt>:<source>` — marketId is a UUID (no colons).
  const parts = handle.split(":");
  if (parts.length !== 4 || parts[0] !== "snap") return null;
  const [, marketId, observedAt, source] = parts;
  if (!marketId || !observedAt || !source) return null;
  const at = Number(observedAt);
  if (!Number.isFinite(at)) return null;
  return snapshotUuid(marketId, at, source);
}
