/**
 * The BFF service the tRPC routes call. It owns three things the adapters
 * deliberately do not:
 *
 *  1. CACHING with the tiers contracts §4 fixes (event lists 30-60s, open
 *     markets/prices 10-30s, settled markets much longer);
 *  2. PERSISTENCE of the normalized form + the raw payload + price snapshots +
 *     venue-published resolutions;
 *  3. the server-side `funded_positions` KILL SWITCH (contracts §7). When it is
 *     off, every order/claim path refuses here — before the venue is called,
 *     before anything is written — while every read path stays fully functional.
 *     A client-side flag is not a kill switch, so the check lives at this layer
 *     AND at the route layer.
 *
 * Backoff and the circuit breaker live inside the network adapter
 * (PantaVenue for the live flow).
 */

import { assertCacheTtls, DEFAULT_CACHE_TTLS, TtlCache, ttlForStatus, type CacheTtls } from "./cache.ts";
import { systemClock, type Clock } from "./clock.ts";
import { VenueError } from "./errors.ts";
import { capturesRaw, readsResolutions, readsIndicativePrices, type IndicativePrices } from "./PredictionVenue.ts";
import type {
  Capabilities,
  EventFilters,
  EventPage,
  Orderbook,
  PositionPage,
  PredictionVenue,
  RawPayload,
  TradingStatus,
  UnsignedOrder,
  UnsignedTransaction,
} from "./PredictionVenue.ts";
import { OrderReconciler, type ReconcileReport } from "./Reconciler.ts";
import {
  InMemoryPredictionStore,
  orderFingerprint,
  type OrderRecord,
  type PredictionStore,
} from "./store.ts";
import {
  isBaseUnits,
  isSettledStatus,
  type BaseUnits,
  type Side,
  type VenueId,
  type VenueMarket,
} from "./types.ts";

export interface PredictionFlags {
  /** contracts §7 — default OFF. Gates every order/claim route, server-side. */
  fundedPositions: boolean;
}

export interface PredictionServiceDeps {
  venue: PredictionVenue;
  store?: PredictionStore;
  cache?: TtlCache;
  ttls?: CacheTtls;
  clock?: Clock;
  flags: PredictionFlags;
}

export interface CreateOrderRequest {
  /** Who the BFF thinks is asking. Scopes idempotency and ownership. */
  ownerKey: string;
  /** The venue-side account handle. */
  ownerAddress: string;
  venueMarketId: string;
  side: Side;
  amountBaseUnits: BaseUnits;
  limitProbability?: number | null;
  idempotencyKey: string;
}

export class PredictionService {
  readonly venue: PredictionVenue;
  readonly store: PredictionStore;
  readonly cache: TtlCache;
  readonly ttls: CacheTtls;
  readonly flags: PredictionFlags;
  private readonly clock: Clock;
  private readonly reconciler: OrderReconciler;

  constructor(deps: PredictionServiceDeps) {
    this.venue = deps.venue;
    this.store = deps.store ?? new InMemoryPredictionStore();
    this.clock = deps.clock ?? systemClock;
    this.ttls = assertCacheTtls(deps.ttls ?? DEFAULT_CACHE_TTLS);
    this.cache = deps.cache ?? new TtlCache({ clock: this.clock });
    this.flags = deps.flags;
    this.reconciler = new OrderReconciler({ venue: this.venue, store: this.store, clock: this.clock });
  }

  capabilities(): Capabilities {
    return this.venue.capabilities();
  }

  // ── reads: always available, kill switch or not ───────────────────────────

  async listEvents(filters: EventFilters, cursor?: string): Promise<EventPage> {
    const key = `events:${stableKey(filters)}:${cursor ?? ""}`;
    const page = await this.cache.load(key, () => this.venue.listEvents(filters, cursor), this.ttls.eventList);
    for (const e of page.events) for (const m of e.markets) this.persist(m);
    return page;
  }

  async getMarket(venueMarketId: string): Promise<VenueMarket> {
    const key = `market:${venueMarketId}`;
    const market = await this.cache.load(
      key,
      async () => {
        const m = await this.venue.getMarket(venueMarketId);
        this.persist(m);
        return m;
      },
      (m) => ttlForStatus(m.status, this.ttls),
    );
    return market;
  }

