/**
 * Deposits configuration, read from the environment by this module alone.
 *
 * `src/config.ts` is integration-owned, so this follows the AuthIdentityRuntime
 * pattern: a forward-compatible `config.deposits` block is honoured if it ever
 * lands, otherwise the env is read here. Nothing in this file logs a value.
 *
 * The emergency stop is `DEPOSITS_ENABLED` — exact lowercase `true` enables,
 * anything else pauses, the same posture as `FUNDED_POSITIONS`.
 */

import type { AppConfig } from "../config.ts";

export type CrossmintEnvironment = "staging" | "production";

/** Verified in Crossmint's create-order reference (docs/crossmint-deposits.md §2). */
export const CROSSMINT_USDC_SOLANA: Record<CrossmintEnvironment, string> = {
  staging: "solana:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  production: "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const HOSTS: Record<CrossmintEnvironment, string> = {
  staging: "https://staging.crossmint.com",
  production: "https://www.crossmint.com",
};

/** Single-transaction ownership proof starts above this (external wallets). */
const PROOF_THRESHOLD_CENTS = 100_000;
/** Crossmint's minimum card charge. */
const CARD_MINIMUM_CENTS = 50;
/** Crossmint's staging cap for USDC orders. */
const STAGING_USDC_CAP_CENTS = 1_000;

export interface DepositsConfig {
  environment: CrossmintEnvironment;
  /** e.g. https://staging.crossmint.com/api */
  apiBase: string;
  /** Host the embedded checkout page is served from. */
  checkoutBase: string;
  serverApiKey: string;
  clientApiKey: string;
  tokenLocator: string;
  chain: "solana";
  /** Where Crossmint delivers. Staging delivers devnet test USDC. */
  deliveryNetwork: "solana-devnet" | "solana-mainnet";
  minOrderCents: number;
  maxOrderCents: number;
  presetsCents: number[];
}

export type DepositsUnavailableCode = "PAUSED" | "NOT_CONFIGURED" | "MISCONFIGURED" | "NO_ACCOUNTS";

export interface DepositsReadiness {
  available: boolean;
  /** Present only when unavailable. Plain words a person can read. */
  reason: { code: DepositsUnavailableCode; message: string } | null;
  config: DepositsConfig | null;
}

interface DepositsConfigBlock {
  enabled?: boolean;
  environment?: string;
  serverApiKey?: string;
  clientApiKey?: string;
  minOrderUsd?: string;
  maxOrderUsd?: string;
}

const unavailable = (code: DepositsUnavailableCode, message: string): DepositsReadiness => ({
  available: false,
  reason: { code, message },
  config: null,
});

/** "25" | "25.5" | "25.50" → 2550. Anything else → null. */
export function usdToCents(value: string | undefined | null): number | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9][0-9]{0,5})(?:\.([0-9]{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + fraction;
}

/** 2550 → "25.50"; 2500 → "25". Never a float round-trip. */
export function centsToUsd(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = cents % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

export function resolveDeposits(
  appConfig: AppConfig,
  env: Record<string, string | undefined> = process.env,
): DepositsReadiness {
  const block = (appConfig as AppConfig & { deposits?: DepositsConfigBlock }).deposits;
  const enabled = block?.enabled ?? env.DEPOSITS_ENABLED === "true";
  const environment = block?.environment ?? env.CROSSMINT_ENV;
  const serverApiKey = block?.serverApiKey ?? env.CROSSMINT_SERVER_API_KEY;
  const clientApiKey = block?.clientApiKey ?? env.CROSSMINT_CLIENT_API_KEY;

  if (!enabled) return unavailable("PAUSED", "Adding funds is paused right now. Your wallet and balance are unaffected.");
  if (!environment || !serverApiKey || !clientApiKey) {
    return unavailable("NOT_CONFIGURED", "Adding funds isn't set up yet.");
  }
  if (environment !== "staging" && environment !== "production") {
    return unavailable("MISCONFIGURED", "Adding funds isn't set up correctly yet.");
  }
  // A staging key against the production host (or the reverse) fails at
  // Crossmint; refuse locally instead of sending a key to the wrong host.
  const keyEnv = environment === "production" ? "production" : "staging";
  if (!serverApiKey.startsWith(`sk_${keyEnv}_`) || !clientApiKey.startsWith(`ck_${keyEnv}_`)) {
    return unavailable("MISCONFIGURED", "Adding funds isn't set up correctly yet.");
  }
  if (!appConfig.social) {
    return unavailable("NO_ACCOUNTS", "Adding funds needs your account, which this server can't reach right now.");
  }

  const staging = environment === "staging";
  const ceiling = staging ? STAGING_USDC_CAP_CENTS : PROOF_THRESHOLD_CENTS - 100;
  const configuredMax = usdToCents(block?.maxOrderUsd ?? env.CROSSMINT_MAX_ORDER_USD);
  const configuredMin = usdToCents(block?.minOrderUsd ?? env.CROSSMINT_MIN_ORDER_USD);
  const maxOrderCents = Math.min(configuredMax ?? (staging ? STAGING_USDC_CAP_CENTS : 50_000), ceiling);
  const minOrderCents = Math.min(
    Math.max(configuredMin ?? (staging ? 100 : 500), CARD_MINIMUM_CENTS),
    maxOrderCents,
  );
  const presetPool = staging ? [100, 500, 1_000] : [1_000, 2_500, 5_000, 10_000];
  const presets = presetPool.filter((c) => c >= minOrderCents && c <= maxOrderCents);

  const host = HOSTS[environment];
  return {
    available: true,
    reason: null,
    config: {
      environment,
      apiBase: `${host}/api`,
      checkoutBase: host,
      serverApiKey,
      clientApiKey,
      tokenLocator: CROSSMINT_USDC_SOLANA[environment],
      chain: "solana",
      deliveryNetwork: staging ? "solana-devnet" : "solana-mainnet",
      minOrderCents,
      maxOrderCents,
      presetsCents: presets.length ? presets : [minOrderCents, maxOrderCents].filter((c, i, a) => a.indexOf(c) === i),
    },
  };
}
