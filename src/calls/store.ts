/**
 * The BFF-side store for the social-call layer. Mirrors, one-for-one, the three
 * tables added by the Packet D migrations (calls, call_responses, call_results)
 * plus the person directory and the legacy/canonical follow graphs, so
 * the in-memory implementation and the SQL implementation enforce the SAME
 * invariants:
 *
 *   - a call is IMMUTABLE after lockedAt. The only fields any writer may change
 *     are hiddenAt/hiddenReason. Everything else throws — the exact list the
 *     `calls_guard_immutability` trigger enforces (§3).
 *   - a call is NEVER deleted. `deleteCall` exists only to refuse, because
 *     "deleting a public call hides it from distribution; it does not rewrite
 *     CallResult or accuracy history" (§3).
 *   - back/fade ALWAYS carry the actor's own resulting call, on the same market,
 *     on the same (back) or opposite (fade) side; challenge NEVER does (§3).
 *   - a CallResult is SERVICE-DERIVED ONLY. `writeResult` does not accept an
 *     outcome from anyone: it takes the venue evidence (or null) and derives the
 *     outcome itself through Packet B's `deriveCallOutcome`. A wrong outcome is
 *     not representable, so there is no admin override and no client input (§3).
 *   - a settled result is PERMANENT: it may be re-stated identically (which is
 *     what makes the resolution synchroniser idempotent) and nothing else.
 *
 * The SQL side encodes every one of these as a CHECK plus a BEFORE trigger (see
 * 20260913140000/140500/141000_social_calls_*.sql), so the invariants survive a
 * writer that never goes through this class — including our own service-role
 * backend, which RLS does not bind (§2).
 */

import { deriveCallOutcome, type MarketResolutionRecord } from "../prediction/types.ts";
import { CallsError } from "./errors.ts";
import { parseSharePrice, usableSharePrice } from "../prediction/sharePrices.ts";
import type {
  Call,
  CallRecord,
  CallResponseKind,
  CallResponseRecord,
  CallResult,
  Person,
} from "./types.ts";

/**
 * Who is attempting a `call_results` write. §5: "call_results is service-write
 * only." The SQL side has no INSERT/UPDATE/DELETE policy for anon or
 * authenticated at all; this is the same rule at the BFF layer, so a route that
 * forgot could not slip a client write through either.
 */
export type ResultWriteActor = "service" | "client";

/**
 * The columns §3 freezes after `lockedAt`, plus the ones §0.1 freezes by
 * calling a call "an immutable, timestamped statement by a person".
 *
 * `column` is the SQL name, so a test can assert the migration's trigger covers
 * exactly this list and the two implementations can never drift.
 */
export const IMMUTABLE_CALL_FIELDS: ReadonlyArray<{ field: keyof CallRecord; column: string; source: string }> = [
  // ── §3, verbatim ──
  { field: "marketId", column: "market_id", source: "§3" },
  { field: "side", column: "side", source: "§3" },
  { field: "entryProbability", column: "entry_probability", source: "§3" },
  { field: "snapshotId", column: "snapshot_id", source: "§3" },
  { field: "createdAt", column: "created_at", source: "§3" },
  { field: "fundingState", column: "funding_state", source: "§3 (free/funded provenance)" },
  // ── §0.1: "a free, immutable, timestamped statement by a person" ──
  { field: "id", column: "id", source: "§0.1" },
  { field: "userId", column: "user_id", source: "§0.1 (by a person)" },
  { field: "lockedAt", column: "locked_at", source: "§0.1 (timestamped)" },
  { field: "thesis", column: "thesis", source: "§0.1 (the statement)" },
  { field: "confidence", column: "confidence", source: "§0.1 (the statement)" },
  { field: "parentCallId", column: "parent_call_id", source: "§0.1 (lineage)" },
  { field: "visibility", column: "visibility", source: "§0.1 (the audience)" },
] as const;

/** The ONLY fields any writer may change on a locked call. */
export const MUTABLE_CALL_FIELDS: ReadonlyArray<keyof CallRecord> = ["hiddenAt", "hiddenReason"] as const;

