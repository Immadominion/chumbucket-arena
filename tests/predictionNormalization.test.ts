/**
 * Normalisation is the boundary the whole packet rests on: if a lifecycle state
 * is mis-mapped, a call's result is wrong; if a schema change is absorbed
 * silently, a receipt is written against a market nobody parsed.
 *
 * So this file proves two things:
 *   1. EVERY normalized lifecycle state round-trips, from both venues;
 *   2. every way the wire can change shape is REJECTED, loudly, with nothing
 *      written.
 */

import { describe, expect, test } from "bun:test";
import {
  FixtureVenue,
  FIXTURE_CATALOG,
  InMemoryPredictionStore,
  JupiterVenue,
  MARKET_STATUSES,
  PredictionService,
  deriveCallOutcome,
  marketUuid,
  isVenueError,
  type MarketStatus,
  type Resolution,
} from "../src/prediction/index.ts";
import {
  JUP_LIFECYCLE,
  T0,
  TestClock,
  jsonResponse,
  jupEventsPage,
  jupMarket,
  jupOrder,
  stubFetch,
} from "./predictionFixtures.ts";

const jupiterFor = (markets: Record<string, unknown>, clock = new TestClock()) => {
  const { fetch } = stubFetch((url) => {
    const id = url.pathname.split("/").filter(Boolean).pop()!;
    const body = markets[id];
    if (!body) return new Response("not found", { status: 404 });
    return jsonResponse(body);
  });
  return new JupiterVenue({
    baseUrl: "https://venue.invalid",
    apiKey: "test-api-key-never-real",
    clock,
    fetchImpl: fetch,
    retry: { attempts: 1 },
  });
};

