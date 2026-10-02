/**
 * SOL for network fees from the person's own USDC — `solTopUp.*`.
 *
 * A Jupiter swap whose network fee Jupiter (or the quoting market maker)
 * pays, so a wallet with 0 SOL can make it. Every procedure is a POST
 * mutation with the Supabase session in the Authorization header; no
 * procedure takes an address it would trust: `wallet` only SELECTS among the
 * person's server-verified wallets, exactly like deposits.*.
 * docs/gasless-sol-topup.md has the research and the rules.
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import type { DepositPerson } from "../deposits/accounts.ts";
import { depositsRuntimeFor } from "../deposits/runtime.ts";
import { solTopUpRuntimeFor, type SolTopUpRuntime } from "../solTopUp/runtime.ts";
import { isTopUpError, TopUpError, type TopUpErrorCode } from "../solTopUp/service.ts";
import type { Context } from "./trpc.ts";
import { publicProcedure, router } from "./trpc.ts";

const TRPC_CODES: Record<TopUpErrorCode, TRPC_ERROR_CODE_KEY> = {
  UNAVAILABLE: "PRECONDITION_FAILED",
  SIGNED_OUT: "UNAUTHORIZED",
  NOT_LINKED: "FORBIDDEN",
  NO_WALLET: "PRECONDITION_FAILED",
  WALLET_NOT_YOURS: "FORBIDDEN",
  AMOUNT_OUT_OF_RANGE: "BAD_REQUEST",
  NEEDS_USDC: "PRECONDITION_FAILED",
  ENOUGH_SOL: "PRECONDITION_FAILED",
  BELOW_GASLESS_MINIMUM: "PRECONDITION_FAILED",
  NOT_GASLESS: "PRECONDITION_FAILED",
  SWAP_REJECTED: "UNPROCESSABLE_CONTENT",
  PROVIDER_UNAVAILABLE: "BAD_GATEWAY",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  NOT_FOUND: "NOT_FOUND",
  EXPIRED: "CONFLICT",
  SIGNATURE_MISMATCH: "BAD_REQUEST",
  IN_PROGRESS: "CONFLICT",
  BALANCE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
};

async function person(ctx: Context): Promise<DepositPerson> {
  const resolved = await depositsRuntimeFor(ctx.app.config).accounts.resolve(ctx.supabaseAccessToken, { email: false });
  if (resolved.ok) return resolved.person;
  if (resolved.reason === "SIGNED_OUT") throw new TopUpError("SIGNED_OUT", "Sign in to swap for SOL.");
  if (resolved.reason === "NOT_LINKED") throw new TopUpError("NOT_LINKED", "Finish setting up your account first.");
  throw new TopUpError("UNAVAILABLE", "We couldn't confirm your account just now. Try again in a moment.");
}

function serviceOf(rt: SolTopUpRuntime) {
  if (!rt.service) {
    throw new TopUpError("UNAVAILABLE", rt.readiness.reason?.message ?? "Swapping USDC for SOL isn't available right now.");
  }
  return rt.service;
}

/** Our copy only. Anything unexpected is a generic, causeless failure. */
async function run<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isTopUpError(error)) throw new TRPCError({ code: TRPC_CODES[error.code], message: error.message });
    throw new TRPCError({ code: "BAD_GATEWAY", message: "Something went wrong with the swap. Nothing was signed. Try again." });
  }
}

/** Answers the app acts on rather than errors: nothing went wrong. */
const REFUSALS = ["NEEDS_USDC", "ENOUGH_SOL", "BELOW_GASLESS_MINIMUM", "NOT_GASLESS"] as const;
type Refusal = (typeof REFUSALS)[number];
const isRefusal = (code: TopUpErrorCode): code is Refusal => (REFUSALS as readonly string[]).includes(code);

const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const amountBaseUnits = z.string().regex(/^[1-9][0-9]{0,11}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export const solTopUpRouter = router({
  /** Whether swaps are on, and the limits. No account needed. */
  status: publicProcedure.mutation(({ ctx }) => {
    const rt = solTopUpRuntimeFor(ctx.app.config);
    const cfg = rt.service?.config ?? null;
    return {
      available: rt.service !== null,
      reason: rt.readiness.reason,
      provider: "Jupiter" as const,
      from: "USDC" as const,
      to: "SOL" as const,
      network: "solana-mainnet" as const,
      limits: cfg ? { minBaseUnits: cfg.minUsdcBaseUnits.toString(), maxBaseUnits: cfg.maxUsdcBaseUnits.toString() } : null,
    };
  }),

  /** The wallet's SOL against what Panta trades need, and a suggested swap. */
  plan: publicProcedure
    .input(z.object({ wallet: wallet.optional() }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => serviceOf(solTopUpRuntimeFor(ctx.app.config)).plan(await person(ctx), input.wallet)),
    ),

  /** A checked, unsigned gasless swap for the person's wallet to sign — or,
   *  when no such swap can be offered for an expected reason, which reason,
   *  as data the app acts on (a bigger amount, add funds, not needed). */
  order: publicProcedure
    .input(z.object({ wallet: wallet.optional(), amountBaseUnits }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        const service = serviceOf(solTopUpRuntimeFor(ctx.app.config));
        const who = await person(ctx);
        try {
          return { status: "READY" as const, ...(await service.order(who, input)) };
        } catch (error) {
          if (isTopUpError(error) && isRefusal(error.code)) {
            return { status: "REFUSED" as const, reason: error.code, message: error.message };
          }
          throw error;
        }
      }),
    ),

  /** Sends the person-signed swap (the exact reviewed message) through Jupiter. */
  execute: publicProcedure
    .input(z.object({ requestId, signedTransaction: z.string().min(1).max(1644) }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => serviceOf(solTopUpRuntimeFor(ctx.app.config)).execute(await person(ctx), input)),
    ),
});
