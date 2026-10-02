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
import type { FetchImpl } from "../prediction/pgrest.ts";
import { resolveNotificationsConfig, type NotificationsConfig } from "./config.ts";
import { NotificationDeriver } from "./NotificationDeriver.ts";
import { NotificationsService } from "./NotificationsService.ts";
import { callsStoreReader, emptySocialGraphReader, type SocialGraphReader } from "./sources.ts";
import { InMemoryNotificationsStore, type NotificationsStore } from "./store.ts";
import { SupabaseNotificationsStore } from "./supabaseStore.ts";

export interface NotificationsRuntime {
  config: NotificationsConfig;
  store: NotificationsStore;
  graph: SocialGraphReader;
  markets: VenueMarketReader;
  service: NotificationsService;
  deriver: NotificationDeriver;
  /** Packet A's session -> canonical public.users.id, borrowed from Packet D. */
  viewer: ViewerResolver;
  /** The durable store when one was built; null when this runtime is in memory. */
  durable: SupabaseNotificationsStore | null;
  /**
   * True once `startNotificationScheduler` runs the deriver on a timer. Inbox
   * reads then stop deriving: derivation is off the request path (M3/M4).
   */
  scheduled: boolean;
  /**
   * Resolves once the mirror has been read back from Postgres (and the calls
   * mirror before it). Immediately for an in-memory runtime. A failed read is
   * retried by the next caller rather than remembered, so a database blip at
   * boot does not disable the inbox until the next deploy.
   */
  ready(): Promise<void>;
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
  /** Injected by tests: no network and no real Postgres, ever. */
  fetchImpl?: FetchImpl;
}

export function buildNotificationsRuntime(
  appConfig: AppConfig | undefined,
  overrides: BuildNotificationsRuntimeOverrides = {},
): NotificationsRuntime {
  const config = overrides.config ?? resolveNotificationsConfig(appConfig);
  const clock = overrides.clock ?? systemClock;

  // Packet D owns the social rows. Read its runtime through its own memo so the
  // two packets share one world per app, without either editing the other.
  const calls =
    overrides.calls ?? (appConfig ? callsRuntimeFor(appConfig) : buildCallsRuntime(undefined));

  // Durable exactly when calls are: every notification row is a FK onto a
  // call (and a response or result), so a durable inbox over in-memory calls
  // would be refused row by row. Otherwise memory, as before.
  const social = appConfig?.social;
  let durable: SupabaseNotificationsStore | null = null;
  let store: NotificationsStore;
  if (overrides.store) {
    store = overrides.store;
    durable = store instanceof SupabaseNotificationsStore ? store : null;
  } else if (calls.durable && social) {
    durable = new SupabaseNotificationsStore({
      config: social,
      clock,
      parentQueue: calls.durable.queue,
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    });
    store = durable;
  } else {
    store = new InMemoryNotificationsStore();
  }
  if (social) {
    console.log(
      `[persist] notifications store: ${durable ? "supabase" : "in-memory"} — ${
        durable ? "calls are durable" : calls.persistence.reason
      }`,
    );
  }

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

  let hydrating: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    if (!durable) return calls.ready;
    hydrating ??= calls.ready
      .then(() => durable.hydrate())
      .then((report) => {
        console.log(
          `[persist] notifications hydrated: ${report.notifications} notifications, ${report.records} record rows` +
            (report.skipped.notifications || report.skipped.records
              ? ` (skipped ${report.skipped.notifications} / ${report.skipped.records})`
              : ""),
        );
      })
      .catch((err: unknown) => {
        hydrating = null;
        throw err;
      });
    return hydrating;
  };

  return { config, store, graph, markets, service, deriver, viewer, durable, ready, scheduled: false };
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
