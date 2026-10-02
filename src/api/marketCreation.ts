/**
 * `marketCreation.*` — propose a Panta market, review it, publish it with a
 * wallet-signed create, and see who proposed a live market.
 *
 *   status · propose · mine · get · withdraw · reviewQueue · review ·
 *   preparePublish · submitPublish · refreshPublish · byMarket
 *
 * No procedure takes a person id: the actor is the verified Supabase session
 * mapped to public.users.id (the pantaTrading rule; a wallet string or DevAuth
 * session is never an identity). The Panta key never leaves the server; a
 * client sees only its reviewed unsigned transaction and the fee.
 * Every refusal message is readable copy (the mobile transport shows it).
 */
import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import { authIdentityRuntimeFor } from "../auth/AuthIdentityRuntime.ts";
import { isPgrestError } from "../prediction/pgrest.ts";
import { isMarketCreationError, type MarketCreationErrorCode } from "../marketCreation/errors.ts";
import { marketCreationFor } from "../marketCreation/runtime.ts";
import { publicRules, PANTA_CREATE_CATEGORIES, QUESTION_MAX, RULES_MAX, DESCRIPTION_MAX, SOURCES_MAX, SOURCE_URL_MAX } from "../marketCreation/rules.ts";
import type { Context } from "./trpc.ts";
import { publicProcedure, router } from "./trpc.ts";

const CODES: Record<MarketCreationErrorCode, TRPC_ERROR_CODE_KEY> = {
  MC_DISABLED: "PRECONDITION_FAILED", MC_SIGNED_OUT: "UNAUTHORIZED", MC_FORBIDDEN: "FORBIDDEN",
  MC_NOT_FOUND: "NOT_FOUND", MC_INVALID: "BAD_REQUEST", MC_CONFLICT: "CONFLICT", MC_LIMIT: "TOO_MANY_REQUESTS",
  MC_STATE: "PRECONDITION_FAILED", MC_FEE_TOO_HIGH: "PRECONDITION_FAILED", MC_PANTA_REFUSED: "BAD_REQUEST",
  MC_PANTA_UNAVAILABLE: "BAD_GATEWAY", MC_RATE_LIMITED: "TOO_MANY_REQUESTS", MC_SCHEMA: "BAD_GATEWAY",
  MC_UNVERIFIED: "BAD_GATEWAY",
};

async function viewer(ctx: Context, required: true): Promise<string>;
async function viewer(ctx: Context, required: false): Promise<string | null>;
async function viewer(ctx: Context, required: boolean): Promise<string | null> {
  const identity = authIdentityRuntimeFor(ctx.app.config);
  const signedOut = (): null => {
    if (required) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to create markets." });
    return null;
  };
  if (!ctx.supabaseAccessToken || !identity.store.enabled) return signedOut();
  const session = await identity.verifier.verify(ctx.supabaseAccessToken);
  if (!session) return signedOut();
  const id = await identity.store.userIdForAuthUser(session.authUserId);
  if (!id) {
    if (required) throw new TRPCError({ code: "UNAUTHORIZED", message: "Your account isn't linked yet. Sign in again to finish setting it up." });
    return null;
  }
  return id;
}

async function run<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isMarketCreationError(error)) throw new TRPCError({ code: CODES[error.code], message: error.message });
    // Deliberately no cause: rows can hold signed approvals.
    if (isPgrestError(error)) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Market proposals are temporarily unavailable. Try again shortly." });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Something went wrong with this market. Nothing was charged by this request." });
  }
}

const uuid = z.string().uuid();
const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const draft = z.object({
  question: z.string().max(QUESTION_MAX + 64),
  category: z.enum(PANTA_CREATE_CATEGORIES),
  closesAt: z.number().int().positive().safe(),
  resolvesAt: z.number().int().positive().safe(),
  rules: z.string().max(RULES_MAX + 64),
  sources: z.array(z.string().max(SOURCE_URL_MAX + 16)).min(1).max(SOURCES_MAX),
  description: z.string().max(DESCRIPTION_MAX + 64).nullish(),
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
}).strict();