export interface CallsStore {
  // ── people (mirrors public.users) ─────────────────────────────────────────
  upsertPerson(p: Person): Person;
  getPerson(userId: string): Person | undefined;
  getPersonByHandle(handle: string): Person | undefined;
  getPersonByWallet(wallet: string): Person | undefined;
  listPeople(): Person[];

  // ── follow graph (legacy follows + canonical person_follows) ─────────────
  follow(followerUserId: string, followeeUserId: string): void;
  unfollow(followerUserId: string, followeeUserId: string): void;
  isFollowing(followerUserId: string, followeeUserId: string): boolean;
  followingOf(followerUserId: string): string[];

  // ── calls ─────────────────────────────────────────────────────────────────
  insertCall(rec: CallRecord): CallRecord;
  getCall(callId: string): CallRecord | undefined;
  listCalls(): CallRecord[];
  liveCalls(): CallRecord[];
  liveCallsOnMarket(marketId: string): CallRecord[];
  liveCallByUserOnMarket(userId: string, marketId: string): CallRecord | undefined;
  callsByAuthor(userId: string): CallRecord[];
  /** The in-memory analogue of `calls_guard_immutability`. Refuses everything
   *  outside MUTABLE_CALL_FIELDS, for every caller. */
  attemptCallUpdate(callId: string, patch: Partial<CallRecord>): CallRecord;
  hideCall(callId: string, reason?: string | null): CallRecord;
  unhideCall(callId: string): CallRecord;
  /** Exists only to refuse. §3: a call is hidden, never deleted. */
  deleteCall(callId: string): never;

  // ── responses ─────────────────────────────────────────────────────────────
  insertResponse(rec: CallResponseRecord): CallResponseRecord;
  getResponse(responseId: string): CallResponseRecord | undefined;
  responsesForTarget(targetCallId: string): CallResponseRecord[];
  responseBy(actorUserId: string, targetCallId: string, kind: CallResponseKind): CallResponseRecord | undefined;
  responsesByActor(actorUserId: string): CallResponseRecord[];
  listResponses(): CallResponseRecord[];

  // ── results (service-write only) ──────────────────────────────────────────
  /**
   * Derive and store the result for one call from venue evidence, or from the
   * ABSENCE of venue evidence (which is PENDING and nothing else).
   *
   * There is no `outcome` parameter, by design: §3's rule is applied here and
   * only here, so a caller cannot supply a wrong one, an admin cannot override
   * one, and a client cannot suggest one.
   */
  writeResult(
    input: { callId: string; evidence: MarketResolutionRecord | null },
    at: number,
    opts: { actor: ResultWriteActor },
  ): { result: CallResult; changed: boolean };
  getResult(callId: string): CallResult | undefined;
  listResults(): CallResult[];
  pendingResults(): CallResult[];

  // ── cursors (restart-safe polling) ────────────────────────────────────────
  getCursor(name: string): string | null;
  setCursor(name: string, cursor: string | null): void;
}

const followKey = (a: string, b: string) => `${a}->${b}`;

export class InMemoryCallsStore implements CallsStore {
  private readonly people = new Map<string, Person>();
  private readonly follows = new Set<string>();
  private readonly calls = new Map<string, CallRecord>();
  private readonly responses = new Map<string, CallResponseRecord>();
  private readonly results = new Map<string, CallResult>();
  private readonly cursors = new Map<string, string | null>();

  // ── people ────────────────────────────────────────────────────────────────

  upsertPerson(p: Person): Person {
    this.people.set(p.id, p);
    return p;
  }

  getPerson(userId: string): Person | undefined {
    return this.people.get(userId);
  }

  getPersonByHandle(handle: string): Person | undefined {
    const wanted = handle.replace(/^@/, "").toLowerCase();
    for (const p of this.people.values()) {
      if (p.handle.replace(/^@/, "").toLowerCase() === wanted) return p;
    }
    return undefined;
  }

  getPersonByWallet(wallet: string): Person | undefined {
    for (const p of this.people.values()) if (p.walletAddress === wallet) return p;
    return undefined;
  }

  listPeople(): Person[] {
    return [...this.people.values()];
  }

