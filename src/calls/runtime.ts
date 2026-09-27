/**
 * Lazy construction of the calls runtime, memoised per AppConfig.
 *
 * contracts §6: a packet's route module builds its own store/adapter behind a
 * module-level memo rather than being wired into the composition root (which is
 * integration-owned). Keyed on the AppConfig OBJECT — never on a string derived
 * from its values — so two apps in one test process never share a store and a
 * rotated key can never be remembered from a stale entry. WeakMap, so a
 * discarded app's store is collectable.
 *
 * Note what is NOT done at import time: nothing. Importing `src/api/calls.ts`
 * costs nothing and starts nothing.
 *
 * ── STORE SELECTION ────────────────────────────────────────────────────────
 *
 * `config.social` present AND Packet B's runtime is actually persisting ->
 * Postgres. Anything else -> memory, with a boot line that says why.
 *
 * The second half of that condition is not belt-and-braces, it is a hard
 * dependency: `calls.market_id` is a FK onto `venue_markets(id)` and
 * `calls_guard_insert` refuses a call whose market row does not exist. A durable
 * calls store on top of an in-memory market catalog would therefore queue
 * calls Postgres rejects, one per call, forever. Persistence is all-or-nothing
 * across the two packets, and `runtime.persistence` says which it is.
 *
 * Both stores also share ONE FIFO durable writer for the same reason: the
 * market and the snapshot a call cites must be written before the call.
 */

import type { AppConfig } from "../config.ts";
import type { EventStore } from "../core/eventstore/EventStore.ts";
import { systemClock, type Clock } from "../prediction/clock.ts";
import type { FetchImpl } from "../prediction/pgrest.ts";
import { predictionRuntimeFor, type PredictionRuntime } from "../prediction/runtime.ts";
import type { PersistenceDecision } from "../prediction/supabaseStore.ts";
import { CallsService } from "./CallsService.ts";
import { resolveCallsConfig, type CallsConfig } from "./config.ts";
import { emptyMarketReader, predictionStoreReader, type VenueMarketReader } from "./markets.ts";
import { CallReceiptsProjection } from "./receipts.ts";
import { ResolutionSync } from "./ResolutionSync.ts";
import { InMemoryCallsStore, type CallsStore } from "./store.ts";
import { SupabaseCallsStore } from "./supabaseStore.ts";
import {
  anonymousViewerResolver,
  supabaseViewerResolver,
  type ViewerResolver,
} from "./viewer.ts";

export interface CallsRuntime {
  config: CallsConfig;
  store: CallsStore;
  markets: VenueMarketReader;
  service: CallsService;
  sync: ResolutionSync;
  receipts: CallReceiptsProjection;
  viewer: ViewerResolver;
  /** Whether calls are written to Postgres, and — always — why. */
  persistence: PersistenceDecision;
  /** The durable store when one was built; null when this runtime is in memory. */
  durable: SupabaseCallsStore | null;
  /** Packet B's runtime, so an ops caller can reach `marketSync` from here. */
  prediction: PredictionRuntime | null;
  /**
   * Resolves once BOTH mirrors have been built from Postgres. Already resolved
   * for an in-memory runtime. Awaiting it at boot closes the cold-start window
   * in which a persisted feed would read as empty — packet-persist.md §2.
   */
  ready: Promise<void>;
  /** Tail the live event log for arena-era receipts. Idempotent; returns the
   *  unsubscribe thunk `EventStore.subscribe()` gave us (§1, §6). */
  attachReceipts(store: EventStore): () => void;
}

export interface BuildCallsRuntimeOverrides {
  config?: CallsConfig;
  store?: CallsStore;
  markets?: VenueMarketReader;
  clock?: Clock;
  viewer?: ViewerResolver;
  newId?: (kind: "call" | "response") => string;
  /** Packet B's runtime, when it should not come from the module memo. */
  prediction?: PredictionRuntime;
  /** Injected by every test: no network and no real Postgres, ever. */
  fetchImpl?: FetchImpl;
  /** Read Postgres into the mirror as part of construction. Default: false. */
  hydrate?: boolean;
}

/**
 * Ids for a persisted store must be UUIDs: `calls.id` and `call_responses.id`
 * are UUID columns. `CallsService`'s default generator produces
 * `call_1_<base36>`, which Postgres refuses with 22P02 — so the durable path
 * supplies `crypto.randomUUID()` instead. This is the "fix the write" answer
 * rather than the "widen the column" one, and it is the only reason this
 * override exists.
 */
const uuidNewId = (): string => crypto.randomUUID();

