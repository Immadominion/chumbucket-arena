/**
 * The BFF-side store for venue data. Mirrors, one-for-one, the five tables added
 * by the Packet B migrations (venue_markets, market_snapshots,
 * market_resolutions, venue_orders, venue_positions) so the in-memory
 * implementation and the SQL implementation enforce the SAME invariants:
 *
 *   - a market row is written whole or not at all (never partially parsed);
 *   - a resolution is append-only venue evidence — never overwritten, never
 *     invented, never admin-set;
 *   - one (ownerKey, idempotencyKey) is at most one order, forever;
 *   - FILLED is reachable ONLY through `applyFill`, and only with confirmed
 *     venue evidence. `createOrder`/`setOrderState` refuse it outright.
 *
 * The SQL side encodes the same FILLED rule as a CHECK constraint plus a
 * BEFORE-UPDATE trigger (see 20260913181000_venue_market_orders.sql), so the
 * invariant survives a writer that never goes through this class.
 */

import { VenueError } from "./errors.ts";
import { assertSharePriceEvidence, parseSharePrice, type SharePriceSnapshot } from "./sharePrices.ts";
import type { UnsignedOrder, VenueOrder, VenuePosition, RawPayload } from "./PredictionVenue.ts";
import type {
  BaseUnits,
  FundingState,
  MarketResolutionRecord,
  MarketSnapshot,
  Resolution,
  Side,
  VenueId,
  VenueMarket,
} from "./types.ts";

export interface VenueMarketRecord {
  market: VenueMarket;
  /** The provider payload the normalized form was read out of. */
  raw: RawPayload | null;
}

/** Confirmed-fill evidence. Nothing may reach FILLED without all of it. */
export interface FillEvidence {
  venue: VenueId;
  venueOrderId: string;
  filledBaseUnits: BaseUnits;
  fillTxSignature: string;
  confirmedAt: number;
  /** The venue payload the confirmation was read from. */
  raw: unknown;
}

export interface OrderRecord {
  orderId: string;
  venue: VenueId;
  venueMarketId: string;
  marketId: string;
  /** Who this order belongs to, as the BFF knows them (see note in predictions.ts). */
  ownerKey: string;
  /** The venue-side account handle the order trades for. */
  ownerAddress: string;
  side: Side;
  amountBaseUnits: BaseUnits;
  filledBaseUnits: BaseUnits;
  fundingState: FundingState;
  venueOrderId: string | null;
  fillTxSignature: string | null;
  fillEvidence: FillEvidence | null;
  idempotencyKey: string;
  /** Hash of the request body, so a replayed key with a different body is a conflict. */
  requestFingerprint: string;
  createdAt: number;
  updatedAt: number;
  reconciledAt: number | null;
  demo: boolean;
}

export interface PositionRecord extends VenuePosition {
  ownerKey: string;
}

/** States an order may legally move to WITHOUT confirmed fill evidence. */
const NON_FILL_STATES: ReadonlySet<FundingState> = new Set<FundingState>([
  "QUOTED",
  "SUBMITTED",
  "PARTIAL",
  "FAILED",
  "CLOSED",
  "CLAIMABLE",
  "CLAIMED",
]);

/** FILLED may only follow a state where money was actually in flight. */
const FILL_PREDECESSORS: ReadonlySet<FundingState> = new Set<FundingState>(["SUBMITTED", "PARTIAL"]);

export interface PredictionStore {
  upsertMarket(market: VenueMarket, raw: RawPayload | null): VenueMarketRecord;
  getMarket(marketId: string): VenueMarketRecord | undefined;
  getMarketByVenueId(venue: VenueId, venueMarketId: string): VenueMarketRecord | undefined;
  listMarkets(): VenueMarketRecord[];

  appendSnapshot(s: MarketSnapshot): void;
  latestSnapshot(marketId: string): MarketSnapshot | undefined;
  snapshots(marketId: string): MarketSnapshot[];
  appendSharePrice(s: SharePriceSnapshot, raw: RawPayload | null): void;
  latestSharePrice(marketId: string): SharePriceSnapshot | undefined;

  recordResolution(r: Omit<MarketResolutionRecord, "id" | "recordedAt">, recordedAt: number): MarketResolutionRecord;
  getResolution(marketId: string): MarketResolutionRecord | undefined;

