/**
 * Trust & safety refusals. Every `message` is copy a person reads verbatim
 * (the mobile client renders CallsRejectedException.message as-is), so each
 * one says what happened and what to do.
 */

export type TrustErrorCode =
  | "TRUST_SIGNED_OUT"
  | "TRUST_NOT_ADMIN"
  | "TRUST_RATE_LIMITED"
  | "TRUST_CONTENT_REFUSED"
  | "TRUST_PERSON_NOT_FOUND"
  | "TRUST_CALL_NOT_FOUND"
  | "TRUST_REPORT_NOT_FOUND"
  | "TRUST_SELF"
  | "TRUST_BLOCKED"
  | "TRUST_ATTESTATION_REQUIRED"
  | "TRUST_TERMS_CHANGED"
  | "TRUST_CONFIRMATION_MISMATCH"
  | "TRUST_DELETION_FAILED"
  | "TRUST_DELETION_RETRY"
  /** The Chumbucket wallet still holds money, or we could not tell. */
  | "TRUST_FUNDS_REMAIN"
  | "TRUST_NOT_CONFIGURED"
  | "TRUST_STORE_UNAVAILABLE";

export class TrustError extends Error {
  readonly code: TrustErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: TrustErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TrustError";
    this.code = code;
    this.details = details;
  }
}

export const isTrustError = (e: unknown): e is TrustError => e instanceof TrustError;
