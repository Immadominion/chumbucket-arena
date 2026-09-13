/**
 * JupiterVenue — the ONLY file in this codebase that may know Jupiter's wire
 * shape (contracts §4). Every field name, every status string and every JSON
 * quirk stops here; everything downstream sees ./types.ts.
 *
 * Three rules this file is built around:
 *
 *  1. FAIL LOUDLY. A field we do not recognise — an unknown status, a float where
 *     money should be, a RESOLVED market with no resolution — throws
 *     VENUE_SCHEMA and the whole normalisation aborts. A partially-parsed market
 *     is never returned, because a call or a receipt could be written against it.
 *  2. THE KEY IS SERVER-SIDE ONLY. It is registered with ./redact.ts at
 *     construction, so it cannot survive into an error message even if the
 *     upstream body echoes it back, and it is never put in a response.
 *  3. RAW + NORMALIZED. The provider payload each market was read from is kept
 *     alongside the versioned normalized form (see `rawPayload`).
 *
 * NOTE ON THE FIXTURES: this adapter is exercised only against recorded /
 * synthetic payloads (tests/predictionNormalization.test.ts). No live call is
 * made anywhere in this repo, and no real key exists here. When the live schema
 * is first observed, reconcile these shapes against it and bump
 * JUPITER_PAYLOAD_VERSION — the version is what tells a stored row which
 * normalisation produced it.
 */

import { z } from "zod";
import { retry, DEFAULT_RETRY, type RetryOptions } from "./backoff.ts";
import { CircuitBreaker, DEFAULT_CIRCUIT } from "./circuit.ts";
import { systemClock, type Clock } from "./clock.ts";
import { VenueError, schemaError } from "./errors.ts";
import { httpJson, type FetchLike } from "./http.ts";
import { registerSecret } from "./redact.ts";
import type {
  Capabilities,
  CreateOrderInput,
  EventFilters,
  EventPage,
  Orderbook,
  OrderbookLevel,
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
  marketUuid,
  type BaseUnits,
  type FundingState,
  type MarketStatus,
  type Resolution,
  type Side,
  type VenueMarket,
} from "./types.ts";

const VENUE = "jupiter" as const;

/** Bump whenever the normalisation below changes shape or meaning. */
export const JUPITER_PAYLOAD_VERSION = 1;

export interface JupiterVenueConfig {
  baseUrl: string;
  /** Server-side only. Never returned, never logged. */
  apiKey: string;
  timeoutMs?: number;
  clock?: Clock;
  /** Injected in tests. There is no live call anywhere in this repo. */
  fetchImpl?: FetchLike;
  retry?: Partial<RetryOptions>;
  circuit?: CircuitBreaker;
  /** Cap on remembered raw payloads (debugging aid, not a store). */
  maxRawPayloads?: number;
}

// ── Jupiter wire shapes (recorded/synthetic — see the note above) ────────────

const JupOutcome = z
  .object({ side: z.string(), label: z.string() })
  .passthrough();

/** Money must arrive as an integer string. A JSON number is a schema change. */
const JupBaseUnits = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);

const JupMarketWire = z
  .object({
    marketId: z.string().min(1),
    eventId: z.string().min(1),
    question: z.string().min(1),
    rules: z.string(),
    category: z.string().optional(),
    status: z.string().min(1),
    outcomes: z.array(JupOutcome).min(2),
    openTime: z.number().int().nullable().optional(),
    closeTime: z.number().int().nullable().optional(),
    resolveTime: z.number().int().nullable().optional(),
    resolutionSource: z.string().nullable().optional(),
    resolution: z.string().nullable().optional(),
    yesPrice: z.number().nullable().optional(),
  })
  .passthrough();

const JupEventWire = z
  .object({
    eventId: z.string().min(1),
    title: z.string().min(1),
    category: z.string().min(1),
    markets: z.array(JupMarketWire),
  })
  .passthrough();

