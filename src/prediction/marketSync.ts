/**
 * `MarketSync` — pull the configured venue's catalog into `venue_markets`,
 * `market_snapshots` and `market_resolutions`.
 *
 * This is the thing that makes the rest of the pivot real. Without it,
 * `markets.open` returns whatever a read happened to warm into memory, and
 * `calls.market_id` — a real FK onto `venue_markets(id)`, guarded by
 * `calls_guard_insert`, which refuses a call whose market row does not exist —
 * has nothing to point at.
 *
 * ── THE FOUR PROPERTIES, each of them tested ────────────────────────────────
 *
 *   IDEMPOTENT      Running it twice writes nothing the second time. Not a
 *                   duplicate market, not a duplicate snapshot, not a second
 *                   resolution. `VenueMarket.id` is a deterministic UUIDv5 over
 *                   `<venue>:<venueMarketId>` (`marketUuid`, ./types.ts), so a
 *                   re-sync hits the SAME row — upstream the write is an upsert
 *                   on that id, and `market_snapshots` has
 *                   `UNIQUE (market_id, observed_at, source)` so re-observing
 *                   one instant is one row.
 *
 *   CURSOR-BACKED   The venue's own pagination cursor is persisted after every
 *                   page, so a crash mid-walk resumes at the next page instead
 *                   of restarting the catalog.
 *
 *   UPDATED-AT      The watermark is `MAX(venue_markets.last_synced_at)` for
 *                   this venue — a real persisted column, not a side note. A
 *                   lost or corrupt cursor is therefore REBUILT from the rows
 *                   themselves: a restart repairs rather than re-imports,
 *                   because the repair walk upserts onto the same ids.
 *
 *   FAILS LOUDLY    A venue wire-shape change (`VENUE_SCHEMA`) aborts the pass.
 *                   §4: "a schema change must fail loudly at the adapter, never
 *                   silently corrupt a call or receipt." A TRANSIENT failure on
 *                   one market's price (timeout, 429, 5xx) is counted and
 *                   stepped over — the catalog still lands, and a snapshot is
 *                   optional data the next pass will pick up.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 *  - It never invents a price. A `market_snapshots` row exists only when the
 *    venue published one (`Orderbook.snapshot`), and the adapter returns null
 *    rather than a guess.
 *  - It never infers a resolution from `MarketStatus`. A `market_resolutions`
 *    row is written only when the adapter's `publishedResolution()` reads one
 *    out of the venue's own payload, and only with that payload attached —
 *    which is also what `market_resolutions_requires_evidence` demands.
 *  - It never parses provider JSON. §4 keeps that in the adapter; everything
 *    here is the normalized form.
 */

import { systemClock, type Clock } from "./clock.ts";
import { isVenueError, schemaError } from "./errors.ts";
import { capturesRaw, readsResolutions, readsIndicativePrices } from "./PredictionVenue.ts";
import { sharePriceFromIndicative } from "./sharePrices.ts";
import type { EventFilters, PredictionVenue, RawPayload } from "./PredictionVenue.ts";
import type { PredictionStore } from "./store.ts";
import { isSettledStatus, marketUuid, type VenueId, type VenueMarket } from "./types.ts";

/** Cursor name, shared by the mirror and `public.indexer_cursors`. */
export const MARKET_SYNC_CURSOR = "venue_markets:sync";

export interface MarketSyncReport {
  /** The venue the rows came from, straight off the markets themselves. null
   *  when the pass saw no market — never a guess from `capabilities()`. */
  venue: VenueId | null;
  pages: number;
  eventsSeen: number;
  marketsSeen: number;
  /** Markets handed to `upsertMarket` (idempotent: a re-sync counts them again). */
  marketsUpserted: number;
  snapshotsRecorded: number;
  resolutionsRecorded: number;
  /** Markets whose price could not be read this pass (transient venue failure). */
  snapshotsUnavailable: number;
  /** Settled markets whose published resolution had no payload to evidence it. */
  resolutionsUnevidenced: number;
  /** The venue cursor to resume from, or null when the catalog was walked out. */
  cursor: string | null;
  /** `MAX(last_synced_at)` across this venue's persisted markets, in unix ms. */
  watermark: number;
  startedAt: number;
  finishedAt: number;
}

export interface CalledMarketRefreshReport {
  marketId: string;
  resolutionRecorded: boolean;
  resolutionUnevidenced: boolean;
}

export interface MarketSyncDeps {
  venue: PredictionVenue;
  store: PredictionStore;
  clock?: Clock;
  /** Which slice of the venue to pull. Defaults to 'crypto' (§3: MVP category). */
  filters?: EventFilters;
  pageSize?: number;
  /** Safety valve against an endless cursor loop. */
  maxPagesPerPass?: number;
  /** Venue price reads per pass. Each one is a request; this bounds the cost. */
  snapshotBudget?: number;
  /** Re-read a market's price only when the stored one is at least this old. */
  snapshotMaxAgeMs?: number;
  /** Provider-scoped storage key; never feed another venue's page to this API. */
  cursorKey?: string;
}

