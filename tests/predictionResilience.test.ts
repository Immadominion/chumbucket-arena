/**
 * Resilience: backoff, rate limits, timeouts, the circuit breaker — and the one
 * non-negotiable, that the venue API key can never escape through any of them.
 */

import { describe, expect, test } from "bun:test";
import {
  CircuitBreaker,
  JupiterVenue,
  VenueError,
  backoffDelay,
  isVenueError,
  parseRetryAfter,
  redactSecrets,
  registerSecret,
  retry,
} from "../src/prediction/index.ts";
import { T0, TestClock, hangingFetch, jsonResponse, jupMarket, stubFetch } from "./predictionFixtures.ts";

const API_KEY = "jup_live_sk_do_not_leak_0123456789";

const venueOver = (
  fetchImpl: ReturnType<typeof stubFetch>["fetch"],
  opts: { clock?: TestClock; attempts?: number; circuit?: CircuitBreaker; timeoutMs?: number } = {},
) => {
  const clock = opts.clock ?? new TestClock();
  return new JupiterVenue({
    baseUrl: "https://venue.invalid",
    apiKey: API_KEY,
    clock,
    fetchImpl,
    timeoutMs: opts.timeoutMs ?? 1_000,
    retry: { attempts: opts.attempts ?? 1, baseDelayMs: 100, maxDelayMs: 2_000, random: () => 1 },
    ...(opts.circuit ? { circuit: opts.circuit } : {}),
  });
};

describe("backoff", () => {
  test("is exponential and capped", () => {
    expect(backoffDelay(1, 100, 2_000)).toBe(100);
    expect(backoffDelay(2, 100, 2_000)).toBe(200);
    expect(backoffDelay(3, 100, 2_000)).toBe(400);
    expect(backoffDelay(9, 100, 2_000)).toBe(2_000); // clamped
  });

  test("retries only transient faults — a schema change is tried exactly once", async () => {
    const clock = new TestClock();
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new VenueError("VENUE_SCHEMA", "shape changed");
        },
        { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, clock },
      ),
    ).rejects.toThrow(/shape changed/);
    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  test("retries a transient fault and eventually succeeds", async () => {
    const clock = new TestClock();
    let calls = 0;
    const out = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new VenueError("VENUE_UNAVAILABLE", "502");
        return "ok";
      },
      { attempts: 4, baseDelayMs: 100, maxDelayMs: 5_000, clock, random: () => 1 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(clock.slept).toEqual([100, 200]);
  });

  test("never waits less than an upstream Retry-After", async () => {
    const clock = new TestClock();
    let calls = 0;
    await retry(
      async () => {
        calls++;
        if (calls === 1) throw new VenueError("VENUE_RATE_LIMITED", "429", { retryAfterMs: 4_000 });
        return "ok";
      },
      { attempts: 2, baseDelayMs: 100, maxDelayMs: 5_000, clock, random: () => 0 },
    );
    expect(clock.slept).toEqual([4_000]);
  });

  test("parses Retry-After in both permitted forms", () => {
    expect(parseRetryAfter("3", T0)).toBe(3_000);
    expect(parseRetryAfter(new Date(T0 + 5_000).toUTCString(), T0)).toBeGreaterThanOrEqual(4_000);
    expect(parseRetryAfter(null, T0)).toBeUndefined();
    expect(parseRetryAfter("later", T0)).toBeUndefined();
  });
});

