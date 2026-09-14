/**
 * A schema change must fail LOUDLY at the adapter, never write a partially-parsed
 * market (contracts §4). A half-built market is worse than no market, because a
 * call or a receipt can be written against it.
 *
 * Every payload below is a REAL recorded response with exactly ONE field
 * deliberately corrupted, so each test isolates one way the wire can change shape
 * rather than testing a wholly invented object.
 *
 * Note the deliberate asymmetry, which is the design decision this file pins:
 *   - a WELL-FORMED market that simply is not a Yes/No binary is SKIPPED in a
 *     listing (normal Polymarket data, see polymarketNormalization.test.ts);
 *   - a MALFORMED market fails the whole page, loudly. A silently-dropped row is
 *     a schema change nobody ever sees.
 */

import { describe, expect, test } from "bun:test";
import { isVenueError, type VenueError } from "../src/prediction/index.ts";
import { harness, corrupt, corruptEvent } from "./polymarketHarness.ts";
import {
  REC_EVENTS_PAGE,
  REC_MARKET_OPEN_FUTURE_END,
  REC_MARKET_RESOLVED_YES,
  type PolymarketRecording,
} from "./polymarketRecordings.ts";

async function schemaCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return isVenueError(e) ? e.code : `THREW:${(e as Error).message.slice(0, 80)}`;
  }
}

/** Run getMarket("665374") against a one-field corruption of its real payload. */
const withCorruptedMarket = (mutate: (m: Record<string, unknown>) => void) => {
  const rec: PolymarketRecording = corrupt(REC_MARKET_OPEN_FUTURE_END, mutate);
  const { venue } = harness({ extra: [rec], retry: { attempts: 1 } });
  return { venue, run: () => venue.getMarket("665374") };
};

describe("the JSON-encoded strings must actually decode", () => {
  test('outcomes that is not JSON at all -> VENUE_SCHEMA', async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomes = "Yes, No";
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("outcomes that decodes to an object rather than an array -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomes = '{"yes":1,"no":0}';
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("outcomes containing a non-string entry -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomes = '["Yes", 0]';
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("outcomes arriving as a REAL array (the shape changing under us) -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomes = ["Yes", "No"];
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("outcomePrices that is not JSON -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomePrices = "0.165, 0.835";
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("outcomePrices with a different length from outcomes -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomePrices = '["0.165", "0.835", "0.0"]';
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("a price outside [0,1] -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomePrices = '["1.4", "-0.4"]';
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("a price that is not a number at all -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomePrices = '["cheap", "dear"]';
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("prices as numbers rather than decimal strings -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.outcomePrices = "[0.165, 0.835]";
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });
});

describe("required fields disappearing is a schema change", () => {
  test("no `question` -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      delete m.question;
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("no `description` (our rulesText) -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      delete m.description;
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("no `outcomes` -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      delete m.outcomes;
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("`closed` arriving as a string rather than a boolean -> VENUE_SCHEMA", async () => {
    const { run } = withCorruptedMarket((m) => {
      m.closed = "false";
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("a timestamp in a shape we do not recognise -> VENUE_SCHEMA, not a silent null", async () => {
    // A market whose deadline we cannot read would otherwise look open forever.
    const { run } = withCorruptedMarket((m) => {
      m.endDate = "31/12/2027";
    });
    expect(await schemaCodeOf(run)).toBe("VENUE_SCHEMA");
  });

  test("the response not being an array -> VENUE_SCHEMA", async () => {
    const rec: PolymarketRecording = { ...REC_MARKET_OPEN_FUTURE_END, body: { markets: [] } };
    const { venue } = harness({ extra: [rec], retry: { attempts: 1 } });
    expect(await schemaCodeOf(() => venue.getMarket("665374"))).toBe("VENUE_SCHEMA");
  });
});

describe("nothing partial escapes", () => {
  test("a corrupted market is never returned half-built", async () => {
    const { venue, run } = withCorruptedMarket((m) => {
      m.outcomePrices = '["oops", "oops"]';
    });
    let value: unknown = "UNSET";
    try {
      value = await run();
    } catch {
      value = "THREW";
    }
    expect(value).toBe("THREW");
    // …and no raw payload was remembered for it either, so nothing downstream can
    // read a resolution out of a market that never normalized.
    expect(venue.rawPayload("665374")).toBeUndefined();
    expect(venue.publishedResolution("665374")).toBeNull();
  });

  test("one malformed market fails the whole page rather than vanishing from it", async () => {
    // The alternative — dropping the bad row — would hide a schema change behind
    // a page that merely looks a little shorter than it should.
    const rec = corruptEvent(REC_EVENTS_PAGE, (m) => {
      m.outcomePrices = "not-json";
    });
    const { venue } = harness({ extra: [rec], retry: { attempts: 1 } });
    expect(await schemaCodeOf(() => venue.listEvents({ limit: 2 }))).toBe("VENUE_SCHEMA");
  });

  test("a schema error is never retried, and does trip the breaker", async () => {
    const { venue, http } = harness({
      extra: [corrupt(REC_MARKET_OPEN_FUTURE_END, (m) => { m.outcomes = "nope"; })],
      retry: { attempts: 3 },
    });
    let err: VenueError | undefined;
    try {
      await venue.getMarket("665374");
    } catch (e) {
      if (isVenueError(e)) err = e;
    }
    expect(err?.code).toBe("VENUE_SCHEMA");
    // Replaying a parse failure cannot make the payload parse.
    expect(err?.retryable).toBe(false);
    expect(http.calls).toHaveLength(1);
    // But it IS a sign the venue changed under us, so it counts toward the breaker.
    expect(err?.countsAsCircuitFault).toBe(true);
  });
});

describe("a resolution is never read out of a payload we could not parse", () => {
  test("publishedResolution on a corrupted body throws instead of guessing", async () => {
    const { venue } = harness();
    await venue.getMarket("3244600");
    expect(venue.publishedResolution("3244600")?.resolution).toBe("YES");

    // Same market, prices corrupted in the raw payload handed to the reader.
    const body = { ...(venue.rawPayload("3244600")?.body as Record<string, unknown>) };
    body.outcomePrices = '["1"]';
    let code = "NO_ERROR";
    try {
      venue.publishedResolution("3244600", {
        venue: venue.venue,
        venueMarketId: "3244600",
        payloadVersion: 1,
        fetchedAt: 0,
        body,
      });
    } catch (e) {
      code = isVenueError(e) ? e.code : "OTHER";
    }
    expect(code).toBe("VENUE_SCHEMA");
    expect(REC_MARKET_RESOLVED_YES.status).toBe(200); // the pristine recording is untouched
  });
});
