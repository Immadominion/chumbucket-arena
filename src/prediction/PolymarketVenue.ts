/**
 * PolymarketVenue — the ONLY file in this codebase that may know Polymarket's
 * wire shape (contracts §4). It reads the public, unauthenticated, read-only
 * gamma REST API at https://gamma-api.polymarket.com. There is no API key, no
 * credential and no secret anywhere in this adapter, because the endpoint needs
 * none.
 *
 * ── READ-ONLY BY DESIGN ──────────────────────────────────────────────────────
 * `createBuyOrder`, `getOrder`, `listPositions`, `closePosition` and
 * `createClaim` all refuse with a typed VenueError before any network call, and
 * `capabilities().trade` is `false`. Funded trading on Polymarket is NOT
 * implemented and must never appear possible. Polymarket's own execution runs on
 * its CLOB, which this adapter deliberately does not touch.
 *
 * ── THE THREE THINGS IT REFUSES TO DO ───────────────────────────────────────
 *  1. It never invents a resolution. A resolution is published ONLY when
 *     `closed === true` AND the parsed `outcomePrices` are exactly one `1` and
 *     one `0`. `["0","0"]` is closed-pending-resolution. `["0.0000000436",
 *     "0.9999999563"]` — the real, recorded prices on "Will Trump win the 2020
 *     U.S. presidential election?" — is ALSO closed-pending-resolution, however
 *     obvious the answer is to a human. See tests/polymarketResolution.test.ts.
 *  2. It never treats a past `endDate` as a resolution, or even as a closure.
 *     Polymarket happily serves `closed: false, acceptingOrders: true` on a
 *     market whose `endDate` was months ago (and whose `startDate` is AFTER its
 *     own `endDate`). Such a market is mapped PAUSED — not OPEN, not RESOLVED.
 *  3. It never coerces a non-binary market into a YES/NO one. `["Long","Short"]`,
 *     `["Democratic","Republican"]` and `["Up","Down"]` are all real, common
 *     Polymarket outcome pairs. They are SKIPPED in a listing and REFUSED by
 *     name in `getMarket`, never mangled into a Side.
 *
 * ── FAIL LOUDLY ─────────────────────────────────────────────────────────────
 * A wire-shape change — a response that is not an array, a market with no
 * `outcomes`, an `outcomes`/`outcomePrices` string that is not parseable JSON, a
 * price outside [0,1], a price array whose length disagrees with the outcome
 * array, an unparseable timestamp — throws VENUE_SCHEMA and aborts the whole
 * normalisation. A partially-parsed market is never returned, because a call or
 * a receipt can be written against it.
 *
 * That loudness is deliberately chosen over "skip the bad row": one malformed
 * market failing a whole page is visible, and a silently-dropped market is not.
 * The one thing that is skipped rather than thrown is a WELL-FORMED market that
 * simply is not a YES/NO binary — that is normal Polymarket data, not a schema
 * change.
 *
 * ── `venue: 'polymarket'` ───────────────────────────────────────────────────
 * `VenueId` in ./types.ts is a FROZEN closed union (`'jupiter' | 'fixture'`,
 * contracts §3). Widening a frozen type is an integration-owned change, so it is
 * NOT done here. The exact patch is filed at
 * docs/contracts/integration-requests/packet-poly.md; until it lands, the single
 * localised cast below is the whole of the workaround, and it is deliberately
 * one line in one place rather than a quiet edit to the frozen file.
 */

import { z } from "zod";
import { DEFAULT_RETRY, retry, type RetryOptions } from "./backoff.ts";
import {
  assertCacheTtls,
  DEFAULT_CACHE_TTLS,
  TtlCache,
  ttlForStatus,
  type CacheTtls,
} from "./cache.ts";
import { CircuitBreaker, DEFAULT_CIRCUIT } from "./circuit.ts";
import { systemClock, type Clock } from "./clock.ts";
import { isVenueError, schemaError, VenueError } from "./errors.ts";
import { httpJson, type FetchLike } from "./http.ts";
import type {
  Capabilities,
  CreateOrderInput,
  EventFilters,
  EventPage,
  Orderbook,
  PositionPage,
  PredictionVenue,
  PublishedResolution,
  RawPayload,
  RawPayloadCapture,
  ResolutionReader,
  TradingStatus,
  UnsignedOrder,
  UnsignedTransaction,
  VenueEvent,
  VenueOrder,
} from "./PredictionVenue.ts";
import {
  marketUuid,
  type BaseUnits,
  type MarketSnapshot,
  type MarketStatus,
  type Resolution,
  type Side,
  type VenueId,
  type VenueMarket,
} from "./types.ts";

/** The venue string that appears on every row this adapter produces. */
export const POLYMARKET_VENUE_NAME = "polymarket";

/**
 * THE ONLY PLACE `'polymarket'` is widened into the frozen `VenueId` union.
 *
 * `types.ts` is frozen by contracts §3 and adding a member is an integration-
 * owned change (filed as docs/contracts/integration-requests/packet-poly.md).
 * Rather than silently editing the frozen file, the adapter compiles against the
 * union as it stands today through this one documented cast. When the patch
 * lands, delete the cast and the constant keeps working unchanged.
 */
export const POLYMARKET_VENUE_ID = POLYMARKET_VENUE_NAME as unknown as VenueId;