describe("rate-limit handling", () => {
  test("429 becomes VENUE_RATE_LIMITED with the Retry-After honoured", async () => {
    const clock = new TestClock();
    let n = 0;
    const { fetch } = stubFetch(() => {
      n++;
      if (n === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      }
      return jsonResponse(jupMarket({ marketId: "jup-open" }));
    });
    const venue = venueOver(fetch, { clock, attempts: 3 });
    const market = await venue.getMarket("jup-open");
    expect(market.status).toBe("OPEN");
    expect(clock.slept).toEqual([2_000]);
  });

  test("an unrelenting 429 surfaces as VENUE_RATE_LIMITED after the last attempt", async () => {
    const { fetch, calls } = stubFetch(() => new Response("nope", { status: 429 }));
    const venue = venueOver(fetch, { attempts: 3 });
    let err: unknown;
    try {
      await venue.getMarket("jup-open");
    } catch (e) {
      err = e;
    }
    expect(isVenueError(err) && err.code).toBe("VENUE_RATE_LIMITED");
    expect(calls.length).toBe(3);
  });
});

describe("timeouts", () => {
  test("a hanging venue is aborted and reported as VENUE_TIMEOUT", async () => {
    const { fetch } = hangingFetch();
    const venue = venueOver(fetch, { attempts: 1, timeoutMs: 20 });
    let err: unknown;
    try {
      await venue.getMarket("jup-open");
    } catch (e) {
      err = e;
    }
    expect(isVenueError(err) && err.code).toBe("VENUE_TIMEOUT");
    expect((err as Error).message).toContain("timed out after 20ms");
  });

  test("an upstream 504 is a timeout, not a schema fault", async () => {
    const { fetch } = stubFetch(() => new Response("gateway timeout", { status: 504 }));
    const venue = venueOver(fetch, { attempts: 1 });
    await expect(venue.getMarket("jup-open")).rejects.toThrow(/upstream timeout/);
  });
});

describe("circuit breaker", () => {
  const fault = () => new VenueError("VENUE_UNAVAILABLE", "boom");

  test("opens after the failure threshold and then refuses without calling", async () => {
    const clock = new TestClock();
    const cb = new CircuitBreaker({ failureThreshold: 3, resetAfterMs: 10_000, halfOpenMaxCalls: 1, clock });
    let calls = 0;
    const failing = async () => {
      calls++;
      throw fault();
    };

    for (let i = 0; i < 3; i++) await expect(cb.run(failing)).rejects.toThrow("boom");
    expect(cb.state).toBe("OPEN");
    expect(calls).toBe(3);

    await expect(cb.run(failing)).rejects.toThrow(/circuit is open/);
    expect(calls).toBe(3); // the venue was NOT called
    expect(cb.retryAfterMs()).toBe(10_000);
  });

  test("half-opens after the reset window and closes on a success", async () => {
    const clock = new TestClock();
    const cb = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 5_000, halfOpenMaxCalls: 1, clock });
    const failing = async () => { throw fault(); };
    await expect(cb.run(failing)).rejects.toThrow();
    await expect(cb.run(failing)).rejects.toThrow();
    expect(cb.state).toBe("OPEN");

    clock.advance(5_000);
    expect(cb.state).toBe("HALF_OPEN");
    await expect(cb.run(async () => "recovered")).resolves.toBe("recovered");
    expect(cb.state).toBe("CLOSED");
    expect(cb.failures).toBe(0);
  });

  test("a failed probe re-opens immediately, without waiting for the threshold again", async () => {
    const clock = new TestClock();
    const cb = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 5_000, halfOpenMaxCalls: 1, clock });
    const failing = async () => { throw fault(); };
    await expect(cb.run(failing)).rejects.toThrow();
    await expect(cb.run(failing)).rejects.toThrow();
    clock.advance(5_000);
    expect(cb.state).toBe("HALF_OPEN");
    await expect(cb.run(failing)).rejects.toThrow("boom");
    expect(cb.state).toBe("OPEN");
    expect(cb.trips).toBe(2);
  });

  test("a 404 does not count against the venue's health", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 5_000, clock: new TestClock() });
    const notFound = async () => { throw new VenueError("VENUE_NOT_FOUND", "404"); };
    await expect(cb.run(notFound)).rejects.toThrow();
    await expect(cb.run(notFound)).rejects.toThrow();
    expect(cb.state).toBe("CLOSED");
  });

  test("a schema change DOES trip the breaker — it is not a transient blip", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 5_000, clock: new TestClock() });
    const schema = async () => { throw new VenueError("VENUE_SCHEMA", "shape changed"); };
    await expect(cb.run(schema)).rejects.toThrow();
    await expect(cb.run(schema)).rejects.toThrow();
    expect(cb.state).toBe("OPEN");
  });

  test("end to end: the adapter stops calling a dead venue, then recovers", async () => {
    const clock = new TestClock();
    let dead = true;
    const { fetch, calls } = stubFetch(() =>
      dead ? new Response("down", { status: 503 }) : jsonResponse(jupMarket({ marketId: "jup-open" })),
    );
    const cb = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 30_000, halfOpenMaxCalls: 1, clock, venue: "jupiter", name: "jupiter" });
    const venue = venueOver(fetch, { clock, attempts: 1, circuit: cb });

    await expect(venue.getMarket("jup-open")).rejects.toThrow(/upstream error/);
    await expect(venue.getMarket("jup-open")).rejects.toThrow(/upstream error/);
    expect(calls.length).toBe(2);

    await expect(venue.getMarket("jup-open")).rejects.toThrow(/circuit is open/);
    expect(calls.length).toBe(2); // no third network attempt

    dead = false;
    clock.advance(30_000);
    const market = await venue.getMarket("jup-open");
    expect(market.status).toBe("OPEN");
    expect(cb.state).toBe("CLOSED");
  });

  test("CIRCUIT_OPEN is not retried — backoff does not paper over it", async () => {
    const clock = new TestClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetAfterMs: 60_000, clock });
    const { fetch, calls } = stubFetch(() => new Response("down", { status: 503 }));
    const venue = venueOver(fetch, { clock, attempts: 5, circuit: cb });
    await expect(venue.getMarket("jup-open")).rejects.toThrow(); // trips on the first fault
    const before = calls.length;
    await expect(venue.getMarket("jup-open")).rejects.toThrow(/circuit is open/);
    expect(calls.length).toBe(before);
  });
});

