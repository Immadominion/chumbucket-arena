/**
 * FixtureVenue — a deterministic, offline catalog that covers EVERY normalized
 * lifecycle state, for UI tests and demos (contracts §4).
 *
 * It is built so that fixture output can never be mistaken for a live venue
 * result, in five independent ways:
 *   1. every market carries `venue: 'fixture'` — the field the UI keys its demo
 *      banner off, and the DB column the row is stored under;
 *   2. every question is prefixed `[DEMO]`, so even a screenshot is honest;
 *   3. every order/position/orderbook/status carries `demo: true`;
 *   4. the unsigned "transaction" uses encoding `demo-non-executable` and a
 *      payload that is a human-readable refusal, not base64 — it cannot be
 *      broadcast by any client, even a buggy one;
 *   5. `resolutionSource` names the demo catalog instead of a real oracle.
 *
 * Nothing here touches the network, a clock we do not control, or randomness.
 */

import { systemClock, type Clock } from "./clock.ts";
import { VenueError } from "./errors.ts";
import type {
  Capabilities,
  CreateOrderInput,
  EventFilters,
  EventPage,
  Orderbook,
  PositionPage,
  PredictionVenue,
  RawPayload,
  RawPayloadCapture,
  TradingStatus,
  UnsignedOrder,
  UnsignedTransaction,
  VenueEvent,
  VenueOrder,
  VenuePosition,
} from "./PredictionVenue.ts";
import {
  DEMO_LABEL,
  marketUuid,
  type BaseUnits,
  type FundingState,
  type MarketSnapshot,
  type MarketStatus,
  type Resolution,
  type Side,
  type VenueMarket,
} from "./types.ts";

const VENUE = "fixture" as const;

export const FIXTURE_PAYLOAD_VERSION = 1;

/** A stable instant so every fixture render is byte-identical run to run. */
export const FIXTURE_EPOCH = 1_760_000_000_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The fixture catalog's own "resolution source" — never a real oracle. */
const DEMO_SOURCE = "Chumbucket demo catalog (fixture venue) — not a live venue result";

interface FixtureSpec {
  venueEventId: string;
  venueMarketId: string;
  eventTitle: string;
  question: string;
  rulesText: string;
  status: MarketStatus;
  rawStatus: string;
  /** null unless the venue has actually published one. */
  resolution: Resolution | null;
  yesProbability: number;
  opensAt: number;
  closesAt: number;
  resolvesAt: number | null;
}

/**
 * Every normalized MarketStatus, plus both RESOLVED resolutions. Adding a state
 * to MarketStatus without adding a fixture here should be caught by
 * tests/predictionNormalization.test.ts, which asserts full coverage.
 */