const VENUE: VenueId = POLYMARKET_VENUE_ID;

/** Bump whenever the normalisation below changes shape or meaning. */
export const POLYMARKET_PAYLOAD_VERSION = 1;

/** Public, unauthenticated, read-only. */
export const POLYMARKET_BASE_URL = "https://gamma-api.polymarket.com";

/** gamma silently caps a page at 100 however large a `limit` is asked for. */
export const POLYMARKET_MAX_PAGE_SIZE = 100;

/**
 * Used when the venue tells us nothing about a market's taxonomy. gamma puts
 * tags on the EVENT, and the per-market endpoint returns an event stub with an
 * empty `tags` array, so a single-market read genuinely has no category.
 */
export const POLYMARKET_UNKNOWN_CATEGORY = "other";

// ── Polymarket gamma wire shapes ─────────────────────────────────────────────
//
// Everything below was verified against live responses on 14 September 2026 and
// recorded verbatim in tests/polymarketRecordings.ts. `.passthrough()` keeps the
// dozens of fields we do not use (liquidity, clobTokenIds, rewards, images …)
// available in the stored raw payload without pretending to understand them.

const PolyTagWire = z
  .object({ slug: z.string().nullish(), label: z.string().nullish() })
  .passthrough();

/** The event stub embedded in a market row. `tags` is usually absent here. */
const PolyEventRefWire = z
  .object({
    id: z.union([z.string(), z.number()]),
    slug: z.string().nullish(),
    title: z.string().nullish(),
    tags: z.array(PolyTagWire).nullish(),
  })
  .passthrough();

/**
 * A gamma market. Required-vs-optional here is not taste: every field marked
 * required was present and correctly typed on all 533 live markets sampled while
 * building this adapter, and every field marked `nullish` was observed missing
 * at least once (`outcomePrices` on 13, `endDate` on 10, `acceptingOrders` on
 * 101, `startDate` on 98, `closedTime` on 408, `umaEndDate` on 508).
 */
const PolyMarketWire = z
  .object({
    id: z.union([z.string(), z.number()]),
    slug: z.string().nullish(),
    question: z.string().min(1),
    /** Polymarket's resolution criteria. Used VERBATIM as `rulesText`. */
    description: z.string(),
    /** A JSON-ENCODED STRING such as `"[\"Yes\", \"No\"]"` — never an array. */
    outcomes: z.string().min(1),
    /** A JSON-ENCODED STRING of decimal strings. Sometimes absent entirely. */
    outcomePrices: z.string().nullish(),
    active: z.boolean(),
    closed: z.boolean(),
    archived: z.boolean().nullish(),
    acceptingOrders: z.boolean().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    /** "YYYY-MM-DD HH:MM:SS+00" — NOT ISO-8601. */
    closedTime: z.string().nullish(),
    umaEndDate: z.string().nullish(),
    umaResolutionStatus: z.string().nullish(),
    umaResolutionStatuses: z.string().nullish(),
    resolutionSource: z.string().nullish(),
    resolvedBy: z.string().nullish(),
    bestBid: z.number().nullish(),
    bestAsk: z.number().nullish(),
    conditionId: z.string().nullish(),
    events: z.array(PolyEventRefWire).nullish(),
  })
  .passthrough();

const PolyMarketsResponse = z.array(PolyMarketWire);

const PolyEventWire = z
  .object({
    id: z.union([z.string(), z.number()]),
    slug: z.string().nullish(),
    title: z.string().min(1),
    tags: z.array(PolyTagWire).nullish(),
    markets: z.array(PolyMarketWire).nullish(),
  })
  .passthrough();

const PolyEventsResponse = z.array(PolyEventWire);

type PolyMarket = z.infer<typeof PolyMarketWire>;
type PolyEvent = z.infer<typeof PolyEventWire>;

// ── parsing helpers. Every failure here is VENUE_SCHEMA. ────────────────────

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw schemaError(VENUE, `${what} failed validation`, {
      issues: parsed.error.issues
        .slice(0, 8)
        .map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/** gamma ids are strings today; a numeric id is rendered, never re-encoded. */
const idOf = (v: string | number): string => (typeof v === "number" ? String(v) : v);

/**
 * Polymarket publishes at least two timestamp spellings: strict ISO-8601 with a
 * `Z` (`endDate`, `umaEndDate`, `startDate`) and a Postgres-ish
 * `"2026-08-08 20:27:18+00"` (`closedTime`). Both are accepted; anything else is
 * a wire-shape change and throws rather than silently becoming `null`, because a
 * market whose deadline we cannot read would otherwise look open forever.
 */
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function parseInstant(
  raw: string | null | undefined,
  what: string,
  ctx: Record<string, unknown>,
): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const text = raw.trim();
  const m = TIMESTAMP_RE.exec(text);
  if (!m) {
    throw schemaError(VENUE, `unparseable ${what} timestamp "${text}"`, ctx);
  }
  const zone = m[8];
  let iso = text.replace(" ", "T");
  if (zone === undefined) {
    iso += "Z"; // gamma's convention is UTC; it has never omitted the zone in practice
  } else if (/^[+-]\d{2}$/.test(zone)) {
    iso = `${iso.slice(0, iso.length - zone.length)}${zone}:00`; // "+00" -> "+00:00"
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw schemaError(VENUE, `unparseable ${what} timestamp "${text}"`, ctx);
  }
  return ms;
}

function parseJsonArray(raw: string, field: string, ctx: Record<string, unknown>): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw schemaError(VENUE, `${field} is not valid JSON`, {
      ...ctx,
      received: raw.slice(0, 120),
    });
  }
  if (!Array.isArray(parsed)) {
    throw schemaError(VENUE, `${field} did not decode to an array`, {
      ...ctx,
      received: raw.slice(0, 120),
    });
  }
  return parsed;
}

