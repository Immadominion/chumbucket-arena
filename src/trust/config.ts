/**
 * Trust & safety configuration, read from the environment beside AppConfig.
 *
 * Same pattern as `resolveWalletProfileCarry`: `src/config.ts` is
 * integration-owned, so this module reads its own few variables and never
 * requires an edit there. Nothing here is a secret.
 *
 *   TRUST_ADMIN_USER_IDS   comma-separated canonical public.users.id values
 *                          allowed to read reports and hide calls. Empty means
 *                          no admin at all, which is the safe default.
 *   LEGAL_TERMS_VERSION    the Terms/Privacy version a funded-trading
 *                          attestation is recorded against. Bumping it asks
 *                          everyone to attest again before their next trade.
 *   LEGAL_SITE_URL         where the Terms, Privacy and deletion pages live.
 *   PANTA_TERMS_URL        the venue terms the attestation passes through.
 */

import type { AppConfig } from "../config.ts";

export type RateLimitedAction =
  | "calls.create"
  | "calls.respond"
  | "people.follow"
  | "people.find"
  | "trust.report"
  | "trust.relation"
  | "account.export"
  | "deletion.request"
  | "deletion.global";

export interface WindowLimit {
  limit: number;
  windowMs: number;
}

export type RateLimits = Record<RateLimitedAction, readonly WindowLimit[]>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Per-person write limits. Generous for a real person, tight for a script.
 * The web deletion form has no session to key on, so it is limited per
 * contact (`deletion.request`) and across everyone (`deletion.global`).
 */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  "calls.create": [
    { limit: 6, windowMs: MINUTE },
    { limit: 40, windowMs: HOUR },
    { limit: 150, windowMs: DAY },
  ],
  "calls.respond": [
    { limit: 15, windowMs: MINUTE },
    { limit: 120, windowMs: HOUR },
    { limit: 500, windowMs: DAY },
  ],
  "people.follow": [
    { limit: 20, windowMs: MINUTE },
    { limit: 200, windowMs: HOUR },
    { limit: 1000, windowMs: DAY },
  ],
  // Looking someone up to add as a friend. A person types a name and taps
  // Find; a script walking the directory by X handle or wallet does not get far.
  "people.find": [
    { limit: 20, windowMs: MINUTE },
    { limit: 150, windowMs: HOUR },
    { limit: 500, windowMs: DAY },
  ],
  "trust.report": [
    { limit: 5, windowMs: MINUTE },
    { limit: 30, windowMs: HOUR },
    { limit: 100, windowMs: DAY },
  ],
  "trust.relation": [
    { limit: 20, windowMs: MINUTE },
    { limit: 200, windowMs: HOUR },
  ],
  "account.export": [{ limit: 5, windowMs: HOUR }],
  "deletion.request": [{ limit: 3, windowMs: HOUR }],
  "deletion.global": [{ limit: 60, windowMs: HOUR }],
};

/** The Terms/Privacy version the drafts in web/app/terms and web/app/privacy carry. */
export const DEFAULT_TERMS_VERSION = "2026-10-02-draft";
export const DEFAULT_LEGAL_SITE_URL = "https://chumbucket.fun";
/** Panta's own site. Its end-user terms URL is an owner action to confirm. */
export const DEFAULT_PANTA_TERMS_URL = "https://panta.market";

export interface TrustConfig {
  adminUserIds: ReadonlySet<string>;
  termsVersion: string;
  legalSiteUrl: string;
  pantaTermsUrl: string;
  rateLimits: RateLimits;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpsUrl(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  if (!v) return fallback;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? v.replace(/\/+$/, "") : fallback;
  } catch {
    return fallback;
  }
}

export function resolveTrustConfig(
  _config: AppConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): TrustConfig {
  const admins = (env.TRUST_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    // Only well-formed canonical ids. A typo must not become a wildcard.
    .filter((s) => UUID.test(s));
  const version = env.LEGAL_TERMS_VERSION?.trim();
  return {
    adminUserIds: new Set(admins),
    termsVersion: version && /^[A-Za-z0-9._-]{1,64}$/.test(version) ? version : DEFAULT_TERMS_VERSION,
    legalSiteUrl: httpsUrl(env.LEGAL_SITE_URL, DEFAULT_LEGAL_SITE_URL),
    pantaTermsUrl: httpsUrl(env.PANTA_TERMS_URL, DEFAULT_PANTA_TERMS_URL),
    rateLimits: DEFAULT_RATE_LIMITS,
  };
}
