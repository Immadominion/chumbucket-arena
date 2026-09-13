/**
 * Lazy construction of the notifications runtime, memoised per AppConfig.
 *
 * contracts §6: a packet's route module builds its own store behind a
 * module-level memo rather than being wired into the composition root (which is
 * integration-owned). Keyed on the AppConfig OBJECT — never on a string derived
 * from its values — so two apps in one test process never share a store.
 * WeakMap, so a discarded app's store is collectable.
 *
 * IT DOES NOT BUILD A SECOND SOCIAL WORLD. Packet D's runtime is read through
 * `callsRuntimeFor(appConfig)`, the same memo Packet D's own route module uses,
 * so the calls, responses, results, people and follow graph this packet derives
 * from are literally the ones Packet D wrote — and the session resolver is
 * Packet D's, which is Packet A's. One identity path, not three (§0.3).
 *
 * Nothing is done at import time. Importing `src/api/notifications.ts` costs
 * nothing and starts nothing.
 */

import type { AppConfig } from "../config.ts";
import { buildCallsRuntime, callsRuntimeFor, type CallsRuntime } from "../calls/runtime.ts";
import { emptyMarketReader, type VenueMarketReader } from "../calls/markets.ts";
import type { ViewerResolver } from "../calls/viewer.ts";
import { systemClock, type Clock } from "../prediction/clock.ts";
import { resolveNotificationsConfig, type NotificationsConfig } from "./config.ts";
import { NotificationDeriver } from "./NotificationDeriver.ts";
import { NotificationsService } from "./NotificationsService.ts";
import { callsStoreReader, emptySocialGraphReader, type SocialGraphReader } from "./sources.ts";
import { InMemoryNotificationsStore, type NotificationsStore } from "./store.ts";

export interface NotificationsRuntime {
  config: NotificationsConfig;
  store: NotificationsStore;
  graph: SocialGraphReader;
  markets: VenueMarketReader;
  service: NotificationsService;
  deriver: NotificationDeriver;
  /** Packet A's session -> canonical public.users.id, borrowed from Packet D. */
  viewer: ViewerResolver;
}

export interface BuildNotificationsRuntimeOverrides {
  config?: NotificationsConfig;
  store?: NotificationsStore;
  /** Packet D's runtime — the source of calls, responses, results and people. */
  calls?: CallsRuntime;
  graph?: SocialGraphReader;
  markets?: VenueMarketReader;
  viewer?: ViewerResolver;
  clock?: Clock;
  newId?: () => string;
}

export function buildNotificationsRuntime(
  appConfig: AppConfig | undefined,
  overrides: BuildNotificationsRuntimeOverrides = {},
): NotificationsRuntime {
  const config = overrides.config ?? resolveNotificationsConfig(appConfig);
  const clock = overrides.clock ?? systemClock;
  const store = overrides.store ?? new InMemoryNotificationsStore();

  // Packet D owns the social rows. Read its runtime through its own memo so the
  // two packets share one world per app, without either editing the other.
  const calls =
    overrides.calls ?? (appConfig ? callsRuntimeFor(appConfig) : buildCallsRuntime(undefined));

  const graph = overrides.graph ?? (calls ? callsStoreReader(calls.store) : emptySocialGraphReader);
  const markets = overrides.markets ?? calls?.markets ?? emptyMarketReader;
  const viewer = overrides.viewer ?? calls.viewer;

  const service = new NotificationsService({
    store,
    graph,
    markets,
    clock,
    maxPageSize: config.maxPageSize,
  });

  const deriver = new NotificationDeriver({
    store,
    graph,
    markets,
    clock,
    maxPerPass: config.maxPerPass,
    ...(overrides.newId ? { newId: overrides.newId } : {}),
  });

  return { config, store, graph, markets, service, deriver, viewer };
}

let RUNTIMES = new WeakMap<AppConfig, NotificationsRuntime>();

/** The module-level memo the route module reads. Built on first use, never at import. */
export function notificationsRuntimeFor(appConfig: AppConfig): NotificationsRuntime {
  let rt = RUNTIMES.get(appConfig);
  if (!rt) {
    rt = buildNotificationsRuntime(appConfig);
    RUNTIMES.set(appConfig, rt);
  }
  return rt;
}

/** Test/ops seam: pin a runtime for one AppConfig. */
export function setNotificationsRuntime(appConfig: AppConfig, runtime: NotificationsRuntime): void {
  RUNTIMES.set(appConfig, runtime);
}

/** Test seam: forget every memoised runtime. */
export function resetNotificationsRuntimes(): void {
  RUNTIMES = new WeakMap<AppConfig, NotificationsRuntime>();
}