export const marketCreationRouter = router({
  /** Public. Says what is switched on, the rules to validate against, and
   *  (with a session) whether the caller reviews proposals. */
  status: publicProcedure.query(({ ctx }) => run(async () => {
    const rt = marketCreationFor(ctx.app.config);
    const me = rt.proposals.enabled ? await viewer(ctx, false) : null;
    return {
      proposalsEnabled: rt.proposals.enabled, publishingEnabled: rt.publishing.enabled,
      reason: rt.proposals.reason ?? rt.publishing.reason, viewerIsReviewer: rt.service.isReviewer(me),
      maxFeeBaseUnits: rt.config.maxFeeBaseUnits, rules: publicRules(), attribution: "Powered by Panta" as const,
    };
  })),

  propose: publicProcedure.input(draft).mutation(({ ctx, input }) => run(async () => {
    const rt = marketCreationFor(ctx.app.config);
    if (!rt.proposals.enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: rt.proposals.reason! });
    const { idempotencyKey, ...rest } = input;
    return rt.service.propose(await viewer(ctx, true), { ...rest, description: rest.description ?? null, idempotencyKey });
  })),

  mine: publicProcedure.input(z.object({}).strict().default({})).query(({ ctx }) => run(async () =>
    marketCreationFor(ctx.app.config).service.mine(await viewer(ctx, true)))),

  get: publicProcedure.input(z.object({ proposalId: uuid }).strict()).query(({ ctx, input }) => run(async () =>
    marketCreationFor(ctx.app.config).service.get(await viewer(ctx, true), input.proposalId))),

  withdraw: publicProcedure.input(z.object({ proposalId: uuid }).strict()).mutation(({ ctx, input }) => run(async () =>
    marketCreationFor(ctx.app.config).service.withdraw(await viewer(ctx, true), input.proposalId))),

  reviewQueue: publicProcedure.input(z.object({}).strict().default({})).query(({ ctx }) => run(async () =>
    marketCreationFor(ctx.app.config).service.reviewQueue(await viewer(ctx, true)))),

  review: publicProcedure.input(z.discriminatedUnion("decision", [
    z.object({ proposalId: uuid, decision: z.literal("approve") }).strict(),
    z.object({ proposalId: uuid, decision: z.literal("reject"),
      reason: z.enum(["unclear", "unverifiable", "duplicate", "not_allowed", "other"]),
      note: z.string().max(280).nullish() }).strict(),
  ])).mutation(({ ctx, input }) => run(async () => {
    const service = marketCreationFor(ctx.app.config).service;
    const me = await viewer(ctx, true);
    return input.decision === "approve"
      ? service.review(me, input.proposalId, { approve: true })
      : service.review(me, input.proposalId, { approve: false, reason: input.reason, note: input.note ?? null });
  })),

  /** Quote + build the paid create. Returns the unsigned transaction to review. */
  preparePublish: publicProcedure.input(z.object({ proposalId: uuid, wallet }).strict()).mutation(({ ctx, input }) => run(async () =>
    marketCreationFor(ctx.app.config).service.preparePublish(await viewer(ctx, true), input.proposalId, input.wallet))),

  /** The wallet-signed create. Committed before broadcast; never re-quoted. */
  submitPublish: publicProcedure.input(z.object({
    proposalId: uuid, sessionId: uuid, signedTransaction: z.string().min(1).max(1644),
  }).strict()).mutation(({ ctx, input }) => run(async () =>
    marketCreationFor(ctx.app.config).service.submitPublish(await viewer(ctx, true), input.proposalId, input.sessionId, input.signedTransaction))),

  /** Re-check a publishing market against Panta and the chain. */
  refreshPublish: publicProcedure.input(z.object({ proposalId: uuid }).strict()).mutation(({ ctx, input }) => run(async () =>
    marketCreationFor(ctx.app.config).service.refresh(await viewer(ctx, true), input.proposalId))),

  /** Public: who proposed a live market. Null for venue-created markets. */
  byMarket: publicProcedure.input(z.object({ venueMarketId: wallet }).strict()).query(({ ctx, input }) => run(async () =>
    marketCreationFor(ctx.app.config).service.byMarket(input.venueMarketId))),
});
