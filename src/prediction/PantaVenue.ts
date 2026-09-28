/** Panta's live, READ-ONLY adapter. Wire shape isolated here.
 * Docs: https://docs.panta.market/api-reference/markets/{list,get}.md
 * Detail-only onChain fields observed with a live key on 2026-09-28.
 * Never infer a result from prices, `resolved`, or an oracle proposal alone.
 * No probability snapshot: independent USDC/share prices are NOT 1-p odds.
 * Test keys/fixtures are deliberately rejected instead of branded as live. */
import { utils } from "@coral-xyz/anchor";
import { z } from "zod";
import { retry, type RetryOptions } from "./backoff.ts";
import { TtlCache } from "./cache.ts";
import { CircuitBreaker } from "./circuit.ts";
import { systemClock, type Clock } from "./clock.ts";
import { VenueError, schemaError } from "./errors.ts";
import { parseRetryAfter, type FetchLike } from "./http.ts";
import { registerSecret } from "./redact.ts";
import { marketUuid, type MarketStatus, type VenueMarket } from "./types.ts";
import type { Capabilities, CreateOrderInput, EventFilters, EventPage, IndicativePriceReader,
  IndicativePrices, Orderbook, PositionPage, PredictionVenue, PublishedResolution, RawPayload,
  RawPayloadCapture, ResolutionReader, TradingStatus, UnsignedOrder, UnsignedTransaction, VenueOrder } from "./PredictionVenue.ts";

export const PANTA_BASE_URL = "https://live-api.panta.market/api/v1";
export const PANTA_PAYLOAD_VERSION = 1;
const address = z.string().refine(value => {
  try { return value.length >= 32 && value.length <= 44 && utils.bytes.bs58.decode(value).length === 32; }
  catch { return false; }
});
// Live API uses seconds, not sandbox ISO strings or client milliseconds.
const seconds = z.number().int().nonnegative().max(10_000_000_000);
const price = z.string().regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/).nullable();
const chainSchema = z.object({
  resolutionRule: z.string().optional(), sources: z.array(z.string()).optional(),
  isResolved: z.boolean().optional(), isCancelled: z.boolean().optional(), isActive: z.boolean().optional(),
  yesWins: z.boolean().optional(), pendingReview: z.string().optional(),
  resolvedAt: seconds.optional(), cancelledAt: seconds.optional(),
  claimableAt: seconds.optional(), reviewExpiresAt: seconds.optional(),
}).passthrough();
const rowSchema = z.object({
  marketId: address, category: z.string(), title: z.string(), description: z.string(),
  phase: z.enum(["primary", "secondary", "resolved", "cancelled"]),
  status: z.enum(["primary", "open", "secondary", "secondary_active", "resolved", "cancelled"]),
  resolved: z.boolean(), startTime: seconds.nullable(), endTime: seconds.nullable(),
  resolutionTime: seconds.nullable(), yesPrice: price, noPrice: price,
  onChain: chainSchema.nullish(),
}).passthrough();
type Row = z.infer<typeof rowSchema>;
/** Store/SQL evidence parity while keeping Panta wire-field parsing here. */
export function pantaPriceEvidenceMatches(body: unknown, prices: { yesPrice: string | null; noPrice: string | null }): boolean {
  const parsed = rowSchema.pick({ yesPrice: true, noPrice: true }).safeParse(body);
  return parsed.success && parsed.data.yesPrice === prices.yesPrice && parsed.data.noPrice === prices.noPrice;
}
const pageSchema = z.object({ items: z.array(z.unknown()), nextCursor: address.nullish() });
type Detail = { row: Row; raw: RawPayload; fetchedAt: number };
export interface PantaVenueConfig {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  clock?: Clock;
  retry?: Partial<RetryOptions>;
  circuit?: CircuitBreaker;
}

export class PantaVenue implements PredictionVenue, RawPayloadCapture, ResolutionReader, IndicativePriceReader {
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly circuit: CircuitBreaker;
  private readonly cache: TtlCache;
  private readonly raw = new Map<string, RawPayload>();
  private readonly timeoutMs: number;
  private nextRequestAt = 0;
  private throttle: Promise<void> = Promise.resolve();

  constructor(private readonly config: PantaVenueConfig) {
    registerSecret(config.apiKey);
    if (!/^pk_live_[A-Za-z0-9_-]+$/.test(config.apiKey)) {
      throw new VenueError("VENUE_MISCONFIGURED", "Panta requires a server-held LIVE API key; sandbox fixtures are not live markets", { venue: "panta" });
    }
    this.clock = config.clock ?? systemClock;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.circuit = config.circuit ?? new CircuitBreaker({ clock: this.clock, venue: "panta", name: "panta" });
    this.cache = new TtlCache({ clock: this.clock, maxEntries: 256 });
    this.timeoutMs = Math.min(15_000, Math.max(1, config.timeoutMs ?? 8_000));
  }