/**
 * The outcome pair, as the venue published it. `not-binary` is normal, expected
 * Polymarket data — NOT a schema fault.
 */
type OutcomeShape =
  | { kind: "binary"; labels: string[]; yesIndex: number; noIndex: number }
  | { kind: "not-binary"; reason: string; labels: string[] };

function readOutcomes(wire: PolyMarket, ctx: Record<string, unknown>): OutcomeShape {
  const decoded = parseJsonArray(wire.outcomes, "outcomes", ctx);
  const labels: string[] = [];
  for (const entry of decoded) {
    if (typeof entry !== "string") {
      throw schemaError(VENUE, "outcomes contains a non-string entry", {
        ...ctx,
        received: wire.outcomes.slice(0, 120),
      });
    }
    labels.push(entry);
  }
  if (labels.length !== 2) {
    return { kind: "not-binary", reason: `${labels.length} outcomes, expected 2`, labels };
  }
  const yesIndex = labels.findIndex((l) => l.trim().toLowerCase() === "yes");
  const noIndex = labels.findIndex((l) => l.trim().toLowerCase() === "no");
  if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) {
    return { kind: "not-binary", reason: "outcomes are not a Yes/No pair", labels };
  }
  return { kind: "binary", labels, yesIndex, noIndex };
}

/** The price pair, as published. `absent` is real: 13 of 533 sampled markets. */
type PriceReading =
  | { kind: "absent" }
  | { kind: "prices"; raw: string[]; values: number[] };

function readPrices(
  wire: PolyMarket,
  outcomeCount: number,
  ctx: Record<string, unknown>,
): PriceReading {
  const raw = wire.outcomePrices;
  if (raw === null || raw === undefined || raw.trim() === "") return { kind: "absent" };
  const decoded = parseJsonArray(raw, "outcomePrices", ctx);
  if (decoded.length !== outcomeCount) {
    throw schemaError(VENUE, "outcomePrices and outcomes have different lengths", {
      ...ctx,
      outcomes: outcomeCount,
      prices: decoded.length,
    });
  }
  const strings: string[] = [];
  const values: number[] = [];
  for (const entry of decoded) {
    if (typeof entry !== "string") {
      throw schemaError(VENUE, "outcomePrices contains a non-string entry", {
        ...ctx,
        received: raw.slice(0, 120),
      });
    }
    const n = Number(entry);
    if (!(Number.isFinite(n) && n >= 0 && n <= 1)) {
      throw schemaError(VENUE, `outcomePrices entry "${entry}" is not a probability in [0,1]`, ctx);
    }
    strings.push(entry);
    values.push(n);
  }
  return { kind: "prices", raw: strings, values };
}

/**
 * The venue's own flags, unmapped, joined into `VenueMarket.rawStatus`.
 * Polymarket has no single status string — it has this flag set — so this is the
 * faithful rendering of it. Nothing derived appears here.
 */
function rawStatusOf(wire: PolyMarket): string {
  const show = (v: unknown): string => (v === null || v === undefined ? "null" : String(v));
  return [
    `active=${show(wire.active)}`,
    `closed=${show(wire.closed)}`,
    `archived=${show(wire.archived)}`,
    `acceptingOrders=${show(wire.acceptingOrders)}`,
    `umaResolutionStatus=${show(wire.umaResolutionStatus)}`,
    `umaResolutionStatuses=${show(wire.umaResolutionStatuses)}`,
  ].join(";");
}

/**
 * THE resolution rule, and the only one.
 *
 * Published ⟺ `closed === true` AND the parsed prices are exactly one `1` and
 * one `0`. Everything else — `["0","0"]`, `["1","1"]`, 0.99999…, absent prices,
 * a market that is merely past its `endDate`, a `umaResolutionStatus` of
 * "resolved" without a 1/0 settlement — returns `null`, meaning "the venue has
 * not published one". Never an inference, never a guess.
 *
 * Polymarket's gamma payload carries no cancellation/void flag, so this adapter
 * NEVER produces `Resolution: 'VOID'` and never produces `MarketStatus:
 * 'CANCELLED'`. If Polymarket voids a market, that is reported as
 * CLOSED_PENDING_RESOLUTION with no resolution rather than guessed as VOID.
 */
