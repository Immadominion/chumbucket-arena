/**
 * Adapter-level failures. Deliberately separate from src/domain/errors.ts: these
 * are *infrastructure* facts about a venue (it timed out, it rate-limited us, it
 * changed its wire shape), not rules of the game.
 *
 * Every message and every detail is redacted on construction, so an API key can
 * never escape through a thrown error (contracts §4).
 */

import { redactDeep, redactSecrets } from "./redact.ts";
import type { VenueId } from "./types.ts";

export type VenueErrorCode =
  /** The provider's wire shape changed. FAIL LOUDLY — never write a partial market. */
  | "VENUE_SCHEMA"
  | "VENUE_TIMEOUT"
  | "VENUE_RATE_LIMITED"
  /** 5xx or transport failure. */
  | "VENUE_UNAVAILABLE"
  /** 4xx that is our fault, not theirs. */
  | "VENUE_BAD_REQUEST"
  | "VENUE_NOT_FOUND"
  /** The circuit breaker is open; we did not even ask. */
  | "CIRCUIT_OPEN"
  /** The server-side `funded_positions` kill switch is off. */
  | "FUNDED_POSITIONS_DISABLED"
  /** Same idempotency key, different order body. */
  | "IDEMPOTENCY_CONFLICT"
  /** A funding-state transition that the lifecycle forbids (e.g. anything → FILLED off-reconciliation). */
  | "INVALID_TRANSITION"
  /** Adapter/config misuse caught before any network call. */
  | "VENUE_MISCONFIGURED"
  /** The signing wallet is not one of the account's own proven wallets. */
  | "WALLET_NOT_LINKED";

/** Codes worth retrying with backoff. A schema change is NOT one of them. */
const RETRYABLE: ReadonlySet<VenueErrorCode> = new Set<VenueErrorCode>([
  "VENUE_TIMEOUT",
  "VENUE_RATE_LIMITED",
  "VENUE_UNAVAILABLE",
]);

/** Codes that count as "the venue is unhealthy" for the circuit breaker. */
const CIRCUIT_FAULTS: ReadonlySet<VenueErrorCode> = new Set<VenueErrorCode>([
  "VENUE_TIMEOUT",
  "VENUE_RATE_LIMITED",
  "VENUE_UNAVAILABLE",
  "VENUE_SCHEMA",
]);

export interface VenueErrorInit {
  venue?: VenueId;
  details?: Record<string, unknown>;
  /** Honour an upstream Retry-After, in milliseconds. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class VenueError extends Error {
  readonly code: VenueErrorCode;
  readonly venue: VenueId | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: VenueErrorCode, message: string, init: VenueErrorInit = {}) {
    super(redactSecrets(message));
    this.name = "VenueError";
    this.code = code;
    this.venue = init.venue;
    this.details = init.details ? redactDeep(init.details) : undefined;
    this.retryAfterMs = init.retryAfterMs;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  get countsAsCircuitFault(): boolean {
    return CIRCUIT_FAULTS.has(this.code);
  }
}

export const isVenueError = (e: unknown): e is VenueError => e instanceof VenueError;

/**
 * The single place an adapter admits "I do not understand this payload". Throwing
 * this MUST abort the whole normalisation: a half-parsed market is worse than no
 * market, because a call or a receipt can be written against it.
 */
export function schemaError(
  venue: VenueId,
  what: string,
  details: Record<string, unknown> = {},
): VenueError {
  return new VenueError(
    "VENUE_SCHEMA",
    `${venue}: unexpected wire shape — ${what}. Refusing to write a partially-parsed market.`,
    { venue, details },
  );
}