  findOrderByIdempotencyKey(ownerKey: string, idempotencyKey: string): OrderRecord | undefined;
  createOrder(rec: OrderRecord): OrderRecord;
  getOrder(orderId: string): OrderRecord | undefined;
  listOrders(ownerKey: string): OrderRecord[];
  setOrderState(orderId: string, next: FundingState, at: number): OrderRecord;
  applyFill(orderId: string, evidence: FillEvidence, at: number): OrderRecord;

  upsertPosition(p: PositionRecord): PositionRecord;
  listPositions(ownerKey: string): PositionRecord[];

  getCursor(name: string): string | null;
  setCursor(name: string, cursor: string | null): void;
}

export class InMemoryPredictionStore implements PredictionStore {
  private readonly markets = new Map<string, VenueMarketRecord>();
  private readonly snaps = new Map<string, MarketSnapshot[]>();
  private readonly sharePrices = new Map<string, SharePriceSnapshot[]>();
  private readonly resolutions = new Map<string, MarketResolutionRecord>();
  private readonly orders = new Map<string, OrderRecord>();
  private readonly idemIndex = new Map<string, string>();
  private readonly positions = new Map<string, PositionRecord>();
  private readonly cursors = new Map<string, string | null>();
  /** Market ids currently holding a raw payload, oldest first. */
  private readonly rawHeld: string[] = [];
  private readonly maxSnapshotsPerMarket: number;
  private readonly maxRawHeld: number;
  private resolutionSeq = 0;

  constructor(opts: { maxSnapshotsPerMarket?: number; maxRawHeld?: number } = {}) {
    this.maxSnapshotsPerMarket = opts.maxSnapshotsPerMarket ?? 200;
    this.maxRawHeld = opts.maxRawHeld ?? 400;
  }

  // ── markets ───────────────────────────────────────────────────────────────

  upsertMarket(market: VenueMarket, raw: RawPayload | null): VenueMarketRecord {
    const existing = this.markets.get(market.id);
    // Idempotent: re-syncing the same venue market overwrites the same row.
    if (existing && existing.market.venue !== market.venue) {
      throw new VenueError("INVALID_TRANSITION", `market ${market.id} cannot change venue`, {
        details: { from: existing.market.venue, to: market.venue },
      });
    }
    const rec: VenueMarketRecord = { market, raw };
    this.markets.set(market.id, rec);

    // A raw provider payload is WRITE-ONLY: the durable writer reads it on its
    // way to Postgres and nothing reads it again. Retaining one per market
    // meant thousands of full JSON bodies pinned in memory for the life of the
    // process — the single biggest driver of a service that grew from 1.3 GB to
    // 3.1 GB in a day. Keep a window big enough to cover the in-flight write
    // queue and drop the rest.
    if (raw) {
      this.rawHeld.push(market.id);
      while (this.rawHeld.length > this.maxRawHeld) {
        const evict = this.rawHeld.shift();
        if (evict === undefined || evict === market.id) continue;
        const held = this.markets.get(evict);
        if (held?.raw) this.markets.set(evict, { market: held.market, raw: null });
      }
    }
    return rec;
  }

  getMarket(marketId: string): VenueMarketRecord | undefined {
    return this.markets.get(marketId);
  }

  getMarketByVenueId(venue: VenueId, venueMarketId: string): VenueMarketRecord | undefined {
    for (const r of this.markets.values()) {
      if (r.market.venue === venue && r.market.venueMarketId === venueMarketId) return r;
    }
    return undefined;
  }

  listMarkets(): VenueMarketRecord[] {
    return [...this.markets.values()];
  }

  // ── snapshots ─────────────────────────────────────────────────────────────

  appendSnapshot(s: MarketSnapshot): void {
    if (!(s.yesProbability >= 0 && s.yesProbability <= 1)) {
      throw new VenueError("INVALID_TRANSITION", `snapshot probability ${s.yesProbability} outside [0,1]`, {});
    }
    const arr = this.snaps.get(s.marketId) ?? [];
    const last = arr[arr.length - 1];
    // Idempotent re-poll: the same observation at the same instant is not a new row.
    if (last && last.observedAt === s.observedAt && last.yesProbability === s.yesProbability) return;
    arr.push(s);
    if (arr.length > this.maxSnapshotsPerMarket) arr.splice(0, arr.length - this.maxSnapshotsPerMarket);
    this.snaps.set(s.marketId, arr);
  }