function publishedResolutionOf(
  wire: PolyMarket,
  shape: OutcomeShape,
  prices: PriceReading,
  ctx: Record<string, unknown>,
): PublishedResolution | null {
  if (wire.closed !== true) return null;
  if (shape.kind !== "binary") return null;
  if (prices.kind !== "prices") return null;
  const yes = prices.values[shape.yesIndex];
  const no = prices.values[shape.noIndex];
  if (yes === undefined || no === undefined) return null;

  let resolution: Resolution;
  if (yes === 1 && no === 0) resolution = "YES";
  else if (yes === 0 && no === 1) resolution = "NO";
  else return null; // not a 1/0 settlement — not a resolution

  const resolvedAt =
    parseInstant(wire.closedTime, "closedTime", ctx) ??
    parseInstant(wire.umaEndDate, "umaEndDate", ctx);
  return { resolution, resolvedAt };
}

/**
 * Polymarket flags → the frozen `MarketStatus` vocabulary.
 *
 * | Polymarket                                                  | MarketStatus              |
 * | ----------------------------------------------------------- | ------------------------- |
 * | closed=true, prices exactly one 1 and one 0                  | RESOLVED                  |
 * | closed=true, any other prices (incl. ["0","0"], 0.9999…)     | CLOSED_PENDING_RESOLUTION |
 * | closed=true, no prices published                             | CLOSED_PENDING_RESOLUTION |
 * | closed=false, archived=true                                  | PAUSED                    |
 * | closed=false, active=false                                   | PAUSED                    |
 * | closed=false, acceptingOrders=false                          | PAUSED                    |
 * | closed=false, endDate already in the past                    | PAUSED                    |
 * | closed=false, otherwise                                      | OPEN                      |
 * | (nothing)                                                    | CANCELLED — never emitted |
 *
 * The fourth-from-last row is the frozen vocabulary's blind spot: a market past
 * its stated end date that the venue has NOT closed and IS still quoting is
 * neither OPEN nor CLOSED_PENDING_RESOLUTION nor RESOLVED. PAUSED is the only
 * member that asserts nothing about closure or outcome and, per §3, "may
 * reopen" — which is exactly what these markets do when Polymarket extends the
 * date. `rawStatus` carries the venue's real flags either way.
 */
function statusOf(
  wire: PolyMarket,
  shape: OutcomeShape,
  prices: PriceReading,
  closesAt: number | null,
  nowMs: number,
  ctx: Record<string, unknown>,
): MarketStatus {
  if (wire.closed === true) {
    return publishedResolutionOf(wire, shape, prices, ctx) === null
      ? "CLOSED_PENDING_RESOLUTION"
      : "RESOLVED";
  }
  if (wire.archived === true) return "PAUSED";
  if (wire.active === false) return "PAUSED";
  if (wire.acceptingOrders === false) return "PAUSED";
  if (closesAt !== null && closesAt <= nowMs) return "PAUSED";
  return "OPEN";
}

/**
 * gamma's taxonomy is tag-based and lives on the EVENT. `all` is a meta-tag
 * carried by every event (verified: event 6090 has `['all']` and nothing else,
 * event 903224 has `['all','trump','politics',…]`), so the first MORE SPECIFIC
 * tag is preferred — but if `all` is the only thing the venue says, that is what
 * we report. The tag slug is used verbatim; no taxonomy is invented.
 */
const firstTagSlug = (tags: PolyEvent["tags"] | PolyMarket["events"]): string | null => {
  if (!Array.isArray(tags)) return null;
  const slugs: string[] = [];
  for (const t of tags) {
    const slug = (t as { slug?: string | null }).slug;
    if (typeof slug === "string" && slug.trim() !== "") slugs.push(slug);
  }
  return slugs.find((s) => s !== "all") ?? slugs[0] ?? null;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * gamma pages by `offset`, not by an opaque cursor, so the cursor IS the offset.
 * A cursor we did not mint is a caller error, not a venue fault.
 */
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d{1,9}$/.test(cursor)) {
    throw new VenueError("VENUE_BAD_REQUEST", "polymarket: malformed page cursor", {
      venue: VENUE,
      details: { cursor: cursor.slice(0, 32) },
    });
  }
  return Number(cursor);
}

/**
 * Which `closed` value answers a normalized status filter, or null for "both".
 *
 * With NO filter the answer is `false` — markets the venue still considers live.
 * gamma's own default returns the whole history, oldest first, which for this
 * product means a page of markets that ended in 2020. That is a query default,
 * not a data judgement: a caller who wants settled markets asks for them by
 * status, and nothing is hidden from a caller who does.
 */
function closedParamFor(statuses: MarketStatus[] | undefined): boolean | null {
  if (!statuses || statuses.length === 0) return false;
  const closedTrue: MarketStatus[] = ["RESOLVED", "CLOSED_PENDING_RESOLUTION"];
  const closedFalse: MarketStatus[] = ["OPEN", "PAUSED"];
  if (statuses.every((s) => closedTrue.includes(s))) return true;
  if (statuses.every((s) => closedFalse.includes(s))) return false;
  return null;
}

interface NormalizeContext {
  /** From the parent event when listing; absent on a single-market read. */
  eventId?: string;
  category?: string;
}

interface LoadedMarket {
  market: VenueMarket;
  snapshot: MarketSnapshot | null;
  fetchedAt: number;
}

export interface PolymarketVenueConfig {
  /** Defaults to the public gamma host. No key is required or accepted. */
  baseUrl?: string;
  timeoutMs?: number;
  clock?: Clock;
  /** Injected by tests, which are served entirely from recorded responses. */
  fetchImpl?: FetchLike;
  retry?: Partial<RetryOptions>;
  circuit?: CircuitBreaker;
  /** contracts §4 TTL tiers. Validated at construction. */
  cache?: CacheTtls;
  /** Cap on remembered raw payloads (a debugging aid, not a store). */
  maxRawPayloads?: number;
  defaultPageSize?: number;
}

