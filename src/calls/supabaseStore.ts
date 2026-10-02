/**
 * `SupabaseCallsStore` — Packet D's three tables, for real.
 *
 * Same shape, and the same honest limits, as `SupabasePredictionStore` (read the
 * header there first; it explains why a synchronous store interface forces a
 * mirror plus a write-behind queue, and what that does and does not give you):
 *
 *   1. an in-process `InMemoryCallsStore` MIRROR serves every read and enforces
 *      every invariant, delegated to rather than re-implemented, so "the
 *      existing CallsService tests pass against either" is true by construction;
 *   2. every mutation is ALSO written to Postgres, through the FIFO queue
 *      SHARED with the prediction store — `calls.market_id` is a real FK onto
 *      `venue_markets(id)` and `calls.snapshot_id` onto `market_snapshots(id)`,
 *      so a market and its price must be written before a call that cites them;
 *   3. `hydrate()` rebuilds the mirror from Postgres at boot, which is the
 *      whole point: a redeploy stops being an amnesia event;
 *   4. a rejected write is recorded, reported and re-raised by `flush()` —
 *      never swallowed.
 *
 * ── THE TWO TABLES THIS STORE READS BUT NEVER WRITES ────────────────────────
 *
 * `public.users` is Packet A's and the legacy auth path's (§6), and §8.1 records
 * a LIVE production hole where `anon` can already rewrite any `users` row. This
 * store therefore READS the canonical directory and never writes it: a
 * credential is looked up, never minted, which is exactly the property §8.2
 * says `sync_user_by_wallet` lacks. `upsertPerson()` is consequently mirror-only
 * and says so at the point of use.
 *
 * `public.follows` IS written (insert/delete), because the follow graph is what
 * `calls_followers_select` reads and a `followers`-only call is unreadable
 * without it. It is written in the table's own shape — wallet columns plus the
 * canonical id columns — and refuses rather than inventing a wallet for a
 * wallet-less account.
 *
 * ── WHAT THE DATABASE REFUSES, AND WHY THAT IS RIGHT ────────────────────────
 *
 *   trg_calls_guard_insert          market must exist, be OPEN, be unclosed, and
 *                                   have no resolution; no call may be born hidden
 *   trg_calls_guard_immutability    only hidden_at/hidden_reason may ever change;
 *                                   DELETE is refused for EVERY role
 *   uq_calls_one_live_per_user_market
 *   trg_call_responses_guard        append-only; back = same side, fade = other
 *   trg_call_results_guard_derivation
 *                                   re-derives the outcome in SQL and refuses
 *                                   any row that disagrees
 *
 * Every one of those is already a rule `InMemoryCallsStore` enforces, so the
 * mirror refuses the same writes for the same reasons before Postgres is asked.
 * The only rules that live solely upstream are the two this layer cannot see —
 * the market's state at the instant of the INSERT, and the database's own NOW().
 */

import { parseSharePrice } from "../prediction/sharePrices.ts";
import {
  fromTimestamptz,
  isUuid,
  parseNumeric,
  parseTimestamptz,
  Pgrest,
  PgrestError,
  snapshotUuidFromHandle,
  toTimestamptz,
  toTimestamptzOrNull,
  WriteQueue,
  writeFailureError,
  type FetchImpl,
  type PgrestConfig,
  type WriteFailure,
} from "../prediction/pgrest.ts";
import { systemClock, type Clock } from "../prediction/clock.ts";
import type { MarketResolutionRecord, Resolution, Side, VenueId } from "../prediction/types.ts";
import { CallsError } from "./errors.ts";
import { InMemoryCallsStore, type CallsStore, type ResultWriteActor } from "./store.ts";
import type {
  CallRecord,
  CallResponseKind,
  CallResponseRecord,
  CallResult,
  CallVisibility,
  FundingState,
  Person,
  ThesisUpdate,
} from "./types.ts";

/** Cursor namespace in `public.indexer_cursors` (see `SupabasePredictionStore`). */
export const CALLS_CURSOR_SOURCE = "bff_calls";

const CALLS_TABLE = "calls";
const RESPONSES_TABLE = "call_responses";
const RESULTS_TABLE = "call_results";
const USERS_TABLE = "users";
const FOLLOWS_TABLE = "follows";
const PERSON_FOLLOWS_TABLE = "person_follows";
const CURSORS_TABLE = "indexer_cursors";
/** Added by 20261002130000_call_thesis_updates.sql — optional until applied. */
export const THESIS_UPDATES_TABLE = "call_thesis_updates";

