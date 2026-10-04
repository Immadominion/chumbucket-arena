/**
 * `wallet.*` — the Chumbucket wallet: one balance that follows the account.
 *
 *   wallet.status   whether this server runs the Chumbucket wallet and, signed
 *                   in, which of the account's proven wallets trades
 *   wallet.balance  that wallet's real mainnet USDC and SOL (read-only RPC,
 *                   genesis-pinned like deposits.balance)
 *
 * POST mutations, like deposits.*: the Supabase session rides in the
 * Authorization header and nothing private lands in a URL. No input names a
 * wallet: the server picks the trading wallet from the account's own links.
 * Behind CHUMBUCKET_WALLET_ENABLED (default off).
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import type { DepositPerson } from "../deposits/accounts.ts";
import { DepositError, isDepositError, type DepositErrorCode } from "../deposits/errors.ts";
import { depositsRuntimeFor, type DepositsRuntime } from "../deposits/runtime.ts";
import { readDepositBalance } from "../deposits/service.ts";
import { CHUMBUCKET_WALLET_TYPE, chooseTradingWallet, chumbucketWalletEnabled } from "../wallet/tradingWallet.ts";
import type { Context } from "./trpc.ts";
import { publicProcedure, router } from "./trpc.ts";

const CODES: Partial<Record<DepositErrorCode, TRPC_ERROR_CODE_KEY>> = {
  UNAVAILABLE: "PRECONDITION_FAILED",
  SIGNED_OUT: "UNAUTHORIZED",
  NOT_LINKED: "FORBIDDEN",
  NO_WALLET: "PRECONDITION_FAILED",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  BALANCE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
};

async function person(ctx: Context, rt: DepositsRuntime): Promise<DepositPerson> {
  const resolved = await rt.accounts.resolve(ctx.supabaseAccessToken);
  if (resolved.ok) return resolved.person;
  throw resolved.reason === "SIGNED_OUT"
    ? new DepositError("SIGNED_OUT", "Sign in to see your balance.")
    : resolved.reason === "NOT_LINKED"
      ? new DepositError("NOT_LINKED", "Finish setting up your account first.")
      : new DepositError("UNAVAILABLE", "We couldn't confirm your account just now. Try again in a moment.");
}

/** Our copy only. Anything unexpected is a generic, causeless failure. */
async function run<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isDepositError(error)) throw new TRPCError({ code: CODES[error.code] ?? "BAD_REQUEST", message: error.message });
    throw new TRPCError({ code: "BAD_GATEWAY", message: "We couldn't read your wallet just now. Try again in a moment." });
  }
}

export const walletRouter = router({
  status: publicProcedure.input(z.object({}).strict().optional()).mutation(async ({ ctx }) => {
    if (!chumbucketWalletEnabled(ctx.app.config)) return { enabled: false as const, account: null };
    const rt = depositsRuntimeFor(ctx.app.config);
    const resolved = await rt.accounts.resolve(ctx.supabaseAccessToken).catch(() => ({ ok: false }) as const);
    if (!resolved.ok) return { enabled: true as const, account: null };
    const trading = chooseTradingWallet(resolved.person, true);
    const own = resolved.person.wallets.find((w) => w.walletType === CHUMBUCKET_WALLET_TYPE);
    return {
      enabled: true as const,
      account: {
        tradingWallet: trading ? { address: trading.address, walletType: trading.walletType } : null,
        chumbucketWallet: own?.address ?? null,
      },
    };
  }),

  balance: publicProcedure.input(z.object({}).strict().optional()).mutation(({ ctx }) =>
    run(async () => {
      if (!chumbucketWalletEnabled(ctx.app.config)) {
        throw new DepositError("UNAVAILABLE", "Your Chumbucket wallet isn't available yet.");
      }
      const rt = depositsRuntimeFor(ctx.app.config);
      const who = await person(ctx, rt);
      const trading = chooseTradingWallet(who, true);
      if (!trading) throw new DepositError("NO_WALLET", "Set up your wallet first.");
      if (!rt.balances) throw new DepositError("BALANCE_UNAVAILABLE", "Balances aren't available on this server.");
      const balance = await readDepositBalance({ reader: rt.balances, limiter: rt.limiter }, who, trading.address);
      return {
        wallet: balance.wallet,
        walletType: trading.walletType,
        network: balance.network,
        lamports: balance.lamports,
        usdcBaseUnits: balance.usdcBaseUnits,
        slot: balance.slot,
      };
    }),
  ),
});
