/**
 * Domain errors. A command is rejected with one of these; the API layer maps the
 * code to a transport error. Keep these about *rules*, not infrastructure.
 */

export type DomainErrorCode =
  | "NOT_SIGNED"
  | "ALREADY_SIGNED"
  | "INSUFFICIENT_BALANCE"
  | "FUNDS_LOCKED"
  | "MATCH_NOT_OPEN"
  | "MATCH_LOCKED"
  | "UNKNOWN_MARKET"
  | "UNKNOWN_BUCKET"
  | "DUPLICATE_CALL"
  | "DUPLICATE_DEPOSIT"
  | "STAKE_TOO_SMALL"
  | "RATE_LIMITED" // too many paid (LLM) calls — per-wallet bucket or global cap
  | "CONFLICT" // optimistic-concurrency clash on the stream
  | "INVALID";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    if (details) this.details = details;
  }
}

export const fail = (
  code: DomainErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never => {
  throw new DomainError(code, message, details);
};
