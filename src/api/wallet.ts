/**
 * `wallet.*` — the Chumbucket wallet: one balance that follows the account.
 *
 *   wallet.status   whether this server runs the Chumbucket wallet and, signed
 *                   in, which of the account's proven wallets trades
 *   wallet.balance  that wallet's real mainnet USDC and SOL (read-only RPC,
 *                   genesis-pinned like deposits.balance)
 *   wallet.privyToken  a ten-minute JWT whose `sub` is the ACCOUNT, which the
 *                   apps hand Privy (src/wallet/privyJwt.ts). Every sign-in of
 *                   one account gets the same `sub`, so the same wallet: the
 *                   account comes from src/auth/accountResolver.ts, uncached.
 *
 * Each is rate limited per account.
 *
 * POST mutations, like deposits.*: the Supabase session rides in the
 * Authorization header and nothing private lands in a URL. No input names a
 * wallet: the server picks the trading wallet from the account's own links.
 * Behind CHUMBUCKET_WALLET_ENABLED (default off).
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import { resolveAccountOutcome } from "../auth/accountResolver.ts";
import type { DepositPerson } from "../deposits/accounts.ts";
import { DepositError, isDepositError, type DepositErrorCode } from "../deposits/errors.ts";
import { depositsRuntimeFor, type DepositsRuntime } from "../deposits/runtime.ts";
import { readDepositBalance } from "../deposits/service.ts";
import { privyJwtSignerFor } from "../wallet/privyJwt.ts";
import { CHUMBUCKET_WALLET_TYPE, chooseTradingWallet, chumbucketWalletEnabled, chumbucketWalletFor } from "../wallet/tradingWallet.ts";
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

function unresolved(reason: "SIGNED_OUT" | "NOT_LINKED" | "UNAVAILABLE"): DepositError {
  return reason === "SIGNED_OUT"
    ? new DepositError("SIGNED_OUT", "Sign in to see your balance.")
    : reason === "NOT_LINKED"
      ? new DepositError("NOT_LINKED", "Finish setting up your account first.")
      : new DepositError("UNAVAILABLE", "We couldn't confirm your account just now. Try again in a moment.");
}

async function person(ctx: Context, rt: DepositsRuntime): Promise<DepositPerson> {
  const resolved = await rt.accounts.resolve(ctx.supabaseAccessToken);
  if (resolved.ok) return resolved.person;
  throw unresolved(resolved.reason);
}

/**
 * The account id the Privy token names, from the one account resolver
 * (src/auth/accountResolver.ts), never a cached answer: the token opens the
 * account's wallet, so a sign-in unlinked or folded a moment ago gets none.
 */
async function account(ctx: Context): Promise<string> {
  const resolved = await resolveAccountOutcome(ctx.app.config, ctx.supabaseAccessToken);
  if (resolved.ok) return resolved.account.userId;
  throw unresolved(resolved.reason);
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

const OFF_COPY = "Your Chumbucket wallet isn't available yet.";

/**
 * CHUMBUCKET_WALLET_ENABLED per account (src/rollout.ts). "admins": an account
 * that is not an admin, or a session with no account, gets exactly the
 * flag-off answer.
 */
async function walletPerson(ctx: Context, rt: DepositsRuntime): Promise<DepositPerson> {
  const config = ctx.app.config;
  if (!chumbucketWalletEnabled(config)) throw new DepositError("UNAVAILABLE", OFF_COPY);
  if (chumbucketWalletFor(config, null)) return person(ctx, rt);
  let who: DepositPerson;
  try { who = await person(ctx, rt); } catch { throw new DepositError("UNAVAILABLE", OFF_COPY); }
  if (!chumbucketWalletFor(config, who.userId)) throw new DepositError("UNAVAILABLE", OFF_COPY);
  return who;
}

export const walletRouter = router({
  status: publicProcedure.input(z.object({}).strict().optional()).mutation(async ({ ctx }) => {
    const off = { enabled: false as const, account: null };
    if (!chumbucketWalletEnabled(ctx.app.config)) return off;
    const rt = depositsRuntimeFor(ctx.app.config);
    const resolved = await rt.accounts.resolve(ctx.supabaseAccessToken).catch(() => ({ ok: false }) as const);
    // "admins": per account; anyone else is told exactly what flag-off says.
    if (!chumbucketWalletFor(ctx.app.config, resolved.ok ? resolved.person.userId : null)) return off;
    if (!resolved.ok) return { enabled: true as const, account: null };
    try {
      rt.limiter.take(resolved.person.userId, "walletStatus");
    } catch (error) {
      if (isDepositError(error)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: error.message });
      throw error;
    }
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
      const rt = depositsRuntimeFor(ctx.app.config);
      const who = await walletPerson(ctx, rt);
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

  privyToken: publicProcedure.input(z.object({}).strict().optional()).mutation(({ ctx }) =>
    run(async () => {
      const config = ctx.app.config;
      if (!chumbucketWalletEnabled(config)) throw new DepositError("UNAVAILABLE", OFF_COPY);
      const signer = privyJwtSignerFor(config, config.chumbucketWallet?.privyJwt);
      if (!signer) throw new DepositError("UNAVAILABLE", OFF_COPY);
      let userId: string;
      if (chumbucketWalletFor(config, null)) userId = await account(ctx);
      else {
        // "admins": a Privy token only for an admin account; anyone else, exactly flag-off.
        try { userId = await account(ctx); } catch { throw new DepositError("UNAVAILABLE", OFF_COPY); }
        if (!chumbucketWalletFor(config, userId)) throw new DepositError("UNAVAILABLE", OFF_COPY);
      }
      depositsRuntimeFor(ctx.app.config).limiter.take(userId, "privyToken");
      return signer.mint(userId);
    }),
  ),
});
