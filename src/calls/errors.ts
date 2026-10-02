/**
 * Packet D failures.
 *
 * Deliberately separate from `src/domain/errors.ts` (integration-owned) and
 * from `src/prediction/errors.ts` (Packet B's infrastructure facts about a
 * venue). These are rules of the SOCIAL layer.
 *
 * Every code maps to exactly one of the four exception classes the mobile slice
 * already distinguishes (`calls_repository.dart`):
 *
 *   transport/network failure  -> CallsOfflineException
 *   401 / unauthenticated      -> CallsSignedOutException
 *   validation/business refusal-> CallsRejectedException
 *   anything else              -> CallsFailure
 *
 * The mapping lives in `src/api/calls.ts`; this file owns the codes.
 */

export type CallsErrorCode =
  // ── signed out / not this user (-> CallsSignedOutException) ──
  /** No credential at all on a write. */
  | "CALLS_SIGNED_OUT"
  /** A credential that resolves to no canonical public.users.id (§0.3). */
  | "CALLS_USER_UNLINKED"

  // ── refusals (-> CallsRejectedException) ──
  | "CALL_MARKET_UNKNOWN"
  /** The market is not accepting new calls (not OPEN). */
  | "CALL_MARKET_CLOSED"
  | "CALL_NOT_FOUND"
  | "CALL_HIDDEN"
  /** The caller may not see this call (a followers-only row). */
  | "CALL_NOT_VISIBLE"
  /** One live call per person per market. A second opinion would be an edit. */
  | "CALL_ALREADY_MADE"
  | "CALL_INVALID"
  /** A Back/Fade parent that is not on the same market. */
  | "CALL_PARENT_MISMATCH"
  | "RESPONSE_SELF"
  | "RESPONSE_DUPLICATE"
  | "PERSON_NOT_FOUND"
  | "FOLLOW_SELF"
  /** Only a call's author may append to its thesis thread. */
  | "THESIS_NOT_AUTHOR"
  /** A thread is capped at MAX_THESIS_UPDATES_PER_CALL. */
  | "THESIS_UPDATE_LIMIT"
  /** The durable table for updates is not present yet (migration pending). */
  | "THESIS_UPDATES_UNAVAILABLE"

  // ── invariants the service must never be able to break (-> CallsFailure) ──
  /** An attempt to change a column §3 freezes after lockedAt. */
  | "CALL_IMMUTABLE"
  /** An attempt to remove a call row rather than hide it. */
  | "CALL_NOT_DELETABLE"
  /** A client tried to write a call_results row. Service-write only (§5). */
  | "RESULT_SERVICE_WRITE_ONLY"
  /** A result that disagrees with §3's derivation, or a settled result rewritten. */
  | "RESULT_DERIVATION_VIOLATION";

/** Codes the client must render as "sign in", not as "something went wrong". */
const SIGNED_OUT: ReadonlySet<CallsErrorCode> = new Set<CallsErrorCode>([
  "CALLS_SIGNED_OUT",
  "CALLS_USER_UNLINKED",
]);

/** Codes that are an understood, legitimate refusal. */
const REJECTED: ReadonlySet<CallsErrorCode> = new Set<CallsErrorCode>([
  "CALL_MARKET_UNKNOWN",
  "CALL_MARKET_CLOSED",
  "CALL_NOT_FOUND",
  "CALL_HIDDEN",
  "CALL_NOT_VISIBLE",
  "CALL_ALREADY_MADE",
  "CALL_INVALID",
  "CALL_PARENT_MISMATCH",
  "RESPONSE_SELF",
  "RESPONSE_DUPLICATE",
  "PERSON_NOT_FOUND",
  "FOLLOW_SELF",
  "THESIS_NOT_AUTHOR",
  "THESIS_UPDATE_LIMIT",
  "THESIS_UPDATES_UNAVAILABLE",
]);

export interface CallsErrorInit {
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class CallsError extends Error {
  readonly code: CallsErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: CallsErrorCode, message: string, init: CallsErrorInit = {}) {
    super(message);
    this.name = "CallsError";
    this.code = code;
    this.details = init.details;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  get signedOut(): boolean {
    return SIGNED_OUT.has(this.code);
  }

  get rejected(): boolean {
    return REJECTED.has(this.code);
  }
}

export const isCallsError = (e: unknown): e is CallsError => e instanceof CallsError;
