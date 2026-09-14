/**
 * Polymarket normalisation, driven entirely by RECORDED REAL RESPONSES
 * (./polymarketRecordings.ts, captured live on 14 Sep 2026). No network call is
 * made anywhere in this file — `recordedFetch` throws on an unrecognised URL.
 *
 * What this proves:
 *   1. `outcomes` / `outcomePrices` arrive as JSON-ENCODED STRINGS and are parsed,
 *      not assumed;
 *   2. a non-binary market is SKIPPED in a listing, never coerced into YES/NO;
 *   3. a market past its `endDate` that the venue has NOT closed is neither OPEN
 *      nor RESOLVED;
 *   4. the venue's own text and flags survive verbatim into `rulesText` and
 *      `rawStatus`.
 */

import { describe, expect, test } from "bun:test";
import { isVenueError, marketUuid } from "../src/prediction/index.ts";
import {
  POLYMARKET_PAYLOAD_VERSION,
  POLYMARKET_VENUE_ID,
} from "../src/prediction/PolymarketVenue.ts";
import { harness, PolyClock, POLY_NOW } from "./polymarketHarness.ts";
import {
  REC_EVENTS_PAGE,
  REC_MARKET_CLOSED_ZERO_ZERO,
  REC_MARKET_NON_BINARY,
  REC_MARKET_OPEN_FUTURE_END,
  REC_MARKET_PAST_END_NOT_CLOSED,
  REC_MARKET_RESOLVED_NO,
  recordedMarket,
} from "./polymarketRecordings.ts";

describe("the JSON-encoded outcome/price strings are parsed, never assumed", () => {
  test("the recordings really do carry strings, not arrays", () => {
    const wire = recordedMarket(REC_MARKET_OPEN_FUTURE_END);
    expect(typeof wire.outcomes).toBe("string");
    expect(wire.outcomes).toBe('["Yes", "No"]');
    expect(typeof wire.outcomePrices).toBe("string");
    expect(wire.outcomePrices).toBe('["0.165", "0.835"]');
  });

  test("they decode into a YES/NO pair with the venue's own labels", async () => {
    const { venue } = harness();
    const m = await venue.getMarket("665374");
    expect(m.outcomes).toEqual([
      { side: "YES", label: "Yes" },
      { side: "NO", label: "No" },
    ]);
  });

  test("the decoded YES price becomes the snapshot probability", async () => {
    const { venue } = harness();
    const book = await venue.getOrderbook("665374");
    expect(book.snapshot?.yesProbability).toBe(0.165);
    expect(book.snapshot?.source).toBe("venue");
    // gamma publishes no depth on the public REST API, so there is none to show.
    // Inventing a size at bestBid would be exactly the fabrication we refuse.
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
    expect(book.demo).toBe(false);
  });
});

describe("a genuinely open market maps to OPEN", () => {
  test("market 665374: not closed, accepting orders, endDate 2027", async () => {
    const { venue } = harness();
    const m = await venue.getMarket("665374");
    expect(m.status).toBe("OPEN");
    expect(m.venue).toBe(POLYMARKET_VENUE_ID);
    expect(m.venueMarketId).toBe("665374");
    expect(m.id).toBe(marketUuid(POLYMARKET_VENUE_ID, "665374"));
    expect(m.venueEventId).toBe("73130");
    expect(m.question).toBe("Will the U.S. invade Iran before 2027?");
    expect(m.closesAt).toBe(Date.parse("2027-01-01T04:59:00Z"));
    expect(m.opensAt).toBe(Date.parse("2025-11-05T17:52:17.414Z"));
    expect(m.resolvesAt).toBeNull();
    expect(m.payloadVersion).toBe(POLYMARKET_PAYLOAD_VERSION);
    expect(m.lastSyncedAt).toBe(POLY_NOW);
  });

  test("rulesText is the venue's description VERBATIM, never paraphrased", async () => {
    const { venue } = harness();
    const m = await venue.getMarket("665374");
    expect(m.rulesText).toBe(recordedMarket(REC_MARKET_OPEN_FUTURE_END).description as string);
    expect(m.rulesText.length).toBeGreaterThan(200);
  });

  test("rawStatus carries Polymarket's own flags, unmapped", async () => {
    const { venue } = harness();
    const m = await venue.getMarket("665374");
    expect(m.rawStatus).toBe(
      "active=true;closed=false;archived=false;acceptingOrders=true;umaResolutionStatus=null;umaResolutionStatuses=[]",
    );
  });

  test("resolutionSource falls back to the UMA resolver the venue names", async () => {
    const { venue } = harness();
    // Polymarket leaves `resolutionSource` empty here and names the resolver in
    // `resolvedBy`. Both are passed through verbatim; neither is invented.
    const m = await venue.getMarket("665374");
    expect(m.resolutionSource).toBe("0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7");

    // …and where a real source string exists, that wins.
    const near = await venue.getMarket("40");
    expect(near.resolutionSource).toBe("https://www.cnn.com/election/2020");

    // …and where the venue publishes neither, it is null rather than a guess.
    const zero = await venue.getMarket("12");
    expect(zero.resolutionSource).toBeNull();
    expect(recordedMarket(REC_MARKET_CLOSED_ZERO_ZERO).resolutionSource ?? null).toBeNull();
  });
});

