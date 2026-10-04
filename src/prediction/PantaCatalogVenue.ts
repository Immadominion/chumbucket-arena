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
    if (this.chain.quoteOf(venueMarketId) === "SOL") {
      return normalizePantaChainMarket(await this.chain.readSolMarket(venueMarketId), this.clock.now());
    }
    try {
      return await this.live.getMarket(venueMarketId);
    } catch (error) {
      // The partner API does not serve SOL markets. A miss there is only a
      // miss if the program does not hold a SOL market at this address either.
      if (!isVenueError(error) || error.code !== "VENUE_NOT_FOUND") throw error;
      try {
        return normalizePantaChainMarket(await this.chain.readSolMarket(venueMarketId), this.clock.now());
      } catch (chainError) {
        if (isVenueError(chainError) && chainError.code === "VENUE_NOT_FOUND") throw error;
        throw chainError;
      }
    }
  }

  async getIndicativePrices(venueMarketId: string): Promise<IndicativePrices> {
    if (this.chain.quoteOf(venueMarketId) !== "SOL") return this.live.getIndicativePrices(venueMarketId);
    const read = await this.chain.readSolMarket(venueMarketId);
    const body = read.raw.body as { yesPrice: string | null; noPrice: string | null };
    const market = normalizePantaChainMarket(read, this.clock.now());
    return { marketId: market.id, venue: "panta", venueMarketId, currency: "SOL", unit: "per_share",
      yesPrice: body.yesPrice, noPrice: body.noPrice, observedAt: read.fetchedAt, executable: false,
      attribution: "Powered by Panta", demo: false };
  }

  async getOrderbook(venueMarketId: string): Promise<Orderbook> {
    if (this.chain.quoteOf(venueMarketId) !== "SOL") return this.live.getOrderbook(venueMarketId);
    const read = await this.chain.readSolMarket(venueMarketId);
    return { marketId: normalizePantaChainMarket(read, this.clock.now()).id, venue: "panta", venueMarketId,
      bids: [], asks: [], snapshot: null, observedAt: read.fetchedAt, demo: false };
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
