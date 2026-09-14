/**
 * The resolution rule, and nothing but the resolution rule.
 *
 * A resolution is published ⟺ `closed === true` AND the parsed `outcomePrices`
 * are exactly one `1` and one `0`. Everything else is "the venue has not
 * published one" — which is the entire point of this adapter. Contracts §0.2:
 * the venue is the only source of a result.
 *
 * Every payload here is a verbatim live capture; the ugly ones are the whole
 * reason the file exists.
 */

import { describe, expect, test } from "bun:test";
import { deriveCallOutcome, isVenueError } from "../src/prediction/index.ts";
import {
  POLYMARKET_PAYLOAD_VERSION,
  POLYMARKET_VENUE_ID,
} from "../src/prediction/PolymarketVenue.ts";
import { harness, POLY_NOW } from "./polymarketHarness.ts";
import {
  REC_MARKET_CLOSED_NEAR_ONE,
  REC_MARKET_CLOSED_ZERO_ZERO,
  REC_MARKET_NON_BINARY,
  REC_MARKET_RESOLVED_NO,
  REC_MARKET_RESOLVED_YES,
  recordedMarket,
} from "./polymarketRecordings.ts";

describe('a clean ["1","0"] is Resolution YES', () => {
  test("market 3244600 — Todd Blanche, YES leg settled at 1", async () => {
    expect(recordedMarket(REC_MARKET_RESOLVED_YES).outcomePrices).toBe('["1", "0"]');
    const { venue } = harness();
    const m = await venue.getMarket("3244600");
    expect(m.status).toBe("RESOLVED");

    const published = venue.publishedResolution("3244600");
    expect(published?.resolution).toBe("YES");
    // `closedTime` is the non-ISO "YYYY-MM-DD HH:MM:SS+00" form; it still parses.
    expect(published?.resolvedAt).toBe(Date.parse("2026-08-08T23:33:13Z"));
    expect(m.resolvesAt).toBe(published?.resolvedAt ?? null);
  });

  test("a YES call on it is CORRECT and a NO call is INCORRECT", async () => {
    const { venue } = harness();
    await venue.getMarket("3244600");
    const r = venue.publishedResolution("3244600")?.resolution ?? null;
    expect(deriveCallOutcome("YES", r)).toBe("CORRECT");
    expect(deriveCallOutcome("NO", r)).toBe("INCORRECT");
  });
});

describe('a clean ["0","1"] is Resolution NO', () => {
  test("market 3244610 — Andrew Bailey, NO leg settled at 1", async () => {
    expect(recordedMarket(REC_MARKET_RESOLVED_NO).outcomePrices).toBe('["0", "1"]');
    const { venue } = harness();
    const m = await venue.getMarket("3244610");
    expect(m.status).toBe("RESOLVED");

    const published = venue.publishedResolution("3244610");
    expect(published?.resolution).toBe("NO");
    expect(published?.resolvedAt).toBe(Date.parse("2026-08-08T20:27:18Z"));
  });
});

describe('a closed market priced ["0","0"] produces NO resolution', () => {
  test("market 12 — closed, but the venue published no winner at all", async () => {
    const wire = recordedMarket(REC_MARKET_CLOSED_ZERO_ZERO);
    expect(wire.closed).toBe(true);
    expect(wire.outcomePrices).toBe('["0", "0"]');

    const { venue } = harness();
    const m = await venue.getMarket("12");
    expect(m.status).toBe("CLOSED_PENDING_RESOLUTION");
    expect(m.status).not.toBe("RESOLVED");
    expect(m.resolvesAt).toBeNull();
    expect(venue.publishedResolution("12")).toBeNull();
  });

  test("a call on it stays PENDING rather than becoming a loss", async () => {
    const { venue } = harness();
    await venue.getMarket("12");
    const r = venue.publishedResolution("12")?.resolution ?? null;
    expect(deriveCallOutcome("YES", r)).toBe("PENDING");
    expect(deriveCallOutcome("NO", r)).toBe("PENDING");
  });
});

describe("almost-1 and almost-0 are NOT a resolution, however obvious the answer", () => {
  test('market 40 — "Will Trump win the 2020 U.S. presidential election?"', async () => {
    const wire = recordedMarket(REC_MARKET_CLOSED_NEAR_ONE);
    expect(wire.closed).toBe(true);
    // The real, recorded prices. Everyone knows how this one ended. The venue
    // has not published it as a 1/0 settlement, so we do not publish one either.
    expect(wire.outcomePrices).toBe(
      '["0.00000004364303498046286702037228176483457", "0.9999999563569650195371329796277182"]',
    );

    const { venue } = harness();
    const m = await venue.getMarket("40");
    expect(m.status).toBe("CLOSED_PENDING_RESOLUTION");
    expect(venue.publishedResolution("40")).toBeNull();
  });
});

describe("what this adapter will never do", () => {
  test("it never returns VOID, because gamma publishes no void flag", async () => {
    const { venue } = harness();
    for (const id of ["665374", "1642010", "3244600", "3244610", "12", "40"]) {
      await venue.getMarket(id);
      expect(venue.publishedResolution(id)?.resolution).not.toBe("VOID");
    }
  });

  test("it never returns CANCELLED, for the same reason", async () => {
    const { venue } = harness();
    for (const id of ["665374", "1642010", "3244600", "3244610", "12", "40"]) {
      expect((await venue.getMarket(id)).status).not.toBe("CANCELLED");
    }
  });

  test("a market it has never fetched has no resolution — not an error, not a guess", () => {
    const { venue } = harness();
    expect(venue.publishedResolution("3244600")).toBeNull();
  });

  test("umaResolutionStatus='resolved' alone does not make a resolution", async () => {
    // Both settled recordings say umaResolutionStatus 'resolved'. The one with
    // ["0","0"] does not, and neither carries the decision — the PRICES do.
    expect(recordedMarket(REC_MARKET_RESOLVED_YES).umaResolutionStatus).toBe("resolved");
    expect(recordedMarket(REC_MARKET_CLOSED_ZERO_ZERO).umaResolutionStatus ?? null).toBeNull();

    const { venue } = harness();
    await venue.getMarket("40"); // umaResolutionStatus absent, closed, near-1 prices
    expect(venue.publishedResolution("40")).toBeNull();
  });

  test("asking for a non-binary market's resolution is refused, not answered", () => {
    const { venue } = harness();
    let thrown: unknown;
    try {
      // Reach past getMarket (which already refuses market 36) straight at the
      // reader, with market 36's real payload.
      venue.publishedResolution("36", {
        venue: POLYMARKET_VENUE_ID,
        venueMarketId: "36",
        payloadVersion: POLYMARKET_PAYLOAD_VERSION,
        fetchedAt: POLY_NOW,
        body: recordedMarket(REC_MARKET_NON_BINARY),
      });
    } catch (e) {
      thrown = e;
    }
    expect(isVenueError(thrown) && thrown.code).toBe("VENUE_SCHEMA");
  });
});
