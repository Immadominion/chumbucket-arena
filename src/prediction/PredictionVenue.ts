/**
 * `PredictionVenue` — the ONLY interface that may know a provider's wire shape
 * (contracts §4). The method list below is frozen verbatim; the supporting types
 * are ours.
 *
 * Rules this file exists to enforce:
 *   - a provider's JSON appears in exactly one implementation file
 *   - everything downstream sees the normalized types from ./types.ts
 *   - a schema change fails loudly at the adapter, never silently downstream
 *   - the API key is server-side only
 *   - `fixture` data is structurally demo and can never present as a live result
 */

import type {
  BaseUnits,
  FundingState,
  MarketSnapshot,
  MarketStatus,
  Resolution,
  Side,
  VenueId,
  VenueMarket,
} from "./types.ts";

// ── reads ────────────────────────────────────────────────────────────────────

export interface EventFilters {
  /** 'crypto' for MVP. Omit for every category the venue offers. */
  category?: string;
  /** Restrict to these normalized statuses. Omit for all. */
  status?: MarketStatus[];
  /** Free-text search, passed through to the venue when it supports one. */
  query?: string;
  /** Page size hint. The venue may return fewer. */
  limit?: number;
}

/** A venue "event" groups the markets that resolve off one real-world question. */
export interface VenueEvent {
  venue: VenueId;
  venueEventId: string;
  title: string;
  category: string;
  markets: VenueMarket[];
  /** true for the fixture catalog — the UI must label it as demo data. */
  demo: boolean;
}

export interface EventPage {
  events: VenueEvent[];
  /** Opaque, venue-supplied. `null` means there is no next page. */
  nextCursor: string | null;
  fetchedAt: number;
}

export interface OrderbookLevel {
  side: Side;
  probability: number; // [0,1]
  sizeBaseUnits: BaseUnits; // integer base units as a string
}

export interface Orderbook {
  marketId: string; // Chumbucket UUID
  venue: VenueId;
  venueMarketId: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  /** Mid-price snapshot derived from the book, in normalized form. */
  snapshot: MarketSnapshot | null;
  observedAt: number;
  demo: boolean;
}

export interface TradingStatus {
  venue: VenueId;
  /** Whether the VENUE will accept orders right now. Orthogonal to our kill switch. */
  tradingEnabled: boolean;
  /** The venue's own explanation, verbatim, when trading is off. */
  reason: string | null;
  geoBlocked: boolean;
  kycRequired: boolean;
  minimumOrderBaseUnits: BaseUnits;
  observedAt: number;
  demo: boolean;
}

export interface Capabilities {
  read: boolean;
  trade: boolean;
  liveScores: boolean;
  stream: boolean;
  geoGate: boolean;
  kyc: boolean;
  executionModel: "orderbook" | "amm" | "rfq" | "demo";
  minimumOrder: BaseUnits;
  claimMode: "manual" | "automatic" | "none";
  /** true for the fixture catalog. Never omit — the UI keys its demo banner off it. */
  demo: boolean;
}

// ── orders ───────────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  /** REQUIRED. The same key must never create two orders. */
  idempotencyKey: string;
  /** The venue-side account the order trades for. */
  owner: string;
  venueMarketId: string;
  side: Side;
  amountBaseUnits: BaseUnits;
  /** Worst acceptable probability, [0,1]. null = take the venue's quote. */
  limitProbability?: number | null;
}

/**
 * A transaction the CLIENT signs. The BFF never holds a user key.
 * `demo: true` marks a fixture payload that can never be broadcast anywhere.
 */
export interface UnsignedTransaction {
  venue: VenueId;
  encoding: "solana-tx-base64" | "demo-non-executable";
  payload: string;
  expiresAt: number;
  demo: boolean;
}

/**
 * The result of asking the venue to quote + build an order. It is a QUOTE, not
 * money: `fundingState` here may never be 'FILLED'.
 */