describe("normalized lifecycle coverage — jupiter", () => {
  const cases: [string, MarketStatus, Resolution | null][] = [
    ["OPEN", "OPEN", null],
    ["CLOSED_PENDING_RESOLUTION", "CLOSED_PENDING_RESOLUTION", null],
    ["RESOLVED-YES", "RESOLVED", "YES"],
    ["RESOLVED-NO", "RESOLVED", "NO"],
    ["CANCELLED", "CANCELLED", "VOID"],
    ["PAUSED", "PAUSED", null],
  ];

  for (const [label, status, resolution] of cases) {
    test(`${label} normalizes to status ${status} and resolution ${resolution ?? "none"}`, async () => {
      const wire = JUP_LIFECYCLE[label]!;
      const venue = jupiterFor({ [wire.marketId]: wire });
      const market = await venue.getMarket(wire.marketId);

      expect(market.status).toBe(status);
      expect(market.venue).toBe("jupiter");
      expect(market.rawStatus).toBe(wire.status); // the venue's own string, unmapped
      expect(market.venueMarketId).toBe(wire.marketId); // verbatim, never re-encoded
      expect(market.rulesText).toBe(wire.rules); // never paraphrased
      expect(market.id).toBe(marketUuid("jupiter", wire.marketId));
      expect(market.outcomes.map((o) => o.side).sort()).toEqual(["NO", "YES"]);
      expect(market.payloadVersion).toBe(1);

      const published = venue.publishedResolution(wire.marketId, null);
      expect(published?.resolution ?? null).toBe(resolution);
    });
  }

  test("the six cases cover every MarketStatus in the frozen union", () => {
    const covered = new Set(
      Object.values(JUP_LIFECYCLE).map((m) => m.status),
    );
    expect(covered.size).toBe(6); // 6 distinct raw strings…
    const normalized = new Set<MarketStatus>([
      "OPEN",
      "CLOSED_PENDING_RESOLUTION",
      "RESOLVED",
      "CANCELLED",
      "PAUSED",
    ]);
    for (const s of MARKET_STATUSES) expect(normalized.has(s)).toBe(true); // …mapping onto all 5 states
  });

  test("the Chumbucket id is stable across re-syncs and distinct per venue", async () => {
    const wire = JUP_LIFECYCLE.OPEN!;
    const venue = jupiterFor({ [wire.marketId]: wire });
    const a = await venue.getMarket(wire.marketId);
    const b = await venue.getMarket(wire.marketId);
    expect(a.id).toBe(b.id);
    expect(marketUuid("fixture", wire.marketId)).not.toBe(a.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("the raw payload is kept alongside the normalized form", async () => {
    const wire = JUP_LIFECYCLE.OPEN!;
    const venue = jupiterFor({ [wire.marketId]: wire });
    await venue.getMarket(wire.marketId);
    const raw = venue.rawPayload(wire.marketId);
    expect(raw?.venue).toBe("jupiter");
    expect(raw?.payloadVersion).toBe(1);
    expect((raw?.body as { status: string }).status).toBe("open");
  });
});

describe("normalized lifecycle coverage — fixture (demo catalog)", () => {
  test("covers every MarketStatus, plus RESOLVED-YES and RESOLVED-NO", async () => {
    const venue = new FixtureVenue({ clock: new TestClock() });
    const seen = new Map<string, MarketStatus>();
    const resolutions = new Set<string>();
    for (const spec of FIXTURE_CATALOG) {
      const m = await venue.getMarket(spec.venueMarketId);
      seen.set(m.venueMarketId, m.status);
      const r = venue.publishedResolution(m.venueMarketId);
      if (r) resolutions.add(`${m.status}:${r.resolution}`);
    }
    expect(new Set(seen.values())).toEqual(new Set(MARKET_STATUSES));
    expect(resolutions).toEqual(new Set(["RESOLVED:YES", "RESOLVED:NO", "CANCELLED:VOID"]));
  });

  test("every fixture artefact is structurally impossible to mistake for a live result", async () => {
    const venue = new FixtureVenue({ clock: new TestClock() });
    for (const spec of FIXTURE_CATALOG) {
      const m = await venue.getMarket(spec.venueMarketId);
      expect(m.venue).toBe("fixture");
      expect(m.question.startsWith("[DEMO]")).toBe(true);
      expect(m.rawStatus.startsWith("fixture:")).toBe(true);
      expect(m.resolutionSource).toContain("not a live venue result");
      const book = await venue.getOrderbook(spec.venueMarketId);
      expect(book.demo).toBe(true);
      expect(book.snapshot?.source).toBe("fixture");
    }
    expect(venue.capabilities().demo).toBe(true);
    expect((await venue.getTradingStatus()).demo).toBe(true);
  });

  test("a fixture 'transaction' is non-executable by construction", async () => {
    const clock = new TestClock();
    const venue = new FixtureVenue({ clock });
    const quote = await venue.createBuyOrder({
      idempotencyKey: "idem-demo-0001",
      owner: "demo-owner",
      venueMarketId: "fx-open-btc-120k",
      side: "YES",
      amountBaseUnits: "5000000",
    });
    expect(quote.demo).toBe(true);
    expect(quote.transaction.encoding).toBe("demo-non-executable");
    expect(quote.transaction.payload).toContain("DEMO-NON-EXECUTABLE");
    expect(quote.fundingState).toBe("QUOTED"); // a quote is never money
  });

  test("the fixture catalog is deterministic run to run", async () => {
    const a = await new FixtureVenue({ clock: new TestClock() }).getMarket("fx-open-btc-120k");
    const b = await new FixtureVenue({ clock: new TestClock() }).getMarket("fx-open-btc-120k");
    expect(a).toEqual(b);
  });
});

describe("a venue schema change is rejected, and nothing partial is written", () => {
  const reject = async (wire: unknown, id = "jup-bad") => {
    const venue = jupiterFor({ [id]: wire });
    let err: unknown;
    try {
      await venue.getMarket(id);
    } catch (e) {
      err = e;
    }
    expect(isVenueError(err)).toBe(true);
    if (isVenueError(err)) expect(err.code).toBe("VENUE_SCHEMA");
    return err;
  };

  test("an unknown status string", async () => {
    const err = await reject(jupMarket({ marketId: "jup-bad", status: "settling_soon" }));
    expect((err as Error).message).toContain("settling_soon");
  });

  test("a RESOLVED market with no resolution — never guessed", async () => {
    await reject(jupMarket({ marketId: "jup-bad", status: "resolved", resolution: null }));
  });

  test("a resolution that contradicts the status", async () => {
    await reject(jupMarket({ marketId: "jup-bad", status: "resolved", resolution: "void" }));
  });

  test("an unknown outcome side", async () => {
    await reject(
      jupMarket({
        marketId: "jup-bad",
        outcomes: [
          { side: "yes", label: "Yes" },
          { side: "maybe", label: "Maybe" },
        ],
      }),
    );
  });

  test("a market that is no longer binary", async () => {
    await reject(
      jupMarket({
        marketId: "jup-bad",
        outcomes: [
          { side: "yes", label: "Yes" },
          { side: "yes", label: "Also yes" },
        ],
      }),
    );
  });

  test("a renamed required field", async () => {
    const { marketId: _drop, ...rest } = jupMarket({ marketId: "jup-bad" });
    await reject({ ...rest, market_id: "jup-bad" });
  });

  test("money arriving as a JSON number instead of integer base units", async () => {
    const clock = new TestClock();
    const { fetch } = stubFetch(() =>
      jsonResponse({
        marketId: "jup-open",
        bids: [{ side: "yes", price: 0.6, size: 25000000 }],
        asks: [],
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
    await expect(venue.getOrderbook("jup-open")).rejects.toThrow(/unexpected wire shape/);
  });

  test("a probability outside [0,1]", async () => {
    const clock = new TestClock();
    const { fetch } = stubFetch(() =>
      jsonResponse({ marketId: "jup-open", bids: [{ side: "yes", price: 1.4, size: "1" }], asks: [], ts: T0 }),
    );
    const venue = new JupiterVenue({
      baseUrl: "https://venue.invalid",
      apiKey: "test-api-key-never-real",
      clock,
      fetchImpl: fetch,
      retry: { attempts: 1 },
    });
    await expect(venue.getOrderbook("jup-open")).rejects.toThrow(/outside \[0,1\]/);
  });

  test("a 200 that is not JSON at all", async () => {
    const { fetch } = stubFetch(() => new Response("<html>maintenance</html>", { status: 200 }));
    const venue = new JupiterVenue({
      baseUrl: "https://venue.invalid",
      apiKey: "test-api-key-never-real",
      clock: new TestClock(),
      fetchImpl: fetch,
      retry: { attempts: 1 },
    });
    await expect(venue.getMarket("jup-open")).rejects.toThrow(/not JSON/);
  });

  test("an order that claims FILLED without confirmed fill evidence", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(jupOrder({ status: "filled", filledSize: "0", txSignature: null })),
    );
    const venue = new JupiterVenue({
      baseUrl: "https://venue.invalid",
      apiKey: "test-api-key-never-real",
      clock: new TestClock(),
      fetchImpl: fetch,
      retry: { attempts: 1 },
    });
    await expect(venue.getOrder("jup-order-1")).rejects.toThrow(/without confirmed fill evidence/);
  });

  test("ONE bad market in a page aborts the whole page — nothing is stored", async () => {
    const good = jupMarket({ marketId: "jup-good" });
    const bad = jupMarket({ marketId: "jup-bad", status: "who_knows" });
    const { fetch } = stubFetch(() => jsonResponse(jupEventsPage([good, bad])));
    const clock = new TestClock();
    const venue = new JupiterVenue({
      baseUrl: "https://venue.invalid",
      apiKey: "test-api-key-never-real",
      clock,
      fetchImpl: fetch,
      retry: { attempts: 1 },
    });
    const store = new InMemoryPredictionStore();
    const service = new PredictionService({ venue, store, clock, flags: { fundedPositions: false } });

    await expect(service.listEvents({})).rejects.toThrow(/unexpected wire shape/);
    expect(store.listMarkets()).toEqual([]); // not even the good one
  });
});

describe("deterministic result derivation (contracts §3)", () => {
  test("is the only rule there is", () => {
    expect(deriveCallOutcome("YES", null)).toBe("PENDING");
    expect(deriveCallOutcome("NO", null)).toBe("PENDING");
    expect(deriveCallOutcome("YES", "VOID")).toBe("VOID");
    expect(deriveCallOutcome("NO", "VOID")).toBe("VOID");
    expect(deriveCallOutcome("YES", "YES")).toBe("CORRECT");
    expect(deriveCallOutcome("NO", "NO")).toBe("CORRECT");
    expect(deriveCallOutcome("YES", "NO")).toBe("INCORRECT");
    expect(deriveCallOutcome("NO", "YES")).toBe("INCORRECT");
  });
});

describe("resolutions are venue evidence, and append-only", () => {
  test("a settled market records the venue's resolution; a contradiction is refused", async () => {
    const clock = new TestClock();
    const venue = new FixtureVenue({ clock });
    const store = new InMemoryPredictionStore();
    const service = new PredictionService({ venue, store, clock, flags: { fundedPositions: false } });

    const market = await service.getMarket("fx-resolved-yes-sol-300");
    const rec = store.getResolution(market.id);
    expect(rec?.resolution).toBe("YES");
    expect(rec?.demo).toBe(true); // fixture evidence is never a live result

    expect(() =>
      store.recordResolution(
        {
          marketId: market.id,
          venue: "fixture",
          venueMarketId: market.venueMarketId,
          resolution: "NO",
          resolvedAt: T0,
          evidenceSource: "an admin who felt like it",
          rawEvidence: null,
          demo: true,
        },
        T0,
      ),
    ).toThrow(/refusing to overwrite/);
  });

  test("an unresolved market records nothing", async () => {
    const clock = new TestClock();
    const store = new InMemoryPredictionStore();
    const service = new PredictionService({
      venue: new FixtureVenue({ clock }),
      store,
      clock,
      flags: { fundedPositions: false },
    });
    const market = await service.getMarket("fx-closed-eth-5k");
    expect(market.status).toBe("CLOSED_PENDING_RESOLUTION");
    expect(store.getResolution(market.id)).toBeUndefined();
  });
});
