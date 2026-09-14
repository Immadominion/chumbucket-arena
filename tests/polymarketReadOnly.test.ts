/**
 * READ-ONLY BY DESIGN.
 *
 * Funded trading on Polymarket is not implemented and must not appear possible.
 * This file proves that every order/position/claim entry point refuses — before
 * any network call, before anything is written — and that `capabilities()` says
 * so plainly, so the UI and the kill switch both key off the truth.
 */

import { describe, expect, test } from "bun:test";
import {
  FixtureVenue,
  InMemoryPredictionStore,
  isVenueError,
  PredictionService,
  type PredictionVenue,
} from "../src/prediction/index.ts";
import { POLYMARKET_VENUE_ID } from "../src/prediction/PolymarketVenue.ts";
import { harness, PolyClock } from "./polymarketHarness.ts";

const ORDER_INPUT = {
  idempotencyKey: "idem-poly-1",
  owner: "OwnerAddress111",
  venueMarketId: "665374",
  side: "YES" as const,
  amountBaseUnits: "5000000",
  limitProbability: null,
};

describe("capabilities report a read-only venue", () => {
  test("trade is false, claimMode is none, demo is false", () => {
    const { venue } = harness();
    const caps = venue.capabilities();
    expect(caps.read).toBe(true);
    expect(caps.trade).toBe(false);
    expect(caps.claimMode).toBe("none");
    // It is real data from a real venue — it must NOT be labelled demo, because
    // the demo banner is what tells a user a result is not real.
    expect(caps.demo).toBe(false);
    expect(caps.stream).toBe(false);
    expect(caps.liveScores).toBe(false);
  });

  test("tradingStatus says trading is off and says why, with no network call", async () => {
    const { venue, http } = harness();
    const status = await venue.getTradingStatus();
    expect(status.tradingEnabled).toBe(false);
    expect(status.reason).toContain("READ-ONLY");
    expect(status.venue).toBe(POLYMARKET_VENUE_ID);
    expect(status.demo).toBe(false);
    expect(status.minimumOrderBaseUnits).toBe("0");
    expect(http.calls).toHaveLength(0);
  });
});

describe("every trading method refuses", () => {
  const cases: [string, (v: PredictionVenue) => Promise<unknown>][] = [
    ["createBuyOrder", (v) => v.createBuyOrder(ORDER_INPUT)],
    ["getOrder", (v) => v.getOrder("any-order")],
    ["listPositions", (v) => v.listPositions("OwnerAddress111")],
    ["closePosition", (v) => v.closePosition("OwnerAddress111", "any-position")],
    ["createClaim", (v) => v.createClaim("OwnerAddress111", "any-position")],
  ];

  for (const [name, call] of cases) {
    test(`${name} throws a typed VenueError and never touches the network`, async () => {
      const { venue, http } = harness();
      let thrown: unknown;
      try {
        await call(venue);
      } catch (e) {
        thrown = e;
      }
      expect(isVenueError(thrown)).toBe(true);
      expect(isVenueError(thrown) && thrown.code).toBe("VENUE_MISCONFIGURED");
      expect(isVenueError(thrown) && thrown.venue).toBe(POLYMARKET_VENUE_ID);
      expect(String((thrown as Error).message)).toContain("READ-ONLY");
      expect(String((thrown as Error).message)).toContain(name);
      // Refused before any request left the adapter.
      expect(http.calls).toHaveLength(0);
      // Not retryable, and not a signal that the venue is unhealthy.
      expect(isVenueError(thrown) && thrown.retryable).toBe(false);
      expect(isVenueError(thrown) && thrown.countsAsCircuitFault).toBe(false);
      expect(venue.breaker.state).toBe("CLOSED");
    });
  }

  test("refusing never opens the circuit, however many times it happens", async () => {
    const { venue } = harness();
    for (let i = 0; i < 20; i++) {
      await venue.createBuyOrder(ORDER_INPUT).catch(() => undefined);
    }
    expect(venue.breaker.state).toBe("CLOSED");
    expect(venue.breaker.failures).toBe(0);
  });
});

describe("reads keep working while trading is refused", () => {
  test("listEvents, getMarket, getOrderbook and tradingStatus all answer", async () => {
    const { venue } = harness();
    expect((await venue.listEvents({ limit: 2 })).events.length).toBeGreaterThan(0);
    expect((await venue.getMarket("665374")).question.length).toBeGreaterThan(0);
    expect((await venue.getOrderbook("665374")).snapshot).not.toBeNull();
    expect((await venue.getTradingStatus()).tradingEnabled).toBe(false);
  });
});

describe("through the service layer, with the kill switch ON", () => {
  /**
   * contracts §7's `funded_positions` flag is a SEPARATE control from this
   * adapter's read-only-ness. Turning the flag on must still not produce a
   * tradeable Polymarket venue: the adapter refuses underneath it.
   */
  test("createOrder still refuses even with funded_positions enabled", async () => {
    const clock = new PolyClock();
    const { venue } = harness({ clock });
    const service = new PredictionService({
      venue,
      store: new InMemoryPredictionStore(),
      clock,
      flags: { fundedPositions: true },
    });

    let thrown: unknown;
    try {
      await service.createOrder({
        ownerKey: "wallet:OwnerAddress111",
        ownerAddress: "OwnerAddress111",
        venueMarketId: "665374",
        side: "YES",
        amountBaseUnits: "5000000",
        idempotencyKey: "idem-poly-service-1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(isVenueError(thrown) && thrown.code).toBe("VENUE_MISCONFIGURED");
    expect(service.capabilities().trade).toBe(false);
  });

  test("the fixture venue, by contrast, does allow a demo order — so this is a real difference", async () => {
    const clock = new PolyClock();
    const venue = new FixtureVenue({ clock });
    const service = new PredictionService({
      venue,
      store: new InMemoryPredictionStore(),
      clock,
      flags: { fundedPositions: true },
    });
    const { order } = await service.createOrder({
      ownerKey: "wallet:OwnerAddress111",
      ownerAddress: "OwnerAddress111",
      venueMarketId: "fx-open-btc-120k",
      side: "YES",
      amountBaseUnits: "5000000",
      idempotencyKey: "idem-fixture-1",
    });
    expect(order.demo).toBe(true);
    expect(venue.capabilities().trade).toBe(true);
  });
});
