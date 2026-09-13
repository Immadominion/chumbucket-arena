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
 */

import type { AppConfig } from "../config.ts";
import type { EventStore } from "../core/eventstore/EventStore.ts";
import { systemClock, type Clock } from "../prediction/clock.ts";
import { predictionRuntimeFor } from "../prediction/runtime.ts";
import { CallsService } from "./CallsService.ts";
import { resolveCallsConfig, type CallsConfig } from "./config.ts";
import { emptyMarketReader, predictionStoreReader, type VenueMarketReader } from "./markets.ts";
import { CallReceiptsProjection } from "./receipts.ts";
import { ResolutionSync } from "./ResolutionSync.ts";
import { InMemoryCallsStore, type CallsStore } from "./store.ts";
import {
  chainViewerResolvers,
  supabaseViewerResolver,
  walletDirectoryViewerResolver,
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
}

export function buildCallsRuntime(
  appConfig: AppConfig | undefined,
  overrides: BuildCallsRuntimeOverrides = {},
): CallsRuntime {
  const config = overrides.config ?? resolveCallsConfig(appConfig);
  const clock = overrides.clock ?? systemClock;
  const store = overrides.store ?? new InMemoryCallsStore();

  // Packet B owns venue data. Read it through its own runtime memo so the two
  // packets share one store per app and a market synced by one is visible to
  // the other — without either editing the other's files.
  const markets =
    overrides.markets ??
    (appConfig ? predictionStoreReader(predictionRuntimeFor(appConfig).store) : emptyMarketReader);

  const receipts = new CallReceiptsProjection({
    walletToUserId: (wallet) => store.getPersonByWallet(wallet)?.id,
  });

  const service = new CallsService({
    store,
    markets,
    clock,
    receipts,
    maxPageSize: config.maxPageSize,
    ...(overrides.newId ? { newId: overrides.newId } : {}),
  });

  const sync = new ResolutionSync({
    store,
    markets,
    clock,
    receipts,
    pageSize: config.syncPageSize,
    maxPagesPerPass: config.syncMaxPagesPerPass,
  });

  // Session -> canonical public.users.id. Supabase first (Packet A's path),
  // then the already-verified wallet credential. Neither accepts a client id.
  const viewer =
    overrides.viewer ??
    (appConfig
      ? chainViewerResolvers(supabaseViewerResolver(appConfig), walletDirectoryViewerResolver(store))
      : walletDirectoryViewerResolver(store));

  let detach: (() => void) | null = null;
  return {
    config,
    store,
    markets,
    service,
    sync,
    receipts,
    viewer,
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

/** The module-level memo the route module reads. Built on first use, never at import. */
export function callsRuntimeFor(appConfig: AppConfig): CallsRuntime {
  let rt = RUNTIMES.get(appConfig);
  if (!rt) {
    rt = buildCallsRuntime(appConfig);
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
