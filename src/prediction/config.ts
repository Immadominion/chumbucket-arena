/**
 * Prediction-BFF configuration.
 *
 * Panta is the only live provider. An explicit in-code fixture config remains
 * for isolated tests; the environment cannot select it or another provider.
 * Missing keys and stale provider config fail closed, never select a fallback.
 *
 * The API key never leaves this module in a readable form: `describe()` is the
 * only thing a route may put in a response, and it reports presence, not value.
 */

import type { AppConfig } from "../config.ts";
import { assertCacheTtls, DEFAULT_CACHE_TTLS, type CacheTtls } from "./cache.ts";
import { DEFAULT_CIRCUIT } from "./circuit.ts";
import { DEFAULT_RETRY } from "./backoff.ts";
import { registerSecret } from "./redact.ts";
import type { VenueId } from "./types.ts";
import { VenueError } from "./errors.ts";
import { livePredictionVenue } from "./venuePolicy.ts";

export interface PredictionConfigInput {
  /** Defaults to Panta. Historical live providers are refused; fixture is test-only. */
  venue?: VenueId;
  /** Historical input compatibility only; ignored and never enables an adapter. */
  jupiter?: { baseUrl?: string; apiKey: string; timeoutMs?: number };
  panta?: { apiKey: string; timeoutMs?: number; programId?: string };
  pantaSchemaReady?: boolean;
  maxAmountBaseUnits?: string;
  /** Historical input compatibility only; ignored and never enables an adapter. */
  polymarket?: { baseUrl?: string; timeoutMs?: number };
  flags?: { fundedPositions?: boolean };
  cache?: Partial<CacheTtls>;
  circuit?: { failureThreshold?: number; resetAfterMs?: number; halfOpenMaxCalls?: number };
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
}

/** The structural extension of AppConfig this packet reads. Additive, optional. */
export interface PredictionAppConfig {
  predictions?: PredictionConfigInput;
}

export interface PredictionConfig {
  venue: VenueId;
  jupiter: { baseUrl: string; apiKey: string; timeoutMs: number } | null;
  panta: { apiKey: string; timeoutMs: number } | null;
  polymarket: { baseUrl: string; timeoutMs: number } | null;
  flags: { fundedPositions: boolean };
  cache: CacheTtls;
  circuit: { failureThreshold: number; resetAfterMs: number; halfOpenMaxCalls: number };
  retry: { attempts: number; baseDelayMs: number; maxDelayMs: number };
}

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Resolve the effective prediction config: `ctx.app.config.predictions` first,
 * then the environment, then contract defaults.
 */
export function resolvePredictionConfig(
  appConfig: AppConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): PredictionConfig {
  const fromApp = (appConfig as (AppConfig & PredictionAppConfig) | undefined)?.predictions;

  const venue = fromApp?.venue === "fixture"
    ? "fixture"
    : livePredictionVenue(fromApp?.venue ?? env.PREDICTION_VENUE);

  const pantaKey = fromApp?.panta?.apiKey ?? env.PANTA_API_KEY;
  if (pantaKey) registerSecret(pantaKey);
  if (venue === "panta" && (!pantaKey || !/^pk_live_[A-Za-z0-9_-]+$/.test(pantaKey))) {
    // No silent substitution with another venue or invented fixture markets.
    throw new VenueError("VENUE_MISCONFIGURED", "Panta selected without a live server key", { venue: "panta" });
  }

  const cache = assertCacheTtls({
    eventList: fromApp?.cache?.eventList ?? num(env.PREDICTION_TTL_EVENTS_MS, DEFAULT_CACHE_TTLS.eventList),
    openMarket: fromApp?.cache?.openMarket ?? num(env.PREDICTION_TTL_OPEN_MS, DEFAULT_CACHE_TTLS.openMarket),
    orderbook: fromApp?.cache?.orderbook ?? num(env.PREDICTION_TTL_BOOK_MS, DEFAULT_CACHE_TTLS.orderbook),
    settledMarket:
      fromApp?.cache?.settledMarket ?? num(env.PREDICTION_TTL_SETTLED_MS, DEFAULT_CACHE_TTLS.settledMarket),
    tradingStatus:
      fromApp?.cache?.tradingStatus ?? num(env.PREDICTION_TTL_STATUS_MS, DEFAULT_CACHE_TTLS.tradingStatus),
  });

  return {
    venue,
    jupiter: null,
    panta: venue === "panta" ? { apiKey: pantaKey!, timeoutMs: fromApp?.panta?.timeoutMs ?? num(env.PANTA_TIMEOUT_MS, 8_000) } : null,
    polymarket: null,
    flags: {
      // Native Panta execution additionally requires durable schema and a
      // pinned program, and accepts only an exact wallet-signed transaction.
      fundedPositions: venue === "fixture" ? fromApp?.flags?.fundedPositions === true
        : (fromApp?.flags?.fundedPositions ?? (env.FUNDED_POSITIONS === "true")),
    },
    cache,
    circuit: {
      failureThreshold:
        fromApp?.circuit?.failureThreshold ?? num(env.PREDICTION_CIRCUIT_FAILURES, DEFAULT_CIRCUIT.failureThreshold),
      resetAfterMs:
        fromApp?.circuit?.resetAfterMs ?? num(env.PREDICTION_CIRCUIT_RESET_MS, DEFAULT_CIRCUIT.resetAfterMs),
      halfOpenMaxCalls: fromApp?.circuit?.halfOpenMaxCalls ?? DEFAULT_CIRCUIT.halfOpenMaxCalls,
    },
    retry: {
      attempts: fromApp?.retry?.attempts ?? num(env.PREDICTION_RETRY_ATTEMPTS, DEFAULT_RETRY.attempts),
      baseDelayMs: fromApp?.retry?.baseDelayMs ?? num(env.PREDICTION_RETRY_BASE_MS, DEFAULT_RETRY.baseDelayMs),
      maxDelayMs: fromApp?.retry?.maxDelayMs ?? num(env.PREDICTION_RETRY_MAX_MS, DEFAULT_RETRY.maxDelayMs),
    },
  };
}

/**
 * The ONLY shape of this config that may appear in a response body or a log.
 * Reports whether a key is configured — never the key.
 */
export function describePredictionConfig(cfg: PredictionConfig): {
  venue: VenueId;
  demo: boolean;
  fundedPositions: boolean;
  jupiterConfigured: boolean;
  polymarketConfigured: boolean;
  pantaConfigured: boolean;
  cache: CacheTtls;
} {
  return {
    venue: cfg.venue,
    demo: cfg.venue === "fixture",
    fundedPositions: cfg.flags.fundedPositions,
    jupiterConfigured: cfg.jupiter !== null,
    // Retained response fields for old clients; both retired providers are false.
    polymarketConfigured: cfg.polymarket !== null,
    pantaConfigured: cfg.panta !== null,
    cache: cfg.cache,
  };
}

/**
 * Explicit in-code injection for isolated tests, including the fixture venue.
 * Deployment configuration must go through loadConfig(), which is Panta-only.
 */
export function withPredictionConfig(base: AppConfig, predictions: PredictionConfigInput): AppConfig {
  return Object.assign({}, base, { predictions }) as AppConfig;
}
