/**
 * Add funds (Crossmint onramp) — `deposits.*`.
 *
 * Every procedure is a POST mutation: the Supabase session rides in the
 * Authorization header and nothing private lands in a URL. No procedure takes
 * a recipient address: `wallet` only SELECTS among the person's
 * server-verified wallets (see src/deposits/accounts.ts).
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import type { DepositPerson } from "../deposits/accounts.ts";
import { centsToUsd } from "../deposits/config.ts";
import { DepositError, isDepositError, type DepositErrorCode } from "../deposits/errors.ts";
import { depositsRuntimeFor, type DepositsRuntime } from "../deposits/runtime.ts";
import { maskEmail, readDepositBalance } from "../deposits/service.ts";
import type { Context } from "./trpc.ts";
import { publicProcedure, router } from "./trpc.ts";

const TRPC_CODES: Record<DepositErrorCode, TRPC_ERROR_CODE_KEY> = {
  UNAVAILABLE: "PRECONDITION_FAILED",
  SIGNED_OUT: "UNAUTHORIZED",
  NOT_LINKED: "FORBIDDEN",
  NO_WALLET: "PRECONDITION_FAILED",
  WALLET_NOT_YOURS: "FORBIDDEN",
  EMAIL_REQUIRED: "BAD_REQUEST",
  AMOUNT_OUT_OF_RANGE: "BAD_REQUEST",
  LIMIT_REACHED: "BAD_REQUEST",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  IDEMPOTENCY_CONFLICT: "CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  NOT_AWAITING_PROOF: "CONFLICT",
  BAD_PROOF: "BAD_REQUEST",
  WALLET_LINK_CONFLICT: "CONFLICT",
  PROVIDER_REJECTED: "BAD_REQUEST",
  PROVIDER_UNAVAILABLE: "BAD_GATEWAY",
  BALANCE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
};

const SIGNED_OUT = new DepositError("SIGNED_OUT", "Sign in to add funds.");
const NOT_LINKED = new DepositError("NOT_LINKED", "Finish setting up your account to add funds.");
const ACCOUNT_DOWN = new DepositError("UNAVAILABLE", "We couldn't confirm your account just now. Try again in a moment.");

async function person(ctx: Context, rt: DepositsRuntime, email = false): Promise<DepositPerson> {
  const resolved = await rt.accounts.resolve(ctx.supabaseAccessToken, { email });
  if (resolved.ok) return resolved.person;
  throw resolved.reason === "SIGNED_OUT" ? SIGNED_OUT : resolved.reason === "NOT_LINKED" ? NOT_LINKED : ACCOUNT_DOWN;
}

function serviceOf(rt: DepositsRuntime) {
  if (!rt.service) {
    throw new DepositError("UNAVAILABLE", rt.readiness.reason?.message ?? "Adding funds isn't available right now.");
  }
  return rt.service;
}

/** Our copy only. Anything unexpected is a generic, causeless failure. */
async function run<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isDepositError(error)) throw new TRPCError({ code: TRPC_CODES[error.code], message: error.message });
    throw new TRPCError({ code: "BAD_GATEWAY", message: "Something went wrong adding funds. Nothing was charged. Try again." });
  }
}

const amountUsd = z.string().regex(/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/);
const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const receiptEmail = z.string().trim().min(3).max(254).email();
const orderId = z.string().uuid();

export const depositsRouter = router({
  /** Public shape plus, when signed in, which wallets can receive funds. */
  status: publicProcedure.mutation(async ({ ctx }) => {
    const rt = depositsRuntimeFor(ctx.app.config);
    const cfg = rt.readiness.config;
    const resolved = await rt.accounts
      .resolve(ctx.supabaseAccessToken, { email: rt.readiness.available })
      .catch(() => ({ ok: false, reason: "UNAVAILABLE" }) as const);
    return {
      available: rt.readiness.available,
      reason: rt.readiness.reason,
      provider: "Crossmint" as const,
      environment: cfg?.environment ?? null,
      asset: "USDC" as const,
      chain: "solana" as const,
      deliveryNetwork: cfg?.deliveryNetwork ?? null,
      limits: cfg ? { minUsd: centsToUsd(cfg.minOrderCents), maxUsd: centsToUsd(cfg.maxOrderCents) } : null,
      presetsUsd: cfg ? cfg.presetsCents.map(centsToUsd) : [],
      paymentMethods: ["card", "apple_pay", "google_pay"] as const,
      balanceAvailable: rt.balances !== null,
      account: resolved.ok
        ? {
            wallets: resolved.person.wallets.map((w) => ({
              address: w.address,
              walletType: w.walletType,
              primary: w.primary,
              session: w.session,
            })),
            receiptEmail: resolved.person.email ? maskEmail(resolved.person.email) : null,
            needsEmail: !resolved.person.email,
          }
        : null,
      accountIssue: resolved.ok ? null : resolved.reason,
    };
  }),

  /** Real mainnet SOL + USDC of one of the person's own wallets. */
  balance: publicProcedure
    .input(z.object({ wallet: wallet.optional() }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        const rt = depositsRuntimeFor(ctx.app.config);
        const who = await person(ctx, rt);
        if (!rt.balances) throw new DepositError("BALANCE_UNAVAILABLE", "Balances aren't available on this server.");
        return readDepositBalance({ reader: rt.balances, limiter: rt.limiter }, who, input.wallet);
      }),
    ),

  /** Crossmint's own draft quote: fiat total and the USDC range. Persists nothing. */
  quote: publicProcedure
    .input(z.object({ amountUsd, wallet: wallet.optional(), receiptEmail: receiptEmail.optional() }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        const rt = depositsRuntimeFor(ctx.app.config);
        const service = serviceOf(rt);
        return service.quote(await person(ctx, rt, true), input);
      }),
    ),

  /** Creates the order and returns the device-only checkout URL. */
  create: publicProcedure
    .input(
      z
        .object({
          amountUsd,
          wallet: wallet.optional(),
          receiptEmail: receiptEmail.optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      run(async () => {
        const rt = depositsRuntimeFor(ctx.app.config);
        const service = serviceOf(rt);
        return service.create(await person(ctx, rt, true), input);
      }),
    ),

  /** Live status of one of YOUR orders. Someone else's reads as not found. */
  order: publicProcedure
    .input(z.object({ orderId }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        const rt = depositsRuntimeFor(ctx.app.config);
        const service = serviceOf(rt);
        return service.order(await person(ctx, rt), input.orderId);
      }),
    ),

  /** Forwards a wallet's signature over Crossmint's ownership message, after we verify it. */
  verifyWallet: publicProcedure
    .input(z.object({ orderId, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        const rt = depositsRuntimeFor(ctx.app.config);
        const service = serviceOf(rt);
        return service.verifyWallet(await person(ctx, rt), input.orderId, input.signature);
      }),
    ),
});