// ── the adapter ──────────────────────────────────────────────────────────────


/**
 * gamma's "you have paged as deep as offset paging goes" answer.
 *
 * Matched on the venue's own wording rather than on the bare 422, so an
 * unrelated validation error keeps throwing. `/events/keyset` is the documented
 * way to go deeper; until this adapter speaks it, the honest behaviour is to
 * treat the cap as the end of the catalog and start again from the top.
 */
function isOffsetExhausted(err: unknown): boolean {
  if (!isVenueError(err) || err.code !== "VENUE_BAD_REQUEST") return false;
  const status = (err.details as { status?: number } | undefined)?.status;
  if (status !== 422) return false;
  const preview = String((err.details as { bodyPreview?: unknown } | undefined)?.bodyPreview ?? "");
  return /offset too large/i.test(preview);
}

export class PolymarketVenue implements PredictionVenue, RawPayloadCapture, ResolutionReader {
  readonly venue = VENUE;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly retryOpts: Partial<RetryOptions>;
  private readonly circuit: CircuitBreaker;
  private readonly ttls: CacheTtls;
  private readonly cache: TtlCache;
  private readonly raw = new Map<string, RawPayload>();
  private readonly maxRawPayloads: number;
  private readonly defaultPageSize: number;

  constructor(cfg: PolymarketVenueConfig = {}) {
    const baseUrl = (cfg.baseUrl ?? POLYMARKET_BASE_URL).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new VenueError("VENUE_MISCONFIGURED", "polymarket: baseUrl must be an http(s) URL", {
        venue: VENUE,
      });
    }
    this.baseUrl = baseUrl;
    this.timeoutMs = cfg.timeoutMs ?? 8_000;
    this.clock = cfg.clock ?? systemClock;
    this.fetchImpl = cfg.fetchImpl ?? ((url, init) => fetch(url, init));
    this.retryOpts = { ...DEFAULT_RETRY, clock: this.clock, ...cfg.retry };
    this.circuit =
      cfg.circuit ??
      new CircuitBreaker({ ...DEFAULT_CIRCUIT, clock: this.clock, venue: VENUE, name: "polymarket" });
    // contracts §4 tiers: event lists 30-60s, open markets 10-30s, settled much
    // longer. A config that violates them fails at boot, not in production.
    this.ttls = assertCacheTtls(cfg.cache ?? DEFAULT_CACHE_TTLS);
    this.cache = new TtlCache({ clock: this.clock });
    this.maxRawPayloads = cfg.maxRawPayloads ?? 500;
    this.defaultPageSize = clamp(cfg.defaultPageSize ?? 20, 1, POLYMARKET_MAX_PAGE_SIZE);
  }

  get breaker(): CircuitBreaker {
    return this.circuit;
  }

  /** Observability for cache tests and ops. */
  get cacheStats(): TtlCache["stats"] {
    return this.cache.stats;
  }

  /** Test/ops seam: forget every cached page and market. */
  clearCache(): void {
    this.cache.clear();
  }

  capabilities(): Capabilities {
    return {
      read: true,
      // READ-ONLY BY DESIGN. Every order/position/claim method refuses.
      trade: false,
      liveScores: false,
      stream: false,
      // We never place an order, so this adapter applies no geo gate of its own.
      // Polymarket's per-market `restricted` flag survives in the raw payload.
      geoGate: false,
      kyc: false,
      // Polymarket's own venue really is a central limit order book; we just
      // never send it anything.
      executionModel: "orderbook",
      // There is no order path, so there is no minimum.
      minimumOrder: "0" as BaseUnits,
      claimMode: "none",
      demo: false,
    };
  }

  rawPayload(venueMarketId: string): RawPayload | undefined {
    return this.raw.get(venueMarketId);
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /**
   * `GET /events` — gamma groups markets under an event, which is exactly the
   * `VenueEvent` shape. Markets that are not YES/NO binaries are skipped; an
   * event left with no surviving market is dropped from the page entirely.
   */
  async listEvents(filters: EventFilters, cursor?: string): Promise<EventPage> {
    const limit = clamp(filters.limit ?? this.defaultPageSize, 1, POLYMARKET_MAX_PAGE_SIZE);
    const offset = decodeCursor(cursor);

    const closed = closedParamFor(filters.status);
    // Polymarket never closes a long tail of expired markets, so endDate-
    // ascending buries every live market under years of them, and the soonest-
    // ending live markets are five-minute "Up or Down" crypto ticks and sports
    // totals — none of which are YES/NO binaries this adapter can represent.
    // A live listing therefore asks for the venue's most-traded markets whose
    // deadline has not passed; a settled listing asks for the most recently
    // ended. Both are orderings of the venue's own data, not judgements about it.
    const wantsPaused = filters.status?.includes("PAUSED") ?? false;
    const wantsFresh = closed === false && !wantsPaused;

    const qs = new URLSearchParams();
    if (closed !== null) qs.set("closed", String(closed));
    qs.set("limit", String(limit));
    qs.set("offset", String(offset));
    qs.set("order", wantsFresh ? "volume24hr" : "endDate");
    qs.set("ascending", "false");
    // gamma's taxonomy is tag-based; 'crypto' is a real tag slug.
    if (filters.category) qs.set("tag_slug", filters.category);

    // `end_date_min` is deliberately NOT part of the cache key: it is a moving
    // 'now', and keying on it would defeat the cache entirely while changing
    // nothing a caller can observe inside one TTL window.
    const cacheKey = `events:${qs.toString()}${wantsFresh ? ":live" : ""}`;

    const page = await this.cache.load<EventPage>(
      cacheKey,
      async () => {
        const q = new URLSearchParams(qs);
        if (wantsFresh) q.set("end_date_min", new Date(this.clock.now()).toISOString());

        let body: unknown;
        try {
          body = await this.call(`/events?${q.toString()}`);
        } catch (err) {
          // gamma caps offset pagination and says so in words:
          //   422 {"type":"validation error",
          //        "error":"offset too large, use /events/keyset for deeper pagination"}
          //
          // That is the venue telling us there is nothing deeper to read on
          // this access path, which is the END of the catalog — not a failure.
          // Reporting it as an error made the sync cursor a poison pill: it
          // climbed past the cap once and then every pass died on its first
          // page, forever, while the catalog silently went stale.
          //
          // Narrow on purpose. Any other 422 is a real rejection and still
          // throws, because a validation error we do not understand must not
          // be quietly turned into "no more results".
          if (isOffsetExhausted(err)) {
            return { events: [], nextCursor: null, fetchedAt: this.clock.now() };
          }
          throw err;
        }
        const wire = parseOrThrow(PolyEventsResponse, body, "GET /events");
        const fetchedAt = this.clock.now();
        const events: VenueEvent[] = [];
        for (const e of wire) {
          const eventId = idOf(e.id);
          const category = filters.category ?? firstTagSlug(e.tags) ?? POLYMARKET_UNKNOWN_CATEGORY;
          const markets: VenueMarket[] = [];
          for (const m of e.markets ?? []) {
            const loaded = this.normalizeOrSkip(m, fetchedAt, { eventId, category });
            if (loaded) markets.push(loaded.market);
          }
          // An event whose every market is non-binary contributes nothing we can
          // represent. Dropping it beats emitting an empty event.
          if (markets.length === 0) continue;
          events.push({
            venue: VENUE,
            venueEventId: eventId,
            title: e.title,
            category,
            markets,
            demo: false,
          });
        }
        // gamma pages by offset and never says whether more exist; a full page
        // is the only honest signal that there might be.
        const nextCursor = wire.length >= limit ? String(offset + limit) : null;
        return { events, nextCursor, fetchedAt };
      },
      this.ttls.eventList,
    );

    return { ...page, events: applyFilters(page.events, filters) };
  }

  async getMarket(venueMarketId: string): Promise<VenueMarket> {
    return (await this.loadMarket(venueMarketId)).market;
  }

  /**
   * gamma publishes NO order-book depth on the public REST API — the book lives
   * on Polymarket's CLOB, which this read-only adapter does not call. So the
   * levels are empty rather than fabricated: inventing a size at `bestBid` would
   * be exactly the kind of made-up number this adapter exists to avoid.
   *
   * The `snapshot` is real: it is the venue's own published YES price
   * (`outcomePrices`), falling back to the midpoint of the published
   * `bestBid`/`bestAsk` when prices are absent. `observedAt` is when the payload
   * was actually fetched, not when it was served from cache.
   */
  async getOrderbook(venueMarketId: string): Promise<Orderbook> {
    const { market, snapshot, fetchedAt } = await this.loadMarket(venueMarketId);
    return {
      marketId: market.id,
      venue: VENUE,
      venueMarketId: market.venueMarketId,
      bids: [],
      asks: [],
      snapshot,
      observedAt: fetchedAt,
      demo: false,
    };
  }

  /**
   * No network call: this adapter's trading status is a property of the adapter,
   * not of Polymarket. It never accepts an order, so it reports so plainly.
   */
  async getTradingStatus(): Promise<TradingStatus> {
    return {
      venue: VENUE,
      tradingEnabled: false,
      reason:
        "Chumbucket's Polymarket adapter is READ-ONLY: it reads the public gamma REST API and implements no order, position or claim path. Polymarket's own trading runs on its CLOB and is deliberately not wired up.",
      geoBlocked: false,
      kycRequired: false,
      minimumOrderBaseUnits: "0" as BaseUnits,
      observedAt: this.clock.now(),
      demo: false,
    };
  }

  /**
   * The venue's published resolution, read back out of the raw payload the
   * market was normalized from — or `null` when it has not published one.
   *
   * `null` is the answer for a closed market with `["0","0"]`, for a closed
   * market priced 0.9999999/0.0000000, for a market merely past its `endDate`,
   * and for a market we have never fetched. It is never an inference from status.
   */
  publishedResolution(venueMarketId: string, raw?: RawPayload | null): PublishedResolution | null {
    const body = raw?.body ?? this.raw.get(venueMarketId)?.body;
    if (body === undefined) return null;
    const wire = parseOrThrow(PolyMarketWire, body, "market payload");
    const ctx = { venueMarketId: idOf(wire.id) };
    const shape = readOutcomes(wire, ctx);
    if (shape.kind !== "binary") {
      // We would never have produced a VenueMarket for this payload, so we must
      // not produce a resolution for it either.
      throw schemaError(VENUE, `resolution asked for a non-binary market (${shape.reason})`, {
        ...ctx,
        outcomes: shape.labels,
      });
    }
    const prices = readPrices(wire, shape.labels.length, ctx);
    return publishedResolutionOf(wire, shape, prices, ctx);
  }

  // ── trading: refused, by design ────────────────────────────────────────────
  //
  // Every one of these throws BEFORE any network call and before anything is
  // written. VENUE_MISCONFIGURED is the code for "adapter misuse caught before a
  // network call": it is not retryable and does not trip the circuit breaker,
  // both of which are correct for an operation that can never succeed here.

  private refuse(method: string): never {
    throw new VenueError(
      "VENUE_MISCONFIGURED",
      `polymarket: this venue adapter is READ-ONLY by design — ${method} is not implemented. Funded trading on Polymarket does not exist in Chumbucket; capabilities().trade is false.`,
      { venue: VENUE, details: { method, readOnly: true, trade: false } },
    );
  }

  async createBuyOrder(_o: CreateOrderInput): Promise<UnsignedOrder> {
    this.refuse("createBuyOrder");
  }

  async getOrder(_orderId: string): Promise<VenueOrder> {
    this.refuse("getOrder");
  }

  async listPositions(_owner: string, _cursor?: string): Promise<PositionPage> {
    this.refuse("listPositions");
  }

  async closePosition(_owner: string, _positionId: string): Promise<UnsignedOrder> {
    this.refuse("closePosition");
  }

  async createClaim(_owner: string, _positionId: string): Promise<UnsignedTransaction> {
    this.refuse("createClaim");
  }

  // ── normalisation (the boundary) ───────────────────────────────────────────

  /**
   * One market, from gamma JSON to the frozen `VenueMarket`.
   *
   * `null` means "well-formed, but not a YES/NO binary" — a routine Polymarket
   * fact, not a fault. Anything genuinely malformed throws VENUE_SCHEMA from
   * inside the readers, so a partially-parsed market can never escape.
   */
  private normalizeOrSkip(
    wire: PolyMarket,
    fetchedAt: number,
    ctx: NormalizeContext,
  ): LoadedMarket | null {
    const venueMarketId = idOf(wire.id);
    const errCtx = { venueMarketId };

    const shape = readOutcomes(wire, errCtx);
    if (shape.kind !== "binary") return null;
    const prices = readPrices(wire, shape.labels.length, errCtx);

    const opensAt = parseInstant(wire.startDate, "startDate", errCtx);
    const closesAt = parseInstant(wire.endDate, "endDate", errCtx);
    const status = statusOf(wire, shape, prices, closesAt, fetchedAt, errCtx);
    const published = publishedResolutionOf(wire, shape, prices, errCtx);

    const yesLabel = shape.labels[shape.yesIndex];
    const noLabel = shape.labels[shape.noIndex];
    if (yesLabel === undefined || noLabel === undefined) {
      throw schemaError(VENUE, "outcome labels disappeared during normalisation", errCtx);
    }
    const outcomes: { side: Side; label: string }[] = [
      { side: "YES", label: yesLabel },
      { side: "NO", label: noLabel },
    ];

    // Polymarket usually leaves `resolutionSource` empty and names the UMA
    // adapter that resolves it in `resolvedBy`. Both are passed through
    // verbatim; neither is invented, and an empty string becomes null.
    const source = nonEmpty(wire.resolutionSource) ?? nonEmpty(wire.resolvedBy) ?? null;

    const market: VenueMarket = {
      id: marketUuid(VENUE, venueMarketId),
      venue: VENUE,
      venueEventId: ctx.eventId ?? eventIdOf(wire) ?? venueMarketId,
      venueMarketId, // verbatim, never re-encoded
      question: wire.question,
      rulesText: wire.description, // the venue's exact criteria — never paraphrased
      category: ctx.category ?? firstTagSlug(wire.events?.[0]?.tags) ?? POLYMARKET_UNKNOWN_CATEGORY,
      outcomes,
      status,
      rawStatus: rawStatusOf(wire), // the venue's own flags, unmapped
      opensAt,
      closesAt,
      // Only a PUBLISHED resolution gets a resolution time. A closed market
      // awaiting settlement has none, and we do not borrow `endDate` for it.
      resolvesAt: published?.resolvedAt ?? null,
      resolutionSource: source,
      lastSyncedAt: fetchedAt,
      payloadVersion: POLYMARKET_PAYLOAD_VERSION,
    };

    this.rememberRaw(venueMarketId, wire, fetchedAt);
    return { market, snapshot: snapshotOf(market, wire, shape, prices, fetchedAt), fetchedAt };
  }

  /** Same, but a non-binary market is an error: the caller asked for it by id. */
  private normalizeOrThrow(
    wire: PolyMarket,
    fetchedAt: number,
    ctx: NormalizeContext,
  ): LoadedMarket {
    const loaded = this.normalizeOrSkip(wire, fetchedAt, ctx);
    if (loaded) return loaded;
    const shape = readOutcomes(wire, { venueMarketId: idOf(wire.id) });
    throw schemaError(
      VENUE,
      `market ${idOf(wire.id)} is not a binary Yes/No market (${
        shape.kind === "not-binary" ? shape.reason : "unknown"
      })`,
      {
        venueMarketId: idOf(wire.id),
        outcomes: shape.kind === "not-binary" ? shape.labels : [],
      },
    );
  }

  /**
   * Cached market read. Settled markets are held for the long TTL because their
   * price can never move again (contracts §4); everything else gets the short
   * open-market TTL. Concurrent misses coalesce into a single upstream call.
   */
  private loadMarket(venueMarketId: string): Promise<LoadedMarket> {
    return this.cache.load<LoadedMarket>(
      `market:${venueMarketId}`,
      async () => {
        // gamma's `?id=` filter defaults to open markets only, so a settled
        // market needs the explicit `closed=true` pass. The path form
        // (`/markets/:id`) answers both but omits the `events` grouping, which
        // would make `venueEventId` disagree with what listEvents produced.
        const wire =
          (await this.fetchMarketById(venueMarketId, false)) ??
          (await this.fetchMarketById(venueMarketId, true));
        if (!wire) {
          throw new VenueError("VENUE_NOT_FOUND", `polymarket: no market ${venueMarketId}`, {
            venue: VENUE,
            details: { venueMarketId },
          });
        }
        return this.normalizeOrThrow(wire, this.clock.now(), {});
      },
      (v) => ttlForStatus(v.market.status, this.ttls),
    );
  }

  private async fetchMarketById(venueMarketId: string, closed: boolean): Promise<PolyMarket | null> {
    const qs = new URLSearchParams({ id: venueMarketId, limit: "1" });
    if (closed) qs.set("closed", "true");
    const body = await this.call(`/markets?${qs.toString()}`);
    const rows = parseOrThrow(PolyMarketsResponse, body, "GET /markets?id=");
    return rows[0] ?? null;
  }

  private rememberRaw(venueMarketId: string, body: unknown, fetchedAt: number): void {
    if (this.raw.size >= this.maxRawPayloads && !this.raw.has(venueMarketId)) {
      const oldest = this.raw.keys().next();
      if (!oldest.done) this.raw.delete(oldest.value);
    }
    this.raw.set(venueMarketId, {
      venue: VENUE,
      venueMarketId,
      payloadVersion: POLYMARKET_PAYLOAD_VERSION,
      fetchedAt,
      body,
    });
  }

  // ── transport: circuit breaker inside, backoff outside. No credentials. ────

  private call(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    return retry(
      () =>
        this.circuit.run(() =>
          httpJson(
            this.fetchImpl,
            VENUE,
            { url, method: "GET", headers: { accept: "application/json" }, timeoutMs: this.timeoutMs },
            this.clock.now(),
          ),
        ),
      this.retryOpts,
    );
  }
}

