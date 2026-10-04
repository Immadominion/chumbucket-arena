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
import { chargeRequest } from "./writeLimits.ts";

export interface Context {
  app: App;
  wallet?: Wallet;
  /**
   * Raw Supabase access token from Authorization (or x-supabase-authorization).
   *
   * Carried, never trusted: Packet A verifies it against GoTrue on every
   * use. Without it `supabaseViewerResolver` always returned null, so a
   * signed-in person could not be resolved to a canonical user at all and
   * every write answered "your account isn't linked yet".
   */
  supabaseAccessToken?: string;
  /** The player's Privy wallet handle (when provider-custodied) — for deposit sweeps. */
  privyWalletId?: string;
  /** The provider's own user id (e.g. Privy user id) — needed to ask the Auth
   *  port for that user's already-linked social identities (X/Google). */
  privyUserId?: string;
  /** The caller's network address, for per-IP write limits. Absent in-process. */
  clientIp?: string;
  /** The verified legacy credential, for per-session write limits only. */
  legacyCredential?: string;
}

/**
 * Build a request context: verify the credential via the app's Auth port and, if
 * valid, attach the player's wallet. A missing/invalid token just yields a
 * logged-out context (public procedures still work; authed ones reject).
 */
export async function makeContext(
  app: App,
  token: string | undefined,
  supabaseAccessToken?: string,
  clientIp?: string,
): Promise<Context> {
  const user = await app.auth.verify(token ?? "");
  const ip = clientIp ? { clientIp } : {};
  if (!user) return { app, ...ip, ...(supabaseAccessToken ? { supabaseAccessToken } : {}) };
  return {
    app,
    ...ip,
    ...(supabaseAccessToken ? { supabaseAccessToken } : {}),
    ...(token ? { legacyCredential: token } : {}),
    wallet: user.wallet,
    ...(user.privyWalletId ? { privyWalletId: user.privyWalletId } : {}),
    ...(user.userId ? { privyUserId: user.userId } : {}),
  };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  /**
   * An error may carry machine-readable `publicDetails` (only our own ids and
   * codes, e.g. money.* TRANSFER_IN_FLIGHT with the transfer in flight). They
   * are sent as `data.details`; nothing else of a cause is.
   */
  errorFormatter({ shape, error }) {
    // Never a stack trace on the wire, whatever NODE_ENV says.
    const { stack: _stack, ...data } = shape.data as typeof shape.data & { stack?: unknown };
    const details = (error.cause as { publicDetails?: unknown } | undefined)?.publicDetails;
    if (!details || typeof details !== "object" || Array.isArray(details)) return { ...shape, data };
    const safe = Object.fromEntries(Object.entries(details as Record<string, unknown>).filter(([, v]) => typeof v === "string"));
    return { ...shape, data: { ...data, details: safe } };
  },
});

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

/**
 * Every mutation pays its client address's and its session's write budget
 * before it runs (B2). Queries are free; see `writeLimits.ts`.
 */
const limitWrites = t.middleware(({ ctx, type, path, next }) => {
  if (type === "mutation") chargeRequest(ctx.app.config, path, ctx);
  return next();
});

export const publicProcedure = t.procedure.use(mapDomainErrors).use(limitWrites);

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
