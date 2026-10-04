/** Money calls' refusals. Every message is copy a person reads; no provider text, no ids, no secrets. */
export type MoneyErrorCode =
  | "DISABLED"
  | "SIGNED_OUT"
  | "NOT_LINKED"
  | "NO_WALLET"
  | "WALLET_NOT_LINKED"
  | "AMOUNT"
  | "NOT_FOUND"
  | "STATE"
  | "IN_FLIGHT"
  | "IDEMPOTENCY_CONFLICT"
  | "MARKET_CLOSED"
  | "NOT_TRADABLE"
  | "PRICE_UNAVAILABLE"
  | "PRICE_MOVED"
  | "TRANSFER_IN_FLIGHT"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export class MoneyError extends Error {
  /**
   * Machine-readable facts the client branches on, sent as the error's
   * `data.details` (src/api/trpc.ts): always a stable `reason` (the code,
   * unless a more precise one is given, e.g. CALL_EXPIRED / REVIEW_EXPIRED),
   * plus our own ids where useful. Never provider text.
   */
  readonly publicDetails: Record<string, string>;
  constructor(readonly code: MoneyErrorCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = "MoneyError";
    this.publicDetails = { reason: code, ...details };
  }
}

export const isMoneyError = (e: unknown): e is MoneyError => e instanceof MoneyError;

export const MONEY_OFF_COPY = "Calls with money aren't available yet.";
export const IN_FLIGHT_COPY = "Your money is still going through. Check back in a moment.";