  latestSnapshot(marketId: string): MarketSnapshot | undefined {
    const arr = this.snaps.get(marketId);
    return arr && arr.length ? arr[arr.length - 1] : undefined;
  }

  snapshots(marketId: string): MarketSnapshot[] {
    return [...(this.snaps.get(marketId) ?? [])];
  }

  // ── resolutions: append-only venue evidence ───────────────────────────────

  appendSharePrice(input: SharePriceSnapshot, raw: RawPayload | null): void {
    const s = parseSharePrice(input);
    const market = this.getMarket(s.marketId)?.market;
    if (!market || market.venue !== "panta") throw new VenueError("VENUE_SCHEMA", "Share-price market must be Panta", {});
    assertSharePriceEvidence(s, raw, market.venueMarketId);
    const rows = this.sharePrices.get(s.marketId) ?? [];
    const previous = rows.find((r) => r.id === s.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(s)) throw new VenueError("INVALID_TRANSITION", "A share-price observation is immutable", {});
      return;
    }
    rows.push(s);
    rows.sort((a, b) => a.observedAt - b.observedAt);
    if (rows.length > this.maxSnapshotsPerMarket) rows.splice(0, rows.length - this.maxSnapshotsPerMarket);
    this.sharePrices.set(s.marketId, rows);
  }

  latestSharePrice(marketId: string): SharePriceSnapshot | undefined {
    return this.sharePrices.get(marketId)?.at(-1);
  }

  recordResolution(
    r: Omit<MarketResolutionRecord, "id" | "recordedAt">,
    recordedAt: number,
  ): MarketResolutionRecord {
    const existing = this.resolutions.get(r.marketId);
    if (existing) {
      // Never overwrite venue evidence. A restatement is a NEW row upstream; a
      // contradiction is a loud failure, not a silent flip.
      if (existing.resolution !== r.resolution) {
        throw new VenueError(
          "INVALID_TRANSITION",
          `market ${r.marketId} already resolved ${existing.resolution}; refusing to overwrite with ${r.resolution}`,
          { details: { marketId: r.marketId } },
        );
      }
      return existing;
    }
    const rec: MarketResolutionRecord = {
      ...r,
      id: `res_${++this.resolutionSeq}`,
      recordedAt,
      demo: r.venue === "fixture",
    };
    this.resolutions.set(r.marketId, rec);
    return rec;
  }

  getResolution(marketId: string): MarketResolutionRecord | undefined {
    return this.resolutions.get(marketId);
  }

  // ── orders ────────────────────────────────────────────────────────────────

  findOrderByIdempotencyKey(ownerKey: string, idempotencyKey: string): OrderRecord | undefined {
    const id = this.idemIndex.get(idemKey(ownerKey, idempotencyKey));
    return id ? this.orders.get(id) : undefined;
  }

  createOrder(rec: OrderRecord): OrderRecord {
    if (rec.fundingState === "FILLED") {
      throw new VenueError(
        "INVALID_TRANSITION",
        "an order may not be created FILLED — FILLED is reachable only from a reconciliation write",
        { details: { orderId: rec.orderId } },
      );
    }
    // Defence against a venue that reuses an order id across accounts: an order
    // id is ours to own, and it may never change hands.
    const collision = this.orders.get(rec.orderId);
    if (collision && collision.ownerKey !== rec.ownerKey) {
      throw new VenueError("IDEMPOTENCY_CONFLICT", `order id ${rec.orderId} already belongs to another owner`, {
        details: { orderId: rec.orderId },
      });
    }
    const k = idemKey(rec.ownerKey, rec.idempotencyKey);
    const existingId = this.idemIndex.get(k);
    if (existingId) {
      const existing = this.orders.get(existingId)!;
      if (existing.requestFingerprint !== rec.requestFingerprint) {
        throw new VenueError(
          "IDEMPOTENCY_CONFLICT",
          "this idempotency key was already used with a different order body",
          { details: { orderId: existing.orderId } },
        );
      }
      return existing;
    }
    this.orders.set(rec.orderId, rec);
    this.idemIndex.set(k, rec.orderId);
    return rec;
  }

  getOrder(orderId: string): OrderRecord | undefined {
    return this.orders.get(orderId);
  }

  listOrders(ownerKey: string): OrderRecord[] {
    return [...this.orders.values()].filter((o) => o.ownerKey === ownerKey);
  }

  setOrderState(orderId: string, next: FundingState, at: number): OrderRecord {
    const o = this.require(orderId);
    if (next === "FILLED") {
      throw new VenueError(
        "INVALID_TRANSITION",
        "FILLED may only be written by applyFill() with confirmed venue fill evidence",
        { details: { orderId } },
      );
    }
    if (!NON_FILL_STATES.has(next)) {
      throw new VenueError("INVALID_TRANSITION", `cannot set order state to ${next}`, { details: { orderId } });
    }
    if (o.fundingState === "FILLED" && !["CLOSED", "CLAIMABLE", "CLAIMED"].includes(next)) {
      throw new VenueError("INVALID_TRANSITION", `a FILLED order may not regress to ${next}`, {
        details: { orderId },
      });
    }
    const updated: OrderRecord = { ...o, fundingState: next, updatedAt: at };
    this.orders.set(orderId, updated);
    return updated;
  }

  /**
   * THE ONLY PATH TO FILLED. Requires a confirmed fill from the venue: a venue
   * order id, a non-zero filled size, a transaction signature and the raw
   * payload it was read from. Idempotent — replaying the same evidence is a
   * no-op, which is what makes the reconciler safe to run on a loop.
   */
  applyFill(orderId: string, evidence: FillEvidence, at: number): OrderRecord {
    const o = this.require(orderId);
    if (!evidence.venueOrderId || !evidence.fillTxSignature) {
      throw new VenueError("INVALID_TRANSITION", "fill evidence needs a venue order id and a tx signature", {
        details: { orderId },
      });
    }
    if (BigInt(evidence.filledBaseUnits) <= 0n) {
      throw new VenueError("INVALID_TRANSITION", "fill evidence needs a non-zero filled size", {
        details: { orderId },
      });
    }
    if (evidence.venue !== o.venue) {
      throw new VenueError("INVALID_TRANSITION", "fill evidence came from a different venue", {
        details: { orderId, expected: o.venue, got: evidence.venue },
      });
    }
    if (o.fundingState === "FILLED") {
      if (o.fillTxSignature !== evidence.fillTxSignature) {
        throw new VenueError("INVALID_TRANSITION", "order is already FILLED with different evidence", {
          details: { orderId },
        });
      }
      return o; // idempotent replay
    }
    if (!FILL_PREDECESSORS.has(o.fundingState)) {
      throw new VenueError(
        "INVALID_TRANSITION",
        `FILLED may only follow SUBMITTED or PARTIAL (order is ${o.fundingState})`,
        { details: { orderId } },
      );
    }
    const full = BigInt(evidence.filledBaseUnits) >= BigInt(o.amountBaseUnits);
    const updated: OrderRecord = {
      ...o,
      fundingState: full ? "FILLED" : "PARTIAL",
      filledBaseUnits: evidence.filledBaseUnits,
      venueOrderId: evidence.venueOrderId,
      fillTxSignature: evidence.fillTxSignature,
      fillEvidence: evidence,
      reconciledAt: at,
      updatedAt: at,
    };
    this.orders.set(orderId, updated);
    return updated;
  }

  private require(orderId: string): OrderRecord {
    const o = this.orders.get(orderId);
    if (!o) throw new VenueError("VENUE_NOT_FOUND", `no such order ${orderId}`, { details: { orderId } });
    return o;
  }

  // ── positions ─────────────────────────────────────────────────────────────

  upsertPosition(p: PositionRecord): PositionRecord {
    const existing = this.positions.get(p.positionId);
    // Idempotent: an older restatement never clobbers a newer one.
    if (existing && existing.updatedAt > p.updatedAt) return existing;
    this.positions.set(p.positionId, p);
    return p;
  }

  listPositions(ownerKey: string): PositionRecord[] {
    return [...this.positions.values()].filter((p) => p.ownerKey === ownerKey);
  }

  // ── cursors (restart-safe polling) ────────────────────────────────────────

  getCursor(name: string): string | null {
    return this.cursors.get(name) ?? null;
  }

  setCursor(name: string, cursor: string | null): void {
    this.cursors.set(name, cursor);
  }
}

const idemKey = (ownerKey: string, idempotencyKey: string) => `${ownerKey}::${idempotencyKey}`;

/** Stable fingerprint of an order request, so a replayed key can be validated. */
export function orderFingerprint(o: Pick<UnsignedOrder, "venueMarketId" | "side" | "amountBaseUnits" | "owner">): string {
  return [o.owner, o.venueMarketId, o.side, o.amountBaseUnits].join("|");
}