interface PersistedCursor {
  /** The venue's own opaque page cursor, or null for "start at the beginning". */
  page: string | null;
  /** The watermark at the moment the cursor was written, unix ms. */
  at: number;
}

export class MarketSync {
  private readonly venue: PredictionVenue;
  private readonly store: PredictionStore;
  private readonly clock: Clock;
  private readonly filters: EventFilters;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly snapshotBudget: number;
  private readonly snapshotMaxAgeMs: number;
  private readonly cursorKey: string;

  constructor(deps: MarketSyncDeps) {
    this.venue = deps.venue;
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
    this.cursorKey = deps.cursorKey ?? MARKET_SYNC_CURSOR;
    this.filters = deps.filters ?? { category: "crypto" };
    this.pageSize = clamp(deps.pageSize ?? 50, 1, 100);
    // Four pages is ~900 markets, which fits inside the adapter's raw cache
    // and keeps one pass's working set small. The cursor advances every pass
    // and wraps at gamma's offset cap, so the whole catalog is still covered —
    // just over several minutes instead of all at once.
    this.maxPages = clamp(deps.maxPagesPerPass ?? 4, 1, 1000);
    this.snapshotBudget = Math.max(0, deps.snapshotBudget ?? 150);
    // Ten minutes, not one. At a 60s floor the pass re-priced the same markets
    // every tick — 150 rows a minute, ~216,000 a day, on a product with no
    // calls on it yet. Almost all of it was the same number written again.
    //
    // Ten minutes keeps a price fresh enough to call on and keeps the "data
    // age" the UI shows honest, at a tenth of the write volume. It is a cost
    // decision as much as a correctness one: these rows live in the founder's
    // Supabase.
    this.snapshotMaxAgeMs = Math.max(0, deps.snapshotMaxAgeMs ?? 600_000);
  }

  /**
   * The high-water mark: the newest `last_synced_at` this venue's persisted
   * markets carry, or the value stashed with the cursor, whichever is later.
   *
   * Deriving it from the ROWS is what makes a lost cursor a non-event: there is
   * nothing to lose that the data does not already say.
   */
  watermark(): number {
    const stashed = this.readCursor()?.at ?? 0;
    let fromRows = 0;
    for (const rec of this.store.listMarkets()) {
      if (rec.market.lastSyncedAt > fromRows) fromRows = rec.market.lastSyncedAt;
    }
    return Math.max(stashed, fromRows);
  }

  /** Forget the page cursor. The next pass re-walks and upserts onto the same ids. */
  resetCursor(): void {
    this.store.setCursor(this.cursorKey, null);
  }

  async runOnce(): Promise<MarketSyncReport> {
    const report: MarketSyncReport = {
      venue: null,
      pages: 0,
      eventsSeen: 0,
      marketsSeen: 0,
      marketsUpserted: 0,
      snapshotsRecorded: 0,
      resolutionsRecorded: 0,
      snapshotsUnavailable: 0,
      resolutionsUnevidenced: 0,
      cursor: null,
      watermark: 0,
      startedAt: this.clock.now(),
      finishedAt: 0,
    };

    // Resume where the last pass stopped. A null page cursor is "start over",
    // which is safe precisely because every write is an upsert onto a
    // deterministic id.
    let cursor: string | undefined = this.readCursor()?.page ?? undefined;
    const pending: { market: VenueMarket; raw: RawPayload | null }[] = [];

    for (let page = 0; page < this.maxPages; page++) {
      const result = await this.venue.listEvents({ ...this.filters, limit: this.pageSize }, cursor);
      report.pages++;

      for (const event of result.events) {
        report.eventsSeen++;
        for (const market of event.markets) {
          report.marketsSeen++;
          // The venue string on the row comes from the market itself, never
          // from a guess about which adapter is running.
          report.venue = market.venue;
          const raw = this.rawFor(market.venueMarketId);
          // Parent first: `market_snapshots.market_id` and
          // `market_resolutions.market_id` are both FKs onto this row, and the
          // durable writer is strictly FIFO, so upserting here is what makes
          // the two writes below legal.
          this.store.upsertMarket(market, raw);
          report.marketsUpserted++;
          pending.push({ market, raw });
        }
      }

      cursor = result.nextCursor ?? undefined;
      // Persisted after EVERY page: a crash here resumes at the next page.
      this.writeCursor({ page: result.nextCursor, at: this.clock.now() });
      if (!result.nextCursor) break;
    }

    // ── prices: the venue's own published number, or none at all ────────────
    //
    // Spend the budget on the markets people can actually call on: soonest to
    // close, first. The catalog is dominated by far-dated markets ("Arizona
    // Cardinals to win the 2027 championship"), and an unordered pass spends
    // its whole budget on those while a Bitcoin market closing tonight — the
    // product's whole target category, 4 hours to 7 days — never gets a price.
    //
    // A market with no snapshot cannot be called on at all: entry_probability
    // has no source, and calls.snapshot_id is a real FK that the store refuses
    // to null. So this ordering decides what the product can actually do.
    let budget = this.snapshotBudget;
    const now = this.clock.now();
    const byClosingSoonest = [...pending].sort((a, b) => {
      const ac = a.market.closesAt ?? Number.MAX_SAFE_INTEGER;
      const bc = b.market.closesAt ?? Number.MAX_SAFE_INTEGER;
      return ac - bc;
    });
    for (const { market } of byClosingSoonest) {
      if (budget <= 0) break;
      if (market.status !== "OPEN") continue; // a settled price will never move again
      const known = market.venue === "panta" ? this.store.latestSharePrice(market.id) : this.store.latestSnapshot(market.id);
      if (known && now - known.observedAt < this.snapshotMaxAgeMs) continue;
      budget--;
      try {
        if (market.venue === "panta" && readsIndicativePrices(this.venue)) {
          const prices = await this.venue.getIndicativePrices(market.venueMarketId);
          this.store.appendSharePrice(sharePriceFromIndicative(prices), this.rawFor(market.venueMarketId));
          report.snapshotsRecorded++;
          continue;
        }
        const book = await this.venue.getOrderbook(market.venueMarketId);
        if (!book.snapshot) continue; // the venue published no price; inventing one is worse
        this.store.appendSnapshot(book.snapshot);
        report.snapshotsRecorded++;
      } catch (err) {
        // A wire-shape change must abort the pass (§4). A timeout must not.
        if (isVenueError(err) && err.code === "VENUE_SCHEMA") throw err;
        if (isVenueError(err) && (err.retryable || err.code === "CIRCUIT_OPEN")) {
          report.snapshotsUnavailable++;
          continue;
        }
        if (isVenueError(err) && err.code === "VENUE_NOT_FOUND") {
          report.snapshotsUnavailable++;
          continue;
        }
        throw err;
      }
    }

    // ── resolutions: venue evidence only, and only with its payload ─────────
    if (readsResolutions(this.venue)) {
      for (const { market, raw } of pending) {
        if (!isSettledStatus(market.status)) continue;
        const result = this.recordPublishedResolution(market, raw);
        if (result.recorded) report.resolutionsRecorded++;
        if (result.unevidenced) report.resolutionsUnevidenced++;
      }
    }

    report.cursor = this.readCursor()?.page ?? null;
    report.watermark = this.watermark();
    report.finishedAt = this.clock.now();
    return report;
  }

