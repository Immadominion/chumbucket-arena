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

import type { PredictionStore } from "../prediction/store.ts";
import type { MarketResolutionRecord, MarketSnapshot, VenueMarket } from "../prediction/types.ts";

export interface VenueMarketReader {
  getMarket(marketId: string): VenueMarket | undefined;
  listMarkets(): VenueMarket[];
  latestSnapshot(marketId: string): MarketSnapshot | undefined;
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
    getMarket: (marketId) => store.getMarket(marketId)?.market,
    listMarkets: () => store.listMarkets().map((r) => r.market),
    latestSnapshot: (marketId) => store.latestSnapshot(marketId),
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

/** A market that accepts new calls. Only OPEN does (§3 MarketStatus). */
export const acceptsNewCalls = (m: VenueMarket, now: number): boolean =>
  // Panta reads are implemented; its independent share-price call/receipt
  // schema and mobile presentation are not. Never pin them as 1-p odds.
  m.venue !== "panta" &&
  m.status === "OPEN" &&
  (m.opensAt === null || m.opensAt <= now) &&
  (m.closesAt === null || m.closesAt > now);
