/**
 * A fake PostgREST + Postgres for the persistence tests.
 *
 * WHY IT ENFORCES CONSTRAINTS INSTEAD OF JUST RECORDING CALLS
 *
 * The production database will refuse a badly-shaped row, and the whole point
 * of the stores under test is that their writes satisfy those refusals rather
 * than working around them. A mock that accepts everything would prove nothing:
 * it would pass just as happily for a store that sent `venue: 'polymarket'`, a
 * non-UUID `calls.id`, a call on a resolved market, or a `call_results` row
 * whose outcome disagreed with §3.
 *
 * So this file transcribes the constraints that the six pivot migrations
 * actually apply, with the same names, and raises the same SQLSTATEs:
 *
 *   venue_markets_venue_check / market_resolutions_venue_check /
 *   venue_orders_venue_check / venue_positions_venue_check        23514
 *   venue_markets_live_rows_keep_raw                              23514
 *   market_resolutions_requires_evidence                          23514
 *   uq_market_resolutions_original                                23505
 *   trg_market_resolutions_append_only                            P0001
 *   trg_calls_guard_insert (market exists / OPEN / unclosed /
 *     unresolved / not born hidden / parent on the same market)   P0001
 *   trg_calls_guard_immutability (UPDATE + DELETE)                P0001
 *   uq_calls_one_live_per_user_market                             23505
 *   trg_call_responses_guard (append-only)                        P0001
 *   trg_call_results_guard_derivation                             P0001
 *   venue_orders_filled_requires_evidence +
 *     trg_venue_orders_guard_funding_state                        23514 / P0001
 *   UUID column typing                                            22P02
 *   foreign keys (calls.market_id, calls.snapshot_id,
 *     call_results.market_resolution_id)                          23503
 *
 * NOTHING HERE TOUCHES A NETWORK OR A REAL DATABASE. It is a plain object graph
 * behind a `fetch`-shaped function, injected into the stores under test.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Row = Record<string, unknown>;

interface TableSpec {
  /** Columns forming the primary key. */
  pk: string[];
  /** Columns typed UUID upstream: a non-UUID value is 22P02. */
  uuid?: string[];
  /** Additional unique constraints, each with the SQLSTATE name to report. */
  unique?: { name: string; cols: string[]; where?: (r: Row) => boolean }[];
}

const TABLES: Record<string, TableSpec> = {
  users: { pk: ["id"], uuid: ["id"] },
  follows: {
    pk: ["network", "follower_wallet", "followee_wallet"],
    uuid: ["follower_user_id", "followee_user_id"],
  },
  indexer_cursors: { pk: ["network", "source", "cursor_key"] },
  linked_wallets: { pk: ["wallet_address"], uuid: ["user_id"] },
  venue_markets: {
    pk: ["id"],
    uuid: ["id"],
    unique: [{ name: "venue_markets_venue_venue_market_id_key", cols: ["venue", "venue_market_id"] }],
  },
  market_snapshots: {
    pk: ["id"],
    uuid: ["id", "market_id"],
    unique: [
      {
        name: "market_snapshots_market_id_observed_at_source_key",
        cols: ["market_id", "observed_at", "source"],
      },
    ],
  },
  // Transport coverage only for this new table; real constraints are exercised
  // against disposable PostgreSQL in pantaPrices.postgres.test.ts.
  market_share_price_snapshots: { pk: ["id"], uuid: ["id", "market_id"] },
  market_resolutions: {
    pk: ["id"],
    uuid: ["id", "market_id", "supersedes_id"],
    unique: [
      {
        name: "uq_market_resolutions_original",
        cols: ["market_id"],
        where: (r) => r.supersedes_id === null || r.supersedes_id === undefined,
      },
    ],
  },
  venue_orders: {
    pk: ["order_id"],
    uuid: ["user_id", "market_id"],
    unique: [{ name: "venue_orders_user_id_idempotency_key_key", cols: ["user_id", "idempotency_key"] }],
  },
  venue_positions: { pk: ["position_id"], uuid: ["user_id", "market_id"] },
  calls: {
    pk: ["id"],
    uuid: ["id", "user_id", "market_id", "snapshot_id", "parent_call_id"],
    unique: [
      {
        name: "uq_calls_one_live_per_user_market",
        cols: ["user_id", "market_id"],
        where: (r) => r.hidden_at === null || r.hidden_at === undefined,
      },
    ],
  },
  call_responses: {
    pk: ["id"],
    uuid: ["id", "actor_user_id", "target_call_id", "resulting_call_id"],
    unique: [
      { name: "call_responses_actor_target_kind_key", cols: ["actor_user_id", "target_call_id", "kind"] },
      {
        name: "uq_call_responses_resulting_call",
        cols: ["resulting_call_id"],
        where: (r) => r.resulting_call_id !== null && r.resulting_call_id !== undefined,
      },
    ],
  },
  call_results: { pk: ["call_id"], uuid: ["call_id", "market_resolution_id"] },
};

