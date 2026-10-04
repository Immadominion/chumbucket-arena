/**
 * The whole open Panta catalog behind the one venue interface MarketSync knows.
 *
 * Panta's partner API (./PantaVenue.ts) stays the only source for USDC
 * markets: their status, prices, results and anything tradable. Its catalog
 * never lists SOL-quoted markets, so when a walk of that catalog reaches its
 * last page, the SOL-quoted markets that are still live are appended from
 * the program accounts themselves (./PantaChainCatalog.ts). Each SOL market
 * keeps its own evidence (payload version 2: the account bytes), its own
 * price series (`currency: "SOL"`) and its own result reader, and is never
 * offered for trading.
 *
 * A chain failure never fails a USDC walk: the SOL slice is simply absent
 * that pass. Rows it already mirrored are re-read by MarketSync's unlisted
 * sweep through `getMarket`, so a market that closes or settles while the
 * RPC is unavailable still converges once it answers.
 */
import { isVenueError } from "./errors.ts";
import type { PantaChainCatalog } from "./PantaChainCatalog.ts";
import { PANTA_CHAIN_PAYLOAD_VERSION, normalizePantaChainMarket, pantaChainReadFromRaw, pantaEventResolution,
  type PantaChainRead } from "./PantaProgram.ts";
import type { PantaVenue } from "./PantaVenue.ts";
import type { Capabilities, CreateOrderInput, EventFilters, EventPage, IndicativePriceReader, IndicativePrices,
  Orderbook, PositionPage, PredictionVenue, PublishedResolution, RawPayload, RawPayloadCapture, ResolutionReader,
  TradingStatus, UnsignedOrder, UnsignedTransaction, VenueOrder } from "./PredictionVenue.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import type { VenueMarket } from "./types.ts";

export interface PantaCatalogVenueDeps {
  live: PantaVenue;
  chain: PantaChainCatalog;
  clock?: Clock;
  /** Told when the SOL slice of a pass could not be read. */
  onChainFailure?: (error: unknown) => void;
}

/** Live and paused SOL markets are listed; ended ones settle through the sweep. */
const LISTED: ReadonlySet<VenueMarket["status"]> = new Set(["OPEN", "PAUSED"]);

export class PantaCatalogVenue implements PredictionVenue, RawPayloadCapture, ResolutionReader, IndicativePriceReader {
  /** Panta's partner adapter: the only source for USDC markets and trading. */
  readonly live: PantaVenue;
  private readonly chain: PantaChainCatalog;
  private readonly clock: Clock;

  constructor(private readonly deps: PantaCatalogVenueDeps) {
    this.live = deps.live;
    this.chain = deps.chain;
    this.clock = deps.clock ?? systemClock;
  }

  async listEvents(filters: EventFilters, cursor?: string): Promise<EventPage> {
    const page = await this.live.listEvents(filters, cursor);
    if (page.nextCursor) return page;
    let reads: PantaChainRead[];
    try { reads = await this.chain.listSolMarkets(); }
    catch (error) {
      this.deps.onChainFailure?.(error);
      return page;
    }
    const now = this.clock.now();
    const events = [...page.events];
    for (const read of reads) {
      const market = normalizePantaChainMarket(read, now);
      if (!LISTED.has(market.status)) continue;
      if (filters.category && market.category.toLowerCase() !== filters.category.toLowerCase()) continue;
      if (filters.query && !market.question.toLowerCase().includes(filters.query.toLowerCase())) continue;
      if (filters.status && !filters.status.includes(market.status)) continue;
      events.push({ venue: "panta", venueEventId: market.venueEventId, title: market.question,
        category: market.category, markets: [market], demo: false });
    }
    return { ...page, events };
  }

  async getMarket(venueMarketId: string): Promise<VenueMarket> {
    return this.liveOrChain(venueMarketId, () => this.live.getMarket(venueMarketId),
      read => normalizePantaChainMarket(read, this.clock.now()));
  }

  async getIndicativePrices(venueMarketId: string): Promise<IndicativePrices> {
    return this.liveOrChain(venueMarketId, () => this.live.getIndicativePrices(venueMarketId), read => {
      const body = read.raw.body as { yesPrice: string | null; noPrice: string | null };
      const market = normalizePantaChainMarket(read, this.clock.now());
      return { marketId: market.id, venue: "panta", venueMarketId, currency: "SOL", unit: "per_share",
        yesPrice: body.yesPrice, noPrice: body.noPrice, observedAt: read.fetchedAt, executable: false,
        attribution: "Powered by Panta", demo: false };
    });
  }

  async getOrderbook(venueMarketId: string): Promise<Orderbook> {
    return this.liveOrChain(venueMarketId, () => this.live.getOrderbook(venueMarketId), read => ({
      marketId: normalizePantaChainMarket(read, this.clock.now()).id, venue: "panta", venueMarketId,
      bids: [], asks: [], snapshot: null, observedAt: read.fetchedAt, demo: false }));
  }

  /**
   * A proven SOL market is read from the program. Anything else asks the
   * partner API first. It does not serve SOL markets, so a miss there is only
   * a miss if the program does not hold a SOL market at this address either:
   * after a restart nothing is classified yet, and a lock's price re-read or
   * the sync's pricing must not fail on a SOL market until the next listing.
   */
  private async liveOrChain<T>(venueMarketId: string, live: () => Promise<T>, chain: (read: PantaChainRead) => T): Promise<T> {
    if (this.chain.quoteOf(venueMarketId) === "SOL") return chain(await this.chain.readSolMarket(venueMarketId));
    try {
      return await live();
    } catch (error) {
      if (!isVenueError(error) || error.code !== "VENUE_NOT_FOUND") throw error;
      try {
        return chain(await this.chain.readSolMarket(venueMarketId));
      } catch (chainError) {
        if (isVenueError(chainError) && chainError.code === "VENUE_NOT_FOUND") throw error;
        throw chainError;
      }
    }
  }

  rawPayload(venueMarketId: string): RawPayload | undefined {
    return this.chain.quoteOf(venueMarketId) === "SOL"
      ? this.chain.rawPayload(venueMarketId)
      : this.live.rawPayload(venueMarketId);
  }

  publishedResolution(venueMarketId: string, raw?: RawPayload | null): PublishedResolution | null {
    const evidence = raw === undefined ? this.rawPayload(venueMarketId) ?? null : raw;
    if (evidence?.payloadVersion === PANTA_CHAIN_PAYLOAD_VERSION) {
      return pantaEventResolution(pantaChainReadFromRaw(evidence, venueMarketId).event, this.clock.now());
    }
    return this.live.publishedResolution(venueMarketId, evidence);
  }

  // Trading stays exactly what the partner adapter says: none here.
  capabilities(): Capabilities { return this.live.capabilities(); }
  getTradingStatus(): Promise<TradingStatus> { return this.live.getTradingStatus(); }
  createBuyOrder(o: CreateOrderInput): Promise<UnsignedOrder> { return this.live.createBuyOrder(o); }
  getOrder(id: string): Promise<VenueOrder> { return this.live.getOrder(id); }
  listPositions(owner: string, cursor?: string): Promise<PositionPage> { return this.live.listPositions(owner, cursor); }
  closePosition(owner: string, id: string): Promise<UnsignedOrder> { return this.live.closePosition(owner, id); }
  createClaim(owner: string, id: string): Promise<UnsignedTransaction> { return this.live.createClaim(owner, id); }
}