export const FIXTURE_CATALOG: readonly FixtureSpec[] = [
  {
    venueEventId: "fx-evt-btc",
    venueMarketId: "fx-open-btc-120k",
    eventTitle: `${DEMO_LABEL} Bitcoin price milestones`,
    question: `${DEMO_LABEL} Will BTC trade above $120,000 before 31 Dec 2026?`,
    rulesText:
      "Resolves YES if the demo reference price prints above 120000.00 at any point before the close time. Demo data only.",
    status: "OPEN",
    rawStatus: "fixture:open",
    resolution: null,
    yesProbability: 0.62,
    opensAt: FIXTURE_EPOCH - 7 * DAY,
    closesAt: FIXTURE_EPOCH + 30 * DAY,
    resolvesAt: null,
  },
  {
    venueEventId: "fx-evt-jup",
    venueMarketId: "fx-paused-jup-3usd",
    eventTitle: `${DEMO_LABEL} JUP price milestones`,
    question: `${DEMO_LABEL} Will JUP trade above $3.00 before 31 Dec 2026?`,
    rulesText: "Resolves YES if the demo reference price prints above 3.00 before the close time. Demo data only.",
    status: "PAUSED",
    rawStatus: "fixture:halted_for_demo",
    resolution: null,
    yesProbability: 0.41,
    opensAt: FIXTURE_EPOCH - 3 * DAY,
    closesAt: FIXTURE_EPOCH + 30 * DAY,
    resolvesAt: null,
  },
  {
    venueEventId: "fx-evt-eth",
    venueMarketId: "fx-closed-eth-5k",
    eventTitle: `${DEMO_LABEL} Ethereum price milestones`,
    question: `${DEMO_LABEL} Did ETH close above $5,000 on 1 Sep 2026?`,
    rulesText: "Resolves YES if the demo reference close is above 5000.00. Demo data only.",
    status: "CLOSED_PENDING_RESOLUTION",
    rawStatus: "fixture:closed_pending",
    resolution: null,
    yesProbability: 0.55,
    opensAt: FIXTURE_EPOCH - 30 * DAY,
    closesAt: FIXTURE_EPOCH - 1 * HOUR,
    resolvesAt: null,
  },
  {
    venueEventId: "fx-evt-sol",
    venueMarketId: "fx-resolved-yes-sol-300",
    eventTitle: `${DEMO_LABEL} Solana price milestones`,
    question: `${DEMO_LABEL} Did SOL trade above $300 during August 2026?`,
    rulesText: "Resolves YES if the demo reference price printed above 300.00 during the window. Demo data only.",
    status: "RESOLVED",
    rawStatus: "fixture:resolved_yes",
    resolution: "YES",
    yesProbability: 1,
    opensAt: FIXTURE_EPOCH - 60 * DAY,
    closesAt: FIXTURE_EPOCH - 10 * DAY,
    resolvesAt: FIXTURE_EPOCH - 9 * DAY,
  },
  {
    venueEventId: "fx-evt-doge",
    venueMarketId: "fx-resolved-no-doge-1usd",
    eventTitle: `${DEMO_LABEL} Dogecoin price milestones`,
    question: `${DEMO_LABEL} Did DOGE trade above $1.00 during August 2026?`,
    rulesText: "Resolves YES if the demo reference price printed above 1.00 during the window. Demo data only.",
    status: "RESOLVED",
    rawStatus: "fixture:resolved_no",
    resolution: "NO",
    yesProbability: 0,
    opensAt: FIXTURE_EPOCH - 60 * DAY,
    closesAt: FIXTURE_EPOCH - 10 * DAY,
    resolvesAt: FIXTURE_EPOCH - 9 * DAY,
  },
  {
    venueEventId: "fx-evt-bonk",
    venueMarketId: "fx-cancelled-bonk-halving",
    eventTitle: `${DEMO_LABEL} Cancelled demo event`,
    question: `${DEMO_LABEL} Will the (non-existent) BONK halving ship in 2026?`,
    rulesText: "Voided by the demo catalog: the underlying event cannot occur. Demo data only.",
    status: "CANCELLED",
    rawStatus: "fixture:cancelled",
    resolution: "VOID",
    yesProbability: 0.5,
    opensAt: FIXTURE_EPOCH - 20 * DAY,
    closesAt: FIXTURE_EPOCH - 5 * DAY,
    resolvesAt: FIXTURE_EPOCH - 5 * DAY,
  },
] as const;

const DEMO_TX_PAYLOAD =
  "DEMO-NON-EXECUTABLE: this is fixture data from the Chumbucket demo catalog. There is no transaction to sign and nothing to broadcast.";

interface FixtureOrderState {
  order: VenueOrder;
  positionId: string;
}

export interface FixtureVenueOptions {
  clock?: Clock;
  /** Override the catalog (still forced to venue 'fixture'). */
  catalog?: readonly FixtureSpec[];
  /** Page size used when a caller supplies no limit. */
  defaultPageSize?: number;
}

export class FixtureVenue implements PredictionVenue, RawPayloadCapture {
  readonly venue = VENUE;
  private readonly clock: Clock;
  private readonly catalog: readonly FixtureSpec[];
  private readonly defaultPageSize: number;
  private readonly orders = new Map<string, FixtureOrderState>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private seq = 0;

  constructor(opts: FixtureVenueOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.catalog = opts.catalog ?? FIXTURE_CATALOG;
    this.defaultPageSize = opts.defaultPageSize ?? 25;
  }

