/**
 * The offset cap, and why it must not look like a failure.
 *
 * gamma paginates `/events` by offset and refuses to go past a cap, in words:
 *
 *   422 {"type":"validation error",
 *        "error":"offset too large, use /events/keyset for deeper pagination"}
 *
 * That is the venue saying there is nothing deeper on this access path — the END
 * of the catalog, not an outage. Treating it as an error turned the sync cursor
 * into a poison pill in production: it climbed past the cap once and then every
 * pass died on its first page, forever, while the catalog silently went stale and
 * `market_snapshots` stopped growing. The service looked healthy the whole time.
 *
 * The narrowness is the point. Any OTHER 422 is a real rejection and must keep
 * throwing, because a validation error we do not understand must never be
 * quietly rewritten into "no more results".
 */

import { describe, expect, test } from "bun:test";
import { isVenueError, PolymarketVenue, type FetchLike } from "../src/prediction/index.ts";
import { PolyClock } from "./polymarketHarness.ts";

/**
 * A venue whose every `/events` request gets one canned status + body.
 *
 * Built directly rather than through `harness()`, which always installs its own
 * recorded fetch — these tests are about how the adapter reacts to a status the
 * recordings deliberately do not contain.
 */
function venueRespondingWith(status: number, body: string): PolymarketVenue {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("/events")) {
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request in this test: ${url}`);
  };
  return new PolymarketVenue({ clock: new PolyClock(), fetchImpl });
}

const OFFSET_TOO_LARGE = JSON.stringify({
  type: "validation error",
  error: "offset too large, use /events/keyset for deeper pagination",
});

describe("an exhausted offset is the end of the catalog", () => {
  test("it returns an empty FINAL page instead of throwing", async () => {
    const venue = venueRespondingWith(422, OFFSET_TOO_LARGE);

    const page = await venue.listEvents({ limit: 50 }, "5000");

    expect(page.events).toEqual([]);
    // null, not another cursor: the caller must stop and start over, not spin.
    expect(page.nextCursor).toBeNull();
  });

  test("a sync loop therefore RECOVERS instead of dying on every pass", async () => {
    const venue = venueRespondingWith(422, OFFSET_TOO_LARGE);

    // Three passes in a row, the way the 60s ticker would. Before the fix every
    // one of these threw, which is exactly what happened in production.
    for (const cursor of ["5000", "5050", "5100"]) {
      const page = await venue.listEvents({ limit: 50 }, cursor);
      expect(page.nextCursor).toBeNull();
    }
  });

  test("the wording is what is matched, not the bare 422", async () => {
    // A different validation error at the same status must still be an error.
    // Rewriting an unrecognised rejection into "no more results" would hide a
    // real breakage behind an empty, healthy-looking catalog.
    const venue = venueRespondingWith(
      422,
      JSON.stringify({ type: "validation error", error: "limit must be <= 100" }),
    );

    let thrown: unknown;
    try {
      await venue.listEvents({ limit: 50 }, "0");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(isVenueError(thrown)).toBe(true);
    if (isVenueError(thrown)) expect(thrown.code).toBe("VENUE_BAD_REQUEST");
  });

  test("a 500 is still an outage, not an end of catalog", async () => {
    const venue = venueRespondingWith(500, "upstream exploded");

    let thrown: unknown;
    try {
      await venue.listEvents({ limit: 50 }, "0");
    } catch (e) {
      thrown = e;
    }

    expect(isVenueError(thrown)).toBe(true);
    if (isVenueError(thrown)) expect(thrown.code).toBe("VENUE_UNAVAILABLE");
  });
});
