/**
 * Packet D configuration.
 *
 * Read through `ctx.app.config` (contracts §6) — the seam new modules are meant
 * to use. `AppConfig` is integration-owned, so this packet cannot add a `calls`
 * block to `src/config.ts`; the exact patch is filed at
 * docs/contracts/integration-requests/packet-d.md. Until it lands, the resolver
 * falls back to the environment and then to contract defaults, which keeps the
 * packet buildable and testable without editing a file it does not own. Once
 * the patch lands, `ctx.app.config.calls` simply wins and nothing here changes.
 *
 * Nothing in this file is a secret, and nothing it produces may become one:
 * `describeCallsConfig` is the only shape a route may put in a response body.
 */

import type { AppConfig } from "../config.ts";

export interface CallsConfigInput {
  /** §7 `call_receipt_experience`. On by default: it IS the free social loop. */
  callReceiptExperience?: boolean;
  /** Host used to build a shareable call/person link. Never a secret. */
  shareBaseUrl?: string;
  /** Bound on a feed page. */
  maxPageSize?: number;
  /** Bound on one resolution-sync pass. */
  syncPageSize?: number;
  syncMaxPagesPerPass?: number;
}

/** The structural extension of AppConfig this packet reads. Additive, optional. */
export interface CallsAppConfig {
  calls?: CallsConfigInput;
}

export interface CallsConfig {
  flags: { callReceiptExperience: boolean };
  shareBaseUrl: string;
  maxPageSize: number;
  syncPageSize: number;
  syncMaxPagesPerPass: number;
}

/**
 * The owner's live site. chumbucket.fun serves the /c, /u and /m landing pages
 * (real data from this BFF, OG receipt images, open-in-app/install fallback)
 * and /.well-known/assetlinks.json for Android App Links. The old default,
 * chumbucket.app, never resolved (NXDOMAIN): every link built on it was dead,
 * and whoever registered it would have received them all.
 */
export const DEFAULT_SHARE_BASE_URL = "https://chumbucket.fun";

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v === "on";
};

export function resolveCallsConfig(
  appConfig: AppConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): CallsConfig {
  const fromApp = (appConfig as (AppConfig & CallsAppConfig) | undefined)?.calls;

  return {
    flags: {
      // §7: `call_receipt_experience` defaults ON. Turning it off must leave
      // the rest of the product working, so nothing else reads this flag.
      callReceiptExperience:
        fromApp?.callReceiptExperience ?? bool(env.CALL_RECEIPT_EXPERIENCE, true),
    },
    shareBaseUrl: (fromApp?.shareBaseUrl ?? env.CALLS_SHARE_BASE_URL ?? DEFAULT_SHARE_BASE_URL).replace(/\/$/, ""),
    maxPageSize: clamp(fromApp?.maxPageSize ?? num(env.CALLS_MAX_PAGE_SIZE, 50), 1, 100),
    syncPageSize: clamp(fromApp?.syncPageSize ?? num(env.CALLS_SYNC_PAGE_SIZE, 100), 1, 1000),
    syncMaxPagesPerPass: clamp(fromApp?.syncMaxPagesPerPass ?? num(env.CALLS_SYNC_MAX_PAGES, 50), 1, 1000),
  };
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.trunc(n)));

/** The ONLY shape of this config that may appear in a response body or a log. */
export function describeCallsConfig(cfg: CallsConfig): {
  callReceiptExperience: boolean;
  shareBaseUrl: string;
  maxPageSize: number;
} {
  return {
    callReceiptExperience: cfg.flags.callReceiptExperience,
    shareBaseUrl: cfg.shareBaseUrl,
    maxPageSize: cfg.maxPageSize,
  };
}

/** Attach a calls block to an AppConfig without editing src/config.ts. */
export function withCallsConfig(base: AppConfig, calls: CallsConfigInput): AppConfig {
  return Object.assign({}, base, { calls }) as AppConfig;
}

export const shareLinkForCall = (cfg: CallsConfig, callId: string): string => `${cfg.shareBaseUrl}/c/${callId}`;
export const shareLinkForPerson = (cfg: CallsConfig, handleOrId: string): string =>
  `${cfg.shareBaseUrl}/u/${handleOrId.replace(/^@/, "")}`;
export const shareLinkForMarket = (cfg: CallsConfig, marketId: string): string => `${cfg.shareBaseUrl}/m/${marketId}`;
