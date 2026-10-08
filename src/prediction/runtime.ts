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
 * Panta's durable schema and native-price receipt path are still gated below.
 * Historical venue rows remain readable without reactivating their adapters.
 */

import type { AppConfig } from "../config.ts";
import { FixtureVenue } from "./FixtureVenue.ts";
import { PantaVenue, type PantaVenueConfig } from "./PantaVenue.ts";
import { PantaCatalogVenue } from "./PantaCatalogVenue.ts";
import { PantaChainCatalog } from "./PantaChainCatalog.ts";
import { registerSecret } from "./redact.ts";
import { CircuitBreaker } from "./circuit.ts";
import { systemClock, type Clock } from "./clock.ts";
import { resolvePredictionConfig, type PredictionConfig } from "./config.ts";
import { VenueError } from "./errors.ts";
import { MARKET_SYNC_CURSOR, MarketSync, type MarketSyncDeps } from "./marketSync.ts";
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
  /** The clock every read and write above uses; catalog reads judge "open" by it. */
  clock: Clock;
  /** The program reader the live Panta adapter completes USDC rows with, for
   *  any other PantaVenue built against this config (the trade path's).
   *  Absent when Panta is not live or no catalog RPC is configured. */
  pantaProgram?: Pick<PantaVenueConfig, "program" | "onProgramFailure">;
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

/** Live composition has no other-provider or demo fallback. */
function buildVenue(config: PredictionConfig, clock: Clock): { venue: PredictionVenue; pantaProgram?: PredictionRuntime["pantaProgram"] } {
  if (config.venue === "panta" && config.panta) {
    const chain = pantaChain(config, clock);
    // Since 2026-10-08 Panta's detail payload carries no rules or final flags;
    // the live adapter reads them from each USDC market's program account.
    const pantaProgram = chain ? { program: chain, onProgramFailure: (id: string, error: unknown) =>
      console.warn(`[panta-chain] program fields unavailable for ${id}: ${describeFailure(error)}`) } : undefined;
    const live = new PantaVenue({ ...config.panta, clock, retry: config.retry, ...pantaProgram,
      circuit: new CircuitBreaker({ ...config.circuit, clock, venue: "panta", name: "panta" }) });
    if (!config.pantaSolMarkets || !chain) return { venue: live, pantaProgram };
    return { pantaProgram, venue: new PantaCatalogVenue({ live, chain, clock,
      onChainFailure: error => console.warn(`[panta-chain] SOL markets unavailable this pass: ${describeFailure(error)}`) }) };
  }
  // Only explicit in-code test injection can select fixtures, never env config.
  if (config.venue === "fixture") return { venue: new FixtureVenue({ clock }) };
  throw new VenueError("VENUE_MISCONFIGURED", "Panta is the only live prediction provider and requires a live server key", { venue: "panta" });
}

/** The program reader: SOL-quoted markets (when enabled) and USDC rows'
 *  program fields. The RPC URL can carry a provider key, so it and its query
 *  values are redacted from every error. A bad URL fails boot only when SOL
 *  markets are enabled, as before; otherwise USDC rows without `onChain` are
 *  refused, as they were before the reader existed, and it says so. */
function pantaChain(config: PredictionConfig, clock: Clock): PantaChainCatalog | null {
  const rpcUrl = config.pantaSolMarkets?.rpcUrl ?? config.pantaProgram?.rpcUrl;
  if (!rpcUrl) return null;
  try {
    registerSecret(rpcUrl);
    for (const [name, value] of new URL(rpcUrl).searchParams) {
      if (/key|token|secret|auth/i.test(name)) registerSecret(value);
    }
    return new PantaChainCatalog({ rpcUrl, clock, retry: config.retry,
      onUnserved: (address, error) => console.warn(`[panta-chain] set aside ${address}: ${describeFailure(error)}`) });
  } catch (error) {
    if (config.pantaSolMarkets) throw error;
    console.warn(`[panta-chain] program reads disabled: ${describeFailure(error)}`);
    return null;
  }
}

/** A log-safe one-liner: a VenueError's code and redacted message, nothing else. */
const describeFailure = (error: unknown): string =>
  error instanceof VenueError ? `${error.code} ${error.message}` : "unexpected error";

export function buildPredictionRuntime(
  appConfig: AppConfig | undefined,
  overrides: BuildRuntimeOverrides = {},
): PredictionRuntime {
  const config = overrides.config ?? resolvePredictionConfig(appConfig);
  const clock = overrides.clock ?? systemClock;
  const built = overrides.venue ? { venue: overrides.venue } : buildVenue(config, clock);
  const venue = built.venue;

  const social = overrides.social ?? appConfig?.social;
  if (config.venue === "panta" && social && !overrides.store && appConfig?.predictions?.pantaSchemaReady !== true) {
    // A deployment must explicitly acknowledge the applied Panta schema. Do not silently
    // replace a configured durable backend with a volatile in-memory mirror.
    throw new VenueError("VENUE_MISCONFIGURED", "Panta durable app traffic is not enabled: apply and verify the Panta schema before setting PANTA_SCHEMA_READY", { venue: "panta" });
  }
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

  const marketSync = new MarketSync({ venue, store, clock,
    // Mirror-wide pricing and the unlisted sweep only ever touch this venue's
    // rows; retired providers' historical rows are never sent to the adapter.
    venueId: config.venue,
    // Keep the old cursor intact for historical repair/rollback. Panta starts
    // its own walk; numeric Polymarket offsets are not Solana market ids.
    // All Panta categories are discoverable. Start an independent cursor walk
    // so the old crypto-only continuation cannot skip other categories.
    ...(config.venue === "panta" ? {cursorKey:`${MARKET_SYNC_CURSOR}:panta:all`, filters: {}} : {}),
    ...(overrides.marketSync ?? {}) });

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
          () => { throw new VenueError("VENUE_UNAVAILABLE", "Prediction database is unavailable; no empty-feed fallback", { venue: config.venue }); },
        )
      : Promise.resolve();
  // Consumers await the ORIGINAL promise. Attach a handler immediately so a
  // cold-start refusal does not become an unhandled rejection before first use.
  void ready.catch(() => undefined);

  return { config, venue, store, service, persistence, durable, marketSync, ready, clock,
    ...(built.pantaProgram ? { pantaProgram: built.pantaProgram } : {}) };
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