  // ── follow graph ──────────────────────────────────────────────────────────

  follow(followerUserId: string, followeeUserId: string): void {
    if (followerUserId === followeeUserId) return; // follows_not_self
    this.follows.add(followKey(followerUserId, followeeUserId));
  }

  unfollow(followerUserId: string, followeeUserId: string): void {
    this.follows.delete(followKey(followerUserId, followeeUserId));
  }

  isFollowing(followerUserId: string, followeeUserId: string): boolean {
    return this.follows.has(followKey(followerUserId, followeeUserId));
  }

  followingOf(followerUserId: string): string[] {
    const out: string[] = [];
    const prefix = `${followerUserId}->`;
    for (const k of this.follows) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    return out;
  }

  // ── calls ─────────────────────────────────────────────────────────────────

  insertCall(rec: CallRecord): CallRecord {
    if (rec.entryPrice) {
      const price = parseSharePrice(rec.entryPrice);
      if (price.marketId !== rec.marketId || !usableSharePrice(price, rec.lockedAt) || rec.entryProbability !== null || rec.snapshotId !== null) {
        throw new CallsError("CALL_INVALID", "A Panta call must retain its own fresh share-price snapshot, never probability evidence.");
      }
      rec = { ...rec, entryPrice: price };
    }
    if (this.calls.has(rec.id)) {
      throw new CallsError("CALL_INVALID", `call ${rec.id} already exists`, { details: { callId: rec.id } });
    }
    if (rec.hiddenAt !== null) {
      // calls_guard_insert: a call may not be born hidden.
      throw new CallsError(
        "CALL_INVALID",
        "a call may not be created already hidden — the record of it having been made is the point (contracts §0.1)",
      );
    }
    const existing = this.liveCallByUserOnMarket(rec.userId, rec.marketId);
    if (existing) {
      // uq_calls_one_live_per_user_market. A second opinion would be an edit,
      // and a call is not editable.
      throw new CallsError("CALL_ALREADY_MADE", "you already have a live call on this market", {
        details: { callId: existing.id, marketId: rec.marketId },
      });
    }
    if (rec.parentCallId) {
      const parent = this.calls.get(rec.parentCallId);
      if (!parent) {
        throw new CallsError("CALL_NOT_FOUND", `parent call ${rec.parentCallId} does not exist`);
      }
      if (parent.marketId !== rec.marketId) {
        throw new CallsError(
          "CALL_PARENT_MISMATCH",
          "a Back/Fade must be on the same market as the call it came from",
          { details: { parentCallId: rec.parentCallId } },
        );
      }
    }
    rec = Object.freeze({ ...rec });
    this.calls.set(rec.id, rec);
    return rec;
  }

  getCall(callId: string): CallRecord | undefined {
    return this.calls.get(callId);
  }

  listCalls(): CallRecord[] {
    return [...this.calls.values()];
  }

  liveCalls(): CallRecord[] {
    return this.listCalls().filter((c) => c.hiddenAt === null);
  }

  liveCallsOnMarket(marketId: string): CallRecord[] {
    return this.liveCalls().filter((c) => c.marketId === marketId);
  }

  liveCallByUserOnMarket(userId: string, marketId: string): CallRecord | undefined {
    return this.liveCalls().find((c) => c.userId === userId && c.marketId === marketId);
  }

  callsByAuthor(userId: string): CallRecord[] {
    return this.listCalls().filter((c) => c.userId === userId);
  }

  /**
   * THE IMMUTABILITY GUARD. Mirrors `calls_guard_immutability` exactly: the only
   * columns any writer may change after INSERT are hiddenAt and hiddenReason.
   */
  attemptCallUpdate(callId: string, patch: Partial<CallRecord>): CallRecord {
    const current = this.require(callId);
    for (const { field, column, source } of IMMUTABLE_CALL_FIELDS) {
      if (!(field in patch)) continue;
      if (patch[field] === current[field]) continue;
      throw new CallsError(
        "CALL_IMMUTABLE",
        `calls.${column} is immutable after lockedAt (call ${callId}; ${source}). To withdraw a call, hide it.`,
        { details: { callId, field: String(field), column } },
      );
    }
    for (const key of Object.keys(patch) as (keyof CallRecord)[]) {
      if (!MUTABLE_CALL_FIELDS.includes(key)) {
        throw new CallsError("CALL_IMMUTABLE", `calls.${String(key)} is not a mutable column (call ${callId})`, {
          details: { callId, field: String(key) },
        });
      }
    }
    const updated: CallRecord = { ...current, ...patch };
    this.calls.set(callId, updated);
    return updated;
  }

