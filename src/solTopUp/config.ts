/**
 * SOL top-up configuration, read from the environment by this module alone
 * (src/config.ts is integration-owned; same pattern as src/deposits/config.ts).
 * Nothing here logs a value.
 *
 *   SOL_TOPUP_ENABLED     exact lowercase `true` enables; anything else pauses.
 *   JUPITER_API_KEY       server-held key for api.jup.ag (Swap API v2).
 *   SOL_TOPUP_TARGET_USDC the usual swap, default "1" (the owner's choice).
 *   SOL_TOPUP_MAX_USDC    the largest swap ever offered, default "5".
 *   JUPITER_MIN_INTERVAL_MS spacing between /order calls (Free plan: 1 rps).
 */

import type { AppConfig } from "../config.ts";

/** Jupiter Swap API v2 (https://developers.jup.ag/docs/swap). Pinned: the key
 *  is only ever sent here. */
export const JUPITER_SWAP_API = "https://api.jup.ag/swap/v2";

const USDC = 1_000_000n;

export interface SolTopUpConfig {
  apiBase: string;
  apiKey: string;
  /** Never below $1: smaller swaps are rarely sponsored and buy too little. */
  minUsdcBaseUnits: bigint;
  targetUsdcBaseUnits: bigint;
  maxUsdcBaseUnits: bigint;
  /** How many new Panta positions a top-up aims to cover. */
  tradesToCover: number;
  minIntervalMs: number;
}

export type SolTopUpUnavailableCode = "PAUSED" | "NOT_CONFIGURED" | "MISCONFIGURED";

export interface SolTopUpReadiness {
  available: boolean;
  reason: { code: SolTopUpUnavailableCode; message: string } | null;
  config: SolTopUpConfig | null;
}

/** "1" | "1.5" | "2.25" USDC -> base units. Anything else -> null. */
export function usdcToBaseUnits(value: string | undefined): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9][0-9]{0,3})(?:\.([0-9]{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  return BigInt(match[1]!) * USDC + BigInt((match[2] ?? "").padEnd(6, "0"));
}

const unavailable = (code: SolTopUpUnavailableCode, message: string): SolTopUpReadiness => ({
  available: false,
  reason: { code, message },
  config: null,
});

export function resolveSolTopUp(
  _appConfig: AppConfig,
  env: Record<string, string | undefined> = process.env,
): SolTopUpReadiness {
  if (env.SOL_TOPUP_ENABLED !== "true") {
    return unavailable("PAUSED", "Swapping USDC for SOL is paused right now. Your wallet is unaffected.");
  }
  const apiKey = env.JUPITER_API_KEY?.trim();
  if (!apiKey) return unavailable("NOT_CONFIGURED", "Swapping USDC for SOL isn't set up yet.");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(apiKey)) {
    return unavailable("MISCONFIGURED", "Swapping USDC for SOL isn't set up correctly yet.");
  }
  const min = USDC;
  const target = usdcToBaseUnits(env.SOL_TOPUP_TARGET_USDC) ?? USDC;
  const max = usdcToBaseUnits(env.SOL_TOPUP_MAX_USDC) ?? 5n * USDC;
  if (target < min || max < target || max > 25n * USDC) {
    return unavailable("MISCONFIGURED", "Swapping USDC for SOL isn't set up correctly yet.");
  }
  const interval = Number(env.JUPITER_MIN_INTERVAL_MS ?? "1100");
  return {
    available: true,
    reason: null,
    config: {
      apiBase: JUPITER_SWAP_API,
      apiKey,
      minUsdcBaseUnits: min,
      targetUsdcBaseUnits: target,
      maxUsdcBaseUnits: max,
      tradesToCover: 3,
      minIntervalMs: Number.isFinite(interval) && interval >= 0 && interval <= 10_000 ? interval : 1100,
    },
  };
}