  async getOrderbook(venueMarketId: string): Promise<Orderbook> {
    const key = `book:${venueMarketId}`;
    const book = await this.cache.load(
      key,
      async () => {
        const b = await this.venue.getOrderbook(venueMarketId);
        if (b.snapshot) this.store.appendSnapshot(b.snapshot);
        return b;
      },
      this.ttls.orderbook,
    );
    return book;
  }

  async getTradingStatus(): Promise<TradingStatus> {
    return this.cache.load("status", () => this.venue.getTradingStatus(), this.ttls.tradingStatus);
  }

  async getIndicativePrices(venueMarketId: string): Promise<IndicativePrices | null> {
    const venue = this.venue;
    if (!readsIndicativePrices(venue)) return null;
    return this.cache.load(`prices:${venueMarketId}`, () => venue.getIndicativePrices(venueMarketId), this.ttls.orderbook);
  }

  /**
   * Write the normalized market, the raw payload it came from, a price snapshot
   * when one is available, and — only when the venue actually published one —
   * the resolution. Never infers a resolution from status.
   */
  private persist(market: VenueMarket): void {
    const raw: RawPayload | null = capturesRaw(this.venue)
      ? (this.venue.rawPayload(market.venueMarketId) ?? null)
      : null;
    this.store.upsertMarket(market, raw);

    if (!isSettledStatus(market.status)) return;
    if (!readsResolutions(this.venue)) return;
    const published = this.venue.publishedResolution(market.venueMarketId, raw);
    if (!published) return;
    this.store.recordResolution(
      {
        marketId: market.id,
        venue: market.venue,
        venueMarketId: market.venueMarketId,
        resolution: published.resolution,
        resolvedAt: published.resolvedAt ?? market.resolvesAt ?? this.clock.now(),
        evidenceSource: market.resolutionSource ?? market.rawStatus,
        rawEvidence: raw?.body ?? null,
        demo: market.venue === "fixture",
      },
      this.clock.now(),
    );
  }

  // ── the kill switch ───────────────────────────────────────────────────────

  /**
   * contracts §7: `funded_positions` is enforced SERVER-SIDE. Reading a market
   * never passes through here; every order/claim path does.
   */
  assertFundedPositionsEnabled(): void {
    if (!this.flags.fundedPositions) {
      throw new VenueError(
        "FUNDED_POSITIONS_DISABLED",
        "funded positions are disabled on this server (feature flag `funded_positions` is off). Reading markets and making free calls still works.",
        { details: { flag: "funded_positions" } },
      );
    }
  }

  // ── orders: every one of these refuses while the kill switch is off ───────

  async createOrder(req: CreateOrderRequest): Promise<{ order: UnsignedOrder; record: OrderRecord; reused: boolean }> {
    this.assertFundedPositionsEnabled();
    if (!req.idempotencyKey) {
      throw new VenueError("VENUE_BAD_REQUEST", "createOrder requires an idempotencyKey", {});
    }
    if (!isBaseUnits(req.amountBaseUnits)) {
      throw new VenueError("VENUE_BAD_REQUEST", "amount must be integer base units as a string", {});
    }
    if (BigInt(req.amountBaseUnits) <= 0n) {
      throw new VenueError("VENUE_BAD_REQUEST", "amount must be greater than zero", {});
    }

    const fingerprint = orderFingerprint({
      owner: req.ownerAddress,
      venueMarketId: req.venueMarketId,
      side: req.side,
      amountBaseUnits: req.amountBaseUnits,
    });

    // Idempotency is checked BEFORE the venue is called, so a retried request
    // can never produce a second quote — let alone a second order.
    const existing = this.store.findOrderByIdempotencyKey(req.ownerKey, req.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new VenueError(
          "IDEMPOTENCY_CONFLICT",
          "this idempotency key was already used with a different order body",
          { details: { orderId: existing.orderId } },
        );
      }
      return { order: this.replayQuote(existing), record: existing, reused: true };
    }

    const unsigned = await this.venue.createBuyOrder({
      idempotencyKey: req.idempotencyKey,
      owner: req.ownerAddress,
      venueMarketId: req.venueMarketId,
      side: req.side,
      amountBaseUnits: req.amountBaseUnits,
      limitProbability: req.limitProbability ?? null,
    });