  hideCall(callId: string, reason: string | null = null): CallRecord {
    const current = this.require(callId);
    if (current.hiddenAt !== null) return current; // idempotent
    return this.attemptCallUpdate(callId, { hiddenAt: Date.now(), hiddenReason: reason });
  }

  unhideCall(callId: string): CallRecord {
    return this.attemptCallUpdate(callId, { hiddenAt: null, hiddenReason: null });
  }

  deleteCall(callId: string): never {
    throw new CallsError(
      "CALL_NOT_DELETABLE",
      `a call is never deleted (call ${callId}). Hide it: call_results and accuracy history must survive (contracts §3).`,
      { details: { callId } },
    );
  }

  private require(callId: string): CallRecord {
    const c = this.calls.get(callId);
    if (!c) throw new CallsError("CALL_NOT_FOUND", `no such call ${callId}`, { details: { callId } });
    return c;
  }

  // ── responses ─────────────────────────────────────────────────────────────

  insertResponse(rec: CallResponseRecord): CallResponseRecord {
    const target = this.require(rec.targetCallId);

    if (target.userId === rec.actorUserId) {
      throw new CallsError("RESPONSE_SELF", `you cannot ${rec.kind} your own call`, {
        details: { targetCallId: rec.targetCallId },
      });
    }
    if (this.responseBy(rec.actorUserId, rec.targetCallId, rec.kind)) {
      throw new CallsError("RESPONSE_DUPLICATE", `you have already ${rec.kind}ed this call`, {
        details: { targetCallId: rec.targetCallId, kind: rec.kind },
      });
    }

    // call_responses_resulting_call_matches_kind: back/fade ALWAYS carry the
    // actor's own call; challenge NEVER does.
    const shouldHaveCall = rec.kind === "back" || rec.kind === "fade";
    if (shouldHaveCall && !rec.resultingCallId) {
      throw new CallsError("CALL_INVALID", `a ${rec.kind} must create the actor's own call (contracts §3)`);
    }
    if (!shouldHaveCall && rec.resultingCallId) {
      throw new CallsError(
        "CALL_INVALID",
        "a challenge creates no call: it carries no amount, no escrow and no transaction (contracts §3)",
      );
    }

    if (rec.resultingCallId) {
      const resulting = this.require(rec.resultingCallId);
      if (resulting.userId !== rec.actorUserId) {
        throw new CallsError("CALL_INVALID", `a ${rec.kind} must create the ACTOR'S OWN call (contracts §3)`);
      }
      if (resulting.marketId !== target.marketId) {
        throw new CallsError("CALL_PARENT_MISMATCH", `a ${rec.kind} must be on the same market as its target`);
      }
      if (rec.kind === "back" && resulting.side !== target.side) {
        throw new CallsError("CALL_INVALID", "a back must take the SAME side as the call it backs");
      }
      if (rec.kind === "fade" && resulting.side === target.side) {
        throw new CallsError("CALL_INVALID", "a fade must take the OPPOSITE side to the call it fades");
      }
    }

    this.responses.set(rec.id, rec);
    return rec;
  }

  getResponse(responseId: string): CallResponseRecord | undefined {
    return this.responses.get(responseId);
  }

  responsesForTarget(targetCallId: string): CallResponseRecord[] {
    return this.listResponses().filter((r) => r.targetCallId === targetCallId);
  }

  responseBy(actorUserId: string, targetCallId: string, kind: CallResponseKind): CallResponseRecord | undefined {
    return this.listResponses().find(
      (r) => r.actorUserId === actorUserId && r.targetCallId === targetCallId && r.kind === kind,
    );
  }