export interface UnsignedOrder {
  orderId: string;
  venue: VenueId;
  venueMarketId: string;
  owner: string;
  side: Side;
  amountBaseUnits: BaseUnits;
  quotedProbability: number | null;
  fundingState: Extract<FundingState, "QUOTED">;
  transaction: UnsignedTransaction;
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number;
  demo: boolean;
}

export interface VenueOrder {
  orderId: string;
  /** The venue's own id for the order. null until the venue has acknowledged it. */
  venueOrderId: string | null;
  venue: VenueId;
  venueMarketId: string;
  owner: string;
  side: Side;
  amountBaseUnits: BaseUnits;
  filledBaseUnits: BaseUnits;
  fundingState: FundingState;
  /** Present only for a CONFIRMED fill. */
  fillTxSignature: string | null;
  createdAt: number;
  updatedAt: number;
  idempotencyKey: string | null;
  demo: boolean;
}

export interface VenuePosition {
  positionId: string;
  venue: VenueId;
  venueMarketId: string;
  marketId: string;
  owner: string;
  side: Side;
  sizeBaseUnits: BaseUnits;
  averageProbability: number | null;
  fundingState: FundingState;
  claimableBaseUnits: BaseUnits;
  resolution: Resolution | null;
  updatedAt: number;
  demo: boolean;
}

export interface PositionPage {
  positions: VenuePosition[];
  nextCursor: string | null;
  fetchedAt: number;
}

// ── the frozen interface (contracts §4, verbatim) ────────────────────────────

export interface PredictionVenue {
  listEvents(filters: EventFilters, cursor?: string): Promise<EventPage>;
  getMarket(venueMarketId: string): Promise<VenueMarket>;
  getOrderbook(venueMarketId: string): Promise<Orderbook>;
  getTradingStatus(): Promise<TradingStatus>;
  createBuyOrder(o: CreateOrderInput): Promise<UnsignedOrder>; // requires idempotencyKey
  getOrder(orderId: string): Promise<VenueOrder>;
  listPositions(owner: string, cursor?: string): Promise<PositionPage>;
  closePosition(owner: string, positionId: string): Promise<UnsignedOrder>;
  createClaim(owner: string, positionId: string): Promise<UnsignedTransaction>;
  capabilities(): Capabilities;
}

// ── raw-payload capture (contracts §4: "store the raw payload AND the versioned
//    normalized form"). Deliberately a SEPARATE interface so PredictionVenue
//    itself stays exactly as frozen. ───────────────────────────────────────────

export interface RawPayload {
  venue: VenueId;
  venueMarketId: string;
  payloadVersion: number;
  fetchedAt: number;
  /** The provider's JSON, untouched. */
  body: unknown;
}

export interface RawPayloadCapture {
  /** The raw provider payload the last normalisation of this market was read from. */
  rawPayload(venueMarketId: string): RawPayload | undefined;
}

export const capturesRaw = (v: PredictionVenue): v is PredictionVenue & RawPayloadCapture =>
  typeof (v as Partial<RawPayloadCapture>).rawPayload === "function";

/** `venue` is the single source of truth for demo-ness everywhere. */
export const venueIsDemo = (venue: VenueId): boolean => venue === "fixture";

// ── published-resolution capture ─────────────────────────────────────────────
//
// §3 freezes `VenueMarket` WITHOUT a resolution field (status says RESOLVED, but
// not to which side). The resolution therefore has to be read back out of the
// venue's own payload — which, by §4, only the adapter may parse. This optional
// capability is how the synchroniser asks for it without anyone else touching
// provider JSON. Returning null means "the venue has not published one" — it is
// never an inference from status alone.

export interface PublishedResolution {
  resolution: Resolution;
  resolvedAt: number | null;
}

export interface ResolutionReader {
  publishedResolution(venueMarketId: string, raw?: RawPayload | null): PublishedResolution | null;
}

export const readsResolutions = (v: PredictionVenue): v is PredictionVenue & ResolutionReader =>
  typeof (v as Partial<ResolutionReader>).publishedResolution === "function";
