import { z } from "zod";
import { VenueError } from "./errors.ts";
import { uuidV5 } from "./pgrest.ts";
import { PANTA_PAYLOAD_VERSION, pantaPriceEvidenceMatches } from "./PantaVenue.ts";
import { PANTA_CHAIN_PAYLOAD_VERSION, pantaChainPriceEvidenceMatches } from "./PantaProgram.ts";
import type { IndicativePrices, RawPayload } from "./PredictionVenue.ts";

// These are independent unit prices, NOT probabilities or user stake sizes.
// `currency` is the market's quote asset: USDC from Panta's partner API, SOL
// from the program account of a SOL-quoted market. Never a USD conversion.
const decimal = z.string().regex(/^(0|[1-9]\d{0,30})(\.\d{1,18})?$/);
export const SHARE_PRICE_CURRENCIES = ["USDC", "SOL"] as const;
export type ShareCurrency = (typeof SHARE_PRICE_CURRENCIES)[number];
export const sharePriceSchema = z.object({
  id: z.string().uuid(), marketId: z.string().uuid(), venue: z.literal("panta"),
  currency: z.enum(SHARE_PRICE_CURRENCIES), unit: z.literal("per_share"),
  yesPrice: decimal.nullable(), noPrice: decimal.nullable(),
  observedAt: z.number().int().positive().safe(), source: z.literal("venue"),
  attribution: z.literal("Powered by Panta"), executable: z.literal(false),
}).strict();
export type SharePriceSnapshot = z.infer<typeof sharePriceSchema>;
export const SHARE_PRICE_MAX_AGE_MS = 600_000;
export const sharePriceUuid = (marketId: string, observedAt: number): string =>
  uuidV5(`share-price:panta:${marketId}:${observedAt}`);

export function parseSharePrice(value: unknown): SharePriceSnapshot {
  const parsed = sharePriceSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== sharePriceUuid(parsed.data.marketId, parsed.data.observedAt)) {
    throw new VenueError("VENUE_SCHEMA", "Invalid Panta share-price snapshot", { venue: "panta" });
  }
  return Object.freeze(parsed.data);
}

export function sharePriceFromIndicative(prices: IndicativePrices): SharePriceSnapshot {
  if (prices.demo || prices.venue !== "panta") {
    throw new VenueError("VENUE_SCHEMA", "Only live Panta observations can become share-price snapshots", { venue: "panta" });
  }
  return parseSharePrice({ id: sharePriceUuid(prices.marketId, prices.observedAt), marketId: prices.marketId,
    venue: prices.venue, currency: prices.currency, unit: prices.unit, yesPrice: prices.yesPrice,
    noPrice: prices.noPrice, observedAt: prices.observedAt, source: "venue",
    attribution: prices.attribution, executable: prices.executable });
}

/** USDC prices are evidenced by a partner-API row (payload version 1), SOL
 *  prices by the program account they were derived from (version 2). */
export function assertSharePriceEvidence(s: SharePriceSnapshot, raw: RawPayload | null, venueMarketId: string): void {
  const matches = !!raw && raw.venue === "panta" && raw.venueMarketId === venueMarketId && raw.fetchedAt === s.observedAt && (
    (raw.payloadVersion === PANTA_PAYLOAD_VERSION && s.currency === "USDC" && pantaPriceEvidenceMatches(raw.body, s)) ||
    (raw.payloadVersion === PANTA_CHAIN_PAYLOAD_VERSION && s.currency === "SOL" && pantaChainPriceEvidenceMatches(raw.body, s)));
  if (!matches) {
    throw new VenueError("VENUE_SCHEMA", "Panta share prices require matching captured venue evidence", { venue: "panta" });
  }
}

export function usableSharePrice(s: SharePriceSnapshot | undefined, now: number): s is SharePriceSnapshot {
  return !!s && s.yesPrice !== null && s.noPrice !== null &&
    s.observedAt <= now && now - s.observedAt <= SHARE_PRICE_MAX_AGE_MS;
}
