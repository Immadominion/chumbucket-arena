/**
 * The narrow view of Packet B this packet is allowed to hold.
 *
 * Packet D never sees a provider's wire shape and never calls a venue: §4 says
 * "Jupiter JSON appears in exactly one file", and this is not it. Everything
 * below is the NORMALIZED form — `VenueMarket`, `MarketSnapshot`,
 * `MarketResolutionRecord` — read out of Packet B's store.
 *
 * It is a port rather than a direct dependency for one reason that matters:
 * §0.2 says the venue is the ONLY source of a result, so the single method that
 * could ever produce one, `getResolution`, has exactly one implementation that
 * reads Packet B's `market_resolutions` mirror and no other. There is no method
 * here that could invent, infer or guess a resolution, because there is nothing
 * for such a method to be built out of.
 */

import { servedMarket } from "../prediction/marketQuote.ts";
import type { PredictionStore } from "../prediction/store.ts";
import type { SharePriceSnapshot } from "../prediction/sharePrices.ts";
import type { MarketResolutionRecord, MarketSnapshot, VenueMarket } from "../prediction/types.ts";

export interface VenueMarketReader {
  getMarket(marketId: string): VenueMarket | undefined;
  listMarkets(): VenueMarket[];
  latestSnapshot(marketId: string): MarketSnapshot | undefined;
  latestSharePrice?(marketId: string): SharePriceSnapshot | undefined;
  /** Venue evidence, or undefined. NEVER an inference (§0.2). */
  getResolution(marketId: string): MarketResolutionRecord | undefined;
  /** Every venue resolution recorded at or after `since`, oldest first. */
  resolutionsSince(since: number): MarketResolutionRecord[];
}

/**
 * Read Packet B's store as a VenueMarketReader. Uses only its public interface;
 * `src/prediction/**` is not edited and not extended.
 *
 * `resolutionsSince` is composed from `listMarkets()` + `getResolution()`
 * rather than requiring a new method on PredictionStore — which keeps this
 * packet from needing a change to a file it does not own.
 */
export function predictionStoreReader(store: PredictionStore): VenueMarketReader {
  return {
    // Served with the market's quote asset and whether it can be traded
    // (../prediction/marketQuote.ts): a SOL-quoted Panta market takes calls
    // but is never offered a trade.
    getMarket: (marketId) => {
      const market = store.getMarket(marketId)?.market;
      return market ? servedMarket(market) : undefined;
    },
    listMarkets: () => store.listMarkets().map((r) => servedMarket(r.market)),
    latestSnapshot: (marketId) => store.latestSnapshot(marketId),
    latestSharePrice: (marketId) => store.latestSharePrice(marketId),
    getResolution: (marketId) => store.getResolution(marketId),
    resolutionsSince: (since) =>
      store
        .listMarkets()
        .map((r) => store.getResolution(r.market.id))
        .filter((r): r is MarketResolutionRecord => r !== undefined && r.recordedAt >= since)
        .sort((a, b) => a.recordedAt - b.recordedAt || a.id.localeCompare(b.id)),
  };
}

/** An empty reader — a server with no venue data yet. Never throws, never invents. */
export const emptyMarketReader: VenueMarketReader = {
  getMarket: () => undefined,
  listMarkets: () => [],
  latestSnapshot: () => undefined,
  getResolution: () => undefined,
  resolutionsSince: () => [],
};

/** A market that accepts new calls. Only OPEN does (§3 MarketStatus), and
 *  only until `cutoffMs` before it closes (M14). */
export const acceptsNewCalls = (m: VenueMarket, now: number, cutoffMs = 0): boolean =>
  // Historical rows stay readable, but cannot become a second live catalog.
  (m.venue === "panta" || m.venue === "fixture") &&
  m.status === "OPEN" &&
  (m.opensAt === null || m.opensAt <= now) &&
  (m.closesAt === null || m.closesAt - Math.max(0, cutoffMs) > now);

/** When a market stops taking calls: its close minus the cut-off. Null when it has no close. */
export const callsCloseAt = (m: VenueMarket, cutoffMs = 0): number | null =>
  m.closesAt === null ? null : m.closesAt - Math.max(0, cutoffMs);
