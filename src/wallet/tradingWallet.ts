/**
 * The Chumbucket wallet, server side: one balance that follows the account.
 *
 * Whichever provider ends up holding it (the owner is choosing), the server
 * treats it like every other wallet: linked to the account by a signature
 * over a server-issued SIWS challenge, recorded with the label 'chumbucket'.
 * The label only lets the server pick the account's trading wallet; it never
 * authorises anything.
 */

import type { AppConfig } from "../config.ts";
import type { DepositPerson, DepositWallet } from "../deposits/accounts.ts";
import { chumbucketWalletRollout, rolloutActive, rolloutAllows } from "../rollout.ts";

/** `linked_wallets.wallet_type` of the Chumbucket wallet. */
export const CHUMBUCKET_WALLET_TYPE = "chumbucket";

/**
 * CHUMBUCKET_WALLET_ENABLED is "true" or "admins" (src/rollout.ts): on for
 * someone. Off for any other value. Whether a person gets it is
 * `chumbucketWalletFor`.
 */
export function chumbucketWalletEnabled(config: AppConfig): boolean {
  return rolloutActive(chumbucketWalletRollout(config));
}

/** Whether this account gets the Chumbucket wallet. Null: no account (flag-off answer under "admins"). */
export function chumbucketWalletFor(config: AppConfig, userId: string | null | undefined): boolean {
  return rolloutAllows(config, chumbucketWalletRollout(config), userId);
}

/**
 * The account's trading wallet, from its proven wallets only: the Chumbucket
 * wallet when it is on and linked, else the wallet this session signed in
 * with, else the primary link, else any link. Null with no wallet at all.
 */
export function chooseTradingWallet(person: DepositPerson, chumbucketWallet: boolean): DepositWallet | null {
  const own = chumbucketWallet ? person.wallets.find((w) => w.walletType === CHUMBUCKET_WALLET_TYPE) : undefined;
  return own ?? person.wallets.find((w) => w.session) ?? person.wallets.find((w) => w.primary) ?? person.wallets[0] ?? null;
}
