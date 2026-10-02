/**
 * Market-creation refusals. Every message is copy a person can read, because the
 * mobile transport renders a 4xx message verbatim. Provider bodies are never
 * echoed: a Panta refusal is reduced to an allowlisted code and field name.
 */

export type MarketCreationErrorCode =
  | "MC_DISABLED"           // the server switch or schema gate is off
  | "MC_SIGNED_OUT"         // no verified canonical session
  | "MC_FORBIDDEN"          // not the proposer / not a reviewer
  | "MC_NOT_FOUND"
  | "MC_INVALID"            // the draft breaks a rule; `field` says which
  | "MC_CONFLICT"           // idempotency or state race
  | "MC_LIMIT"              // too many open proposals
  | "MC_STATE"              // the action does not fit the proposal's state
  | "MC_FEE_TOO_HIGH"       // Panta's quoted fee exceeds the server cap
  | "MC_PANTA_REFUSED"      // Panta refused; providerCode/field say why
  | "MC_PANTA_UNAVAILABLE"  // transport/5xx/timeout; nothing was created
  | "MC_RATE_LIMITED"
  | "MC_SCHEMA"             // Panta's response or transaction broke our bounds
  | "MC_UNVERIFIED";        // a broadcast whose outcome is not yet proven

export class MarketCreationError extends Error {
  readonly code: MarketCreationErrorCode;
  readonly field: string | undefined;
  readonly providerCode: string | undefined;
  constructor(code: MarketCreationErrorCode, message: string, init: { field?: string; providerCode?: string } = {}) {
    super(message);
    this.name = "MarketCreationError";
    this.code = code;
    this.field = init.field;
    this.providerCode = init.providerCode;
  }
}

export const isMarketCreationError = (e: unknown): e is MarketCreationError => e instanceof MarketCreationError;

/** Panta error codes we know (docs.panta.market/guides/errors.md). Others are "unknown". */
export const PANTA_CREATE_CODES = new Set([
  "INVALID_MARKET_PARAMS", "DUPLICATE_MARKET", "CREATE_NOT_PERMITTED", "UNAUTHORIZED", "FORBIDDEN",
  "RATE_LIMITED", "CREATE_EXPIRED", "TX_NOT_FOUND", "TX_FAILED", "TX_MISMATCH", "TX_FEE_MISMATCH",
  "UPLOAD_NOT_CONFIGURED", "INTERNAL_ERROR",
]);

/** Panta create field names we may surface (they are our own wire names too). */
export const PANTA_CREATE_FIELDS = new Set([
  "wallet", "question", "resolutionRule", "sourcesOfTruth", "category", "startTime", "endTime",
  "resolutionTime", "imageUrl", "marketType", "eventInProgress", "title", "description", "region",
  "oracle", "createId", "signature",
]);

/** Fixed, readable copy for a Panta refusal. Never the provider's own text. */
export function pantaRefusalMessage(providerCode: string | undefined, field: string | undefined): string {
  switch (providerCode) {
    case "DUPLICATE_MARKET":
      return "This wallet has already created a market with this exact question on Panta.";
    case "CREATE_NOT_PERMITTED":
      return "Panta has not enabled market creation for Chumbucket right now. Nothing was charged.";
    case "CREATE_EXPIRED":
      return "That Panta create session expired. Review a fresh fee quote.";
    case "TX_NOT_FOUND":
      return "Panta has not seen the transaction confirmed yet. Check again shortly.";
    case "TX_FAILED":
      return "The create transaction failed on Solana. Nothing was created.";
    case "TX_MISMATCH":
    case "TX_FEE_MISMATCH":
      return "Panta could not match the transaction to the reviewed market. It was not registered.";
    case "UPLOAD_NOT_CONFIGURED":
      return "Panta's image upload is unavailable right now. Try again later.";
    case "RATE_LIMITED":
      return "Panta is busy. Try again in a minute.";
    case "INVALID_MARKET_PARAMS": {
      const what: Record<string, string> = {
        question: "the question", resolutionRule: "the rules", sourcesOfTruth: "the source links",
        category: "the category", startTime: "the start time", endTime: "the close time",
        resolutionTime: "the result time", imageUrl: "the cover image", wallet: "the wallet",
        description: "the description",
      };
      return field && what[field]
        ? `Panta refused ${what[field]} for this market. Edit it and propose again.`
        : "Panta refused these market details.";
    }
    default:
      return "Panta refused this market.";
  }
}
