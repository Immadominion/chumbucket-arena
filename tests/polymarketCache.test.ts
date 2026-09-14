/**
 * Caching, per contracts §4: "Event lists 30-60s; open markets/prices 10-30s;
 * settled markets much longer."
 *
 * The adapter reuses src/prediction/cache.ts rather than growing its own, so the
 * contract bounds are enforced at construction and the tiers are the same ones
 * the service layer uses. Every upstream request is counted through the recorded
 * fetch, which is also what proves the suite never reaches the network.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CACHE_TTLS, isVenueError, PolymarketVenue } from "../src/prediction/index.ts";
import { harness, PolyClock } from "./polymarketHarness.ts";
import { recordedFetch } from "./polymarketRecordings.ts";

describe("contract TTL bounds are enforced at construction", () => {
  const bad = (over: Partial<typeof DEFAULT_CACHE_TTLS>) => {
    try {
      new PolymarketVenue({
        fetchImpl: recordedFetch().fetch,
        cache: { ...DEFAULT_CACHE_TTLS, ...over },
      });
      return "NO_ERROR";
    } catch (e) {
      return isVenueError(e) ? e.code : "OTHER";
    }
  };

  test("an event-list TTL outside 30-60s is refused at boot", () => {
    expect(bad({ eventList: 5_000 })).toBe("VENUE_MISCONFIGURED");
    expect(bad({ eventList: 120_000 })).toBe("VENUE_MISCONFIGURED");
  });

  test("an open-market TTL outside 10-30s is refused at boot", () => {
    expect(bad({ openMarket: 1_000 })).toBe("VENUE_MISCONFIGURED");
    expect(bad({ openMarket: 60_000 })).toBe("VENUE_MISCONFIGURED");
  });

  test("a settled TTL that is not 'much longer' is refused at boot", () => {
    expect(bad({ settledMarket: 20_000 })).toBe("VENUE_MISCONFIGURED");
  });

  test("the defaults satisfy the contract", () => {
    expect(bad({})).toBe("NO_ERROR");
    expect(DEFAULT_CACHE_TTLS.eventList).toBeGreaterThanOrEqual(30_000);
    expect(DEFAULT_CACHE_TTLS.eventList).toBeLessThanOrEqual(60_000);
    expect(DEFAULT_CACHE_TTLS.openMarket).toBeGreaterThanOrEqual(10_000);
    expect(DEFAULT_CACHE_TTLS.openMarket).toBeLessThanOrEqual(30_000);
    expect(DEFAULT_CACHE_TTLS.settledMarket).toBeGreaterThanOrEqual(
      DEFAULT_CACHE_TTLS.openMarket * 10,
    );
  });
});

describe("event lists are cached for the event-list tier", () => {
  test("a repeat inside the TTL makes no second request", async () => {
    const { venue, clock, http } = harness();
    await venue.listEvents({ limit: 2 });
    expect(http.calls).toHaveLength(1);

    clock.advance(DEFAULT_CACHE_TTLS.eventList - 1);
    await venue.listEvents({ limit: 2 });
    expect(http.calls).toHaveLength(1);
  });

  test("once the TTL expires, it refetches", async () => {
    const { venue, clock, http } = harness();
    await venue.listEvents({ limit: 2 });
    clock.advance(DEFAULT_CACHE_TTLS.eventList + 1);
    await venue.listEvents({ limit: 2 });
    expect(http.calls).toHaveLength(2);
  });

  test("a different page or filter is a different cache key", async () => {
    const { venue, http } = harness();
    await venue.listEvents({ limit: 2 });
    await venue.listEvents({ limit: 2 }, "2");
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]).toContain("offset=2");
  });
});

describe("an OPEN market gets the short tier", () => {
  test("cached within 10-30s, refetched after", async () => {
    const { venue, clock, http } = harness();
    await venue.getMarket("665374");
    expect(http.calls).toHaveLength(1);

    clock.advance(DEFAULT_CACHE_TTLS.openMarket - 1);
    await venue.getMarket("665374");
    expect(http.calls).toHaveLength(1);

    clock.advance(2);
    await venue.getMarket("665374");
    expect(http.calls).toHaveLength(2);
  });

  test("getOrderbook shares the market's cache entry rather than refetching", async () => {
    const { venue, http } = harness();
    await venue.getMarket("665374");
    const book = await venue.getOrderbook("665374");
    expect(http.calls).toHaveLength(1);
    // observedAt is when the payload was fetched, not when it was served.
    expect(book.observedAt).toBe((await venue.getMarket("665374")).lastSyncedAt);
  });
});

describe("a SETTLED market is held much longer — its price can never move again", () => {
  test("still cached an hour later, where an open market would have expired", async () => {
    const { venue, clock, http } = harness();
    const m = await venue.getMarket("3244610");
    expect(m.status).toBe("RESOLVED");
    // gamma's `?id=` filter defaults to open markets, so a settled market costs
    // an empty first pass plus the closed=true pass.
    expect(http.calls).toHaveLength(2);

    clock.advance(DEFAULT_CACHE_TTLS.openMarket * 10);
    await venue.getMarket("3244610");
    expect(http.calls).toHaveLength(2); // an OPEN market would have refetched by now

    clock.advance(DEFAULT_CACHE_TTLS.settledMarket);
    await venue.getMarket("3244610");
    expect(http.calls).toHaveLength(4);
  });

  test("a CLOSED_PENDING_RESOLUTION market stays on the SHORT tier, deliberately", async () => {
    // `isSettledStatus` is RESOLVED | CANCELLED only, and that is the right call:
    // a closed-but-unresolved market is precisely the one whose payload we need
    // to keep re-reading, because the 1/0 settlement can appear at any moment.
    // Holding it for an hour would delay every receipt derived from it.
    const { venue, clock, http } = harness();
    expect((await venue.getMarket("12")).status).toBe("CLOSED_PENDING_RESOLUTION");
    const after = http.calls.length;

    clock.advance(DEFAULT_CACHE_TTLS.openMarket - 1);
    await venue.getMarket("12");
    expect(http.calls).toHaveLength(after); // still cached inside the short tier

    clock.advance(2);
    await venue.getMarket("12");
    expect(http.calls.length).toBeGreaterThan(after); // then re-read, looking for a result
  });
});

describe("single-flight: concurrent misses coalesce into one upstream call", () => {
  test("five simultaneous getMarket calls make one request", async () => {
    const { venue, http } = harness();
    const all = await Promise.all([
      venue.getMarket("665374"),
      venue.getMarket("665374"),
      venue.getMarket("665374"),
      venue.getMarket("665374"),
      venue.getMarket("665374"),
    ]);
    expect(http.calls).toHaveLength(1);
    expect(new Set(all.map((m) => m.id)).size).toBe(1);
    expect(venue.cacheStats.coalesced).toBe(4);
  });

  test("clearCache() drops everything and the next read refetches", async () => {
    const { venue, http } = harness();
    await venue.getMarket("665374");
    venue.clearCache();
    await venue.getMarket("665374");
    expect(http.calls).toHaveLength(2);
  });
});

describe("the suite cannot reach the network", () => {
  test("an unrecorded URL throws rather than being fetched", async () => {
    const clock = new PolyClock();
    const venue = new PolymarketVenue({
      clock,
      fetchImpl: recordedFetch().fetch,
      retry: { attempts: 1 },
    });
    let message = "";
    try {
      await venue.getMarket("not-a-recorded-id");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("no recording for");
  });
});
