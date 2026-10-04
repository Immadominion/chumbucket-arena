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
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export class MoneyError extends Error {
  constructor(readonly code: MoneyErrorCode, message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export const isMoneyError = (e: unknown): e is MoneyError => e instanceof MoneyError;

export const MONEY_OFF_COPY = "Calls with money aren't available yet.";
export const IN_FLIGHT_COPY = "Your money is still going through. Check back in a moment.";