// ── free functions ───────────────────────────────────────────────────────────

const nonEmpty = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

const eventIdOf = (wire: PolyMarket): string | null => {
  const first = wire.events?.[0];
  return first ? idOf(first.id) : null;
};

/**
 * A real price snapshot, or nothing. `outcomePrices` is Polymarket's own
 * published YES probability; when it is absent the midpoint of the published
 * top-of-book is the next-best REAL number. When neither exists there is no
 * snapshot — an invented one would be worse than none.
 */
function snapshotOf(
  market: VenueMarket,
  wire: PolyMarket,
  shape: OutcomeShape,
  prices: PriceReading,
  observedAt: number,
): MarketSnapshot | null {
  if (shape.kind !== "binary") return null;
  if (prices.kind === "prices") {
    const yes = prices.values[shape.yesIndex];
    if (yes !== undefined) {
      return { marketId: market.id, yesProbability: yes, observedAt, source: "venue" };
    }
  }
  const bid = wire.bestBid;
  const ask = wire.bestAsk;
  if (
    typeof bid === "number" &&
    typeof ask === "number" &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid >= 0 &&
    bid <= 1 &&
    ask >= 0 &&
    ask <= 1
  ) {
    return { marketId: market.id, yesProbability: (bid + ask) / 2, observedAt, source: "venue" };
  }
  return null;
}

/**
 * Status and free-text filtering, applied to the normalized form. gamma has no
 * verified free-text parameter on `/events` (its search lives on a separate
 * endpoint that is out of scope here), so `filters.query` is matched locally
 * against the page that was fetched — it narrows a page, it does not search the
 * venue.
 */
function applyFilters(events: VenueEvent[], filters: EventFilters): VenueEvent[] {
  const wanted = filters.status;
  const query = filters.query?.trim().toLowerCase();
  let out = events;
  if (wanted?.length) {
    out = out
      .map((e) => ({ ...e, markets: e.markets.filter((m) => wanted.includes(m.status)) }))
      .filter((e) => e.markets.length > 0);
  }
  if (query) {
    out = out
      .map((e) => ({
        ...e,
        markets: e.markets.filter(
          (m) =>
            m.question.toLowerCase().includes(query) || e.title.toLowerCase().includes(query),
        ),
      }))
      .filter((e) => e.markets.length > 0);
  }
  return out;
}