export interface SupabaseCallsStoreOptions {
  config: PgrestConfig & { network: "devnet" | "mainnet-beta" };
  fetchImpl?: FetchImpl;
  clock?: Clock;
  /** Shared with SupabasePredictionStore so cross-table FKs land parent-first. */
  queue?: WriteQueue;
  mirror?: InMemoryCallsStore;
  maxRowsPerTable?: number;
}

export interface CallsHydrationReport {
  people: number;
  follows: number;
  calls: number;
  hiddenCalls: number;
  responses: number;
  results: number;
  cursors: number;
  /** Thesis updates mirrored, or null when the table is not there yet. */
  thesisUpdates: number | null;
  /**
   * Rows Postgres holds that the mirror could not accept. Always zero for a
   * database written only by this store; non-zero means the mirror and the
   * schema disagree, which is a bug worth shouting about rather than hiding.
   */
  skipped: { calls: number; responses: number; results: number };
  hydratedAt: number;
}

export class SupabaseCallsStore implements CallsStore {
  readonly persistent = true;
  readonly mirror: InMemoryCallsStore;
  readonly queue: WriteQueue;

  private readonly pg: Pgrest;
  private readonly clock: Clock;
  private readonly network: "devnet" | "mainnet-beta";
  private readonly maxRowsPerTable: number;
  private hydration: CallsHydrationReport | null = null;
  /**
   * Whether `call_thesis_updates` answered at hydration. Until it has, no
   * update is accepted: a write to a table that is not there would be refused
   * upstream and quarantine the SHARED queue — every call, response and market
   * write behind it — for a feature that is optional. Fail closed, locally.
   */
  private thesisTable = false;

