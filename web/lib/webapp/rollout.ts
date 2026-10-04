/**
 * Who sees a new feature is the server's answer for THIS account, never a
 * build flag alone: calls with money (`money.status`), the Chumbucket wallet
 * (`wallet.status`) and sign-in linking (`auth.signInMethods`) can be on for
 * admin accounts only. A build flag (or the Privy app id) only says the
 * capability ships in this bundle. No answer yet, an error, or anything but
 * an explicit `true` reads as off: everyone else sees today's app.
 *
 * Pure: the BFF repo's bun tests import it.
 */

/** Calls with money, from `money.status`. */
export const moneyOn = (status: { enabled?: unknown } | null | undefined): boolean => status?.enabled === true;

/** The Chumbucket wallet: shipped in this bundle AND on for this account (`wallet.status`). */
export const chumbucketWalletOn = (shipped: boolean, status: { enabled?: unknown } | null | undefined): boolean =>
  shipped && status?.enabled === true;

/** Settings → Sign-in methods (link, unlink, move), from `auth.signInMethods`. */
export const linkingOn = (methods: { linking?: unknown } | null | undefined): boolean => methods?.linking === true;
