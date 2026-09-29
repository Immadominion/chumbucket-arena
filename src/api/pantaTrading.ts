/** No identity strings or filled-state assertions from clients. POST for private orders. */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authIdentityRuntimeFor } from "../auth/AuthIdentityRuntime.ts";
import type { Context } from "./trpc.ts";
import { publicProcedure, router } from "./trpc.ts";
import { pantaTradingFor, pantaTradingReadiness } from "../prediction/PantaTradingRuntime.ts";
import { isVenueError } from "../prediction/errors.ts";

async function person(ctx: Context): Promise<string> {
  // In particular, ctx.wallet / x-wallet / DevAuth are not credentials here.
  const identity = authIdentityRuntimeFor(ctx.app.config);
  if (!ctx.supabaseAccessToken || !identity.store.enabled) throw new TRPCError({ code: "UNAUTHORIZED", message: "Link your existing account before trading" });
  const session = await identity.verifier.verify(ctx.supabaseAccessToken);
  if (!session) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to your existing account" });
  const id = await identity.store.userIdForAuthUser(session.authUserId);
  if (!id) throw new TRPCError({ code: "FORBIDDEN", message: "Your existing profile has not been linked" });
  return id;
}
async function run<T>(ctx: Context, action: (userId: string) => Promise<T>): Promise<T> {
  try { return await action(await person(ctx)); }
  catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isVenueError(error)) {
      const code = error.code === "FUNDED_POSITIONS_DISABLED" ? "FORBIDDEN" : error.code === "IDEMPOTENCY_CONFLICT" ? "CONFLICT"
        : error.code === "VENUE_NOT_FOUND" ? "NOT_FOUND" : error.code === "VENUE_RATE_LIMITED" ? "TOO_MANY_REQUESTS"
        : error.code === "VENUE_BAD_REQUEST" ? "BAD_REQUEST" : "BAD_GATEWAY";
      // Deliberately no cause: approved transaction bytes are private ledger data.
      throw new TRPCError({ code, message: error.message });
    }
    throw new TRPCError({ code: "BAD_GATEWAY", message: "Panta order could not be verified. Check the same order before retrying" });
  }
}
const orderId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const pantaTradingRouter = router({
  status: publicProcedure.mutation(({ ctx }) => pantaTradingReadiness(ctx.app.config)),
  prepare: publicProcedure.input(z.object({
    callId: z.string().uuid(), wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    amountBaseUnits: z.string().regex(/^[1-9][0-9]{0,15}$/), idempotencyKey: z.string().min(8).max(128),
    maxSlippageBps: z.number().int().min(0).max(500).default(100),
  }).strict()).mutation(({ ctx, input }) => run(ctx, userId => pantaTradingFor(ctx.app.config).prepare(userId, input))),
  submit: publicProcedure.input(z.object({ orderId, signedTransaction: z.string().min(1).max(1644) }).strict())
    .mutation(({ ctx, input }) => run(ctx, userId => pantaTradingFor(ctx.app.config).submit(userId, input.orderId, input.signedTransaction))),
  order: publicProcedure.input(z.object({ orderId }).strict())
    .mutation(({ ctx, input }) => run(ctx, userId => pantaTradingFor(ctx.app.config, true).order(userId, input.orderId))),
  forCall: publicProcedure.input(z.object({
    callId: z.string().uuid(), wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  }).strict()).mutation(({ ctx, input }) => run(ctx, userId =>
    pantaTradingFor(ctx.app.config, true).forCall(userId, input.callId, input.wallet))),
});
