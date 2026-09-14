/**
 * Shared harness for the Polymarket adapter tests.
 *
 * Every venue built here is fed exclusively by `recordedFetch()`, which serves
 * the verbatim live responses in ./polymarketRecordings.ts and THROWS on any URL
 * it does not recognise. There is no path from this test suite to the network.
 */

import { PolymarketVenue, type PolymarketVenueConfig } from "../src/prediction/PolymarketVenue.ts";
import type { Clock } from "../src/prediction/clock.ts";
import { recordedFetch, type PolymarketRecording, type RecordedFetch } from "./polymarketRecordings.ts";

/**
 * 2026-09-14T19:20:00Z — the instant the recordings were captured. Anchoring the
 * clock there is what makes "this market's endDate is already in the past" a
 * fact about the recorded data rather than a fact about when the suite is run.
 */
export const POLY_NOW = 1_789_413_600_000;

/** A hand-cranked clock. Sleeps are instant but still move time. */
export class PolyClock implements Clock {
  private t: number;
  readonly slept: number[] = [];

  constructor(start: number = POLY_NOW) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.t += ms;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

export interface PolyHarness {
  venue: PolymarketVenue;
  clock: PolyClock;
  http: RecordedFetch;
  /** How many upstream requests the adapter has actually made. */
  calls(): number;
}

export function harness(
  opts: { extra?: readonly PolymarketRecording[]; clock?: PolyClock } & Partial<PolymarketVenueConfig> = {},
): PolyHarness {
  const { extra, clock: given, ...venueCfg } = opts;
  const clock = given ?? new PolyClock();
  const http = recordedFetch(extra ?? []);
  const venue = new PolymarketVenue({
    ...venueCfg,
    clock,
    fetchImpl: http.fetch,
  });
  return { venue, clock, http, calls: () => http.calls.length };
}

/**
 * Build a recording that is a DELIBERATELY CORRUPTED copy of a real one, for the
 * schema tests. The corruption is always a single named field on an otherwise
 * verbatim live payload, so the test proves the adapter's reaction to a wire-shape
 * change rather than to a wholly invented object.
 */
export function corrupt(
  base: PolymarketRecording,
  mutate: (market: Record<string, unknown>) => void,
): PolymarketRecording {
  const body = JSON.parse(JSON.stringify(base.body)) as Record<string, unknown>[];
  const first = body[0];
  if (!first) throw new Error("corrupt(): the base recording has no market row");
  mutate(first);
  return { ...base, body };
}

/** The same, for the `/events` page recording (corrupts its first market). */
export function corruptEvent(
  base: PolymarketRecording,
  mutate: (market: Record<string, unknown>) => void,
): PolymarketRecording {
  const body = JSON.parse(JSON.stringify(base.body)) as Record<string, unknown>[];
  const first = body[0] as { markets?: Record<string, unknown>[] } | undefined;
  const market = first?.markets?.[0];
  if (!market) throw new Error("corruptEvent(): the base recording has no nested market");
  mutate(market);
  return { ...base, body };
}
