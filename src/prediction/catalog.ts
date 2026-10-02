/**
 * Discovery over the durable venue mirror: what `predictions.catalog` serves.
 *
 * Pure and synchronous on purpose. The worker (./marketSync.ts) is the only
 * thing that talks to the venue; this module only reads what it persisted, so
 * a phone scrolling the catalog never spends the provider's read budget.
 *
 * ── HONESTY RULES ───────────────────────────────────────────────────────────
 *
 *  - Status is never stale-optimistic. A row whose close time has passed is
 *    served as CLOSED_PENDING_RESOLUTION even if the last venue read said
 *    OPEN — the same rule the adapter applies when it normalizes, applied
 *    again at read time because the mirror can be minutes old. It is never
 *    served as RESOLVED: only recorded venue evidence settles a market.
 *  - Discovery does not require a price. A market without a fresh share price
 *    is still listed; whether a call may lock is `markets.open`'s question.
 *  - `volumeUsdc` is Panta's own reported figure from the captured payload, or
 *    null. It orders "most active"; it is never computed or estimated here.
 *  - Category chips come from the rows themselves, so they are exactly the
 *    categories the venue actually has open — never a hardcoded list.
 */

import { VenueError } from "./errors.ts";
import { pantaReportedVolume } from "./PantaVenue.ts";
import type { VenueMarketRecord } from "./store.ts";
import type { MarketStatus, VenueId, VenueMarket } from "./types.ts";

export const CATALOG_SCOPES = ["all", "open"] as const;
export type CatalogScope = (typeof CATALOG_SCOPES)[number];
/** `id` is the legacy, stable order; `closing` soonest first; `volume` most active first. */
export const CATALOG_SORTS = ["id", "closing", "volume"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

/** A mirrored market plus the venue-reported activity discovery may sort by. */
export interface CatalogMarket extends VenueMarket {
  /** Panta's `volumeUsdc`, verbatim, or null when the venue did not report it. */
  volumeUsdc: string | null;
}

export interface CatalogCategory {
  category: string;
  /** Markets in this category within the requested scope. */
  count: number;
}

export interface CatalogPage {
  markets: CatalogMarket[];
  /** Opaque. null means there is no further page. */
  nextCursor: string | null;
  /** Facets over the scope, before the category/query filters narrow it. */
  categories: CatalogCategory[];
  /** Rows matching every filter, across all pages. */
  total: number;
  servedAt: number;
}

export interface CatalogQuery {
  venue: VenueId;
  now: number;
  scope?: CatalogScope;
  category?: string;
  query?: string;
  sort?: CatalogSort;
  limit: number;
  cursor?: string;
  /** Whether the venue's resolution for this market has been recorded. */
  isResolved: (marketId: string) => boolean;
}

/** OPEN never outlives its own close time on the wire. */
export function effectiveStatus(market: VenueMarket, now: number): MarketStatus {
  return market.status === "OPEN" && market.closesAt !== null && market.closesAt <= now
    ? "CLOSED_PENDING_RESOLUTION"
    : market.status;
}

/** Discoverable right now: open, inside its trading window, and unsettled.
 *  Mirrors `acceptsNewCalls` (src/calls/markets.ts) minus the price check. */
export function isDiscoverableOpen(market: VenueMarket, now: number, resolved: boolean): boolean {
  return !resolved && effectiveStatus(market, now) === "OPEN" &&
    (market.opensAt === null || market.opensAt <= now) &&
    (market.closesAt === null || market.closesAt > now);
}

/** Lowercase, and hyphens read as spaces: "pop culture" finds `pop-culture`. */
const fold = (text: string): string => text.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

type SortKey = (string | number)[];

function sortKey(market: CatalogMarket, sort: CatalogSort): SortKey {
  const closes = market.closesAt ?? Number.MAX_SAFE_INTEGER;
  switch (sort) {
    case "id":
      return [market.id];
    case "closing":
      return [closes, market.id];
    case "volume": {
      // Reported volume first, highest first; unreported after, by closing.
      const volume = market.volumeUsdc === null ? null : Number(market.volumeUsdc);
      const known = volume !== null && Number.isFinite(volume);
      return [known ? 0 : 1, known ? -volume! : 0, closes, market.id];
    }
  }
}

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]!, y = b[i]!;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

const CURSOR_PREFIX = "k1.";

function encodeCursor(key: SortKey, sort: CatalogSort): string {
  // The legacy id order keeps its legacy cursor: the last id, verbatim.
  if (sort === "id") return String(key[0]);
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeCursor(cursor: string, sort: CatalogSort): SortKey {
  if (sort === "id") return [cursor];
  const bad = () => new VenueError("VENUE_BAD_REQUEST", "Invalid catalog cursor for this sort");
  if (!cursor.startsWith(CURSOR_PREFIX)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const width = sort === "closing" ? 2 : 4;
  if (!Array.isArray(parsed) || parsed.length !== width ||
      !parsed.every((v, i) => i === width - 1 ? typeof v === "string" : typeof v === "number" && Number.isFinite(v))) {
    throw bad();
  }
  return parsed as SortKey;
}

/**
 * One page of the mirrored catalog. Keyset pagination on (sort key, id), so a
 * market added or repriced between two page reads can neither repeat nor
 * shift another market off a page boundary.
 */
export function catalogPage(records: readonly VenueMarketRecord[], q: CatalogQuery): CatalogPage {
  const scope = q.scope ?? "all";
  const sort = q.sort ?? (scope === "open" ? "closing" : "id");
  const after = q.cursor ? decodeCursor(q.cursor, sort) : null;

  const inScope: CatalogMarket[] = [];
  for (const { market, raw } of records) {
    // Historical rows from a retired provider stay readable elsewhere, never here.
    if (market.venue !== q.venue || (market.venue !== "panta" && market.venue !== "fixture")) continue;
    if (scope === "open" && !isDiscoverableOpen(market, q.now, q.isResolved(market.id))) continue;
    inScope.push({
      ...market,
      status: effectiveStatus(market, q.now),
      volumeUsdc: market.venue === "panta" && raw?.venue === "panta" ? pantaReportedVolume(raw.body) : null,
    });
  }

  const counts = new Map<string, number>();
  for (const market of inScope) counts.set(market.category, (counts.get(market.category) ?? 0) + 1);
  const categories = [...counts].map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const category = q.category?.trim().toLowerCase();
  const term = q.query === undefined ? "" : fold(q.query);
  const matching = inScope
    .filter(m => !category || m.category.toLowerCase() === category)
    .filter(m => !term || fold(m.question).includes(term) || fold(m.category).includes(term))
    .map(m => ({ market: m, key: sortKey(m, sort) }))
    .sort((a, b) => compareKeys(a.key, b.key));

  const rest = after ? matching.filter(row => compareKeys(row.key, after) > 0) : matching;
  const page = rest.slice(0, q.limit);
  return {
    markets: page.map(row => row.market),
    nextCursor: rest.length > q.limit ? encodeCursor(page.at(-1)!.key, sort) : null,
    categories,
    total: matching.length,
    servedAt: q.now,
  };
}