export function buildCallsRuntime(
  appConfig: AppConfig | undefined,
  overrides: BuildCallsRuntimeOverrides = {},
): CallsRuntime {
  const config = overrides.config ?? resolveCallsConfig(appConfig);
  const clock = overrides.clock ?? systemClock;

  // Packet B owns venue data. Read it through its own runtime memo so the two
  // packets share one store per app and a market synced by one is visible to
  // the other — without either editing the other's files.
  const prediction =
    overrides.prediction ??
    (appConfig && !overrides.markets ? predictionRuntimeFor(appConfig) : null);

  const social = appConfig?.social;
  // All-or-nothing across the two packets: a durable call needs a durable
  // market to point at (see the header).
  let persistence: PersistenceDecision = prediction
    ? prediction.persistence.persisting
      ? { persisting: true, reason: prediction.persistence.reason }
      : {
          persisting: false,
          reason: `venue data is not persisting (${prediction.persistence.reason}), and calls.market_id is a FK onto venue_markets(id)`,
        }
    : {
        persisting: false,
        reason: "no prediction runtime: venue markets are unavailable, so a call has nothing to reference",
      };

  let durable: SupabaseCallsStore | null = null;
  let store: CallsStore;

  if (overrides.store) {
    store = overrides.store;
    durable = store instanceof SupabaseCallsStore ? store : null;
    persistence = {
      persisting: durable !== null,
      reason: durable ? "durable store supplied by the caller" : "in-memory store supplied by the caller",
    };
  } else if (persistence.persisting && social && prediction?.durable) {
    durable = new SupabaseCallsStore({
      config: social,
      clock,
      // THE SAME queue as the prediction store: parent rows first.
      queue: prediction.durable.queue,
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    });
    store = durable;
  } else {
    store = new InMemoryCallsStore();
  }

  const markets =
    overrides.markets ??
    (prediction ? predictionStoreReader(prediction.store) : emptyMarketReader);

  const receipts = new CallReceiptsProjection({
    walletToUserId: (wallet) => store.getPersonByWallet(wallet)?.id,
  });

  const service = new CallsService({
    store,
    markets,
    clock,
    receipts,
    maxPageSize: config.maxPageSize,
    // A persisted store needs UUID ids; an in-memory one keeps the existing
    // readable ids so every current test reads exactly as it did.
    ...(overrides.newId ? { newId: overrides.newId } : durable ? { newId: uuidNewId } : {}),
  });

  const sync = new ResolutionSync({
    store,
    markets,
    clock,
    receipts,
    pageSize: config.syncPageSize,
    maxPagesPerPass: config.syncMaxPagesPerPass,
  });

  // A social session never falls back to DevAuth's unverified wallet string.
  // Legacy wallet routes remain independent and keep their own auth gate.
  const identityViewer =
    overrides.viewer ??
    (appConfig ? supabaseViewerResolver(appConfig) : anonymousViewerResolver);
  const viewer: ViewerResolver = {
    async resolve(ctx) {
      const id = await identityViewer.resolve(ctx);
      // A profile may have been created after boot, or on another replica.
      if (id && durable && !store.getPerson(id)) await durable.refreshPerson(id);
      return id;
    },
  };

  if (social) {
    console.log(`[persist] calls store: ${persistence.persisting ? "supabase" : "in-memory"} — ${persistence.reason}`);
  }

  // Packet B's mirror is hydrated FIRST: the markets reader is read through it,
  // and a call's result derivation asks it for venue evidence.
  const ready =
    durable && overrides.hydrate === true
      ? (prediction?.ready ?? Promise.resolve()).then(() =>
          durable.hydrate().then(
            () => undefined,
            (err: unknown) => {
              console.error(
                `[persist] calls hydrate FAILED; the mirror is empty and the feed will under-report until a resync succeeds: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            },
          ),
        )
      : (prediction?.ready ?? Promise.resolve());

  let detach: (() => void) | null = null;
  return {
    config,
    store,
    markets,
    service,
    sync,
    receipts,
    viewer,
    persistence,
    durable,
    prediction,
    ready,
    attachReceipts(eventStore: EventStore): () => void {
      if (detach) return detach;
      const off = receipts.attach(eventStore);
      detach = () => {
        off();
        detach = null;
      };
      return detach;
    },
  };
}

let RUNTIMES = new WeakMap<AppConfig, CallsRuntime>();

/**
 * The module-level memo the route module reads. Built on first use, never at
 * import — and the durable mirror is read from Postgres as part of that first
 * use, which is why `hydrate` is true only here (a test that constructs a
 * runtime directly must never reach the network).
 */
export function callsRuntimeFor(appConfig: AppConfig): CallsRuntime {
  let rt = RUNTIMES.get(appConfig);
  if (!rt) {
    rt = buildCallsRuntime(appConfig, { hydrate: true });
    RUNTIMES.set(appConfig, rt);
  }
  return rt;
}

/** Test/ops seam: pin a runtime for one AppConfig. */
export function setCallsRuntime(appConfig: AppConfig, runtime: CallsRuntime): void {
  RUNTIMES.set(appConfig, runtime);
}

/** Test seam: forget every memoised runtime. */
export function resetCallsRuntimes(): void {
  RUNTIMES = new WeakMap<AppConfig, CallsRuntime>();
}
