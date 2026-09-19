/**
 * Lazy construction of the prediction runtime, memoised per AppConfig.
 *
 * contracts §6: a packet's route module builds its own store/adapter behind a
 * module-level memo rather than being wired into the composition root (which is
 * integration-owned). Keyed on the AppConfig OBJECT so two apps in one test
 * process — one with the kill switch on, one off — never share a runtime.
 *
 * ── STORE SELECTION, AND WHY IT IS LOUD ─────────────────────────────────────
 *
 * `config.social` present AND the configured venue persistable  -> Postgres.
 * Anything else                                                 -> memory, and
 * a boot line that SAYS SO with the reason.
 *
 * That follows the `NoopSocialStore` precedent exactly (src/social/SocialStore.ts):
 * an unconfigured server returns `{ ok: false, reason: "social store is not
 * configured" }` rather than a cheerful `{ ok: true }`. Here the equivalent is
 * `runtime.persistence` — `{ persisting, reason }` — which a test can assert and
 * a boot log prints. Nothing in this file can make a server look durable when
 * it is not.
 *
 * "Persistable venue" is not a preference: `venue_markets_venue_check` and its
 * three siblings are `CHECK (venue IN ('jupiter','fixture'))` in the LIVE
 * schema, so a polymarket row is refused by the database. Writing anyway would
 * queue rows Postgres throws away, which is the same lie in a more expensive
 * costume. See docs/contracts/integration-requests/packet-persist.md §1.
 */

import type { AppConfig } from "../config.ts";
import { FixtureVenue } from "./FixtureVenue.ts";
import { JupiterVenue } from "./JupiterVenue.ts";
import { POLYMARKET_VENUE_ID, PolymarketVenue } from "./PolymarketVenue.ts";
import { CircuitBreaker } from "./circuit.ts";
import { systemClock, type Clock } from "./clock.ts";
import { resolvePredictionConfig, type PredictionConfig } from "./config.ts";
import { MarketSync, type MarketSyncDeps } from "./marketSync.ts";
import type { FetchImpl, WriteQueue } from "./pgrest.ts";
import { PredictionService } from "./PredictionService.ts";
import type { PredictionVenue } from "./PredictionVenue.ts";
import { InMemoryPredictionStore, type PredictionStore } from "./store.ts";
import {
  supabasePersistenceDecision,
  SupabasePredictionStore,
  type PersistenceDecision,
} from "./supabaseStore.ts";

/** The Supabase credentials this runtime needs. Mirrors `AppConfig['social']`. */
export interface SupabaseTarget {
  supabaseUrl: string;
  serviceRoleKey: string;
  network: "devnet" | "mainnet-beta";
}

export interface PredictionRuntime {
  config: PredictionConfig;
  venue: PredictionVenue;
  store: PredictionStore;
  service: PredictionService;
  /** Whether this runtime writes to Postgres, and — always — why. */
  persistence: PersistenceDecision;
  /** The durable store when one was built; null when this runtime is in memory. */
  durable: SupabasePredictionStore | null;
  /**
   * Pull the venue catalog into venue_markets / market_snapshots /
   * market_resolutions. Idempotent and cursor-backed; see ./marketSync.ts.
   */
  marketSync: MarketSync;
  /**
   * Resolves once the durable mirror has been built from Postgres. Already
   * resolved for an in-memory runtime. Awaiting it at boot is what removes the
   * cold-start window in which a persisted feed would read as empty — the
   * three-line `src/app.ts` patch filed as packet-persist.md §2.
   */
  ready: Promise<void>;
}

export interface BuildRuntimeOverrides {
  venue?: PredictionVenue;
  store?: PredictionStore;
  clock?: Clock;
  /** Test/ops override of the resolved config. */
  config?: PredictionConfig;
  /** Supabase target, when it should not come from `appConfig.social`. */
  social?: SupabaseTarget;
  /** Injected by every test: no network and no real Postgres, ever. */
  fetchImpl?: FetchImpl;
  /** The shared FIFO durable writer (see ./pgrest.ts). */
  queue?: WriteQueue;
  /** Read Postgres into the mirror as part of construction. Default: false. */
  hydrate?: boolean;
  marketSync?: Partial<Omit<MarketSyncDeps, "venue" | "store">>;
}

/**
 * The venue selector. `PREDICTION_VENUE=polymarket` reaches here through
 * `resolvePredictionConfig`; unlike Jupiter it needs no key, so it never falls
 * back to the demo catalog.
 */
/**
 * Raw payloads held by the Polymarket adapter at once.
 *
 * Sized against a single sync PAGE-BATCH rather than a whole pass, because
 * 8,000 full market JSONs pinned in memory was a real cost: this service grew
 * to 3.1 GB while every other service on the account sat under 0.3 GB.
 *
 * It only has to outlive the gap between normalizing a market and the durable
 * writer reading its payload back, which is bounded by maxPagesPerPass below.
 */
