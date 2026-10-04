/**
 * Markets' one search-and-filter row, as state. Search, topic and sort are
 * asked of the BFF (`predictions.catalog` takes `query`, `category` and
 * `sort`); the close-time window is applied here, over the rows it returns.
 *
 * Pure, so the filter rules are tested in the BFF repo.
 */

export type MarketSort = "closing" | "volume";
export type CloseWindow = "any" | "24h" | "7d" | "30d";

export interface MarketFilters {
  query: string;
  topic: string | null;
  sort: MarketSort;
  window: CloseWindow;
}

export const DEFAULT_FILTERS: MarketFilters = { query: "", topic: null, sort: "volume", window: "any" };

export const SORTS: ReadonlyArray<{ id: MarketSort; label: string; icon: string }> = [
  { id: "volume", label: "Most active", icon: "fire" },
  { id: "closing", label: "Closing soon", icon: "timer" },
];

export const WINDOWS: ReadonlyArray<{ id: CloseWindow; label: string; ms: number | null }> = [
  { id: "any", label: "Any time", ms: null },
  { id: "24h", label: "Today", ms: 24 * 3_600_000 },
  { id: "7d", label: "This week", ms: 7 * 24 * 3_600_000 },
  { id: "30d", label: "This month", ms: 30 * 24 * 3_600_000 },
];

/** Keep markets that close inside the window (a market with no close time only matches "any"). */
export function withinWindow<T extends { closesAt: number | null }>(markets: T[], window: CloseWindow, now: number): T[] {
  const ms = WINDOWS.find((w) => w.id === window)?.ms ?? null;
  if (ms === null) return markets;
  return markets.filter((m) => m.closesAt !== null && m.closesAt > now && m.closesAt - now <= ms);
}

/** How many filters differ from the default (the badge on the filter button). Search is not counted: it shows itself. */
export function activeFilterCount(f: MarketFilters): number {
  return (f.topic ? 1 : 0) + (f.sort !== DEFAULT_FILTERS.sort ? 1 : 0) + (f.window !== "any" ? 1 : 0);
}

/** The catalog input for these filters. */
export function catalogInput(f: MarketFilters, cursor?: string | null): Record<string, unknown> {
  const query = f.query.trim().slice(0, 120);
  return {
    scope: "open",
    sort: f.sort,
    limit: 50,
    ...(f.topic ? { category: f.topic } : {}),
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** Restore saved filters, dropping anything unknown (a stale or tampered value is not trusted). */
export function parseFilters(raw: unknown): MarketFilters {
  if (!raw || typeof raw !== "object") return DEFAULT_FILTERS;
  const r = raw as Record<string, unknown>;
  const sort = SORTS.some((s) => s.id === r.sort) ? (r.sort as MarketSort) : DEFAULT_FILTERS.sort;
  const window = WINDOWS.some((w) => w.id === r.window) ? (r.window as CloseWindow) : "any";
  const topic = typeof r.topic === "string" && /^[a-z0-9-]{1,64}$/.test(r.topic) ? r.topic : null;
  // Search is per visit: it is not restored.
  return { query: "", topic, sort, window };
}
