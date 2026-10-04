/**
 * Deleting an account must never strand money in its Chumbucket wallet.
 *
 * The Chumbucket wallet is reached only through the account (its Privy user
 * is keyed by the account id), so once the account is gone nobody can sign
 * for it. Deletion therefore waits until that wallet is empty: no USDC or
 * SOL above dust, no open Panta position, no winnings left to claim. Anything
 * the guard cannot read counts as "not empty": it fails closed.
 *
 * Other wallets are not the account's to strand: a wallet app's or an
 * on-phone wallet's key stays with the person after deletion.
 */

import type { WalletBalanceReader } from "../deposits/balance.ts";
import type { LinkedWalletReader } from "../deposits/accounts.ts";
import type { PantaPositionStatus, PantaPositionsPage } from "../prediction/PantaPositions.ts";
import { CHUMBUCKET_WALLET_TYPE } from "./tradingWallet.ts";

/** Under a cent of USDC, or 0.001 SOL, costs more to move than it is worth. */
export const USDC_DUST_BASE_UNITS = 10_000n;
export const SOL_DUST_LAMPORTS = 1_000_000n;

/** Positions that still hold, or will pay, money. */
const LIVE: ReadonlySet<PantaPositionStatus> = new Set(["pending", "open", "awaiting_result", "won_claimable", "claiming"]);

export type FundsVerdict = "clear" | "funds" | "unknown";

export interface FundsGuard {
  verdict(userId: string): Promise<FundsVerdict>;
}

export interface ChumbucketFundsGuardDeps {
  links: LinkedWalletReader;
  balances: WalletBalanceReader | null;
  /** The person's Panta positions, or null when this server cannot read them. */
  positions: () => { positions(userId: string): Promise<PantaPositionsPage> } | null;
}

export class ChumbucketFundsGuard implements FundsGuard {
  constructor(private readonly deps: ChumbucketFundsGuardDeps) {}

  async verdict(userId: string): Promise<FundsVerdict> {
    let wallets: string[];
    try {
      wallets = (await this.deps.links.activeVerified(userId))
        .filter((w) => w.walletType === CHUMBUCKET_WALLET_TYPE)
        .map((w) => w.address);
    } catch {
      return "unknown";
    }
    if (wallets.length === 0) return "clear";
    if (!this.deps.balances) return "unknown";
    for (const wallet of wallets) {
      let usdc: bigint;
      let lamports: bigint;
      try {
        const balance = await this.deps.balances.read(wallet);
        usdc = BigInt(balance.usdcBaseUnits);
        lamports = BigInt(balance.lamports);
      } catch {
        return "unknown";
      }
      if (usdc >= USDC_DUST_BASE_UNITS || lamports >= SOL_DUST_LAMPORTS) return "funds";
    }
    const reader = this.deps.positions();
    if (!reader) return "unknown";
    let page: PantaPositionsPage;
    try {
      page = await reader.positions(userId);
    } catch {
      return "unknown";
    }
    for (const p of page.positions) {
      if (!wallets.includes(p.owner)) continue;
      if (LIVE.has(p.status)) return "funds";
      // "won" with Panta's holdings unread may still be claimable.
      if (p.status === "won" && page.holdings !== "live") return "unknown";
    }
    return "clear";
  }
}