// Tracks 20260917120000_venue_market_allow_polymarket.sql. This fake is only
// worth anything while it transcribes the REAL constraints — if it drifts from
// the migrations it starts proving things about a schema nobody runs.
const PERSISTABLE_VENUES = new Set(["jupiter", "polymarket", "fixture", "panta"]);

class SqlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const check = (name: string, message: string): SqlError =>
  new SqlError(400, "23514", `new row for relation violates check constraint "${name}": ${message}`);
const raise = (message: string): SqlError => new SqlError(400, "P0001", message);
const unique = (name: string): SqlError =>
  new SqlError(409, "23505", `duplicate key value violates unique constraint "${name}"`);
const fk = (name: string): SqlError =>
  new SqlError(409, "23503", `insert or update on table violates foreign key constraint "${name}"`);
const badType = (column: string, value: unknown): SqlError =>
  new SqlError(400, "22P02", `invalid input syntax for type uuid: "${String(value)}" (column ${column})`);

export interface PgrestFakeOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  /** The database's own NOW(), which `calls_guard_insert` compares closes_at to. */
  now?: () => number;
}

export interface RequestLogEntry {
  method: string;
  table: string;
  url: string;
  status: number;
}

/**
 * One fake project. `fetchImpl` is what gets injected into the stores; `rows()`
 * is what a test asserts on.
 */
export class PgrestFake {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly log: RequestLogEntry[] = [];
  /** Every URL the stores asked for, so a test can prove the key is never in one. */
  readonly urls: string[] = [];
  private readonly db = new Map<string, Row[]>();
  private readonly now: () => number;
  /** Set to make the next N writes fail, to exercise the failure paths. */
  failNextWrite: { table: string; error: SqlError } | null = null;

  constructor(opts: PgrestFakeOptions = {}) {
    this.supabaseUrl = opts.supabaseUrl ?? "https://fake.supabase.co";
    this.serviceRoleKey = opts.serviceRoleKey ?? "fake-service-role-key-DO-NOT-LOG-0123456789";
    this.now = opts.now ?? (() => Date.now());
    for (const t of Object.keys(TABLES)) this.db.set(t, []);
  }

  get config(): { supabaseUrl: string; serviceRoleKey: string; network: "devnet" | "mainnet-beta" } {
    return { supabaseUrl: this.supabaseUrl, serviceRoleKey: this.serviceRoleKey, network: "devnet" };
  }

  rows(table: string): Row[] {
    return [...(this.db.get(table) ?? [])];
  }

  /** Seed a row without going through the constraint layer (for fixtures). */
  seed(table: string, row: Row): void {
    this.db.get(table)!.push({ ...row });
  }

  /** `fetch`-shaped. Injected as `fetchImpl` into both Supabase stores. */
  readonly fetchImpl: typeof fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.urls.push(url);