const POLYMARKET_RAW_CACHE_SIZE = 1_200;

function buildVenue(config: PredictionConfig, clock: Clock): PredictionVenue {
  if (config.venue === POLYMARKET_VENUE_ID && config.polymarket) {
    return new PolymarketVenue({
      baseUrl: config.polymarket.baseUrl,
      timeoutMs: config.polymarket.timeoutMs,
      clock,
      // Sized to hold a WHOLE market-sync pass, because the durable writer
      // reads the raw payload back from this cache after the pass has moved on.
      //
      // The trap: MarketSync's pageSize bounds EVENTS, not markets, and gamma
      // groups several markets under one event. 10 pages x 50 events was 2,274
      // markets in production against a 500-entry LRU, so most payloads were
      // evicted before the writer reached them — and venue_markets_live_rows_
      // keep_raw then correctly refused the row rather than let a live market
      // be stored with no record of what the venue actually said.
      maxRawPayloads: POLYMARKET_RAW_CACHE_SIZE,
      retry: config.retry,
      cache: config.cache,
      circuit: new CircuitBreaker({
        ...config.circuit,
        clock,
        venue: POLYMARKET_VENUE_ID,
        name: "polymarket",
      }),
    });
  }
  if (config.venue === "jupiter" && config.jupiter) {
    return new JupiterVenue({
      baseUrl: config.jupiter.baseUrl,
      apiKey: config.jupiter.apiKey,
      timeoutMs: config.jupiter.timeoutMs,
      clock,
      retry: config.retry,
      circuit: new CircuitBreaker({ ...config.circuit, clock, venue: "jupiter", name: "jupiter" }),
    });
  }
  return new FixtureVenue({ clock });
}

export function buildPredictionRuntime(
  appConfig: AppConfig | undefined,
  overrides: BuildRuntimeOverrides = {},
): PredictionRuntime {
  const config = overrides.config ?? resolvePredictionConfig(appConfig);
  const clock = overrides.clock ?? systemClock;
  const venue = overrides.venue ?? buildVenue(config, clock);

  const social = overrides.social ?? appConfig?.social;
  let persistence = supabasePersistenceDecision({ social, venue: config.venue });

  let durable: SupabasePredictionStore | null = null;
  let store: PredictionStore;

  if (overrides.store) {
    store = overrides.store;
    durable = store instanceof SupabasePredictionStore ? store : null;
    persistence = {
      persisting: durable !== null,
      reason: durable ? "durable store supplied by the caller" : "in-memory store supplied by the caller",
    };
  } else if (persistence.persisting && social) {
    durable = new SupabasePredictionStore({
      config: social,
      clock,
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      ...(overrides.queue ? { queue: overrides.queue } : {}),
    });
    store = durable;
  } else {
    store = new InMemoryPredictionStore();
  }

  const service = new PredictionService({
    venue,
    store,
    clock,
    ttls: config.cache,
    flags: config.flags,
  });

  const marketSync = new MarketSync({ venue, store, clock, ...(overrides.marketSync ?? {}) });

  // One line, at most once per runtime, only when somebody actually configured
  // Supabase — so a dev box with no keys stays quiet and a deployment that
  // thinks it is durable cannot find out the hard way.
  if (social) {
    console.log(`[persist] prediction store: ${persistence.persisting ? "supabase" : "in-memory"} — ${persistence.reason}`);
  }

  const ready =
    durable && overrides.hydrate === true
      ? durable.hydrate().then(
          () => undefined,
          (err: unknown) => {
            console.error(
              `[persist] prediction hydrate FAILED; the mirror is empty and reads will under-report until a resync succeeds: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          },
        )
      : Promise.resolve();

  return { config, venue, store, service, persistence, durable, marketSync, ready };
}

let RUNTIMES = new WeakMap<AppConfig, PredictionRuntime>();

/**
 * The module-level memo the route module reads. Built on first use, never at
 * import — and the durable mirror is read from Postgres as part of that first
 * use, which is why `hydrate` is true only here and not in
 * `buildPredictionRuntime` (a test that constructs a runtime directly must
 * never reach the network).
 */
export function predictionRuntimeFor(appConfig: AppConfig): PredictionRuntime {
  let rt = RUNTIMES.get(appConfig);
  if (!rt) {
    rt = buildPredictionRuntime(appConfig, { hydrate: true });
    RUNTIMES.set(appConfig, rt);
  }
  return rt;
}

/** Test/ops seam: pin a runtime for one AppConfig (e.g. a fixture venue). */
export function setPredictionRuntime(appConfig: AppConfig, runtime: PredictionRuntime): void {
  RUNTIMES.set(appConfig, runtime);
}

/** Test seam: forget every memoised runtime. */
export function resetPredictionRuntimes(): void {
  RUNTIMES = new WeakMap<AppConfig, PredictionRuntime>();
}
