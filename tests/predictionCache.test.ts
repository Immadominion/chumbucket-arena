/**
 * Caching and pagination.
 *
 * contracts §4 fixes the tiers: event lists 30-60s, open markets/prices 10-30s,
 * settled markets much longer. Those are not suggestions — an over-long TTL on
 * an open price is a stale quote in front of real money, and an over-short TTL
 * on an event list is a paid API bill. So the bounds are asserted at
 * construction and the behaviour is asserted here.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CACHE_TTLS,
  FixtureVenue,
  InMemoryPredictionStore,
  JupiterVenue,
  PredictionService,
  TtlCache,
  assertCacheTtls,
  ttlForStatus,
} from "../src/prediction/index.ts";
import { T0, TestClock, jsonResponse, jupEventsPage, jupMarket, stubFetch } from "./predictionFixtures.ts";

describe("TtlCache", () => {
  test("hit, then expiry, then refetch", () => {
    const clock = new TestClock();
    const cache = new TtlCache({ clock });
    cache.set("k", { v: 1 }, 10_000);

    expect(cache.get<{ v: number }>("k")).toEqual({ v: 1 });
    clock.advance(9_999);
    expect(cache.get<{ v: number }>("k")).toEqual({ v: 1 });
    clock.advance(1);
    expect(cache.get<{ v: number }>("k")).toBeUndefined(); // expiry is inclusive at the boundary
    expect(cache.stats.expiries).toBe(1);
    expect(cache.stats.hits).toBe(2);
  });

  test("N concurrent misses on one key produce exactly ONE upstream call", async () => {
    const clock = new TestClock();
    const cache = new TtlCache({ clock });
    let calls = 0;
    const loader = async () => {
      calls++;
      return "value";
    };
    const results = await Promise.all([
      cache.load("k", loader, 10_000),
      cache.load("k", loader, 10_000),
      cache.load("k", loader, 10_000),
    ]);
    expect(results).toEqual(["value", "value", "value"]);
    expect(calls).toBe(1);
    expect(cache.stats.coalesced).toBe(2);
  });

  test("a failed load is never cached", async () => {
    const cache = new TtlCache({ clock: new TestClock() });
    await expect(cache.load("k", async () => { throw new Error("upstream"); }, 10_000)).rejects.toThrow("upstream");
    expect(cache.get<string>("k")).toBeUndefined();
    await expect(cache.load("k", async () => "ok", 10_000)).resolves.toBe("ok");
  });

  test("evicts the oldest entry at capacity", () => {
    const cache = new TtlCache({ clock: new TestClock(), maxEntries: 2 });
    cache.set("a", 1, 10_000);
    cache.set("b", 2, 10_000);
    cache.set("c", 3, 10_000);
    expect(cache.size).toBe(2);
    expect(cache.get<number>("a")).toBeUndefined();
    expect(cache.get<number>("c")).toBe(3);
  });
});

describe("cache tiers are the contract, enforced at construction", () => {
  test("the defaults satisfy contracts §4", () => {
    expect(() => assertCacheTtls(DEFAULT_CACHE_TTLS)).not.toThrow();
    expect(DEFAULT_CACHE_TTLS.eventList).toBeGreaterThanOrEqual(30_000);
    expect(DEFAULT_CACHE_TTLS.eventList).toBeLessThanOrEqual(60_000);
    expect(DEFAULT_CACHE_TTLS.openMarket).toBeGreaterThanOrEqual(10_000);
    expect(DEFAULT_CACHE_TTLS.openMarket).toBeLessThanOrEqual(30_000);
  });

  test("an out-of-band TTL fails loudly rather than being clamped", () => {
    expect(() => assertCacheTtls({ ...DEFAULT_CACHE_TTLS, eventList: 5_000 })).toThrow(/eventList/);
    expect(() => assertCacheTtls({ ...DEFAULT_CACHE_TTLS, openMarket: 120_000 })).toThrow(/openMarket/);
    expect(() => assertCacheTtls({ ...DEFAULT_CACHE_TTLS, settledMarket: 20_000 })).toThrow(/settledMarket/);
  });

  test("a settled market is cached far longer than an open one", () => {
    expect(ttlForStatus("OPEN", DEFAULT_CACHE_TTLS)).toBe(DEFAULT_CACHE_TTLS.openMarket);
    expect(ttlForStatus("PAUSED", DEFAULT_CACHE_TTLS)).toBe(DEFAULT_CACHE_TTLS.openMarket);
    expect(ttlForStatus("CLOSED_PENDING_RESOLUTION", DEFAULT_CACHE_TTLS)).toBe(DEFAULT_CACHE_TTLS.openMarket);
    expect(ttlForStatus("RESOLVED", DEFAULT_CACHE_TTLS)).toBe(DEFAULT_CACHE_TTLS.settledMarket);
    expect(ttlForStatus("CANCELLED", DEFAULT_CACHE_TTLS)).toBe(DEFAULT_CACHE_TTLS.settledMarket);
  });
});

describe("PredictionService caching", () => {
  const serviceOver = (handler: Parameters<typeof stubFetch>[0]) => {
    const clock = new TestClock();
    const { fetch, calls } = stubFetch(handler);
    const venue = new JupiterVenue({
      baseUrl: "https://venue.invalid",
      apiKey: "test-api-key-never-real",
      clock,
      fetchImpl: fetch,
      retry: { attempts: 1 },
    });
    const store = new InMemoryPredictionStore();
    const service = new PredictionService({ venue, store, clock, flags: { fundedPositions: false } });
    return { clock, calls, service, store };
  };

  test("an OPEN market is refetched after openMarket ms, not before", async () => {
    const wire = jupMarket({ marketId: "jup-open" });
    const { clock, calls, service } = serviceOver(() => jsonResponse(wire));

    await service.getMarket("jup-open");
    await service.getMarket("jup-open");
    expect(calls.length).toBe(1);

    clock.advance(DEFAULT_CACHE_TTLS.openMarket - 1);
    await service.getMarket("jup-open");
    expect(calls.length).toBe(1);

    clock.advance(1);
    await service.getMarket("jup-open");
    expect(calls.length).toBe(2);
  });

  test("a RESOLVED market is still cached long after an open one would have expired", async () => {
    const wire = jupMarket({ marketId: "jup-res", status: "resolved", resolution: "yes", resolveTime: T0 });
    const { clock, calls, service } = serviceOver(() => jsonResponse(wire));

    await service.getMarket("jup-res");
    clock.advance(DEFAULT_CACHE_TTLS.openMarket * 5);
    await service.getMarket("jup-res");
    expect(calls.length).toBe(1);

    clock.advance(DEFAULT_CACHE_TTLS.settledMarket);
    await service.getMarket("jup-res");
    expect(calls.length).toBe(2);
  });

  test("event lists cache for the event-list tier and key on their filters", async () => {
    const { clock, calls, service } = serviceOver(() => jsonResponse(jupEventsPage([jupMarket()])));

    await service.listEvents({ category: "crypto" });
    await service.listEvents({ category: "crypto" });
    expect(calls.length).toBe(1);

    await service.listEvents({ category: "politics" }); // different key
    expect(calls.length).toBe(2);

    clock.advance(DEFAULT_CACHE_TTLS.eventList);
    await service.listEvents({ category: "crypto" });
    expect(calls.length).toBe(3);
  });

  test("filter key order does not create a second cache entry", async () => {
    const { calls, service } = serviceOver(() => jsonResponse(jupEventsPage([jupMarket()])));
    await service.listEvents({ status: ["OPEN", "PAUSED"], category: "crypto" });
    await service.listEvents({ category: "crypto", status: ["PAUSED", "OPEN"] });
    expect(calls.length).toBe(1);
  });

  test("a cached read still persists the normalized market and its raw payload", async () => {
    const { service, store } = serviceOver(() => jsonResponse(jupMarket({ marketId: "jup-open" })));
    const market = await service.getMarket("jup-open");
    const rec = store.getMarket(market.id);
    expect(rec?.market.venueMarketId).toBe("jup-open");
    expect(rec?.raw?.body).toBeDefined();
    expect(rec?.raw?.payloadVersion).toBe(1);
  });

  test("orderbook reads append a price snapshot", async () => {
    const clock = new TestClock();
    const { fetch } = stubFetch(() =>
      jsonResponse({
        marketId: "jup-open",
        bids: [{ side: "yes", price: 0.6, size: "1000000" }],
        asks: [{ side: "yes", price: 0.64, size: "1000000" }],
        ts: T0,
      }),
    );
    const venue = new JupiterVenue({
      baseUrl: "https://venue.invalid",
      apiKey: "test-api-key-never-real",
      clock,
      fetchImpl: fetch,
      retry: { attempts: 1 },
    });
    const store = new InMemoryPredictionStore();
    const service = new PredictionService({ venue, store, clock, flags: { fundedPositions: false } });
    const book = await service.getOrderbook("jup-open");
    expect(book.snapshot?.yesProbability).toBeCloseTo(0.62, 6);
    expect(book.snapshot?.source).toBe("venue");
    expect(store.latestSnapshot(book.marketId)?.yesProbability).toBeCloseTo(0.62, 6);
  });
});

describe("pagination", () => {
  test("jupiter: the cursor is passed through and the next cursor is surfaced", async () => {
    const clock = new TestClock();
    const pages: Record<string, unknown> = {
      "": jupEventsPage([jupMarket({ marketId: "m1", eventId: "e1" })], "cursor-2"),
      "cursor-2": jupEventsPage([jupMarket({ marketId: "m2", eventId: "e2" })], null),
    };
    const { fetch, calls } = stubFetch((url) => jsonResponse(pages[url.searchParams.get("cursor") ?? ""]));
    const venue = new JupiterVenue({
      baseUrl: "https://venue.invalid",
      apiKey: "test-api-key-never-real",
      clock,
      fetchImpl: fetch,
      retry: { attempts: 1 },
    });
    const service = new PredictionService({
      venue,
      store: new InMemoryPredictionStore(),
      clock,
      flags: { fundedPositions: false },
    });

    const p1 = await service.listEvents({ limit: 1 });
    expect(p1.events.map((e) => e.venueEventId)).toEqual(["e1"]);
    expect(p1.nextCursor).toBe("cursor-2");

    const p2 = await service.listEvents({ limit: 1 }, p1.nextCursor!);
    expect(p2.events.map((e) => e.venueEventId)).toEqual(["e2"]);
    expect(p2.nextCursor).toBeNull();

    expect(calls[1]!.url).toContain("cursor=cursor-2");
    expect(calls[0]!.url).toContain("limit=1");
  });

  test("fixture: walking the cursor visits every catalog entry exactly once", async () => {
    const venue = new FixtureVenue({ clock: new TestClock() });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await venue.listEvents({ limit: 2 }, cursor);
      expect(page.events.length).toBeLessThanOrEqual(2);
      for (const e of page.events) for (const m of e.markets) seen.push(m.venueMarketId);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.length).toBe(6);
    expect(new Set(seen).size).toBe(6);
  });

  test("fixture: a malformed cursor is rejected, not silently reset to page one", async () => {
    const venue = new FixtureVenue({ clock: new TestClock() });
    await expect(venue.listEvents({}, "'; DROP TABLE")).rejects.toThrow(/malformed cursor/);
  });

  test("fixture: status filters narrow the page", async () => {
    const venue = new FixtureVenue({ clock: new TestClock() });
    const page = await venue.listEvents({ status: ["RESOLVED"] });
    const ids = page.events.flatMap((e) => e.markets.map((m) => m.venueMarketId));
    expect(ids.sort()).toEqual(["fx-resolved-no-doge-1usd", "fx-resolved-yes-sol-300"]);
  });
});