const JupEventsResponse = z
  .object({
    events: z.array(JupEventWire),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

const JupLevelWire = z
  .object({ side: z.string(), price: z.number(), size: JupBaseUnits })
  .passthrough();

const JupOrderbookResponse = z
  .object({
    marketId: z.string().min(1),
    bids: z.array(JupLevelWire),
    asks: z.array(JupLevelWire),
    ts: z.number().int(),
  })
  .passthrough();

const JupStatusResponse = z
  .object({
    trading: z.boolean(),
    reason: z.string().nullable().optional(),
    geoBlocked: z.boolean(),
    kycRequired: z.boolean(),
    minimumOrder: JupBaseUnits,
    ts: z.number().int(),
  })
  .passthrough();

const JupOrderResponse = z
  .object({
    orderId: z.string().min(1),
    venueOrderId: z.string().nullable().optional(),
    marketId: z.string().min(1),
    owner: z.string().min(1),
    side: z.string(),
    size: JupBaseUnits,
    filledSize: JupBaseUnits.optional(),
    status: z.string().min(1),
    price: z.number().nullable().optional(),
    txSignature: z.string().nullable().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    idempotencyKey: z.string().nullable().optional(),
  })
  .passthrough();

const JupUnsignedTxWire = z
  .object({ encoding: z.string(), payload: z.string().min(1), expiresAt: z.number().int() })
  .passthrough();

const JupQuoteResponse = z
  .object({
    orderId: z.string().min(1),
    marketId: z.string().min(1),
    owner: z.string().min(1),
    side: z.string(),
    size: JupBaseUnits,
    status: z.string().min(1),
    price: z.number().nullable().optional(),
    transaction: JupUnsignedTxWire,
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .passthrough();

const JupPositionWire = z
  .object({
    positionId: z.string().min(1),
    marketId: z.string().min(1),
    owner: z.string().min(1),
    side: z.string(),
    size: JupBaseUnits,
    avgPrice: z.number().nullable().optional(),
    status: z.string().min(1),
    claimable: JupBaseUnits.optional(),
    resolution: z.string().nullable().optional(),
    updatedAt: z.number().int(),
  })
  .passthrough();

const JupPositionsResponse = z
  .object({
    positions: z.array(JupPositionWire),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

const JupClaimResponse = z.object({ transaction: JupUnsignedTxWire }).passthrough();

// ── enum mappings. An UNKNOWN value is a schema change, never a default. ─────

const STATUS_MAP: Record<string, MarketStatus> = {
  open: "OPEN",
  trading: "OPEN",
  closed: "CLOSED_PENDING_RESOLUTION",
  pending_resolution: "CLOSED_PENDING_RESOLUTION",
  resolved: "RESOLVED",
  settled: "RESOLVED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  voided: "CANCELLED",
  paused: "PAUSED",
  halted: "PAUSED",
};

const SIDE_MAP: Record<string, Side> = { yes: "YES", no: "NO" };

const RESOLUTION_MAP: Record<string, Resolution> = {
  yes: "YES",
  no: "NO",
  void: "VOID",
  cancelled: "VOID",
  canceled: "VOID",
  invalid: "VOID",
};

const ORDER_STATE_MAP: Record<string, FundingState> = {
  quoted: "QUOTED",
  pending: "QUOTED",
  submitted: "SUBMITTED",
  sent: "SUBMITTED",
  pending_fill: "SUBMITTED",
  filled: "FILLED",
  partially_filled: "PARTIAL",
  partial: "PARTIAL",
  failed: "FAILED",
  rejected: "FAILED",
  cancelled: "FAILED",
  canceled: "FAILED",
  closed: "CLOSED",
  claimable: "CLAIMABLE",
  claimed: "CLAIMED",
};

const key = (s: string) => s.trim().toLowerCase();

function mapOrThrow<T>(table: Record<string, T>, raw: string, what: string, ctx: Record<string, unknown>): T {
  const hit = table[key(raw)];
  if (hit === undefined) {
    throw schemaError(VENUE, `unknown ${what} "${raw}"`, { ...ctx, received: raw, known: Object.keys(table) });
  }
  return hit;
}

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw schemaError(VENUE, `${what} failed validation`, {
      issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

const nullableMs = (v: number | null | undefined): number | null =>
  v === undefined || v === null ? null : v;

// ── the adapter ──────────────────────────────────────────────────────────────

export class JupiterVenue implements PredictionVenue, RawPayloadCapture {
  readonly venue = VENUE;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly retryOpts: Partial<RetryOptions>;
  private readonly circuit: CircuitBreaker;
  private readonly raw = new Map<string, RawPayload>();
  private readonly maxRawPayloads: number;

  constructor(cfg: JupiterVenueConfig) {
    if (!cfg.apiKey) {
      throw new VenueError("VENUE_MISCONFIGURED", "jupiter: an API key is required (server-side only)", {
        venue: VENUE,
      });
    }
    if (!cfg.baseUrl) {
      throw new VenueError("VENUE_MISCONFIGURED", "jupiter: a base URL is required", { venue: VENUE });
    }
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    registerSecret(this.apiKey); // <- the key can no longer appear in any VenueError
    this.timeoutMs = cfg.timeoutMs ?? 8_000;
    this.clock = cfg.clock ?? systemClock;
    this.fetchImpl = cfg.fetchImpl ?? ((url, init) => fetch(url, init));
    this.retryOpts = { ...DEFAULT_RETRY, clock: this.clock, ...cfg.retry };
    this.circuit = cfg.circuit ?? new CircuitBreaker({ ...DEFAULT_CIRCUIT, clock: this.clock, venue: VENUE, name: "jupiter" });
    this.maxRawPayloads = cfg.maxRawPayloads ?? 500;
  }

  get breaker(): CircuitBreaker {
    return this.circuit;
  }

  capabilities(): Capabilities {
    return {
      read: true,
      trade: true,
      liveScores: false,
      stream: false,
      geoGate: true,
      kyc: false,
      executionModel: "orderbook",
      minimumOrder: "1000000", // 1 USDC in base units; refreshed by getTradingStatus()
      claimMode: "manual",
      demo: false,
    };
  }

  rawPayload(venueMarketId: string): RawPayload | undefined {
    return this.raw.get(venueMarketId);
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async listEvents(filters: EventFilters, cursor?: string): Promise<EventPage> {
    const qs = new URLSearchParams();
    if (filters.category) qs.set("category", filters.category);
    if (filters.query) qs.set("q", filters.query);
    if (filters.limit) qs.set("limit", String(filters.limit));
    if (cursor) qs.set("cursor", cursor);
    const body = await this.call(`/v1/events${qs.size ? `?${qs}` : ""}`);
    const wire = parseOrThrow(JupEventsResponse, body, "GET /v1/events");
    const fetchedAt = this.clock.now();

    const events: VenueEvent[] = wire.events.map((e) => ({
      venue: VENUE,
      venueEventId: e.eventId,
      title: e.title,
      category: e.category,
      demo: false,
      markets: e.markets.map((m) => this.normalizeMarket(m, fetchedAt, e.category)),
    }));

    const wanted = filters.status;
    const filtered = wanted?.length
      ? events
          .map((e) => ({ ...e, markets: e.markets.filter((m) => wanted.includes(m.status)) }))
          .filter((e) => e.markets.length > 0)
      : events;

    return { events: filtered, nextCursor: wire.nextCursor ?? null, fetchedAt };
  }

  async getMarket(venueMarketId: string): Promise<VenueMarket> {
    const body = await this.call(`/v1/markets/${encodeURIComponent(venueMarketId)}`);
    const wire = parseOrThrow(JupMarketWire, body, "GET /v1/markets/:id");
    return this.normalizeMarket(wire, this.clock.now());
  }

  async getOrderbook(venueMarketId: string): Promise<Orderbook> {
    const body = await this.call(`/v1/markets/${encodeURIComponent(venueMarketId)}/orderbook`);
    const wire = parseOrThrow(JupOrderbookResponse, body, "GET /v1/markets/:id/orderbook");
    const marketId = marketUuid(VENUE, wire.marketId);
    const bids = wire.bids.map((l) => this.normalizeLevel(l, wire.marketId));
    const asks = wire.asks.map((l) => this.normalizeLevel(l, wire.marketId));
    const mid = midProbability(bids, asks);
    return {
      marketId,
      venue: VENUE,
      venueMarketId: wire.marketId,
      bids,
      asks,
      observedAt: wire.ts,
      demo: false,
      snapshot:
        mid === null ? null : { marketId, yesProbability: mid, observedAt: wire.ts, source: "venue" },
    };
  }

  async getTradingStatus(): Promise<TradingStatus> {
    const body = await this.call("/v1/status");
    const wire = parseOrThrow(JupStatusResponse, body, "GET /v1/status");
    return {
      venue: VENUE,
      tradingEnabled: wire.trading,
      reason: wire.reason ?? null,
      geoBlocked: wire.geoBlocked,
      kycRequired: wire.kycRequired,
      minimumOrderBaseUnits: wire.minimumOrder,
      observedAt: wire.ts,
      demo: false,
    };
  }

  // ── orders ─────────────────────────────────────────────────────────────────

  async createBuyOrder(o: CreateOrderInput): Promise<UnsignedOrder> {
    if (!o.idempotencyKey) {
      throw new VenueError("VENUE_BAD_REQUEST", "jupiter: createBuyOrder requires an idempotencyKey", {
        venue: VENUE,
      });
    }
    const body = await this.call(
      "/v1/orders",
      {
        method: "POST",
        headers: { "idempotency-key": o.idempotencyKey },
        body: {
          marketId: o.venueMarketId,
          owner: o.owner,
          side: o.side.toLowerCase(),
          size: o.amountBaseUnits,
          limitPrice: o.limitProbability ?? null,
        },
      },
    );
    const wire = parseOrThrow(JupQuoteResponse, body, "POST /v1/orders");
    const state = mapOrThrow(ORDER_STATE_MAP, wire.status, "order status", { orderId: wire.orderId });
    // A quote is not money. If the venue ever answers a quote request with a
    // terminal money state, that is a schema/protocol change — refuse it.
    if (state !== "QUOTED") {
      throw schemaError(VENUE, `createBuyOrder returned a non-quote state "${wire.status}"`, {
        orderId: wire.orderId,
        mapped: state,
      });
    }
    return {
      orderId: wire.orderId,
      venue: VENUE,
      venueMarketId: wire.marketId,
      owner: wire.owner,
      side: mapOrThrow(SIDE_MAP, wire.side, "order side", { orderId: wire.orderId }),
      amountBaseUnits: wire.size,
      quotedProbability: probabilityOrNull(wire.price, wire.orderId),
      fundingState: "QUOTED",
      transaction: this.normalizeTx(wire.transaction),
      idempotencyKey: o.idempotencyKey,
      createdAt: wire.createdAt,
      expiresAt: wire.expiresAt,
      demo: false,
    };
  }

  async getOrder(orderId: string): Promise<VenueOrder> {
    const body = await this.call(`/v1/orders/${encodeURIComponent(orderId)}`);
    return this.normalizeOrder(parseOrThrow(JupOrderResponse, body, "GET /v1/orders/:id"));
  }

  async listPositions(owner: string, cursor?: string): Promise<PositionPage> {
    const qs = new URLSearchParams({ owner });
    if (cursor) qs.set("cursor", cursor);
    const body = await this.call(`/v1/positions?${qs}`);
    const wire = parseOrThrow(JupPositionsResponse, body, "GET /v1/positions");
    return {
      positions: wire.positions.map((p) => this.normalizePosition(p)),
      nextCursor: wire.nextCursor ?? null,
      fetchedAt: this.clock.now(),
    };
  }

  async closePosition(owner: string, positionId: string): Promise<UnsignedOrder> {
    const body = await this.call(`/v1/positions/${encodeURIComponent(positionId)}/close`, {
      method: "POST",
      body: { owner },
    });
    const wire = parseOrThrow(JupQuoteResponse, body, "POST /v1/positions/:id/close");
    return {
      orderId: wire.orderId,
      venue: VENUE,
      venueMarketId: wire.marketId,
      owner: wire.owner,
      side: mapOrThrow(SIDE_MAP, wire.side, "order side", { orderId: wire.orderId }),
      amountBaseUnits: wire.size,
      quotedProbability: probabilityOrNull(wire.price, wire.orderId),
      fundingState: "QUOTED",
      transaction: this.normalizeTx(wire.transaction),
      idempotencyKey: `close:${positionId}`,
      createdAt: wire.createdAt,
      expiresAt: wire.expiresAt,
      demo: false,
    };
  }

  async createClaim(owner: string, positionId: string): Promise<UnsignedTransaction> {
    const body = await this.call(`/v1/positions/${encodeURIComponent(positionId)}/claim`, {
      method: "POST",
      body: { owner },
    });
    const wire = parseOrThrow(JupClaimResponse, body, "POST /v1/positions/:id/claim");
    return this.normalizeTx(wire.transaction);
  }

  // ── normalisation (the boundary) ───────────────────────────────────────────

  private normalizeMarket(
    wire: z.infer<typeof JupMarketWire>,
    fetchedAt: number,
    eventCategory?: string,
  ): VenueMarket {
    const status = mapOrThrow(STATUS_MAP, wire.status, "market status", { marketId: wire.marketId });

    const outcomes = wire.outcomes.map((o) => ({
      side: mapOrThrow(SIDE_MAP, o.side, "outcome side", { marketId: wire.marketId }),
      label: o.label,
    }));
    const sides = new Set(outcomes.map((o) => o.side));
    if (!(sides.size === 2 && sides.has("YES") && sides.has("NO"))) {
      throw schemaError(VENUE, "a binary market must expose exactly one YES and one NO outcome", {
        marketId: wire.marketId,
        outcomes: outcomes.map((o) => o.side),
      });
    }

    // A RESOLVED market with no readable resolution is the one thing we must
    // never guess at (contracts §0.2 / §3). Refuse the whole market.
    if (status === "RESOLVED") {
      if (wire.resolution === null || wire.resolution === undefined || wire.resolution === "") {
        throw schemaError(VENUE, "market is RESOLVED but carries no resolution", { marketId: wire.marketId });
      }
      const r = mapOrThrow(RESOLUTION_MAP, wire.resolution, "resolution", { marketId: wire.marketId });
      if (r === "VOID") {
        throw schemaError(
          VENUE,
          `market status "${wire.status}" and resolution "${wire.resolution}" disagree (VOID belongs to CANCELLED)`,
          { marketId: wire.marketId },
        );
      }
    }

    const market: VenueMarket = {
      id: marketUuid(VENUE, wire.marketId),
      venue: VENUE,
      venueEventId: wire.eventId,
      venueMarketId: wire.marketId, // verbatim, never re-encoded
      question: wire.question,
      rulesText: wire.rules, // the venue's exact criteria — never paraphrased
      category: wire.category ?? eventCategory ?? "crypto",
      outcomes,
      status,
      rawStatus: wire.status, // the venue's own string, unmapped
      opensAt: nullableMs(wire.openTime),
      closesAt: nullableMs(wire.closeTime),
      resolvesAt: nullableMs(wire.resolveTime),
      resolutionSource: wire.resolutionSource ?? null,
      lastSyncedAt: fetchedAt,
      payloadVersion: JUPITER_PAYLOAD_VERSION,
    };

    this.rememberRaw(wire.marketId, wire, fetchedAt);
    return market;
  }

  /**
   * Read the venue's published resolution off the raw payload the market was
   * normalized from. Returns null when the venue has not published one — never
   * a guess, never an inference from status alone.
   */
  publishedResolution(
    venueMarketId: string,
    raw: RawPayload | null,
  ): { resolution: Resolution; resolvedAt: number | null } | null {
    const body = raw?.body ?? this.raw.get(venueMarketId)?.body;
    if (body === undefined) return null;
    const m = parseOrThrow(JupMarketWire, body, "market payload");
    const status = mapOrThrow(STATUS_MAP, m.status, "market status", { marketId: m.marketId });
    if (status === "CANCELLED") return { resolution: "VOID", resolvedAt: nullableMs(m.resolveTime) };
    if (status !== "RESOLVED") return null;
    if (!m.resolution) {
      throw schemaError(VENUE, "market is RESOLVED but carries no resolution", { marketId: m.marketId });
    }
    return {
      resolution: mapOrThrow(RESOLUTION_MAP, m.resolution, "resolution", { marketId: m.marketId }),
      resolvedAt: nullableMs(m.resolveTime),
    };
  }

  private normalizeLevel(l: z.infer<typeof JupLevelWire>, marketId: string): OrderbookLevel {
    if (!(Number.isFinite(l.price) && l.price >= 0 && l.price <= 1)) {
      throw schemaError(VENUE, `orderbook price ${l.price} is outside [0,1]`, { marketId });
    }
    return {
      side: mapOrThrow(SIDE_MAP, l.side, "orderbook side", { marketId }),
      probability: l.price,
      sizeBaseUnits: l.size as BaseUnits,
    };
  }

  private normalizeTx(wire: z.infer<typeof JupUnsignedTxWire>): UnsignedTransaction {
    if (key(wire.encoding) !== "solana-tx-base64" && key(wire.encoding) !== "base64") {
      throw schemaError(VENUE, `unknown transaction encoding "${wire.encoding}"`, {});
    }
    return {
      venue: VENUE,
      encoding: "solana-tx-base64",
      payload: wire.payload,
      expiresAt: wire.expiresAt,
      demo: false,
    };
  }

  private normalizeOrder(wire: z.infer<typeof JupOrderResponse>): VenueOrder {
    const fundingState = mapOrThrow(ORDER_STATE_MAP, wire.status, "order status", { orderId: wire.orderId });
    const filled = wire.filledSize ?? "0";
    // "Never mark an order FILLED before a CONFIRMED fill." A venue that claims
    // `filled` with nothing filled, no venue order id, or no signature is
    // contradicting itself — that is a schema fault, not a fill.
    if (fundingState === "FILLED") {
      if (BigInt(filled) <= 0n || !wire.txSignature || !wire.venueOrderId) {
        throw schemaError(VENUE, "order claims FILLED without confirmed fill evidence", {
          orderId: wire.orderId,
          filledSize: filled,
          hasTxSignature: !!wire.txSignature,
          hasVenueOrderId: !!wire.venueOrderId,
        });
      }
    }
    if (fundingState === "PARTIAL" && BigInt(filled) <= 0n) {
      throw schemaError(VENUE, "order claims PARTIAL with a zero filled size", { orderId: wire.orderId });
    }
    return {
      orderId: wire.orderId,
      venueOrderId: wire.venueOrderId ?? null,
      venue: VENUE,
      venueMarketId: wire.marketId,
      owner: wire.owner,
      side: mapOrThrow(SIDE_MAP, wire.side, "order side", { orderId: wire.orderId }),
      amountBaseUnits: wire.size,
      filledBaseUnits: filled,
      fundingState,
      fillTxSignature: wire.txSignature ?? null,
      createdAt: wire.createdAt,
      updatedAt: wire.updatedAt,
      idempotencyKey: wire.idempotencyKey ?? null,
      demo: false,
    };
  }

  private normalizePosition(wire: z.infer<typeof JupPositionWire>): VenuePosition {
    return {
      positionId: wire.positionId,
      venue: VENUE,
      venueMarketId: wire.marketId,
      marketId: marketUuid(VENUE, wire.marketId),
      owner: wire.owner,
      side: mapOrThrow(SIDE_MAP, wire.side, "position side", { positionId: wire.positionId }),
      sizeBaseUnits: wire.size,
      averageProbability: probabilityOrNull(wire.avgPrice, wire.positionId),
      fundingState: mapOrThrow(ORDER_STATE_MAP, wire.status, "position status", {
        positionId: wire.positionId,
      }),
      claimableBaseUnits: wire.claimable ?? "0",
      resolution: wire.resolution
        ? mapOrThrow(RESOLUTION_MAP, wire.resolution, "resolution", { positionId: wire.positionId })
        : null,
      updatedAt: wire.updatedAt,
      demo: false,
    };
  }

  private rememberRaw(venueMarketId: string, body: unknown, fetchedAt: number): void {
    if (this.raw.size >= this.maxRawPayloads && !this.raw.has(venueMarketId)) {
      const oldest = this.raw.keys().next();
      if (!oldest.done) this.raw.delete(oldest.value);
    }
    this.raw.set(venueMarketId, {
      venue: VENUE,
      venueMarketId,
      payloadVersion: JUPITER_PAYLOAD_VERSION,
      fetchedAt,
      body,
    });
  }

  // ── transport: circuit breaker inside, backoff outside ────────────────────

  private call(
    path: string,
    init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    return retry(
      () =>
        this.circuit.run(() =>
          httpJson(
            this.fetchImpl,
            VENUE,
            {
              url,
              method: init.method ?? "GET",
              headers: {
                accept: "application/json",
                ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
                ...(init.headers ?? {}),
                // Server-side only. Registered with the redactor at construction.
                "x-api-key": this.apiKey,
              },
              ...(init.body !== undefined ? { body: init.body } : {}),
              timeoutMs: this.timeoutMs,
            },
            this.clock.now(),
          ),
        ),
      this.retryOpts,
    );
  }
}

function probabilityOrNull(v: number | null | undefined, ctxId: string): number | null {
  if (v === null || v === undefined) return null;
  if (!(Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw schemaError(VENUE, `probability ${v} is outside [0,1]`, { id: ctxId });
  }
  return v;
}

function midProbability(bids: OrderbookLevel[], asks: OrderbookLevel[]): number | null {
  const bestBid = bids.filter((l) => l.side === "YES").reduce<number | null>(
    (acc, l) => (acc === null || l.probability > acc ? l.probability : acc),
    null,
  );
  const bestAsk = asks.filter((l) => l.side === "YES").reduce<number | null>(
    (acc, l) => (acc === null || l.probability < acc ? l.probability : acc),
    null,
  );
  if (bestBid === null && bestAsk === null) return null;
  if (bestBid === null) return bestAsk;
  if (bestAsk === null) return bestBid;
  return (bestBid + bestAsk) / 2;
}
