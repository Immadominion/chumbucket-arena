/**
 * Lazy construction of the prediction runtime, memoised per AppConfig.
 *
 * contracts §6: a packet's route module builds its own store/adapter behind a
 * module-level memo rather than being wired into the composition root (which is
 * integration-owned). Keyed on the AppConfig OBJECT so two apps in one test
 * process — one with the kill switch on, one off — never share a runtime.
 */

import type { AppConfig } from "../config.ts";
import { FixtureVenue } from "./FixtureVenue.ts";
import { JupiterVenue } from "./JupiterVenue.ts";
import { CircuitBreaker } from "./circuit.ts";
import { systemClock, type Clock } from "./clock.ts";
import { resolvePredictionConfig, type PredictionConfig } from "./config.ts";
import { PredictionService } from "./PredictionService.ts";
import type { PredictionVenue } from "./PredictionVenue.ts";
import { InMemoryPredictionStore, type PredictionStore } from "./store.ts";

export interface PredictionRuntime {
  config: PredictionConfig;
  venue: PredictionVenue;
  store: PredictionStore;
  service: PredictionService;
}

export interface BuildRuntimeOverrides {
  venue?: PredictionVenue;
  store?: PredictionStore;
  clock?: Clock;
  /** Test/ops override of the resolved config. */
  config?: PredictionConfig;
}

export function buildPredictionRuntime(
  appConfig: AppConfig | undefined,
  overrides: BuildRuntimeOverrides = {},
): PredictionRuntime {
  const config = overrides.config ?? resolvePredictionConfig(appConfig);
  const clock = overrides.clock ?? systemClock;
  const store = overrides.store ?? new InMemoryPredictionStore();
  const venue =
    overrides.venue ??
    (config.venue === "jupiter" && config.jupiter
      ? new JupiterVenue({
          baseUrl: config.jupiter.baseUrl,
          apiKey: config.jupiter.apiKey,
          timeoutMs: config.jupiter.timeoutMs,
          clock,
          retry: config.retry,
          circuit: new CircuitBreaker({ ...config.circuit, clock, venue: "jupiter", name: "jupiter" }),
        })
      : new FixtureVenue({ clock }));

  const service = new PredictionService({
    venue,
    store,
    clock,
    ttls: config.cache,
    flags: config.flags,
  });
  return { config, venue, store, service };
}

let RUNTIMES = new WeakMap<AppConfig, PredictionRuntime>();

/** The module-level memo the route module reads. Built on first use, never at import. */
export function predictionRuntimeFor(appConfig: AppConfig): PredictionRuntime {
  let rt = RUNTIMES.get(appConfig);
  if (!rt) {
    rt = buildPredictionRuntime(appConfig);
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