describe("past endDate but NOT closed is neither OPEN nor RESOLVED", () => {
  test("the recording really is self-contradictory", () => {
    const wire = recordedMarket(REC_MARKET_PAST_END_NOT_CLOSED);
    expect(wire.closed).toBe(false);
    expect(wire.active).toBe(true);
    expect(wire.acceptingOrders).toBe(true);
    // endDate months in the past…
    expect(Date.parse(wire.endDate as string)).toBeLessThan(POLY_NOW);
    // …and a startDate AFTER its own end date. Real data, untouched.
    expect(Date.parse(wire.startDate as string)).toBeGreaterThan(
      Date.parse(wire.endDate as string),
    );
  });

  test("market 1642010 maps to PAUSED — not OPEN, not RESOLVED, not CLOSED", async () => {
    const { venue } = harness();
    const m = await venue.getMarket("1642010");
    expect(m.status).toBe("PAUSED");
    expect(m.status).not.toBe("OPEN");
    expect(m.status).not.toBe("RESOLVED");
    expect(m.status).not.toBe("CLOSED_PENDING_RESOLUTION");
    // The venue's real flags are still on the row, so nothing is hidden.
    expect(m.rawStatus).toContain("closed=false");
    expect(m.rawStatus).toContain("acceptingOrders=true");
    // And no resolution is published for it. Not now, not ever from an endDate.
    expect(venue.publishedResolution("1642010")).toBeNull();
  });

  test("the same market is OPEN when the clock is before its endDate", async () => {
    // Nothing about the payload changed — only where 'now' sits. That is the
    // whole of the rule: a deadline that has not passed yet is still open.
    const before = Date.parse("2025-10-01T00:00:00Z");
    const { venue } = harness({ clock: new PolyClock(before) });
    const m = await venue.getMarket("1642010");
    expect(m.status).toBe("OPEN");
  });
});

describe("non-binary markets are skipped, never mangled", () => {
  test("the recording is a real two-outcome, non-Yes/No market", () => {
    const wire = recordedMarket(REC_MARKET_NON_BINARY);
    expect(wire.outcomes).toBe('["Long", "Short"]');
  });

  test("listEvents drops it, and drops an event left with nothing", async () => {
    const { venue } = harness();
    const page = await venue.listEvents({ limit: 2 });

    // The recorded page holds TWO real events: 73130 (one Yes/No market) and
    // 109965 (one ["Up","Down"] market with no outcomePrices at all).
    const body = REC_EVENTS_PAGE.body as { id: string; markets: unknown[] }[];
    expect(body.map((e) => e.id)).toEqual(["73130", "109965"]);

    expect(page.events.map((e) => e.venueEventId)).toEqual(["73130"]);
    expect(page.events[0]?.markets.map((m) => m.venueMarketId)).toEqual(["665374"]);
    expect(page.events[0]?.demo).toBe(false);
    expect(page.events[0]?.title).toBe("Will the U.S. invade Iran before 2027?");
    expect(page.events[0]?.category).toBe("military-strikes"); // the venue's own first tag
    expect(page.fetchedAt).toBe(POLY_NOW);
  });

  test("getMarket refuses it by name rather than returning half a market", async () => {
    const { venue } = harness();
    let thrown: unknown;
    try {
      await venue.getMarket("36");
    } catch (e) {
      thrown = e;
    }
    expect(isVenueError(thrown)).toBe(true);
    expect(isVenueError(thrown) && thrown.code).toBe("VENUE_SCHEMA");
    expect(String((thrown as Error).message)).toContain("not a binary Yes/No market");
  });
});

describe("paging and filtering", () => {
  test("a full page yields a next cursor; the cursor is the gamma offset", async () => {
    const { venue } = harness();
    const page = await venue.listEvents({ limit: 2 });
    expect(page.nextCursor).toBe("2"); // 2 events returned for limit 2
    const shorter = await venue.listEvents({ limit: 5 });
    expect(shorter.nextCursor).toBeNull(); // 2 events for limit 5 — no more
  });

  test("a cursor we did not mint is a caller error, not a venue fault", async () => {
    const { venue } = harness();
    let thrown: unknown;
    try {
      await venue.listEvents({}, "not-a-cursor");
    } catch (e) {
      thrown = e;
    }
    expect(isVenueError(thrown) && thrown.code).toBe("VENUE_BAD_REQUEST");
  });

  test("a status filter narrows the normalized page", async () => {
    const { venue } = harness();
    expect((await venue.listEvents({ limit: 2, status: ["OPEN"] })).events).toHaveLength(1);
    expect((await venue.listEvents({ limit: 2, status: ["PAUSED"] })).events).toHaveLength(0);
  });

  test("a market id that does not exist is VENUE_NOT_FOUND, not an empty market", async () => {
    // gamma answers 200 [] for an unknown id on BOTH passes — the adapter has to
    // turn that into a typed error itself.
    const { venue, http } = harness();
    let thrown: unknown;
    try {
      await venue.getMarket("999999999");
    } catch (e) {
      thrown = e;
    }
    expect(isVenueError(thrown) && thrown.code).toBe("VENUE_NOT_FOUND");
    expect(http.calls).toHaveLength(2); // the open pass, then the closed=true pass
  });
});

describe("the raw payload is kept alongside the normalized form (contracts §4)", () => {
  test("rawPayload returns the venue's JSON untouched", async () => {
    const { venue } = harness();
    await venue.getMarket("3244610");
    const raw = venue.rawPayload("3244610");
    expect(raw?.venue).toBe(POLYMARKET_VENUE_ID);
    expect(raw?.payloadVersion).toBe(POLYMARKET_PAYLOAD_VERSION);
    const body = raw?.body as Record<string, unknown>;
    expect(body.outcomePrices).toBe('["0", "1"]');
    expect(body.question).toBe(recordedMarket(REC_MARKET_RESOLVED_NO).question);
  });
});
