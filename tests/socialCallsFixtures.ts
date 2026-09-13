/**
 * Shared helpers for the Packet D tests.
 *
 * Everything here is hand-built normalized data — no venue is ever called, and
 * nothing in this repo holds a venue API key. Markets are written straight into
 * Packet B's `InMemoryPredictionStore`, which is what the real BFF reads too, so
 * these tests exercise the same seam production does.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCallsRuntime, type CallsRuntime } from "../src/calls/runtime.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { walletDirectoryViewerResolver } from "../src/calls/viewer.ts";
import type { Person } from "../src/calls/types.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import type { MarketStatus, Resolution, VenueMarket } from "../src/prediction/types.ts";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

export const T0 = 1_760_000_000_000;

/** A clock whose time only moves when a test says so. */
export class TestClock {
  private t: number;
  constructor(start: number = T0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function market(
  id: string,
  overrides: Partial<VenueMarket> = {},
): VenueMarket {
  return {
    id,
    venue: "fixture",
    venueEventId: `ev-${id}`,
    venueMarketId: `vm-${id}`,
    question: `[DEMO] Will ${id} happen?`,
    rulesText: "Resolves YES if it happens.",
    category: "crypto",
    outcomes: [
      { side: "YES", label: "Yes" },
      { side: "NO", label: "No" },
    ],
    status: "OPEN" as MarketStatus,
    rawStatus: "open",
    opensAt: T0 - 1000,
    closesAt: T0 + 1_000_000,
    resolvesAt: T0 + 2_000_000,
    resolutionSource: "fixture:oracle",
    lastSyncedAt: T0,
    payloadVersion: 1,
    ...overrides,
  };
}

export function person(id: string, overrides: Partial<Person> = {}): Person {
  return {
    id,
    handle: id,
    displayName: id.toUpperCase(),
    avatarUrl: null,
    walletAddress: `Wallet_${id}`,
    settledCalls: 0,
    correctCalls: 0,
    ...overrides,
  };
}

export interface Harness {
  rt: CallsRuntime;
  clock: TestClock;
  calls: InMemoryCallsStore;
  venue: InMemoryPredictionStore;
  /** Publish venue evidence for a market. The ONLY way a result is ever settled. */
  resolve(marketId: string, resolution: Resolution, at?: number): string;
}

/**
 * A runtime wired to hand-built venue data, a deterministic clock and
 * deterministic ids. The viewer resolver is the wallet-directory one: a session
 * is a VERIFIED wallet credential looked up in the person directory. Nothing in
 * any test ever passes a user id as data.
 */
export function harness(opts: { people?: Person[]; markets?: VenueMarket[] } = {}): Harness {
  const clock = new TestClock();
  const calls = new InMemoryCallsStore();
  const venue = new InMemoryPredictionStore();
  let seq = 0;

  for (const p of opts.people ?? []) calls.upsertPerson(p);
  for (const m of opts.markets ?? []) venue.upsertMarket(m, null);

  const rt = buildCallsRuntime(undefined, {
    store: calls,
    markets: predictionStoreReader(venue),
    clock,
    viewer: walletDirectoryViewerResolver(calls),
    newId: (kind) => `${kind}-${String(++seq).padStart(3, "0")}`,
  });

  return {
    rt,
    clock,
    calls,
    venue,
    resolve(marketId, resolution, at) {
      const m = venue.getMarket(marketId);
      if (!m) throw new Error(`no such market ${marketId}`);
      const rec = venue.recordResolution(
        {
          marketId,
          venue: m.market.venue,
          venueMarketId: m.market.venueMarketId,
          resolution,
          resolvedAt: at ?? clock.now(),
          evidenceSource: "fixture:oracle",
          rawEvidence: { settled: resolution },
          demo: true,
        },
        at ?? clock.now(),
      );
      return rec.id;
    },
  };
}

/** An App whose config object is a fresh identity, so runtimes never collide. */
export async function testApp(): Promise<App> {
  return createApp({ config: loadConfig({}) });
}

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "chumbucket-social-calls",
  "supabase",
  "migrations",
);

/**
 * Read one of Packet D's migrations, so a test can assert the SQL and the
 * TypeScript enforce the SAME rule and cannot drift apart.
 *
 * The migrations live in the MOBILE worktree (contract §5/§6 put them there),
 * which is a sibling checkout. Returns null when that checkout is not present,
 * so the suite stays green in a standalone API clone — the tests that use it
 * say so out loud rather than silently passing.
 */
export function migrationSql(name: string): string | null {
  try {
    return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
  } catch {
    return null;
  }
}

export const migrationsAvailable = (): boolean => migrationSql(CALLS_MIGRATION) !== null;

export const CALLS_MIGRATION = "20260913140000_social_calls_calls.sql";
export const RESPONSES_MIGRATION = "20260913140500_social_calls_responses.sql";
export const RESULTS_MIGRATION = "20260913141000_social_calls_results.sql";

/**
 * Strip `--` line comments so an assertion about the SQL cannot be satisfied —
 * or defeated — by prose. Every one of these migrations quotes the contract in
 * its header, including the phrases the assertions look for.
 */
export const sqlWithoutComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