  constructor(opts: SupabaseCallsStoreOptions) {
    this.pg = new Pgrest(opts.config, opts.fetchImpl);
    this.clock = opts.clock ?? systemClock;
    this.network = opts.config.network;
    this.mirror = opts.mirror ?? new InMemoryCallsStore();
    this.queue = opts.queue ?? new WriteQueue({ clock: this.clock });
    this.maxRowsPerTable = opts.maxRowsPerTable ?? 50_000;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  get hydrated(): boolean {
    return this.hydration !== null;
  }

  get hydrationReport(): CallsHydrationReport | null {
    return this.hydration;
  }

  get failures(): readonly WriteFailure[] {
    return this.queue.failures;
  }

  /** Every durable write queued so far; throws if any was rejected. */
  async flush(): Promise<void> {
    await this.queue.drain();
    if (this.queue.failures.length > 0) throw writeFailureError(this.queue.failures);
  }

  /**
   * Rebuild the mirror from Postgres. Every write below goes through
   * `this.mirror.*` rather than `this.*`, so hydration enqueues nothing: reading
   * the database must never write to it.
   */
  async hydrate(): Promise<CallsHydrationReport> {
    const report: CallsHydrationReport = {
      people: 0,
      follows: 0,
      calls: 0,
      hiddenCalls: 0,
      responses: 0,
      results: 0,
      cursors: 0,
      thesisUpdates: null,
      skipped: { calls: 0, responses: 0, results: 0 },
      hydratedAt: this.clock.now(),
    };

    // ── the canonical directory (read-only) ──
    for (const row of await this.page<UserRow>(USERS_TABLE, () => {
      return new URLSearchParams({ select: USER_COLUMNS, order: "id.asc" });
    })) {
      this.mirror.upsertPerson(personFromRow(row));
      report.people++;
    }

    // ── the follow graph, canonical-id rows only ──
    for (const row of await this.page<FollowRow>(FOLLOWS_TABLE, () => {
      return new URLSearchParams({
        select: "follower_user_id,followee_user_id",
        network: `eq.${this.network}`,
        follower_user_id: "not.is.null",
        followee_user_id: "not.is.null",
        order: "created_at.asc",
      });
    })) {
      if (!row.follower_user_id || !row.followee_user_id) continue;
      this.mirror.follow(row.follower_user_id, row.followee_user_id);
      report.follows++;
    }

    // Canonical, wallet-optional edges. Keep reading legacy edges above so an
    // existing user's social graph survives the product update unchanged.
    for (const row of await this.page<{ follower_user_id: string; followee_user_id: string }>(
      PERSON_FOLLOWS_TABLE,
      () => new URLSearchParams({ select: "follower_user_id,followee_user_id", order: "created_at.asc" }),
    )) {
      if (!this.mirror.isFollowing(row.follower_user_id, row.followee_user_id)) report.follows++;
      this.mirror.follow(row.follower_user_id, row.followee_user_id);
    }

    // ── calls, oldest first so a Back/Fade's parent always exists already ──
    for (const row of await this.page<CallRow>(CALLS_TABLE, () => {
      return new URLSearchParams({ select: CALL_COLUMNS, order: "locked_at.asc,created_at.asc,id.asc" });
    })) {
      const rec = callFromRow(row);
      try {
        // `calls_guard_insert` forbids a call born hidden, and so does the
        // mirror. A persisted hidden call was therefore locked visible and
        // hidden afterwards — which is exactly how it is replayed, with its own
        // recorded hidden_at rather than "now".
        this.mirror.insertCall({ ...rec, hiddenAt: null, hiddenReason: null });
        if (rec.hiddenAt !== null) {
          this.mirror.attemptCallUpdate(rec.id, { hiddenAt: rec.hiddenAt, hiddenReason: rec.hiddenReason });
          report.hiddenCalls++;
        }
        report.calls++;
      } catch (err) {
        report.skipped.calls++;
        console.error(
          `[persist] hydrate: ${CALLS_TABLE}/${rec.id} could not be mirrored — the schema and the in-memory rules disagree: ${message(err)}`,
        );
      }
    }

    // ── responses ──
    for (const row of await this.page<ResponseRow>(RESPONSES_TABLE, () => {
      return new URLSearchParams({ select: RESPONSE_COLUMNS, order: "created_at.asc,id.asc" });
    })) {
      const rec = responseFromRow(row);
      try {
        this.mirror.insertResponse(rec);
        report.responses++;
      } catch (err) {
        report.skipped.responses++;
        console.error(`[persist] hydrate: ${RESPONSES_TABLE}/${rec.id} could not be mirrored: ${message(err)}`);
      }
    }

    // ── results ──
    // Replayed through `writeResult`, which takes EVIDENCE and derives the
    // outcome itself. There is no code path here that can set an outcome, so a
    // stored row that disagreed with §3 would be re-derived correctly rather
    // than imported — the same property the SQL trigger gives the table.
    for (const row of await this.page<ResultRow>(RESULTS_TABLE, () => {
      return new URLSearchParams({ select: RESULT_COLUMNS, order: "derived_at.asc,call_id.asc" });
    })) {
      const call = this.mirror.getCall(row.call_id);
      if (!call) {
        report.skipped.results++;
        continue;
      }
      try {
        this.mirror.writeResult(
          { callId: row.call_id, evidence: evidenceFromResultRow(row, call.marketId) },
          parseTimestamptz(row.derived_at) ?? report.hydratedAt,
          { actor: "service" },
        );
        report.results++;
      } catch (err) {
        report.skipped.results++;
        console.error(`[persist] hydrate: ${RESULTS_TABLE}/${row.call_id} could not be mirrored: ${message(err)}`);
      }
    }

    // ── the thesis thread (optional table; never fails the hydration) ──
    report.thesisUpdates = await this.hydrateThesisUpdates();

    // ── cursors ──
    for (const row of await this.pg.select<CursorRow>(
      CURSORS_TABLE,
      new URLSearchParams({
        select: "cursor_key,last_signature",
        network: `eq.${this.network}`,
        source: `eq.${CALLS_CURSOR_SOURCE}`,
      }),
    )) {
      this.mirror.setCursor(row.cursor_key, row.last_signature ?? null);
      report.cursors++;
    }

    this.hydration = report;
    return report;
  }

  /**
   * Read the thesis thread into the mirror. The table arrives with its own
   * additive migration, which may be applied after this code ships, so its
   * absence — or any failure to read it — disables updates and nothing else.
   * The calls, responses and results above are the product; this is a thread
   * hung off them, and it must never be the reason the feed does not boot.
   */
  private async hydrateThesisUpdates(): Promise<number | null> {
    this.thesisTable = false;
    let rows: ThesisUpdateRow[];
    try {
      rows = await this.page<ThesisUpdateRow>(THESIS_UPDATES_TABLE, () => {
        return new URLSearchParams({ select: THESIS_UPDATE_COLUMNS, order: "created_at.asc,id.asc" });
      });
    } catch (err) {
      console.warn(
        `[persist] hydrate: ${THESIS_UPDATES_TABLE} unavailable, so thesis updates are off until it is: ${message(err)}`,
      );
      return null;
    }
    let mirrored = 0;
    for (const row of rows) {
      try {
        this.mirror.insertThesisUpdate(thesisUpdateFromRow(row));
        mirrored++;
      } catch (err) {
        console.error(`[persist] hydrate: ${THESIS_UPDATES_TABLE}/${row.id} could not be mirrored: ${message(err)}`);
      }
    }
    this.thesisTable = true;
    return mirrored;
  }

  /** Forget the mirror and rebuild it from Postgres. The repair path. */
  async resync(): Promise<CallsHydrationReport> {
    this.hydration = null;
    // Re-reading Postgres IS the repair for a divergent mirror.
    this.queue.clearFailures();
    (this as { mirror: InMemoryCallsStore }).mirror = new InMemoryCallsStore();
    return this.hydrate();
  }

  // ── people: READ from public.users, never written (see the header) ────────

  /**
   * Mirror-only, deliberately. `public.users` belongs to Packet A and the
   * legacy auth path (§6), and §8.1 is a live hole where anon can already
   * rewrite any row there; this store is not going to become a second writer of
   * it. People arrive through `hydrate()`, which reads the canonical directory.
   */
  upsertPerson(p: Person): Person {
    return this.mirror.upsertPerson(p);
  }

  getPerson(userId: string): Person | undefined {
    return this.mirror.getPerson(userId);
  }

  /** Read through only on a directory miss; never creates/merges an identity. */
  async refreshPerson(userId: string): Promise<Person | undefined> {
    const rows = await this.pg.select<UserRow>(USERS_TABLE, new URLSearchParams({
      id: `eq.${userId}`, select: USER_COLUMNS, limit: "1",
    }));
    return rows[0] ? this.mirror.upsertPerson(personFromRow(rows[0])) : undefined;
  }

  getPersonByHandle(handle: string): Person | undefined {
    return this.mirror.getPersonByHandle(handle);
  }

  getPersonByWallet(wallet: string): Person | undefined {
    return this.mirror.getPersonByWallet(wallet);
  }

  listPeople(): Person[] {
    return this.mirror.listPeople();
  }

  // ── follow graph (canonical person_follows + legacy follows) ─────────────

  follow(followerUserId: string, followeeUserId: string): void {
    if (followerUserId === followeeUserId) return; // follows_not_self
    if (this.mirror.isFollowing(followerUserId, followeeUserId)) return; // idempotent
    this.mirror.follow(followerUserId, followeeUserId);

    this.queue.push(`insert ${PERSON_FOLLOWS_TABLE}/${followerUserId}->${followeeUserId}`, async () => {
      await this.pg.insert(
        PERSON_FOLLOWS_TABLE,
        [{ follower_user_id: followerUserId, followee_user_id: followeeUserId }],
        { onConflict: "follower_user_id,followee_user_id", ignoreDuplicates: true },
      );
    });
  }

  unfollow(followerUserId: string, followeeUserId: string): void {
    if (!this.mirror.isFollowing(followerUserId, followeeUserId)) return;
    this.mirror.unfollow(followerUserId, followeeUserId);
    this.queue.push(`delete ${PERSON_FOLLOWS_TABLE}/${followerUserId}->${followeeUserId}`, async () => {
      await this.pg.remove(PERSON_FOLLOWS_TABLE, new URLSearchParams({
        follower_user_id: `eq.${followerUserId}`,
        followee_user_id: `eq.${followeeUserId}`,
      }));
    });
    // A legacy edge may be the reason the person appeared as followed. Remove
    // only this canonical pair on the configured network; do not touch any
    // other wallet relationship or rewrite the legacy table's schema.
    this.queue.push(`delete ${FOLLOWS_TABLE}/${followerUserId}->${followeeUserId}`, async () => {
      await this.pg.remove(
        FOLLOWS_TABLE,
        new URLSearchParams({
          network: `eq.${this.network}`,
          follower_user_id: `eq.${followerUserId}`,
          followee_user_id: `eq.${followeeUserId}`,
        }),
      );
    });
  }

  isFollowing(followerUserId: string, followeeUserId: string): boolean {
    return this.mirror.isFollowing(followerUserId, followeeUserId);
  }

  followingOf(followerUserId: string): string[] {
    return this.mirror.followingOf(followerUserId);
  }

  followersOf(followeeUserId: string): string[] {
    return this.mirror.followersOf(followeeUserId);
  }


  // ── calls ─────────────────────────────────────────────────────────────────

  insertCall(rec: CallRecord): CallRecord {
    // The mirror enforces: no duplicate id, never born hidden, one live call
    // per user per market, a parent on the same market. Same list as
    // `calls_guard_insert` + `uq_calls_one_live_per_user_market`.
    const stored = this.mirror.insertCall(rec);

    this.queue.push(`insert ${CALLS_TABLE}/${rec.id}`, async () => {
      this.assertUuid(rec.id, `${CALLS_TABLE}.id`);
      this.assertUuid(rec.userId, `${CALLS_TABLE}.user_id`);
      this.assertUuid(rec.marketId, `${CALLS_TABLE}.market_id`);
      // `snapshot_id` is a UUID FK onto market_snapshots. `CallsService` stamps
      // an opaque `snap:<market>:<observedAt>:<source>` handle built from
      // exactly the columns that table's UNIQUE index uses, so the real id is
      // derivable rather than looked up. Anything else is not translatable and
      // is refused rather than dropped to null: null would quietly erase the
      // evidence that the person committed at a known price.
      let snapshotId: string | null = null;
      if (rec.snapshotId !== null) {
        snapshotId = snapshotUuidFromHandle(rec.snapshotId);
        if (snapshotId === null) {
          throw new PgrestError(
            `[persist] ${CALLS_TABLE}/${rec.id}: snapshotId '${rec.snapshotId}' is not a market_snapshots id and not a snap:<market>:<observedAt>:<source> handle, so calls.snapshot_id cannot be set. entry_probability without its snapshot is evidence with no source.`,
            { sqlState: "22P02", details: { callId: rec.id } },
          );
        }
      }
      await this.pg.insert(
        CALLS_TABLE,
        [
          {
            id: rec.id,
            user_id: rec.userId,
            market_id: rec.marketId,
            side: rec.side,
            confidence: rec.confidence,
            thesis: rec.thesis,
            entry_probability: rec.entryProbability,
            snapshot_id: snapshotId,
            ...(rec.entryPrice ? { share_price_snapshot_id: rec.entryPrice.id, entry_price: rec.entryPrice } : {}),
            visibility: rec.visibility,
            created_at: toTimestamptz(rec.createdAt),
            locked_at: toTimestamptz(rec.lockedAt),
            parent_call_id: rec.parentCallId,
            funding_state: rec.fundingState,
            // A call is never born hidden; the trigger says so too.
            hidden_at: null,
            hidden_reason: null,
          },
        ],
        // A replayed insert of the same id is the same fact. `calls` is
        // immutable, so a merge is never correct here.
        { onConflict: "id", ignoreDuplicates: true },
      );
    });

    return stored;
  }

  getCall(callId: string): CallRecord | undefined {
    return this.mirror.getCall(callId);
  }

  listCalls(): CallRecord[] {
    return this.mirror.listCalls();
  }

  liveCalls(): CallRecord[] {
    return this.mirror.liveCalls();
  }

  liveCallsOnMarket(marketId: string): CallRecord[] {
    return this.mirror.liveCallsOnMarket(marketId);
  }

  liveCallByUserOnMarket(userId: string, marketId: string): CallRecord | undefined {
    return this.mirror.liveCallByUserOnMarket(userId, marketId);
  }

  callsByAuthor(userId: string): CallRecord[] {
    return this.mirror.callsByAuthor(userId);
  }

  /**
   * The mirror is the immutability guard; it refuses anything outside
   * hidden_at/hidden_reason for every caller, exactly as
   * `calls_guard_immutability` does. Only the two mutable columns can therefore
   * ever reach the PATCH below.
   */
  attemptCallUpdate(callId: string, patch: Partial<CallRecord>): CallRecord {
    const updated = this.mirror.attemptCallUpdate(callId, patch);
    this.queue.push(`patch ${CALLS_TABLE}/${callId}`, async () => {
      await this.pg.patch(CALLS_TABLE, new URLSearchParams({ id: `eq.${callId}` }), {
        hidden_at: toTimestamptzOrNull(updated.hiddenAt),
        hidden_reason: updated.hiddenReason,
      });
    });
    return updated;
  }

  hideCall(callId: string, reason: string | null = null): CallRecord {
    const current = this.mirror.getCall(callId);
    if (!current) {
      throw new CallsError("CALL_NOT_FOUND", `no such call ${callId}`, { details: { callId } });
    }
    if (current.hiddenAt !== null) return current; // idempotent, as in the mirror
    return this.attemptCallUpdate(callId, { hiddenAt: this.clock.now(), hiddenReason: reason });
  }

  unhideCall(callId: string): CallRecord {
    return this.attemptCallUpdate(callId, { hiddenAt: null, hiddenReason: null });
  }

  /**
   * Exists only to refuse, here as in the mirror and as in
   * `calls_guard_immutability`, which raises on DELETE for every role including
   * service_role. Nothing is enqueued: there is no durable delete to attempt.
   */
  deleteCall(callId: string): never {
    return this.mirror.deleteCall(callId);
  }

  // ── responses ─────────────────────────────────────────────────────────────

  insertResponse(rec: CallResponseRecord): CallResponseRecord {
    // The mirror enforces self/duplicate, the back=same-side / fade=other-side
    // rule, and "a challenge creates no call" — the same list as
    // `call_responses_resulting_call_matches_kind` + `call_responses_guard`.
    const stored = this.mirror.insertResponse(rec);

    this.queue.push(`insert ${RESPONSES_TABLE}/${rec.id}`, async () => {
      this.assertUuid(rec.id, `${RESPONSES_TABLE}.id`);
      this.assertUuid(rec.actorUserId, `${RESPONSES_TABLE}.actor_user_id`);
      await this.pg.insert(
        RESPONSES_TABLE,
        [
          {
            id: rec.id,
            actor_user_id: rec.actorUserId,
            target_call_id: rec.targetCallId,
            kind: rec.kind,
            resulting_call_id: rec.resultingCallId,
            note: rec.note,
            created_at: toTimestamptz(rec.createdAt),
          },
        ],
        // `call_responses` is append-only by trigger: a merge would be refused.
        { onConflict: "id", ignoreDuplicates: true },
      );
    });

    return stored;
  }

  getResponse(responseId: string): CallResponseRecord | undefined {
    return this.mirror.getResponse(responseId);
  }

  responsesForTarget(targetCallId: string): CallResponseRecord[] {
    return this.mirror.responsesForTarget(targetCallId);
  }

  responseBy(
    actorUserId: string,
    targetCallId: string,
    kind: CallResponseKind,
  ): CallResponseRecord | undefined {
    return this.mirror.responseBy(actorUserId, targetCallId, kind);
  }

  responsesByActor(actorUserId: string): CallResponseRecord[] {
    return this.mirror.responsesByActor(actorUserId);
  }

  listResponses(): CallResponseRecord[] {
    return this.mirror.listResponses();
  }

  // ── the thesis thread ─────────────────────────────────────────────────────

  insertThesisUpdate(rec: ThesisUpdate): ThesisUpdate {
    if (!this.thesisTable) {
      throw new CallsError(
        "THESIS_UPDATES_UNAVAILABLE",
        "Thesis updates aren't available yet. Your original call is unchanged.",
        { details: { callId: rec.callId } },
      );
    }
    // The mirror enforces author-only, not hidden, length, and the per-call
    // cap — the same list as `call_thesis_updates_guard`.
    const stored = this.mirror.insertThesisUpdate(rec);
    this.queue.push(`insert ${THESIS_UPDATES_TABLE}/${rec.id}`, async () => {
      this.assertUuid(rec.id, `${THESIS_UPDATES_TABLE}.id`);
      this.assertUuid(rec.callId, `${THESIS_UPDATES_TABLE}.call_id`);
      this.assertUuid(rec.authorUserId, `${THESIS_UPDATES_TABLE}.author_user_id`);
      await this.pg.insert(
        THESIS_UPDATES_TABLE,
        [
          {
            id: stored.id,
            call_id: stored.callId,
            author_user_id: stored.authorUserId,
            body: stored.body,
            created_at: toTimestamptz(stored.createdAt),
          },
        ],
        // Append-only by trigger: a replay of the same id is the same fact.
        { onConflict: "id", ignoreDuplicates: true },
      );
    });
    return stored;
  }

  thesisUpdatesFor(callId: string): ThesisUpdate[] {
    return this.mirror.thesisUpdatesFor(callId);
  }

  thesisUpdatesAvailable(): boolean {
    return this.thesisTable;
  }

  // ── results (service-write only) ──────────────────────────────────────────

  /**
   * There is no `outcome` parameter here either: the mirror applies §3's rule
   * and hands back what it derived, and that is what is written. The SQL
   * trigger then re-derives it independently and refuses any disagreement —
   * which is the point. Nothing in this file computes an outcome and hopes to
   * win the argument.
   */
  writeResult(
    input: { callId: string; evidence: MarketResolutionRecord | null },
    at: number,
    opts: { actor: ResultWriteActor },
  ): { result: CallResult; changed: boolean } {
    const outcome = this.mirror.writeResult(input, at, opts);
    // An identical re-derivation is a no-op in the mirror — derivedAt included.
    // That is what makes the resolution synchroniser idempotent, so it must be
    // a no-op upstream too: no write, no churned timestamp.
    if (!outcome.changed) return outcome;

    const result = outcome.result;
    this.queue.push(`upsert ${RESULTS_TABLE}/${result.callId}`, async () => {
      if (result.marketResolutionId !== null && !isUuid(result.marketResolutionId)) {
        throw new PgrestError(
          `[persist] ${RESULTS_TABLE}/${result.callId}: market_resolution_id '${result.marketResolutionId}' is not a UUID, so the FK onto market_resolutions cannot be satisfied. A settled result without its venue evidence is not representable (contracts §0.2).`,
          { sqlState: "22P02", details: { callId: result.callId } },
        );
      }
      await this.pg.insert(
        RESULTS_TABLE,
        [
          {
            call_id: result.callId,
            outcome: result.outcome,
            resolution: result.resolution,
            resolved_at: toTimestamptzOrNull(result.resolvedAt),
            market_resolution_id: result.marketResolutionId,
            derived_at: toTimestamptz(result.derivedAt),
          },
        ],
        // PENDING -> settled is a legal UPDATE (the trigger allows it, and
        // forbids everything after), so this one really is a merge.
        { onConflict: "call_id" },
      );
    });

    return outcome;
  }

  getResult(callId: string): CallResult | undefined {
    return this.mirror.getResult(callId);
  }

  listResults(): CallResult[] {
    return this.mirror.listResults();
  }

  pendingResults(): CallResult[] {
    return this.mirror.pendingResults();
  }

  // ── cursors ───────────────────────────────────────────────────────────────

  getCursor(name: string): string | null {
    return this.mirror.getCursor(name);
  }

  setCursor(name: string, cursor: string | null): void {
    this.mirror.setCursor(name, cursor);
    this.queue.push(`upsert ${CURSORS_TABLE}/${CALLS_CURSOR_SOURCE}:${name}`, async () => {
      await this.pg.insert(
        CURSORS_TABLE,
        [
          {
            network: this.network,
            source: CALLS_CURSOR_SOURCE,
            cursor_key: name,
            last_signature: cursor,
            last_seen_at: toTimestamptz(this.clock.now()),
            updated_at: toTimestamptz(this.clock.now()),
          },
        ],
        { onConflict: "network,source,cursor_key" },
      );
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private assertUuid(value: string, column: string): void {
    if (isUuid(value)) return;
    throw new PgrestError(
      `[persist] ${column} is a UUID column and '${value}' is not a UUID. Ids reaching a persisted store must be UUIDs — see the newId override in src/calls/runtime.ts.`,
      { sqlState: "22P02", details: { column } },
    );
  }

  private async page<T>(table: string, params: () => URLSearchParams): Promise<T[]> {
    const out: T[] = [];
    const size = 1000;
    for (let offset = 0; offset <= this.maxRowsPerTable; offset += size) {
      const p = params();
      p.set("limit", String(size));
      p.set("offset", String(offset));
      const rows = await this.pg.select<T>(table, p);
      out.push(...rows);
      if (rows.length < size) return out;
    }
    throw new PgrestError(
      `[persist] ${table} has more than ${this.maxRowsPerTable} rows; refusing to hydrate a partial mirror (a partial mirror would mis-enforce uq_calls_one_live_per_user_market).`,
      { details: { table } },
    );
  }
}

// ── row shapes and mappers ───────────────────────────────────────────────────

// `bio` and `created_at` are on `public.users` since the remote baseline and
// are already granted to anon as public display columns
// (20260719161500_security_hardening_pii_columns.sql), so reading them here
// discloses nothing the profile row does not. `profile_image_id` is the app's
// fixed avatar choice (1..5), rendered for other people too (lockdown).
const USER_COLUMNS = "id,handle,full_name,profile_picture,profile_image_id,wallet_address,sns_domain,bio,created_at";

interface UserRow {
  id: string;
  handle: string | null;
  full_name: string | null;
  profile_picture: string | null;
  /** The app's fixed avatar (1..5); absent on rows read by older selects. */
  profile_image_id?: number | null;
  wallet_address: string | null;
  sns_domain: string | null;
  bio?: string | null;
  created_at?: string | null;
}

/**
 * `public.users` carries no display_name and no avatar_url column — it has
 * `handle`, `sns_domain`, `full_name` and `profile_picture` (001_complete_schema
 * plus the 20260715134226 additive ALTER). The fallbacks below never invent an
 * identity: a handle-less account falls back to its SNS domain, then to a short
 * form of its own canonical id, never to its wallet (§0.3 — a wallet is a
 * credential, and a handle is a public label).
 *
 * `settledCalls`/`correctCalls` are left at zero on purpose: `CallsService`
 * re-derives them from `call_results` on every read (`decorate()`), so a stored
 * count could only ever be a second, staler answer.
 */
export function personFromRow(row: UserRow): Person {
  const handle = row.handle ?? row.sns_domain ?? `user-${row.id.slice(0, 8)}`;
  const bio = row.bio?.trim();
  const joinedAt = parseTimestamptz(row.created_at ?? null);
  const avatarId = row.profile_image_id;
  return {
    id: row.id,
    handle,
    displayName: row.full_name ?? handle,
    // Only a real URL is a URL. Legacy rows hold app asset paths here, which
    // the client derives from avatarId instead.
    avatarUrl: row.profile_picture && /^https:\/\//.test(row.profile_picture) ? row.profile_picture : null,
    avatarId: typeof avatarId === "number" && Number.isInteger(avatarId) && avatarId >= 1 && avatarId <= 5 ? avatarId : null,
    walletAddress: row.wallet_address,
    settledCalls: 0,
    correctCalls: 0,
    // Present only when the row carries them: an absent join date is unknown,
    // never "today".
    ...(bio ? { bio } : {}),
    ...(joinedAt !== null ? { joinedAt } : {}),
  };
}

interface FollowRow {
  follower_user_id: string | null;
  followee_user_id: string | null;
}

const CALL_COLUMNS =
  "id,user_id,market_id,side,confidence,thesis,entry_probability,snapshot_id,entry_price,visibility,created_at,locked_at,parent_call_id,funding_state,hidden_at,hidden_reason";

interface CallRow {
  id: string;
  user_id: string;
  market_id: string;
  side: string;
  confidence: unknown;
  thesis: string | null;
  entry_probability: unknown;
  snapshot_id: string | null;
  entry_price?: unknown;
  visibility: string;
  created_at: string;
  locked_at: string;
  parent_call_id: string | null;
  funding_state: string;
  hidden_at: string | null;
  hidden_reason: string | null;
}

export function callFromRow(row: CallRow): CallRecord {
  return {
    id: row.id,
    userId: row.user_id,
    marketId: row.market_id,
    side: row.side as Side,
    confidence: parseNumeric(row.confidence),
    thesis: row.thesis,
    entryProbability: parseNumeric(row.entry_probability),
    snapshotId: row.snapshot_id,
    ...(row.entry_price ? { entryPrice: parseSharePrice(row.entry_price) } : {}),
    visibility: row.visibility as CallVisibility,
    createdAt: fromTimestamptz(row.created_at, `${CALLS_TABLE}.created_at`),
    lockedAt: fromTimestamptz(row.locked_at, `${CALLS_TABLE}.locked_at`),
    parentCallId: row.parent_call_id,
    fundingState: row.funding_state as FundingState,
    hiddenAt: parseTimestamptz(row.hidden_at),
    hiddenReason: row.hidden_reason,
  };
}

const RESPONSE_COLUMNS = "id,actor_user_id,target_call_id,kind,resulting_call_id,note,created_at";

interface ResponseRow {
  id: string;
  actor_user_id: string;
  target_call_id: string;
  kind: string;
  resulting_call_id: string | null;
  note: string | null;
  created_at: string;
}

export function responseFromRow(row: ResponseRow): CallResponseRecord {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    targetCallId: row.target_call_id,
    kind: row.kind as CallResponseKind,
    resultingCallId: row.resulting_call_id,
    note: row.note,
    createdAt: fromTimestamptz(row.created_at, `${RESPONSES_TABLE}.created_at`),
  };
}

const RESULT_COLUMNS = "call_id,outcome,resolution,resolved_at,market_resolution_id,derived_at";

interface ResultRow {
  call_id: string;
  outcome: string;
  resolution: string | null;
  resolved_at: string | null;
  market_resolution_id: string | null;
  derived_at: string;
}

/**
 * Reconstruct the venue evidence a stored `call_results` row CITES, so the row
 * can be replayed through `writeResult` — which derives the outcome itself.
 *
 * This is not a synthesised resolution: `call_results_settled_requires_evidence`
 * and the derivation trigger together guarantee that a non-PENDING row quotes
 * its `market_resolutions` row's `resolution` and `resolved_at` verbatim, so
 * these three fields ARE that row's, and they are the only three `writeResult`
 * reads. The authoritative resolutions live in Packet B's store.
 */
function evidenceFromResultRow(row: ResultRow, marketId: string): MarketResolutionRecord | null {
  if (row.market_resolution_id === null || row.resolution === null) return null;
  const resolvedAt = parseTimestamptz(row.resolved_at);
  if (resolvedAt === null) return null;
  return {
    id: row.market_resolution_id,
    marketId,
    // Descriptive only: `writeResult` reads id/marketId/resolution/resolvedAt.
    venue: "fixture" as VenueId,
    venueMarketId: "",
    resolution: row.resolution as Resolution,
    resolvedAt,
    evidenceSource: "",
    rawEvidence: null,
    recordedAt: parseTimestamptz(row.derived_at) ?? resolvedAt,
    demo: false,
  };
}

interface CursorRow {
  cursor_key: string;
  last_signature: string | null;
}

const THESIS_UPDATE_COLUMNS = "id,call_id,author_user_id,body,created_at";

interface ThesisUpdateRow {
  id: string;
  call_id: string;
  author_user_id: string;
  body: string;
  created_at: string;
}

export function thesisUpdateFromRow(row: ThesisUpdateRow): ThesisUpdate {
  return {
    id: row.id,
    callId: row.call_id,
    authorUserId: row.author_user_id,
    body: row.body,
    createdAt: fromTimestamptz(row.created_at, `${THESIS_UPDATES_TABLE}.created_at`),
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
