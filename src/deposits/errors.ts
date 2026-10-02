/**
 * Every message here is our own copy. Provider bodies, keys, client secrets
 * and addresses never reach a message, a cause, or a log line.
 */

export type DepositErrorCode =
  | "UNAVAILABLE"
  | "SIGNED_OUT"
  | "NOT_LINKED"
  | "NO_WALLET"
  | "WALLET_NOT_YOURS"
  | "EMAIL_REQUIRED"
  | "AMOUNT_OUT_OF_RANGE"
  | "LIMIT_REACHED"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "NOT_AWAITING_PROOF"
  | "BAD_PROOF"
  | "WALLET_LINK_CONFLICT"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "BALANCE_UNAVAILABLE";

export class DepositError extends Error {
  constructor(
    readonly code: DepositErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DepositError";
  }
}

export const isDepositError = (e: unknown): e is DepositError => e instanceof DepositError;

/** What went wrong at Crossmint, reduced to what we act on. Never the body. */
export class CrossmintHttpError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode: string | null,
    readonly limit: { hoursUntilReset: number | null; remainingUsd: string | null } | null,
  ) {
    super(`Crossmint HTTP ${status}`);
    this.name = "CrossmintHttpError";
  }
}

const hours = (h: number | null) =>
  h === null ? "later" : h <= 1 ? "in about an hour" : `in about ${Math.ceil(h)} hours`;

/** Map a transport failure to copy. Unknown failures read as "try again". */
export function depositErrorFromProvider(error: unknown): DepositError {
  if (isDepositError(error)) return error;
  if (!(error instanceof CrossmintHttpError)) {
    return new DepositError("PROVIDER_UNAVAILABLE", "We couldn't reach our payment partner. Nothing was charged. Try again in a moment.");
  }
  const { status, providerCode, limit } = error;
  if (providerCode === "daily_transaction_exceeded") {
    const left = limit?.remainingUsd && limit.remainingUsd !== "0" ? ` You can still add up to $${limit.remainingUsd} today.` : "";
    return new DepositError("LIMIT_REACHED", `You've reached today's card limit.${left} It resets ${hours(limit?.hoursUntilReset ?? null)}.`);
  }
  if (providerCode === "single_purchase_exceeded") {
    return new DepositError("LIMIT_REACHED", "That's above the limit for a single card payment. Try a smaller amount.");
  }
  if (status === 429) {
    return new DepositError("RATE_LIMITED", "Lots of people are adding funds right now. Try again in a minute.");
  }
  if (status === 404) return new DepositError("NOT_FOUND", "We couldn't find that payment.");
  if (status === 409) {
    return new DepositError("WALLET_LINK_CONFLICT", "This wallet is already connected to another payment account. Contact support and we'll sort it out.");
  }
  if (status === 401 || status === 403) {
    return new DepositError("UNAVAILABLE", "Adding funds isn't set up correctly yet. Nothing was charged.");
  }
  if (status >= 400 && status < 500) {
    return new DepositError("PROVIDER_REJECTED", "Our payment partner couldn't start this payment. Nothing was charged.");
  }
  return new DepositError("PROVIDER_UNAVAILABLE", "We couldn't reach our payment partner. Nothing was charged. Try again in a moment.");
}
