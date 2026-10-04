/**
 * What a served Panta market says about money: its quote asset, and whether
 * Chumbucket's trade path can trade it. Calls never depend on either.
 *
 * Derived from `payloadVersion`, the persisted column that names the
 * normalisation which wrote the row (venue_markets.payload_version), because
 * a mirrored row's raw payload is not retained in memory after a restart or
 * under load. Version 1 is Panta's partner API, which lists only USDC
 * markets; version 2 is a SOL-quoted market read from its program account.
 *
 * `VenueMarket` itself is frozen (contracts §3), so these ride beside it on
 * the wire, as `volumeUsdc` does in the catalog.
 */
import { PANTA_CHAIN_PAYLOAD_VERSION } from "./PantaProgram.ts";
import { PANTA_PAYLOAD_VERSION } from "./PantaVenue.ts";
import type { VenueMarket } from "./types.ts";

export type QuoteCurrency = "USDC" | "SOL";

export interface MarketMoneyFields {
  /** The market's own quote asset; null for a normalisation this build does not know. */
  quoteCurrency: QuoteCurrency | null;
  /** True only where Chumbucket's trade path (Panta's USDC primary buy) works. */
  tradable: boolean;
}

/** The quote asset of a Panta market, or null for any other venue or an
 *  unknown normalisation (which is then never offered for trading). */
export function pantaQuoteCurrency(market: Pick<VenueMarket, "venue" | "payloadVersion">): QuoteCurrency | null {
  if (market.venue !== "panta") return null;
  if (market.payloadVersion === PANTA_PAYLOAD_VERSION) return "USDC";
  if (market.payloadVersion === PANTA_CHAIN_PAYLOAD_VERSION) return "SOL";
  return null;
}

/** Whether Chumbucket can place a trade on this market. */
export const pantaTradable = (market: Pick<VenueMarket, "venue" | "payloadVersion">): boolean =>
  pantaQuoteCurrency(market) === "USDC";

/** A Panta market as served: the frozen fields plus its money facts. Other
 *  venues' rows are returned unchanged. */
export function servedMarket<T extends VenueMarket>(market: T): T | (T & MarketMoneyFields) {
  if (market.venue !== "panta") return market;
  const quoteCurrency = pantaQuoteCurrency(market);
  return { ...market, quoteCurrency, tradable: quoteCurrency === "USDC" };
}
