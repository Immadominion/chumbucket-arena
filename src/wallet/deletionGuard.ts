/**
 * Deleting an account must never strand money in its Chumbucket wallet.
 *
 * The Chumbucket wallet is reached only through the account (its Privy user
 * is keyed by the account id), so once the account is gone nobody can sign
 * for it. Deletion therefore waits until that wallet is empty: no USDC or
 * SOL above dust, no open Panta position, no winnings left to claim. Anything
 * the guard cannot read counts as "not empty": it fails closed.
 *
 * Every Chumbucket wallet the account ever linked counts, revoked or not:
 * unlinking does not give anyone else its key. Every order counts too, not
 * the newest page of them.
 *
 * Other wallets are not the account's to strand: a wallet app's or an
 * on-phone wallet's key stays with the person after deletion.
 */

import type { WalletBalanceReader } from "../deposits/balance.ts";
import type { PantaPositionStatus, PantaPositionsPage } from "../prediction/PantaPositions.ts";
import type { AppConfig } from "../config.ts";
import { depositsRuntimeFor } from "../deposits/runtime.ts";
import { pantaLifecycleFor } from "../prediction/PantaTradingRuntime.ts";
import type { AccountDeletionGuard } from "../trust/deletionGuards.ts";
import { TrustError } from "../trust/errors.ts";
import { CHUMBUCKET_WALLET_TYPE } from "./tradingWallet.ts";

/** Short on purpose: the app leads with a wallet icon. */
export const CASH_OUT_FIRST = "Cash out first";
export const FUNDS_UNREADABLE = "We couldn't check your wallet. Try again in a moment.";

/** Under a cent of USDC, or 0.001 SOL, costs more to move than it is worth. */
export const USDC_DUST_BASE_UNITS = 10_000n;
export const SOL_DUST_LAMPORTS = 1_000_000n;

/** Positions that still hold, or will pay, money. */
const LIVE: ReadonlySet<PantaPositionStatus> = new Set(["pending", "open", "awaiting_result", "won_claimable", "claiming"]);

export type FundsVerdict = "clear" | "funds" | "unknown";

export interface FundsGuard {
  verdict(userId: string): Promise<FundsVerdict>;
}

/** Every Chumbucket wallet an account has linked, active or revoked. */
export interface ChumbucketLinks {
  chumbucketWallets(userId: string): Promise<string[]>;
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID = /^[0-9a-f-]{36}$/i;

/** PostgREST with the service role; no revoked/verified filter on purpose. */
export class SupabaseChumbucketLinks implements ChumbucketLinks {
  constructor(
    private readonly cfg: { supabaseUrl: string; serviceRoleKey: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chumbucketWallets(userId: string): Promise<string[]> {
    if (!UUID.test(userId)) throw new Error("not an account id");
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      wallet_type: `eq.${CHUMBUCKET_WALLET_TYPE}`,
      select: "wallet_address",
      limit: "100",
    });
    const res = await this.fetchImpl(`${this.cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/linked_wallets?${params}`, {
      headers: { apikey: this.cfg.serviceRoleKey, Authorization: `Bearer ${this.cfg.serviceRoleKey}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("linked_wallets read failed");
    const rows = (await res.json()) as Array<{ wallet_address?: unknown }>;
    if (!Array.isArray(rows) || rows.length >= 100) throw new Error("linked_wallets read failed");
    return rows.map((r) => r.wallet_address).filter((a): a is string => typeof a === "string" && SOLANA_ADDRESS.test(a));
  }
}

export interface ChumbucketFundsGuardDeps {
  links: ChumbucketLinks;
  balances: WalletBalanceReader | null;
  /** Every one of the person's Panta positions, or null when this server cannot read them. */
  positions: () => { positions(userId: string, opts: { all: true }): Promise<PantaPositionsPage> } | null;
}

export class ChumbucketFundsGuard implements FundsGuard {
  constructor(private readonly deps: ChumbucketFundsGuardDeps) {}

  async verdict(userId: string): Promise<FundsVerdict> {
    let wallets: string[];
    try {
      wallets = await this.deps.links.chumbucketWallets(userId);
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
      page = await reader.positions(userId, { all: true });
    } catch {
      return "unknown";
    }
    for (const p of page.positions) {
      if (!wallets.includes(p.owner)) continue;
      if (LIVE.has(p.status)) return "funds";
      // "won" with Panta's holdings unread may still be claimable.
      if (p.status === "won" && page.holdings !== "live") return "unknown";
      // A void market owes the stake back until it is claimed, or Panta
      // shows nothing left in the wallet for it.
      if (p.status === "void" && p.claim?.state !== "CONFIRMED") {
        if (page.holdings !== "live") return "unknown";
        if (p.walletShares !== null && Number(p.walletShares) !== 0) return "funds";
      }
    }
    return "clear";
  }
}

/**
 * The deletion guard over a funds check: "Cash out first" while the wallet
 * holds money, and a refusal for anything but a clear answer (fail closed).
 */
export function cashOutFirstGuard(funds: FundsGuard): AccountDeletionGuard {
  return async ({ userId }) => {
    let verdict: FundsVerdict;
    try {
      verdict = await funds.verdict(userId);
    } catch {
      verdict = "unknown";
    }
    if (verdict === "funds") throw new TrustError("TRUST_FUNDS_REMAIN", CASH_OUT_FIRST);
    if (verdict !== "clear") throw new TrustError("TRUST_FUNDS_REMAIN", FUNDS_UNREADABLE);
  };
}

/**
 * Registered in src/trust/deletionGuards.ts: every Chumbucket wallet the
 * account has linked (active or revoked), read through this app's Supabase,
 * RPC and Panta positions. Without Supabase there are no linked wallets to
 * strand (and no deletion either: the auth admin is unconfigured).
 */
export function cashOutFirst(config: AppConfig): AccountDeletionGuard {
  const social = config.social;
  if (!social) return async () => {};
  return cashOutFirstGuard(
    new ChumbucketFundsGuard({
      links: new SupabaseChumbucketLinks(social),
      balances: depositsRuntimeFor(config).balances,
      positions: () => {
        try {
          return pantaLifecycleFor(config, true).positions;
        } catch {
          return null;
        }
      },
    }),
  );
}