  /** Revisit a specifically called Panta market even when the venue no longer
   *  includes it in catalog pages. Its current detail payload is the sole source
   *  of finality; an old status or deadline never supplies the result. */
  async refreshCalledMarket(venueMarketId: string): Promise<CalledMarketRefreshReport> {
    const market = await this.venue.getMarket(venueMarketId);
    const raw = this.rawFor(venueMarketId);
    if (market.venue !== "panta" || market.venueMarketId !== venueMarketId ||
        market.id !== marketUuid("panta", venueMarketId) ||
        raw?.venue !== "panta" || raw.venueMarketId !== venueMarketId || !raw.body) {
      throw schemaError("panta", "called-market identity or raw evidence");
    }
    this.store.upsertMarket(market, raw);
    const result = isSettledStatus(market.status)
      ? this.recordPublishedResolution(market, raw)
      : { recorded: false, unevidenced: false };
    return { marketId: market.id, resolutionRecorded: result.recorded, resolutionUnevidenced: result.unevidenced };
  }

  private recordPublishedResolution(
    market: VenueMarket,
    raw: RawPayload | null,
  ): { recorded: boolean; unevidenced: boolean } {
    if (!readsResolutions(this.venue) || this.store.getResolution(market.id)) {
      return { recorded: false, unevidenced: false };
    }
    const published = this.venue.publishedResolution(market.venueMarketId, raw);
    if (!published) return { recorded: false, unevidenced: false };
    const evidence = raw?.body ?? null;
    if (evidence === null) return { recorded: false, unevidenced: true };
    this.store.recordResolution(
      {
        marketId: market.id,
        venue: market.venue,
        venueMarketId: market.venueMarketId,
        resolution: published.resolution,
        resolvedAt: published.resolvedAt ?? market.resolvesAt ?? this.clock.now(),
        evidenceSource: market.resolutionSource ?? market.rawStatus,
        rawEvidence: evidence,
        demo: market.venue === "fixture",
      },
      this.clock.now(),
    );
    return { recorded: true, unevidenced: false };
  }

  private rawFor(venueMarketId: string): RawPayload | null {
    if (!capturesRaw(this.venue)) return null;
    return this.venue.rawPayload(venueMarketId) ?? null;
  }

  private readCursor(): PersistedCursor | null {
    const raw = this.store.getCursor(this.cursorKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedCursor>;
      const page = typeof parsed.page === "string" ? parsed.page : null;
      const at = typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0;
      return { page, at };
    } catch {
      // A corrupt cursor is not a crash and not a re-import: the watermark
      // still comes from the rows, and the walk still upserts onto the same ids.
      return null;
    }
  }

  private writeCursor(c: PersistedCursor): void {
    this.store.setCursor(this.cursorKey, JSON.stringify(c));
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.trunc(n)));
