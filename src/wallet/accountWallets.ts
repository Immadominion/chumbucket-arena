/**
 * The account's own wallets, server side: whether a wallet may sign for the
 * account at all.
 *
 * A wallet belongs to an account only through `linked_wallets`: an active row
 * proven by a signature over a server-issued SIWS challenge
 * (`auth.requestWalletNonce` -> `auth.linkWallet`). The row's `wallet_type`
 * is a label, never an authorisation input; the proof is. A revoked row is a
 * decision the person made, and outranks everything else.
 *
 * One account per wallet (20261004120000_account_sign_ins.sql): a wallet
 * that signs in to ANOTHER account — its own Web3 sign-in, or a proven link
 * there — is that account's, whatever row this one holds (a legacy link from
 * before linking refused it). It is linked here only by moving it, with proof
 * of both accounts; until then it signs for neither here.
 */

/**
 * Where a wallet stands with an account:
 *   active   an active, SIWS-proven link of this account
 *   revoked  this account's link, revoked or never proven: it may not sign
 *   other    another account's wallet
 *   none     no link at all
 */
export type AccountWalletStatus = "active" | "revoked" | "other" | "none";

/** Whether a wallet is one of the account's own, proven wallets. */
export interface AccountWallets {
  /** Throws when the links cannot be read; a caller must refuse, never assume. */
  status(userId: string, wallet: string): Promise<AccountWalletStatus>;
}

/**
 * Linking's answer (`wallet_sign_in_conflict_v1`): whether this wallet signs
 * in to an account other than `userId`. Before that migration, never.
 */
export interface WalletSignInConflicts {
  walletSignInConflict(userId: string, walletAddress: string): Promise<boolean>;
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * One exact PostgREST read with the service role: the `linked_wallets` row
 * for this address (an address has at most one row), judged for this person;
 * then, for an active link and with linking's store, that the wallet signs in
 * to no other account. Fixed labels only in failures.
 */
export class SupabaseAccountWallets implements AccountWallets {
  constructor(
    private readonly cfg: { supabaseUrl: string; serviceRoleKey: string },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly signIns?: WalletSignInConflicts,
  ) {}

  async status(userId: string, wallet: string): Promise<AccountWalletStatus> {
    if (!UUID.test(userId) || !SOLANA_ADDRESS.test(wallet)) return "none";
    const params = new URLSearchParams({
      wallet_address: `eq.${wallet}`,
      select: "user_id,wallet_address,revoked_at,verified_at",
      limit: "1",
    });
    const res = await this.fetchImpl(`${this.cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/linked_wallets?${params}`, {
      headers: { apikey: this.cfg.serviceRoleKey, Authorization: `Bearer ${this.cfg.serviceRoleKey}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("linked_wallets read failed");
    const rows = (await res.json()) as Array<{ user_id?: unknown; wallet_address?: unknown; revoked_at?: unknown; verified_at?: unknown }>;
    if (!Array.isArray(rows)) throw new Error("linked_wallets read failed");
    const row = rows.find((r) => r.wallet_address === wallet);
    if (!row) return "none";
    if (row.user_id !== userId) return "other";
    if (!(row.revoked_at === null && typeof row.verified_at === "string")) return "revoked";
    // A failed read throws (the caller refuses); it is never "no conflict".
    return this.signIns && (await this.signIns.walletSignInConflict(userId, wallet)) ? "other" : "active";
  }
}
