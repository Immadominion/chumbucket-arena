/**
 * TTL cache with single-flight loading and contract-enforced tiers.
 *
 * contracts §4: "Event lists 30-60s; open markets/prices 10-30s; settled markets
 * much longer." Those bounds are checked at construction — a config that
 * violates them fails loudly at boot rather than quietly over-polling a paid API
 * or serving a stale open price into a funded order.
 */

import { systemClock, type Clock } from "./clock.ts";
import { VenueError } from "./errors.ts";
import { isSettledStatus, type MarketStatus } from "./types.ts";

export interface CacheTtls {
  /** Event lists: 30–60s. */
  eventList: number;
  /** An OPEN/PAUSED market and its prices: 10–30s. */
  openMarket: number;
  /** The order book: 10–30s (a price). */
  orderbook: number;
  /** A RESOLVED/CANCELLED market: much longer — it can never change again. */
  settledMarket: number;
  /** Venue trading status. */
  tradingStatus: number;
}

export const DEFAULT_CACHE_TTLS: CacheTtls = {
  eventList: 45_000,
  openMarket: 15_000,
  orderbook: 10_000,
  settledMarket: 3_600_000, // 1h — "much longer"
  tradingStatus: 30_000,
};

const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;

/** Validate TTLs against contracts §4. Throws rather than silently clamping. */
export function assertCacheTtls(t: CacheTtls): CacheTtls {
  const problems: string[] = [];
  if (!inRange(t.eventList, 30_000, 60_000)) problems.push(`eventList=${t.eventList} (must be 30000..60000)`);
  if (!inRange(t.openMarket, 10_000, 30_000)) problems.push(`openMarket=${t.openMarket} (must be 10000..30000)`);
  if (!inRange(t.orderbook, 10_000, 30_000)) problems.push(`orderbook=${t.orderbook} (must be 10000..30000)`);
  if (!(t.settledMarket >= t.openMarket * 10)) {
    problems.push(`settledMarket=${t.settledMarket} (must be >= 10x openMarket, i.e. "much longer")`);
  }
  if (!(t.tradingStatus > 0)) problems.push(`tradingStatus=${t.tradingStatus} (must be > 0)`);
  if (problems.length) {
    throw new VenueError(
      "VENUE_MISCONFIGURED",
      `prediction cache TTLs violate contracts §4: ${problems.join("; ")}`,
    );
  }
  return t;
}

/** The TTL a market's own row and price may be held for, by lifecycle state. */
export function ttlForStatus(status: MarketStatus, ttls: CacheTtls): number {
  return isSettledStatus(status) ? ttls.settledMarket : ttls.openMarket;
}

interface Entry {
  value: unknown;
  storedAt: number;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  expiries: number;
  coalesced: number;
  evictions: number;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly clock: Clock;
  private readonly maxEntries: number;
  readonly stats: CacheStats = { hits: 0, misses: 0, expiries: 0, coalesced: 0, evictions: 0 };

  constructor(opts: { clock?: Clock; maxEntries?: number } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.maxEntries = opts.maxEntries ?? 1_000;
  }

  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) {
      this.stats.misses++;
      return undefined;
    }
    if (e.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      this.stats.expiries++;
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    return e.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Oldest insertion first — Map preserves insertion order.
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
        this.stats.evictions++;
      }
    }
    const now = this.clock.now();
    this.entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  /**
   * Cache-aside with single-flight: N concurrent misses on the same key produce
   * exactly ONE upstream call. A rejected load is never cached.
   *
   * `ttlOf` receives the loaded value so a market's TTL can depend on whether it
   * turned out to be settled.
   */
  async load<T>(key: string, loader: () => Promise<T>, ttlOf: number | ((v: T) => number)): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;

    const pending = this.inflight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return pending as Promise<T>;
    }

    const p = (async () => {
      try {
        const value = await loader();
        this.set(key, value, typeof ttlOf === "function" ? ttlOf(value) : ttlOf);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