  async listEvents(filters: EventFilters, cursor?: string): Promise<EventPage> {
    if (cursor !== undefined) this.checkAddress(cursor);
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, filters.limit ?? 20))) });
    if (cursor) params.set("cursor", cursor);
    if (filters.category) params.set("category", filters.category);
    // API `status` means phase, not our five-state vocabulary. Filter locally.
    const result = await this.cache.load(`list:${params}:${JSON.stringify(filters)}`, async () => {
      const page = await this.circuit.run(async () => {
        const body = await this.request(`/markets/?${params}`);
        const parsed = pageSchema.safeParse(body);
        if (!parsed.success) throw schemaError("panta", "catalog envelope");
        return { rows: parsed.data.items.map(item => this.parseRow(item)), nextCursor: parsed.data.nextCursor ?? null };
      });
      const events: EventPage["events"] = [];
      const raw: RawPayload[] = [];
      for (const catalog of page.rows) {
        // No fake title or invented rule text; incomplete catalog rows are not calls.
        if (!catalog.title.trim()) continue;
        if (filters.category && catalog.category !== filters.category) continue;
        if (filters.query && !catalog.title.toLowerCase().includes(filters.query.toLowerCase())) continue;
        const detail = await this.detail(catalog.marketId);
        const market = this.normalize(detail);
        if (!market.question.trim() || !market.rulesText.trim()) continue;
        if (filters.status && !filters.status.includes(market.status)) continue;
        events.push({ venue: "panta", venueEventId: market.venueEventId, title: market.question,
          category: market.category, markets: [market], demo: false });
        raw.push(detail.raw);
      }
      return { page: { events, nextCursor: page.nextCursor, fetchedAt: this.clock.now() }, raw };
    }, 45_000);
    for (const raw of result.raw) this.remember(raw);
    return result.page;
  }

  async getMarket(id: string): Promise<VenueMarket> {
    const market = this.normalize(await this.detail(id));
    if (!market.question.trim() || !market.rulesText.trim()) {
      throw new VenueError("VENUE_NOT_FOUND", "Panta market has no published question or resolution rules", { venue: "panta" });
    }
    return market;
  }

  async getIndicativePrices(id: string): Promise<IndicativePrices> {
    const d = await this.detail(id);
    return { marketId: marketUuid("panta", id), venue: "panta", venueMarketId: id,
      currency: "USDC", unit: "per_share", yesPrice: d.row.yesPrice, noPrice: d.row.noPrice,
      observedAt: d.fetchedAt, executable: false, attribution: "Powered by Panta", demo: false };
  }

  async getOrderbook(id: string): Promise<Orderbook> {
    const d = await this.detail(id);
    // Panta's catalog is not an orderbook. No fabricated depth or 1-YES price.
    return { marketId: marketUuid("panta", id), venue: "panta", venueMarketId: id,
      bids: [], asks: [], snapshot: null, observedAt: d.fetchedAt, demo: false };
  }

  rawPayload(id: string): RawPayload | undefined { return this.raw.get(id); }

  publishedResolution(id: string, raw: RawPayload | null = this.raw.get(id) ?? null): PublishedResolution | null {
    if (!raw || raw.venue !== "panta" || raw.venueMarketId !== id || raw.payloadVersion !== PANTA_PAYLOAD_VERSION) return null;
    const row = this.parseRow(raw.body);
    if (row.marketId !== id) throw schemaError("panta", "resolution market mismatch");
    const c = row.onChain;
    if (!c || c.pendingReview !== "none") return null;
    if (c.reviewExpiresAt === undefined || c.reviewExpiresAt * 1000 > this.clock.now()) return null;
    if (row.phase === "cancelled" && row.status === "cancelled" && c.isCancelled === true && c.cancelledAt && c.cancelledAt * 1000 <= this.clock.now()) {
      return { resolution: "VOID", resolvedAt: c.cancelledAt * 1000 };
    }
    if (row.phase !== "resolved" || row.status !== "resolved" || !row.resolved ||
        c.isResolved !== true || c.isCancelled !== false || typeof c.yesWins !== "boolean" ||
        !c.resolvedAt || c.resolvedAt * 1000 > this.clock.now() ||
        !c.claimableAt || c.claimableAt * 1000 > this.clock.now()) return null;
    return { resolution: c.yesWins ? "YES" : "NO", resolvedAt: c.resolvedAt * 1000 };
  }

  capabilities(): Capabilities {
    return { read: true, trade: false, liveScores: false, stream: false, geoGate: false,
      kyc: false, executionModel: "hybrid", minimumOrder: "0", claimMode: "none", demo: false };
  }
  async getTradingStatus(): Promise<TradingStatus> {
    return { venue: "panta", tradingEnabled: false, reason: "Powered by Panta. Chumbucket's Panta integration is read-only; orders and claims are not enabled. Eligibility has not been established.",
      geoBlocked: false, kycRequired: false, minimumOrderBaseUnits: "0", observedAt: this.clock.now(), demo: false };
  }
  async createBuyOrder(_o: CreateOrderInput): Promise<UnsignedOrder> { return this.noTrading(); }
  async getOrder(_id: string): Promise<VenueOrder> { return this.noTrading(); }
  async listPositions(_owner: string, _cursor?: string): Promise<PositionPage> { return this.noTrading(); }
  async closePosition(_owner: string, _id: string): Promise<UnsignedOrder> { return this.noTrading(); }
  async createClaim(_owner: string, _id: string): Promise<UnsignedTransaction> { return this.noTrading(); }
  private noTrading(): never {
    throw new VenueError("FUNDED_POSITIONS_DISABLED", "Panta execution and portfolio integration are not enabled", { venue: "panta" });
  }

  private checkAddress(id: string): void {
    if (!address.safeParse(id).success) throw new VenueError("VENUE_BAD_REQUEST", "Invalid Panta market address", { venue: "panta" });
  }
  private parseRow(body: unknown): Row {
    const parsed = rowSchema.safeParse(body);
    if (!parsed.success) throw schemaError("panta", "market fields or units");
    return parsed.data;
  }
  private async detail(id: string): Promise<Detail> {
    this.checkAddress(id);
    const detail = await this.cache.load(`detail:${id}`, () => this.circuit.run(async () => {
      const body = await this.request(`/markets/${id}/`);
      const row = this.parseRow(body);
      if (row.marketId !== id) throw schemaError("panta", "detail address mismatch");
      const fetchedAt = this.clock.now();
      const raw = { venue: "panta" as const, venueMarketId: id, payloadVersion: PANTA_PAYLOAD_VERSION, fetchedAt, body };
      return { row, raw, fetchedAt };
    }), 15_000);
    this.remember(detail.raw);
    return detail;
  }
  private remember(raw: RawPayload): void {
    this.raw.delete(raw.venueMarketId); this.raw.set(raw.venueMarketId, raw);
    if (this.raw.size > 1024) this.raw.delete(this.raw.keys().next().value!);
  }

  private normalize(d: Detail): VenueMarket {
    const r = d.row, c = r.onChain;
    const closesAt = r.endTime === null ? null : r.endTime * 1000;
    let status: MarketStatus;
    if (r.phase === "cancelled" || r.status === "cancelled") status = "CANCELLED";
    else if (r.resolved || r.phase === "resolved" || r.status === "resolved") status = "CLOSED_PENDING_RESOLUTION";
    else if (closesAt !== null && closesAt <= this.clock.now()) status = "CLOSED_PENDING_RESOLUTION";
    else status = c?.isActive === false || closesAt === null ? "PAUSED" : "OPEN";
    const published = this.publishedResolution(r.marketId, d.raw);
    if (published) status = published.resolution === "VOID" ? "CANCELLED" : "RESOLVED";
    return { id: marketUuid("panta", r.marketId), venue: "panta", venueEventId: r.marketId,
      venueMarketId: r.marketId, question: r.title, rulesText: c?.resolutionRule ?? "",
      category: r.category, outcomes: [{ side: "YES", label: "Yes" }, { side: "NO", label: "No" }],
      status, rawStatus: r.status, opensAt: r.startTime === null ? null : r.startTime * 1000,
      closesAt, resolvesAt: r.resolutionTime === null ? null : r.resolutionTime * 1000,
      resolutionSource: `${PANTA_BASE_URL}/markets/${r.marketId}/`,
      lastSyncedAt: d.fetchedAt, payloadVersion: PANTA_PAYLOAD_VERSION };
  }

  private async request(path: string): Promise<unknown> {
    return retry(async () => {
      // Conservative per-instance pacing under the documented 120 reads/minute.
      const slot = this.throttle.then(async () => {
        await this.clock.sleep(Math.max(0, this.nextRequestAt - this.clock.now()));
        this.nextRequestAt = this.clock.now() + 600;
      });
      this.throttle = slot.catch(() => {}); await slot;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${PANTA_BASE_URL}${path}`, { method: "GET",
          headers: { "X-Api-Key": this.config.apiKey }, redirect: "error", signal: controller.signal });
        if (!response.ok) {
          const code = response.status === 429 ? "VENUE_RATE_LIMITED" : response.status === 404 ? "VENUE_NOT_FOUND"
            : response.status === 408 || response.status === 504 ? "VENUE_TIMEOUT" : response.status >= 500 ? "VENUE_UNAVAILABLE" : "VENUE_BAD_REQUEST";
          throw new VenueError(code, `Panta read refused (HTTP ${response.status})`, { venue: "panta",
            ...(response.status === 429 ? { retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), this.clock.now()) } : {}) });
        }
        const text = await response.text();
        if (text.includes(this.config.apiKey)) throw schemaError("panta", "credential echoed in response");
        let body: any;
        try { body = JSON.parse(text); } catch { throw schemaError("panta", "invalid JSON"); }
        if (body?.demo === true || body?.testMode === true || /sandbox|fixture|test mode/i.test(body?.disclaimer ?? "")) {
          throw schemaError("panta", "sandbox response on live adapter");
        }
        return body;
      } catch (error) {
        if (error instanceof VenueError) throw error;
        // Never echo provider bodies, credential-bearing request objects or causes.
        throw new VenueError(controller.signal.aborted ? "VENUE_TIMEOUT" : "VENUE_UNAVAILABLE", "Panta read failed", { venue: "panta" });
      } finally { clearTimeout(timer); }
    }, { ...this.config.retry, clock: this.clock });
  }
}