    // A second concurrent caller may have won the race while we were quoting.
    const raced = this.store.findOrderByIdempotencyKey(req.ownerKey, req.idempotencyKey);
    if (raced) return { order: this.replayQuote(raced), record: raced, reused: true };

    const now = this.clock.now();
    const market = this.store.getMarketByVenueId(unsigned.venue, unsigned.venueMarketId);
    const record = this.store.createOrder({
      orderId: unsigned.orderId,
      venue: unsigned.venue,
      venueMarketId: unsigned.venueMarketId,
      marketId: market?.market.id ?? "",
      ownerKey: req.ownerKey,
      ownerAddress: req.ownerAddress,
      side: unsigned.side,
      amountBaseUnits: unsigned.amountBaseUnits,
      filledBaseUnits: "0",
      fundingState: "QUOTED", // a quote is not money
      venueOrderId: null,
      fillTxSignature: null,
      fillEvidence: null,
      idempotencyKey: req.idempotencyKey,
      requestFingerprint: fingerprint,
      createdAt: now,
      updatedAt: now,
      reconciledAt: null,
      demo: unsigned.demo,
    });
    return { order: unsigned, record, reused: false };
  }

  /** Replay of an already-created order: same order, no new venue call, no new quote. */
  private replayQuote(rec: OrderRecord): UnsignedOrder {
    return {
      orderId: rec.orderId,
      venue: rec.venue,
      venueMarketId: rec.venueMarketId,
      owner: rec.ownerAddress,
      side: rec.side,
      amountBaseUnits: rec.amountBaseUnits,
      quotedProbability: null,
      fundingState: "QUOTED",
      transaction: {
        venue: rec.venue,
        encoding: rec.demo ? "demo-non-executable" : "solana-tx-base64",
        payload: "",
        expiresAt: rec.createdAt,
        demo: rec.demo,
      },
      idempotencyKey: rec.idempotencyKey,
      createdAt: rec.createdAt,
      expiresAt: rec.createdAt,
      demo: rec.demo,
    };
  }

  /** Local (authoritative) view of one of this owner's orders. */
  getOrderRecord(ownerKey: string, orderId: string): OrderRecord {
    this.assertFundedPositionsEnabled();
    const rec = this.store.getOrder(orderId);
    if (!rec || rec.ownerKey !== ownerKey) {
      throw new VenueError("VENUE_NOT_FOUND", `no such order ${orderId}`, { details: { orderId } });
    }
    return rec;
  }

  /** Record that the client signed and sent. SUBMITTED is not money. */
  markSubmitted(ownerKey: string, orderId: string): OrderRecord {
    this.assertFundedPositionsEnabled();
    const rec = this.getOrderRecord(ownerKey, orderId);
    if (rec.fundingState !== "QUOTED") return rec;
    return this.store.setOrderState(rec.orderId, "SUBMITTED", this.clock.now());
  }

  async listPositions(ownerKey: string, owner: string, cursor?: string): Promise<PositionPage> {
    this.assertFundedPositionsEnabled();
    const page = await this.venue.listPositions(owner, cursor);
    for (const p of page.positions) this.store.upsertPosition({ ...p, ownerKey });
    return page;
  }

  async closePosition(ownerKey: string, owner: string, positionId: string): Promise<UnsignedOrder> {
    this.assertFundedPositionsEnabled();
    void ownerKey;
    return this.venue.closePosition(owner, positionId);
  }

  async createClaim(ownerKey: string, owner: string, positionId: string): Promise<UnsignedTransaction> {
    this.assertFundedPositionsEnabled();
    void ownerKey;
    return this.venue.createClaim(owner, positionId);
  }

  /** Cursor-backed, idempotent repair from venue history. */
  async reconcile(ownerKey: string, owner: string): Promise<ReconcileReport> {
    this.assertFundedPositionsEnabled();
    return this.reconciler.runOnce({ ownerKey, owner });
  }
}

/** Order-independent cache key for a filter object. */
function stableKey(filters: EventFilters): string {
  return JSON.stringify({
    category: filters.category ?? null,
    status: filters.status ? [...filters.status].sort() : null,
    query: filters.query ?? null,
    limit: filters.limit ?? null,
  });
}
