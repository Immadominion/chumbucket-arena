/**
 * The one way a Supabase session becomes a Chumbucket account.
 *
 * Every BFF path that needs "who is this" resolves here — whoami and
 * onboarding, the calls viewer (and with it account.*, people.*, trust.*),
 * Panta trading, deposits, market creation, deletion — so there is exactly
 * one answer for a session, and one place that answer is decided:
 *
 *   1. the account whose primary sign-in this is;
 *   2. with ACCOUNT_LINKING_ENABLED, the account this is an additional
 *      sign-in of (a linked wallet's, or a folded account's);
 *   3. with ACCOUNT_LINKING_ENABLED, for a wallet sign-in with no account:
 *      the account that wallet was linked to with a SIWS proof;
 *   4. with WALLET_PROFILE_CARRY_ENABLED, the legacy profile at that wallet.
 *
 * Nothing else may map a session to an account. The wallet workstream mints
 * Privy JWTs from `resolveAccount` (sub = the account id), so a linked wallet
 * can never become a second account anywhere.
 */

import type { AppConfig } from "../config.ts";
import { AuthIdentityError } from "./AuthIdentityError.ts";
import { authIdentityRuntimeFor } from "./AuthIdentityRuntime.ts";
import type { SupabaseSession } from "./SupabaseJwt.ts";
import { WalletLinkService } from "./WalletLinkService.ts";
import { chumbucketWalletEnabled } from "../wallet/tradingWallet.ts";

export interface ResolvedAccount {
  /** The session's own auth.uid(). */
  authUserId: string;
  /** The canonical public.users.id. */
  userId: string;
  session: SupabaseSession;
}

export type AccountResolution =
  | { ok: true; account: ResolvedAccount }
  | { ok: false; reason: "SIGNED_OUT" | "NOT_LINKED" | "UNAVAILABLE" };

/** The identity service for this app's config (the routes' own constructor). */
export function accountService(config: AppConfig): WalletLinkService {
  const rt = authIdentityRuntimeFor(config);
  return new WalletLinkService({
    store: rt.store,
    verifier: rt.verifier,
    policy: rt.policy,
    walletProfileCarry: rt.walletProfileCarry === true,
    ...(rt.accountLinks ? { accountLinks: rt.accountLinks } : {}),
    accountLinking: rt.accountLinking === true,
    chumbucketWallet: chumbucketWalletEnabled(config),
  });
}

/** Resolve or throw the identity code (AUTH_TOKEN_*, AUTH_USER_UNLINKED, …). */
export async function resolveAccount(config: AppConfig, accessToken: string): Promise<ResolvedAccount> {
  return accountService(config).authenticateSession(accessToken);
}

/** Resolve, as an answer every caller can map to its own words. Never throws. */
export async function resolveAccountOutcome(
  config: AppConfig,
  accessToken: string | null | undefined,
): Promise<AccountResolution> {
  if (!accessToken || !accessToken.trim()) return { ok: false, reason: "SIGNED_OUT" };
  try {
    return { ok: true, account: await resolveAccount(config, accessToken) };
  } catch (e) {
    if (e instanceof AuthIdentityError) {
      if (e.code === "AUTH_TOKEN_MISSING" || e.code === "AUTH_TOKEN_INVALID") return { ok: false, reason: "SIGNED_OUT" };
      if (e.code === "AUTH_USER_UNLINKED") return { ok: false, reason: "NOT_LINKED" };
    }
    return { ok: false, reason: "UNAVAILABLE" };
  }
}
