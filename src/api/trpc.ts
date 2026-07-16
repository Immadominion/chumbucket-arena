/**
 * tRPC setup: context, transformer, base procedures, and domain→transport error
 * mapping. superjson carries bigint (FROST) and Date across the wire intact, so
 * the frontend gets real types, not stringified money.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import superjson from "superjson";
import type { App } from "../app.ts";
import { DomainError, type DomainErrorCode } from "../domain/errors.ts";
import type { Wallet } from "../domain/ids.ts";

export interface Context {
  app: App;
  wallet?: Wallet;
  /** The player's Privy wallet handle (when provider-custodied) — for deposit sweeps. */
  privyWalletId?: string;
}

/**
 * Build a request context: verify the credential via the app's Auth port and, if
 * valid, attach the player's wallet. A missing/invalid token just yields a
 * logged-out context (public procedures still work; authed ones reject).
 */
export async function makeContext(app: App, token: string | undefined): Promise<Context> {
  const user = await app.auth.verify(token ?? "");
  if (!user) return { app };
  return {
    app,
    wallet: user.wallet,
    ...(user.privyWalletId ? { privyWalletId: user.privyWalletId } : {}),
  };
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;

const CODE_MAP: Record<DomainErrorCode, TRPC_ERROR_CODE_KEY> = {
  NOT_SIGNED: "UNAUTHORIZED",
  ALREADY_SIGNED: "CONFLICT",
  INSUFFICIENT_BALANCE: "BAD_REQUEST",
  FUNDS_LOCKED: "BAD_REQUEST",
  MATCH_NOT_OPEN: "BAD_REQUEST",
  MATCH_LOCKED: "BAD_REQUEST",
  UNKNOWN_MARKET: "BAD_REQUEST",
  UNKNOWN_BUCKET: "BAD_REQUEST",
  DUPLICATE_CALL: "CONFLICT",
  DUPLICATE_DEPOSIT: "CONFLICT",
  STAKE_TOO_SMALL: "BAD_REQUEST",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  CONFLICT: "CONFLICT",
  INVALID: "BAD_REQUEST",
};

/**
 * Translate a DomainError thrown ANYWHERE in a procedure into the right transport
 * code. Procedures that wrap their body in guard() already throw TRPCError; this
 * catches the ones that throw DomainError directly (e.g. the wallet-signature
 * rejections on follow/recordPredictionCall/linkIdentity) so an auth failure is a
 * 400, not a 500 — which keeps client error handling honest and stops legitimate
 * rejections from being logged as INTERNAL_SERVER_ERROR. Idempotent: a guard()
 * TRPCError whose cause is a DomainError re-maps to the same code.
 */
const mapDomainErrors = t.middleware(async ({ next }) => {
  const res = await next();
  if (!res.ok && res.error.cause instanceof DomainError) {
    const de = res.error.cause;
    throw new TRPCError({ code: CODE_MAP[de.code], message: de.message, cause: de });
  }
  return res;
});

export const publicProcedure = t.procedure.use(mapDomainErrors);

export const authedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.wallet) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "connect your wallet (x-wallet)" });
  }
  return next({ ctx: { ...ctx, wallet: ctx.wallet } });
});

/** Run an engine command, translating DomainError into the right tRPC code. */
export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError) {
      throw new TRPCError({ code: CODE_MAP[e.code], message: e.message, cause: e });
    }
    throw e;
  }
}