    const parsed = new URL(url);
    const table = parsed.pathname.replace(/^.*\/rest\/v1\//, "");
    let status = 200;
    let body = "";
    try {
      if (!this.db.has(table)) throw new SqlError(404, "42P01", `relation "public.${table}" does not exist`);
      if (this.failNextWrite && this.failNextWrite.table === table && method !== "GET") {
        const err = this.failNextWrite.error;
        this.failNextWrite = null;
        throw err;
      }
      if (method === "GET") {
        body = JSON.stringify(this.select(table, parsed.searchParams));
      } else if (method === "POST") {
        const written = this.insert(table, JSON.parse(String(init?.body ?? "[]")) as Row[], parsed, headers);
        status = 201;
        body = wantsRepresentation(headers) ? JSON.stringify(written) : "";
      } else if (method === "PATCH") {
        const written = this.update(table, parsed.searchParams, JSON.parse(String(init?.body ?? "{}")) as Row);
        body = wantsRepresentation(headers) ? JSON.stringify(written) : "";
        if (!body) status = 204;
      } else if (method === "DELETE") {
        this.remove(table, parsed.searchParams);
        status = 204;
      } else {
        throw new SqlError(405, "0A000", `method ${method} not supported`);
      }
    } catch (err) {
      const sql = err instanceof SqlError ? err : new SqlError(500, "XX000", String(err));
      status = sql.status;
      body = JSON.stringify({ message: sql.message, code: sql.code, details: null, hint: null });
    }
    this.log.push({ method, table, url, status });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  // ── SELECT ────────────────────────────────────────────────────────────────

  private select(table: string, params: URLSearchParams): Row[] {
    let rows = this.db.get(table)!.filter((r) => matches(r, params));
    const order = params.get("order");
    if (order) {
      const keys = order.split(",").map((part) => {
        const [col, dir] = part.split(".");
        return { col: col ?? "", desc: dir === "desc" };
      });
      rows = [...rows].sort((a, b) => {
        for (const { col, desc } of keys) {
          const cmp = compare(a[col], b[col]);
          if (cmp !== 0) return desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    const offset = Number(params.get("offset") ?? 0);
    const limit = params.get("limit") ? Number(params.get("limit")) : rows.length;
    rows = rows.slice(offset, offset + limit);

    const select = params.get("select");
    if (!select || select === "*") return rows.map((r) => ({ ...r }));
    // `col::text` is a cast, not a different column.
    const cols = select.split(",").map((c) => c.split("::")[0]!.trim());
    return rows.map((r) => {
      const out: Row = {};
      for (const c of cols) out[c] = r[c] ?? null;
      return out;
    });
  }

  // ── INSERT / UPSERT ───────────────────────────────────────────────────────

  private insert(table: string, rows: Row[], parsed: URL, headers: Record<string, string>): Row[] {
    const prefer = String(headers.Prefer ?? headers.prefer ?? "");
    const merge = prefer.includes("resolution=merge-duplicates");
    const ignore = prefer.includes("resolution=ignore-duplicates");
    const onConflict = (parsed.searchParams.get("on_conflict") ?? "").split(",").filter(Boolean);
    const spec = TABLES[table]!;
    const store = this.db.get(table)!;
    const written: Row[] = [];

    for (const incoming of rows) {
      const row = { ...incoming };
      this.assertTypes(table, row);
      this.assertChecks(table, row);

      const conflictCols = onConflict.length > 0 ? onConflict : spec.pk;
      const existing = store.find((r) => conflictCols.every((c) => sameValue(r[c], row[c])));
      if (existing) {
        if (ignore) {
          written.push({ ...existing });
          continue;
        }
        if (!merge) throw unique(`${table}_pkey`);
        this.assertUpdateGuards(table, existing, { ...existing, ...row });
        Object.assign(existing, row);
        written.push({ ...existing });
        continue;
      }

      // Primary key collision that is NOT the conflict target is still a unique
      // violation — the same thing Postgres would say.
      if (store.some((r) => spec.pk.every((c) => sameValue(r[c], row[c])))) throw unique(`${table}_pkey`);
      for (const u of spec.unique ?? []) {
        if (u.where && !u.where(row)) continue;
        if (u.cols.some((c) => row[c] === null || row[c] === undefined)) continue;
        const clash = store.some((r) => (u.where ? u.where(r) : true) && u.cols.every((c) => sameValue(r[c], row[c])));
        if (clash) throw unique(u.name);
      }
      this.assertInsertGuards(table, row);
      store.push(row);
      written.push({ ...row });
    }
    return written;
  }

  private update(table: string, params: URLSearchParams, patch: Row): Row[] {
    const store = this.db.get(table)!;
    const out: Row[] = [];
    for (const row of store) {
      if (!matches(row, params)) continue;
      const next = { ...row, ...patch };
      this.assertTypes(table, next);
      this.assertChecks(table, next);
      this.assertUpdateGuards(table, row, next);
      Object.assign(row, patch);
      out.push({ ...row });
    }
    return out;
  }

  private remove(table: string, params: URLSearchParams): void {
    const store = this.db.get(table)!;
    const doomed = store.filter((r) => matches(r, params));
    for (const row of doomed) {
      if (table === "calls") {
        throw raise(
          "calls: a call is never deleted. Set hidden_at to withdraw it from distribution — call_results and accuracy history must survive (contracts §3).",
        );
      }
      if (table === "market_resolutions") {
        throw raise("market_resolutions is append-only: a recorded venue resolution may never be deleted.");
      }
      if (table === "call_responses") {
        throw raise("call_responses is append-only: a response may never be deleted.");
      }
      if (table === "call_results") {
        throw raise("call_results: a derived result is never deleted — accuracy history must survive.");
      }
      store.splice(store.indexOf(row), 1);
    }
  }

  // ── constraints ───────────────────────────────────────────────────────────

  private assertTypes(table: string, row: Row): void {
    for (const col of TABLES[table]!.uuid ?? []) {
      const v = row[col];
      if (v === null || v === undefined) continue;
      if (typeof v !== "string" || !UUID_RE.test(v)) throw badType(col, v);
    }
  }

  private assertChecks(table: string, row: Row): void {
    if (
      (table === "venue_markets" ||
        table === "market_resolutions" ||
        table === "venue_orders" ||
        table === "venue_positions") &&
      !PERSISTABLE_VENUES.has(String(row.venue))
    ) {
      throw check(`${table}_venue_check`, `venue '${String(row.venue)}' is not in ('jupiter','polymarket','fixture')`);
    }
    if (table === "venue_markets") {
      if (row.venue === "jupiter" && isEmptyJson(row.raw_payload)) {
        throw check("venue_markets_live_rows_keep_raw", "a live venue row must carry raw_payload");
      }
      const outcomes = row.outcomes;
      const ok =
        Array.isArray(outcomes) &&
        outcomes.length === 2 &&
        outcomes.some((o) => (o as Row).side === "YES") &&
        outcomes.some((o) => (o as Row).side === "NO");
      if (!ok) throw check("venue_markets_outcomes_binary", "outcomes must be exactly one YES and one NO");
      if (row.is_demo !== undefined) {
        throw new SqlError(400, "428C9", 'cannot insert a non-DEFAULT value into column "is_demo"');
      }
    }
    if (table === "market_snapshots") {
      const p = Number(row.yes_probability);
      if (!(p >= 0 && p <= 1)) throw check("market_snapshots_probability_range", "yes_probability outside [0,1]");
    }
    if (table === "market_resolutions" && isEmptyJson(row.raw_evidence)) {
      throw check("market_resolutions_requires_evidence", "raw_evidence must not be '{}'");
    }
    if (table === "venue_orders") {
      if (row.funding_state === "NONE") throw check("venue_orders_never_free", "an order is never a free call");
      if (
        row.funding_state === "FILLED" &&
        !(
          row.reconciliation_source === "reconciliation" &&
          row.reconciled_at &&
          row.venue_order_id &&
          row.fill_tx_signature &&
          BigInt(String(row.filled_base_units ?? "0")) > 0n &&
          !isEmptyJson(row.fill_evidence)
        )
      ) {
        throw check("venue_orders_filled_requires_evidence", "FILLED needs a full reconciliation write");
      }
    }
    if (table === "venue_positions") {
      if (row.funding_state === "FILLED" && !(row.reconciled_at && row.source_order_id)) {
        throw check(
          "venue_positions_filled_requires_reconciliation",
          "FILLED needs reconciled_at and source_order_id",
        );
      }
    }
    if (table === "calls") {
      if (row.funding_state !== "NONE" && row.funding_state !== undefined) {
        // Not a schema CHECK, but the INSERT policy's WITH CHECK for a client.
        // The service role may write any legal FundingState, so this is only a
        // shape assertion for the MVP: every call this store writes is free.
        if (typeof row.funding_state !== "string") throw check("calls_funding_state_check", "bad funding_state");
      }
      const thesis = row.thesis;
      if (typeof thesis === "string" && thesis.length > 280) {
        throw check("calls_thesis_length", "thesis must be <= 280 chars");
      }
    }
    if (table === "call_results") {
      const outcome = String(row.outcome);
      const pending = outcome === "PENDING";
      const hasEvidence = row.market_resolution_id !== null && row.market_resolution_id !== undefined;
      if (pending && (row.resolution || row.resolved_at || hasEvidence)) {
        throw check("call_results_pending_has_no_evidence", "PENDING must carry no evidence");
      }
      if (!pending && !(row.resolution && row.resolved_at && hasEvidence)) {
        throw check("call_results_settled_requires_evidence", "a settled result must cite its evidence");
      }
      if ((outcome === "VOID") !== (row.resolution === "VOID")) {
        throw check("call_results_void_iff_void_resolution", "VOID iff the resolution is VOID");
      }
    }
  }

  private assertInsertGuards(table: string, row: Row): void {
    if (table === "market_snapshots" && !this.exists("venue_markets", "id", row.market_id)) {
      throw fk("market_snapshots_market_id_fkey");
    }
    if (table === "market_resolutions" && !this.exists("venue_markets", "id", row.market_id)) {
      throw fk("market_resolutions_market_id_fkey");
    }
    if (table === "venue_orders" && !this.exists("users", "id", row.user_id)) {
      throw fk("venue_orders_user_id_fkey");
    }
    if (table === "venue_positions") {
      if (!this.exists("users", "id", row.user_id)) throw fk("venue_positions_user_id_fkey");
      if (row.source_order_id && !this.exists("venue_orders", "order_id", row.source_order_id)) {
        throw fk("venue_positions_source_order_id_fkey");
      }
    }
    if (table === "follows") {
      for (const col of ["follower_wallet", "followee_wallet"]) {
        const v = row[col];
        if (typeof v !== "string" || v.trim() === "") {
          throw new SqlError(400, "23502", `null value in column "${col}" violates not-null constraint`);
        }
      }
    }

    if (table === "calls") {
      // ── trg_calls_guard_insert, transcribed ──
      if (!this.exists("users", "id", row.user_id)) throw fk("calls_user_id_fkey");
      const market = this.find("venue_markets", "id", row.market_id);
      if (!market) {
        throw raise(`calls: market ${String(row.market_id)} does not exist.`);
      }
      if (market.status !== "OPEN") {
        throw raise(`calls: market ${String(row.market_id)} is ${String(market.status)}, so it is no longer taking calls.`);
      }
      const closesAt = market.closes_at ? Date.parse(String(market.closes_at)) : null;
      if (closesAt !== null && closesAt <= this.now()) {
        throw raise(`calls: market ${String(row.market_id)} closed at ${String(market.closes_at)}.`);
      }
      if (this.find("market_resolutions", "market_id", row.market_id)) {
        throw raise(
          `calls: market ${String(row.market_id)} was resolved — a call cannot be made after the answer is public.`,
        );
      }
      if (row.hidden_at) {
        throw raise("calls: a call may not be inserted already hidden.");
      }
      if (row.snapshot_id && !this.exists("market_snapshots", "id", row.snapshot_id)) {
        throw fk("calls_snapshot_id_fkey");
      }
      if (row.parent_call_id) {
        const parent = this.find("calls", "id", row.parent_call_id);
        if (!parent) throw raise(`calls: parent_call_id ${String(row.parent_call_id)} does not exist.`);
        if (parent.market_id !== row.market_id) {
          throw raise("calls: a Back/Fade must be on the SAME market as the call it came from.");
        }
      }
    }

    if (table === "call_responses") {
      const target = this.find("calls", "id", row.target_call_id);
      if (!target) throw raise(`call_responses: target call ${String(row.target_call_id)} does not exist.`);
      if (target.user_id === row.actor_user_id) {
        throw raise(`call_responses: you cannot ${String(row.kind)} your own call.`);
      }
      const wantsCall = row.kind === "back" || row.kind === "fade";
      if (wantsCall !== (row.resulting_call_id !== null && row.resulting_call_id !== undefined)) {
        throw check("call_responses_resulting_call_matches_kind", "back/fade carry a call; challenge never does");
      }
      if (row.resulting_call_id) {
        const own = this.find("calls", "id", row.resulting_call_id);
        if (!own) throw raise("call_responses: resulting call does not exist.");
        if (own.user_id !== row.actor_user_id) {
          throw raise("call_responses: a back/fade must create the ACTOR'S OWN call.");
        }
        if (own.market_id !== target.market_id) {
          throw raise("call_responses: a back/fade must be on the same market as its target.");
        }
        if (row.kind === "back" && own.side !== target.side) {
          throw raise("call_responses: a back must take the SAME side as the call it backs.");
        }
        if (row.kind === "fade" && own.side === target.side) {
          throw raise("call_responses: a fade must take the OPPOSITE side to the call it fades.");
        }
      }
    }

    if (table === "call_results") this.assertResultDerivation(row);
    if (table === "venue_orders" && row.funding_state === "FILLED") {
      throw raise("venue_orders: an order may not be INSERTed as FILLED.");
    }
  }

  private assertUpdateGuards(table: string, old: Row, next: Row): void {
    if (table === "market_resolutions") {
      throw raise("market_resolutions is append-only: a recorded venue resolution may never be updated.");
    }
    if (table === "call_responses") {
      throw raise("call_responses is append-only: a response is a timestamped fact.");
    }
    if (table === "calls") {
      // ── trg_calls_guard_immutability, transcribed ──
      const frozen = [
        "id",
        "user_id",
        "market_id",
        "side",
        "entry_probability",
        "snapshot_id",
        "created_at",
        "locked_at",
        "thesis",
        "confidence",
        "parent_call_id",
        "visibility",
        "funding_state",
      ];
      for (const col of frozen) {
        if (!sameValue(old[col], next[col])) {
          throw raise(`calls: ${col} is immutable after lockedAt (call ${String(old.id)}).`);
        }
      }
    }
    if (table === "call_results") {
      if (old.outcome !== "PENDING") {
        const same =
          sameValue(old.outcome, next.outcome) &&
          sameValue(old.resolution, next.resolution) &&
          sameValue(old.resolved_at, next.resolved_at) &&
          sameValue(old.market_resolution_id, next.market_resolution_id);
        if (!same) {
          throw raise(
            `call_results: call ${String(old.call_id)} is already settled ${String(old.outcome)}; a settled result is permanent and there is no admin override.`,
          );
        }
      }
      this.assertResultDerivation(next);
    }
    if (table === "venue_orders") {
      if (next.funding_state === "FILLED" && old.funding_state !== "FILLED") {
        if (old.funding_state !== "SUBMITTED" && old.funding_state !== "PARTIAL") {
          throw raise(
            `venue_orders: FILLED may only follow SUBMITTED or PARTIAL (order ${String(old.order_id)} was ${String(old.funding_state)}).`,
          );
        }
      }
      if (
        old.funding_state === "FILLED" &&
        !["FILLED", "CLOSED", "CLAIMABLE", "CLAIMED"].includes(String(next.funding_state))
      ) {
        throw raise(`venue_orders: a FILLED order may not regress to ${String(next.funding_state)}.`);
      }
    }
  }

  /** trg_call_results_guard_derivation — §3's rule, and nothing else. */
  private assertResultDerivation(row: Row): void {
    const call = this.find("calls", "id", row.call_id);
    if (!call) throw raise(`call_results: call ${String(row.call_id)} does not exist.`);
    let expected = "PENDING";
    if (row.market_resolution_id) {
      const res = this.find("market_resolutions", "id", row.market_resolution_id);
      if (!res) throw fk("call_results_market_resolution_id_fkey");
      if (res.market_id !== call.market_id) {
        throw raise(
          `call_results: resolution ${String(row.market_resolution_id)} is for market ${String(res.market_id)}, but call ${String(row.call_id)} is on ${String(call.market_id)}.`,
        );
      }
      if (row.resolution !== res.resolution) {
        throw raise(
          `call_results: resolution "${String(row.resolution)}" does not match the venue evidence "${String(res.resolution)}" it cites.`,
        );
      }
      if (!sameInstant(row.resolved_at, res.resolved_at)) {
        throw raise("call_results: resolved_at must be the venue's own resolved_at.");
      }
      expected = res.resolution === "VOID" ? "VOID" : res.resolution === call.side ? "CORRECT" : "INCORRECT";
    }
    if (row.outcome !== expected) {
      throw raise(
        `call_results: outcome "${String(row.outcome)}" is not what contracts §3 derives for call ${String(row.call_id)} (side ${String(call.side)}): expected "${expected}".`,
      );
    }
  }

  private find(table: string, col: string, value: unknown): Row | undefined {
    return this.db.get(table)!.find((r) => sameValue(r[col], value));
  }

  private exists(table: string, col: string, value: unknown): boolean {
    return this.find(table, col, value) !== undefined;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (RESERVED.has(key)) continue;
    const v = row[key];
    if (raw === "is.null") {
      if (v !== null && v !== undefined) return false;
    } else if (raw === "not.is.null") {
      if (v === null || v === undefined) return false;
    } else if (raw.startsWith("eq.")) {
      if (String(v) !== raw.slice(3)) return false;
    } else if (raw.startsWith("in.(")) {
      const set = raw.slice(4, -1).split(",");
      if (!set.includes(String(v))) return false;
    } else {
      throw new Error(`pgrestFake: unsupported filter ${key}=${raw}`);
    }
  }
  return true;
}

const wantsRepresentation = (headers: Record<string, string>): boolean =>
  String(headers.Prefer ?? headers.prefer ?? "").includes("return=representation");

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

/** TIMESTAMPTZ equality is on the instant, not on the text. */
function sameInstant(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return Date.parse(String(a)) === Date.parse(String(b));
}

export function isEmptyJson(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  return Object.keys(v as Row).length === 0;
}

/** A canonical `public.users` row, so a call has an author the FK accepts. */
export function seedUser(
  fake: PgrestFake,
  id: string,
  opts: { handle?: string; wallet?: string | null; fullName?: string } = {},
): string {
  fake.seed("users", {
    id,
    handle: opts.handle ?? null,
    full_name: opts.fullName ?? null,
    profile_picture: null,
    wallet_address: opts.wallet === undefined ? `Wallet_${id.slice(0, 8)}` : opts.wallet,
    sns_domain: null,
  });
  return id;
}

export const UUIDS = {
  alice: "11111111-1111-4111-8111-111111111111",
  bob: "22222222-2222-4222-8222-222222222222",
  carol: "33333333-3333-4333-8333-333333333333",
} as const;
