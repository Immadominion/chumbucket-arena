/**
 * Staged rollout for the money workstreams' switches: a feature is on for
 * everyone, on only for the TRUST_ADMIN_USER_IDS accounts (to QA real money
 * in production before the public sees it), or off.
 *
 *   MONEY_CALLS_ENABLED, CHUMBUCKET_WALLET_ENABLED,
 *   ACCOUNT_LINKING_ENABLED, ACCOUNT_FOLD_ENABLED
 *     "true"    on for every account
 *     "admins"  on only for the accounts in TRUST_ADMIN_USER_IDS
 *     anything else (unset, "1", "TRUE", a typo)  off
 *
 * With "admins", every decision is per account: the account is the one the
 * one resolver (src/auth/accountResolver.ts) gives for the session, and an
 * account that is not an admin — or a session with no account — gets exactly
 * the flag-off behaviour, in what it is told and in what it may do. Server
 * machinery that keeps admins' data honest for everyone else (which calls are
 * private, the sweeper, the fill hook) runs whenever the switch is not off.
 */
import type { AppConfig } from "./config.ts";

export type Rollout = "on" | "admins" | "off";

/** Exact lowercase words only. Unknown values are off. */
export function parseRollout(value: string | undefined): Rollout {
  return value === "true" ? "on" : value === "admins" ? "admins" : "off";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** TRUST_ADMIN_USER_IDS: canonical public.users ids, lowercased. A typo never becomes a wildcard. */
export function parseAdminIds(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s));
}

/** The rollout admins this app was configured with. */
export function rolloutAdmins(config: AppConfig | undefined): ReadonlySet<string> {
  return new Set(config?.rolloutAdmins ?? []);
}

/** Whether a switch in this rollout is on for this account (null: no account). */
export function rolloutAllows(config: AppConfig | undefined, rollout: Rollout, userId: string | null | undefined): boolean {
  if (rollout === "on") return true;
  if (rollout === "off" || !userId) return false;
  return rolloutAdmins(config).has(userId.toLowerCase());
}

/** On for someone: the server-side machinery must run. */
export const rolloutActive = (rollout: Rollout): boolean => rollout !== "off";

export function moneyCallsRollout(config: AppConfig | undefined): Rollout {
  return config?.money?.callsRollout ?? (config?.money?.callsEnabled === true ? "on" : "off");
}

export function chumbucketWalletRollout(config: AppConfig | undefined): Rollout {
  return config?.chumbucketWallet?.rollout ?? (config?.chumbucketWallet?.enabled === true ? "on" : "off");
}

export function accountLinkingRollout(config: AppConfig | undefined): Rollout {
  return config?.authIdentity?.accountLinkingRollout ?? (config?.authIdentity?.accountLinkingEnabled === true ? "on" : "off");
}

export function accountFoldRollout(config: AppConfig | undefined): Rollout {
  return config?.authIdentity?.accountFoldRollout ?? (config?.authIdentity?.accountFoldEnabled === true ? "on" : "off");
}