describe("the API key is server-side only", () => {
  test("it is sent as a header and never appears in a URL", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(jupMarket({ marketId: "jup-open" })));
    const venue = venueOver(fetch);
    await venue.getMarket("jup-open");
    expect(calls[0]!.headers["x-api-key"]).toBe(API_KEY);
    expect(calls[0]!.url).not.toContain(API_KEY);
  });

  test("it cannot escape through an error — even when the venue echoes it back", async () => {
    registerSecret(API_KEY);
    const { fetch } = stubFetch(() =>
      new Response(`{"error":"bad key ${API_KEY}"}`, { status: 400 }),
    );
    const venue = venueOver(fetch);
    let err: unknown;
    try {
      await venue.getMarket("jup-open");
    } catch (e) {
      err = e;
    }
    expect(isVenueError(err)).toBe(true);
    const serialized = JSON.stringify({
      message: (err as Error).message,
      details: (err as VenueError).details,
    });
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).toContain("[redacted]");
  });

  test("redaction also masks anything that names itself a credential", () => {
    registerSecret(API_KEY);
    const e = new VenueError("VENUE_BAD_REQUEST", `rejected with ${API_KEY}`, {
      details: { apiKey: "some-other-value", authorization: "Bearer xyz", path: "/v1/markets" },
    });
    expect(e.message).not.toContain(API_KEY);
    expect(e.details?.apiKey).toBe("[redacted]");
    expect(e.details?.authorization).toBe("[redacted]");
    expect(e.details?.path).toBe("/v1/markets");
  });

  test("redactSecrets leaves unrelated text alone", () => {
    registerSecret(API_KEY);
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });

  test("the adapter refuses to construct without a key", () => {
    expect(
      () => new JupiterVenue({ baseUrl: "https://venue.invalid", apiKey: "", clock: new TestClock() }),
    ).toThrow(/API key is required/);
  });
});