  capabilities(): Capabilities {
    return {
      read: true,
      trade: true, // demo trading only — every artefact is stamped demo: true
      liveScores: false,
      stream: false,
      geoGate: false,
      kyc: false,
      executionModel: "demo",
      minimumOrder: "1000000",
      claimMode: "manual",
      demo: true,
    };
  }

  rawPayload(venueMarketId: string): RawPayload | undefined {
    const spec = this.catalog.find((s) => s.venueMarketId === venueMarketId);
    if (!spec) return undefined;
    return {
      venue: VENUE,
      venueMarketId,
      payloadVersion: FIXTURE_PAYLOAD_VERSION,
      fetchedAt: this.clock.now(),
      body: { ...spec, demo: true, source: DEMO_SOURCE },
    };
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async listEvents(filters: EventFilters, cursor?: string): Promise<EventPage> {
    const fetchedAt = this.clock.now();
    const all = this.catalog.filter((s) => {
      if (filters.status?.length && !filters.status.includes(s.status)) return false;
      if (filters.category && filters.category !== "crypto") return false;
      if (filters.query && !s.question.toLowerCase().includes(filters.query.toLowerCase())) return false;
      return true;
    });

    const start = decodeCursor(cursor);
    const limit = Math.max(1, Math.min(filters.limit ?? this.defaultPageSize, 100));
    const slice = all.slice(start, start + limit);
    const next = start + limit < all.length ? encodeCursor(start + limit) : null;

    const events: VenueEvent[] = slice.map((s) => ({
      venue: VENUE,
      venueEventId: s.venueEventId,
      title: s.eventTitle,
      category: "crypto",
      demo: true,
      markets: [this.toMarket(s, fetchedAt)],
    }));
    return { events, nextCursor: next, fetchedAt };
  }

  async getMarket(venueMarketId: string): Promise<VenueMarket> {
    return this.toMarket(this.spec(venueMarketId), this.clock.now());
  }

  /** The venue's published resolution, or null. Never a guess. */
  publishedResolution(
    venueMarketId: string,
    _raw?: RawPayload | null,
  ): { resolution: Resolution; resolvedAt: number | null } | null {
    const spec = this.spec(venueMarketId);
    if (spec.resolution === null) return null;
    return { resolution: spec.resolution, resolvedAt: spec.resolvesAt };
  }

  async getOrderbook(venueMarketId: string): Promise<Orderbook> {
    const spec = this.spec(venueMarketId);
    const marketId = marketUuid(VENUE, spec.venueMarketId);
    const observedAt = this.clock.now();
    // A settled or halted demo market shows no book — same as a real venue.
    const tradable = spec.status === "OPEN";
    const bid = round2(Math.max(0, spec.yesProbability - 0.02));
    const ask = round2(Math.min(1, spec.yesProbability + 0.02));
    return {
      marketId,
      venue: VENUE,
      venueMarketId: spec.venueMarketId,
      bids: tradable ? [{ side: "YES", probability: bid, sizeBaseUnits: "25000000" as BaseUnits }] : [],
      asks: tradable ? [{ side: "YES", probability: ask, sizeBaseUnits: "25000000" as BaseUnits }] : [],
      observedAt,
      demo: true,
      snapshot: this.snapshot(spec, observedAt),
    };
  }

  snapshot(spec: FixtureSpec, observedAt: number): MarketSnapshot {
    return {
      marketId: marketUuid(VENUE, spec.venueMarketId),
      yesProbability: spec.yesProbability,
      observedAt,
      source: "fixture",
    };
  }

  async getTradingStatus(): Promise<TradingStatus> {
    return {
      venue: VENUE,
      tradingEnabled: true,
      reason: "Demo catalog — no real liquidity, no real settlement.",
      geoBlocked: false,
      kycRequired: false,
      minimumOrderBaseUnits: "1000000",
      observedAt: this.clock.now(),
      demo: true,
    };
  }

  // ── orders (demo only) ─────────────────────────────────────────────────────

  async createBuyOrder(o: CreateOrderInput): Promise<UnsignedOrder> {
    if (!o.idempotencyKey) {
      throw new VenueError("VENUE_BAD_REQUEST", "fixture: createBuyOrder requires an idempotencyKey", {
        venue: VENUE,
      });
    }
    const spec = this.spec(o.venueMarketId);
    if (spec.status !== "OPEN") {
      throw new VenueError("VENUE_BAD_REQUEST", `fixture: market ${o.venueMarketId} is ${spec.status}`, {
        venue: VENUE,
        details: { status: spec.status },
      });
    }
    const now = this.clock.now();
    // A venue scopes idempotency keys per ACCOUNT: two different owners using the
    // same key are two different orders, not one shared one.
    const idemKey = `${o.owner}::${o.idempotencyKey}`;
    const existingId = this.byIdempotencyKey.get(idemKey);
    const orderId = existingId ?? `fx-order-${++this.seq}`;
    if (!existingId) {
      this.byIdempotencyKey.set(idemKey, orderId);
      this.orders.set(orderId, {
        positionId: `fx-pos-${orderId}`,
        order: {
          orderId,
          venueOrderId: null,
          venue: VENUE,
          venueMarketId: spec.venueMarketId,
          owner: o.owner,
          side: o.side,
          amountBaseUnits: o.amountBaseUnits,
          filledBaseUnits: "0",
          fundingState: "QUOTED",
          fillTxSignature: null,
          createdAt: now,
          updatedAt: now,
          idempotencyKey: o.idempotencyKey,
          demo: true,
        },
      });
    }
    const state = this.orders.get(orderId)!;
    return {
      orderId,
      venue: VENUE,
      venueMarketId: spec.venueMarketId,
      owner: state.order.owner,
      side: state.order.side,
      amountBaseUnits: state.order.amountBaseUnits,
      quotedProbability: spec.yesProbability,
      fundingState: "QUOTED",
      transaction: this.demoTx(now),
      idempotencyKey: o.idempotencyKey,
      createdAt: state.order.createdAt,
      expiresAt: now + 60_000,
      demo: true,
    };
  }

  async getOrder(orderId: string): Promise<VenueOrder> {
    const state = this.orders.get(orderId);
    if (!state) {
      throw new VenueError("VENUE_NOT_FOUND", `fixture: no such order ${orderId}`, { venue: VENUE });
    }
    return { ...state.order };
  }

  async listPositions(owner: string, cursor?: string): Promise<PositionPage> {
    const all = [...this.orders.values()]
      .filter((s) => s.order.owner === owner && s.order.fundingState !== "QUOTED")
      .map((s) => this.toPosition(s));
    const start = decodeCursor(cursor);
    const slice = all.slice(start, start + this.defaultPageSize);
    return {
      positions: slice,
      nextCursor: start + this.defaultPageSize < all.length ? encodeCursor(start + this.defaultPageSize) : null,
      fetchedAt: this.clock.now(),
    };
  }

  async closePosition(owner: string, positionId: string): Promise<UnsignedOrder> {
    const state = [...this.orders.values()].find((s) => s.positionId === positionId && s.order.owner === owner);
    if (!state) {
      throw new VenueError("VENUE_NOT_FOUND", `fixture: no such position ${positionId}`, { venue: VENUE });
    }
    const now = this.clock.now();
    return {
      orderId: `fx-close-${state.order.orderId}`,
      venue: VENUE,
      venueMarketId: state.order.venueMarketId,
      owner,
      side: state.order.side,
      amountBaseUnits: state.order.filledBaseUnits,
      quotedProbability: this.spec(state.order.venueMarketId).yesProbability,
      fundingState: "QUOTED",
      transaction: this.demoTx(now),
      idempotencyKey: `close:${positionId}`,
      createdAt: now,
      expiresAt: now + 60_000,
      demo: true,
    };
  }

  async createClaim(owner: string, positionId: string): Promise<UnsignedTransaction> {
    const state = [...this.orders.values()].find((s) => s.positionId === positionId && s.order.owner === owner);
    if (!state) {
      throw new VenueError("VENUE_NOT_FOUND", `fixture: no such position ${positionId}`, { venue: VENUE });
    }
    return this.demoTx(this.clock.now());
  }

  // ── demo lifecycle drivers (tests/demos only — never called by a route) ────

  /** Simulate the client signing + sending. Money is NOT confirmed yet. */
  markSubmitted(orderId: string): void {
    const s = this.requireOrder(orderId);
    s.order = { ...s.order, fundingState: "SUBMITTED", venueOrderId: `fx-venue-${orderId}`, updatedAt: this.clock.now() };
  }

  /** Simulate the venue CONFIRMING the fill — the only thing that may read "funded". */
  confirmFill(orderId: string, filledBaseUnits?: BaseUnits): void {
    const s = this.requireOrder(orderId);
    const filled = filledBaseUnits ?? s.order.amountBaseUnits;
    s.order = {
      ...s.order,
      fundingState: BigInt(filled) < BigInt(s.order.amountBaseUnits) ? "PARTIAL" : "FILLED",
      filledBaseUnits: filled,
      venueOrderId: s.order.venueOrderId ?? `fx-venue-${orderId}`,
      fillTxSignature: `fx-sig-${orderId}`,
      updatedAt: this.clock.now(),
    };
  }

  failOrder(orderId: string): void {
    const s = this.requireOrder(orderId);
    s.order = { ...s.order, fundingState: "FAILED", updatedAt: this.clock.now() };
  }

  private requireOrder(orderId: string): FixtureOrderState {
    const s = this.orders.get(orderId);
    if (!s) throw new VenueError("VENUE_NOT_FOUND", `fixture: no such order ${orderId}`, { venue: VENUE });
    return s;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private spec(venueMarketId: string): FixtureSpec {
    const spec = this.catalog.find((s) => s.venueMarketId === venueMarketId);
    if (!spec) {
      throw new VenueError("VENUE_NOT_FOUND", `fixture: no such market ${venueMarketId}`, { venue: VENUE });
    }
    return spec;
  }

  private toMarket(spec: FixtureSpec, fetchedAt: number): VenueMarket {
    return {
      id: marketUuid(VENUE, spec.venueMarketId),
      venue: VENUE, // <- the demo flag every downstream reader keys off
      venueEventId: spec.venueEventId,
      venueMarketId: spec.venueMarketId,
      question: spec.question, // already carries [DEMO]
      rulesText: spec.rulesText,
      category: "crypto",
      outcomes: [
        { side: "YES" as Side, label: "Yes" },
        { side: "NO" as Side, label: "No" },
      ],
      status: spec.status,
      rawStatus: spec.rawStatus,
      opensAt: spec.opensAt,
      closesAt: spec.closesAt,
      resolvesAt: spec.resolvesAt,
      resolutionSource: DEMO_SOURCE,
      lastSyncedAt: fetchedAt,
      payloadVersion: FIXTURE_PAYLOAD_VERSION,
    };
  }

  private toPosition(s: FixtureOrderState): VenuePosition {
    const spec = this.spec(s.order.venueMarketId);
    const resolution = spec.resolution;
    const won = resolution !== null && resolution !== "VOID" && resolution === s.order.side;
    const fundingState: FundingState =
      s.order.fundingState === "FILLED" && resolution !== null
        ? won || resolution === "VOID"
          ? "CLAIMABLE"
          : "CLOSED"
        : s.order.fundingState;
    return {
      positionId: s.positionId,
      venue: VENUE,
      venueMarketId: s.order.venueMarketId,
      marketId: marketUuid(VENUE, s.order.venueMarketId),
      owner: s.order.owner,
      side: s.order.side,
      sizeBaseUnits: s.order.filledBaseUnits,
      averageProbability: spec.yesProbability,
      fundingState,
      claimableBaseUnits: fundingState === "CLAIMABLE" ? s.order.filledBaseUnits : "0",
      resolution,
      updatedAt: s.order.updatedAt,
      demo: true,
    };
  }

  private demoTx(now: number): UnsignedTransaction {
    return {
      venue: VENUE,
      encoding: "demo-non-executable",
      payload: DEMO_TX_PAYLOAD,
      expiresAt: now + 60_000,
      demo: true,
    };
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const encodeCursor = (offset: number): string => `fx:${offset}`;

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const m = /^fx:(\d+)$/.exec(cursor);
  if (!m) {
    throw new VenueError("VENUE_BAD_REQUEST", "fixture: malformed cursor", { venue: VENUE });
  }
  return Number(m[1]);
}
