import { TRPCError } from "@trpc/server";
import { callsRuntimeFor } from "../calls/runtime.ts";
import { redactWallets } from "./redactWallets.ts";
import { publicProcedure } from "./trpc.ts";

/** The synchronous social store has a write-behind mirror. Never acknowledge
 * a lock, nor distribute that mirror, before its durable writes succeed.
 * A failed queue stays quarantined until an operator rebuilds it from the DB;
 * this is intentionally fail-closed, not a claim that writes are transactional.
 * Session/ownership checks still belong to each procedure's requireViewer. */
export const socialProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const rt = callsRuntimeFor(ctx.app.config);
  async function barrier() {
    try {
      await rt.ready;
      await rt.durable?.flush();
    } catch {
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "We couldn't confirm saved calls. Please try again later.",
      });
    }
  }
  await barrier();
  const result = await next();
  await barrier();
  // No social payload names anybody's wallet (M2) — see redactWallets.ts.
  if (result.ok) return { ...result, data: redactWallets(result.data) };
  return result;
});
