/**
 * Prediction-BFF configuration.
 *
 * Read through `ctx.app.config` (contracts §6) — that is the seam new modules
 * are supposed to use, and it is what `resolvePredictionConfig` takes. `AppConfig`
 * is integration-owned, so Packet B cannot add its own `predictions` block to
 * src/config.ts; the exact patch that adds it is filed in
 * docs/contracts/integration-requests/packet-b.md. Until it lands, this resolver
 * falls back to the environment, which keeps this packet buildable and testable
 * without editing a file it does not own. Once the patch lands, `ctx.app.config
 * .predictions` simply wins and nothing here changes.
 *
 * The API key never leaves this module in a readable form: `describe()` is the
 * only thing a route may put in a response, and it reports presence, not value.
 */

import type { AppConfig } from "../config.ts";
import { assertCacheTtls, DEFAULT_CACHE_TTLS, type CacheTtls } from "./cache.ts";
import { DEFAULT_CIRCUIT } from "./circuit.ts";
import { DEFAULT_RETRY } from "./backoff.ts";
import { POLYMARKET_BASE_URL, POLYMARKET_VENUE_ID } from "./PolymarketVenue.ts";
import { registerSecret } from "./redact.ts";
import type { VenueId } from "./types.ts";

export interface PredictionConfigInput {
  /** Which adapter to serve. Defaults to 'fixture' unless a Jupiter key is present. */
  venue?: VenueId;
  jupiter?: { baseUrl?: string; apiKey: string; timeoutMs?: number };
  /** Public, unauthenticated, read-only. There is no key and none is accepted. */
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
  polymarket: { baseUrl: string; timeoutMs: number } | null;
  flags: { fundedPositions: boolean };
  cache: CacheTtls;
  circuit: { failureThreshold: number; resetAfterMs: number; halfOpenMaxCalls: number };
  retry: { attempts: number; baseDelayMs: number; maxDelayMs: number };
}

const DEFAULT_JUPITER_BASE_URL = "https://prediction-api.jup.ag";

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v === "on";
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

  const apiKey = fromApp?.jupiter?.apiKey ?? env.JUPITER_API_KEY;
  const jupiter = apiKey
    ? {
        baseUrl: fromApp?.jupiter?.baseUrl ?? env.JUPITER_BASE_URL ?? DEFAULT_JUPITER_BASE_URL,
        apiKey,
        timeoutMs: fromApp?.jupiter?.timeoutMs ?? num(env.JUPITER_TIMEOUT_MS, 8_000),
      }
    : null;
  // Registered the moment it is read, so it can never escape through an error.
  if (jupiter) registerSecret(jupiter.apiKey);

  // Polymarket's gamma API is public and unauthenticated, so it is ALWAYS
  // available — there is nothing to configure and nothing to keep secret.
  const polymarket = {
    baseUrl: fromApp?.polymarket?.baseUrl ?? env.POLYMARKET_BASE_URL ?? POLYMARKET_BASE_URL,
    timeoutMs: fromApp?.polymarket?.timeoutMs ?? num(env.POLYMARKET_TIMEOUT_MS, 8_000),
  };

  // The integration-owned src/config.ts collapses PREDICTION_VENUE to
  // 'jupiter' | 'fixture' before this resolver ever sees it (it predates this
  // adapter), so an explicit PREDICTION_VENUE=polymarket in the environment has
  // to win over that coerced AppConfig value. The patch that teaches
  // src/config.ts about the venue is filed in
  // docs/contracts/integration-requests/packet-poly.md; once it lands this
  // branch becomes redundant rather than wrong.
  const asked =
    env.PREDICTION_VENUE === POLYMARKET_VENUE_ID
      ? POLYMARKET_VENUE_ID
      : (fromApp?.venue ?? env.PREDICTION_VENUE);
  const requested: VenueId | undefined =
    asked === "jupiter" || asked === "fixture"
      ? asked
      : asked === POLYMARKET_VENUE_ID
        ? POLYMARKET_VENUE_ID
        : undefined;

  // Three deliberate defaults:
  //  - asking for 'polymarket' always works: no key exists to be missing.
  //  - asking for 'jupiter' with no key falls back to 'fixture' rather than
  //    booting a venue that cannot answer. Serving clearly-labelled demo data
  //    beats serving errors, and demo data can never be mistaken for live.
  //  - asking for nothing serves whatever is actually configured.
  const venue: VenueId =
    requested === POLYMARKET_VENUE_ID
      ? POLYMARKET_VENUE_ID
      : requested === "fixture"
        ? "fixture"
        : jupiter
          ? "jupiter"
          : "fixture";

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
    jupiter: venue === "jupiter" ? jupiter : null,
    polymarket: venue === POLYMARKET_VENUE_ID ? polymarket : null,
    flags: {
      // contracts §7: funded_positions defaults OFF and is enforced server-side.
      fundedPositions: fromApp?.flags?.fundedPositions ?? bool(env.FUNDED_POSITIONS, false),
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
  cache: CacheTtls;
} {
  return {
    venue: cfg.venue,
    demo: cfg.venue === "fixture",
    fundedPositions: cfg.flags.fundedPositions,
    jupiterConfigured: cfg.jupiter !== null,
    // Presence only, and there is no key here to hide in the first place.
    polymarketConfigured: cfg.polymarket !== null,
    cache: cfg.cache,
  };
}

/**
 * Attach a prediction block to an AppConfig without editing src/config.ts.
 * Used by tests today and by the integration owner's patch tomorrow.
 */
export function withPredictionConfig(base: AppConfig, predictions: PredictionConfigInput): AppConfig {
  return Object.assign({}, base, { predictions }) as AppConfig;
}