  responsesByActor(actorUserId: string): CallResponseRecord[] {
    return this.listResponses().filter((r) => r.actorUserId === actorUserId);
  }

  listResponses(): CallResponseRecord[] {
    return [...this.responses.values()];
  }

  // ── results ───────────────────────────────────────────────────────────────

  writeResult(
    input: { callId: string; evidence: MarketResolutionRecord | null },
    at: number,
    opts: { actor: ResultWriteActor },
  ): { result: CallResult; changed: boolean } {
    if (opts.actor !== "service") {
      // §5: "call_results is service-write only." The SQL side simply has no
      // write policy for anon/authenticated; this is the same rule one layer up.
      throw new CallsError(
        "RESULT_SERVICE_WRITE_ONLY",
        "call_results is service-write only: no client, no admin, no friend and no model may write a result (contracts §0.2/§5)",
        { details: { callId: input.callId } },
      );
    }

    const call = this.require(input.callId);
    const evidence = input.evidence;

    if (evidence && evidence.marketId !== call.marketId) {
      throw new CallsError(
        "RESULT_DERIVATION_VIOLATION",
        `resolution ${evidence.id} is for market ${evidence.marketId}, but call ${call.id} is on market ${call.marketId}`,
        { details: { callId: call.id } },
      );
    }

    // ★ §3's rule, applied in exactly one place. There is no `outcome`
    //   parameter anywhere in this method's signature: a wrong outcome is not
    //   representable, so there is no admin override and no client input.
    const resolution = evidence ? evidence.resolution : null;
    const next: CallResult = {
      callId: call.id,
      outcome: deriveCallOutcome(call.side, resolution),
      resolution,
      resolvedAt: evidence ? evidence.resolvedAt : null,
      marketResolutionId: evidence ? evidence.id : null,
      derivedAt: at,
    };

    const existing = this.results.get(call.id);
    if (existing) {
      const identical =
        existing.outcome === next.outcome &&
        existing.resolution === next.resolution &&
        existing.resolvedAt === next.resolvedAt &&
        existing.marketResolutionId === next.marketResolutionId;

      // Re-stating the same derivation is a NO-OP, derivedAt included. That is
      // what makes the synchroniser idempotent: running it twice changes
      // nothing, not even a timestamp.
      if (identical) return { result: existing, changed: false };

      if (existing.outcome !== "PENDING") {
        // A settled result is permanent. No admin override, ever.
        throw new CallsError(
          "RESULT_DERIVATION_VIOLATION",
          `call ${call.id} is already settled ${existing.outcome} from venue evidence ${existing.marketResolutionId}; a settled result is permanent (contracts §0.2/§3)`,
          { details: { callId: call.id, from: existing.outcome, to: next.outcome } },
        );
      }
    }

    this.results.set(call.id, next);
    return { result: next, changed: true };
  }

  getResult(callId: string): CallResult | undefined {
    return this.results.get(callId);
  }

  listResults(): CallResult[] {
    return [...this.results.values()];
  }

  pendingResults(): CallResult[] {
    return this.listResults().filter((r) => r.outcome === "PENDING");
  }

  // ── cursors ───────────────────────────────────────────────────────────────

  getCursor(name: string): string | null {
    return this.cursors.get(name) ?? null;
  }

  setCursor(name: string, cursor: string | null): void {
    this.cursors.set(name, cursor);
  }
}

/** Accuracy over SETTLED calls only. VOID is excluded from both sides of the
 *  ratio: a void is never a win and never a loss (§3). */
export function accuracyOf(results: readonly CallResult[]): { settledCalls: number; correctCalls: number } {
  let settledCalls = 0;
  let correctCalls = 0;
  for (const r of results) {
    if (r.outcome === "CORRECT") {
      settledCalls++;
      correctCalls++;
    } else if (r.outcome === "INCORRECT") {
      settledCalls++;
    }
  }
  return { settledCalls, correctCalls };
}

/** A call the wire may carry. Hidden calls never reach a distribution surface. */
export const isDistributable = (c: CallRecord): c is CallRecord => c.hiddenAt === null;

export type { Call };
