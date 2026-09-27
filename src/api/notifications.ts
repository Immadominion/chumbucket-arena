/**
 * `notificationsRouter` — Packet F's isolated tRPC surface.
 *
 * Five procedures, in two namespaces:
 *
 *   notifications.list · notifications.unreadCount · notifications.markRead
 *   record.mine · record.get
 *
 * Deliberate properties, matching `src/api/calls.ts` line for line where the
 * rule is the same:
 *
 *  - it is ONE new file and touches no integration-owned file. Nesting it is
 *    two added keys in `src/api/router.ts` (§6), filed as an exact patch in
 *    docs/contracts/integration-requests/packet-f.md.
 *  - it reads config through `ctx.app.config` and builds its store behind a
 *    module-level memo (§6) — nothing is constructed at import time.
 *  - NO PROCEDURE TAKES A USER ID, A VIEWER ID, A RECIPIENT OR A WALLET AS
 *    INPUT, and every input schema is `.strict()`. This matters more here than
 *    anywhere else in the product: §8 finding 3 is that
 *    `get_notifications(p_network, p_wallet)` is SECURITY DEFINER, was never
 *    revoked from anon, and takes the wallet as an argument — "any anon caller
 *    reads any wallet's inbox by passing that wallet string" — and §8 finding 4
 *    is the same defect on the tRPC side, "notifications included". An inbox is
 *    the one surface where getting this wrong hands over somebody's private
 *    relationships wholesale. The recipient is therefore DERIVED from the
 *    verified session and is not expressible as an input.
 *  - `record.get` names a PUBLIC SUBJECT by handle or canonical id, exactly as
 *    `people.get` does. No authorisation decision reads it; the viewer is still
 *    session-derived, and the record returned is the same for every caller.
 *  - EVERY read here requires a session except `record.get`. An inbox has no
 *    signed-out reading at all — there is no such thing as "the public inbox".
 *  - no TxLINE / API-Football / Arena-pot / keeper / Gaffer dependency appears
 *    anywhere in this module, by design.
 *
 * ERROR CONTRACT (the same four buckets Packet D maps to):
 *   UNAUTHORIZED                      -> the client's signed-out state
 *   BAD_REQUEST / NOT_FOUND / CONFLICT / PRECONDITION_FAILED
 *                                     -> a legitimate refusal, rendering
 *                                        `message` verbatim — so every message
 *                                        below is copy a person can read
 *   5xx                               -> our bug, loudly
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import type { AppConfig } from "../config.ts";
import { hasCredential, type ViewerContext } from "../calls/viewer.ts";
import { isNotificationsError, type NotificationsErrorCode } from "../notifications/errors.ts";
import { notificationsRuntimeFor, type NotificationsRuntime } from "../notifications/runtime.ts";
import { guard, router } from "./trpc.ts";
import { socialProcedure as publicProcedure } from "./socialProcedure.ts";

// ── calls error -> transport error ───────────────────────────────────────────

const CODE_MAP: Record<NotificationsErrorCode, TRPC_ERROR_CODE_KEY> = {
  NOTIFICATIONS_SIGNED_OUT: "UNAUTHORIZED",
  NOTIFICATIONS_USER_UNLINKED: "UNAUTHORIZED",

  NOTIFICATION_NOT_FOUND: "NOT_FOUND",
  NOTIFICATION_NOT_YOURS: "NOT_FOUND",
  PERSON_NOT_FOUND: "NOT_FOUND",

  // Invariants. Reaching one of these from a route means OUR bug, so it is loud
  // rather than dressed up as a user-facing refusal.
  NOTIFICATION_SELF: "INTERNAL_SERVER_ERROR",
  NOTIFICATION_NOT_ABOUT_OWN_CALL: "INTERNAL_SERVER_ERROR",
  NOTIFICATION_SHAPE_INVALID: "INTERNAL_SERVER_ERROR",
  NOTIFICATION_UNSAFE_PAYLOAD: "INTERNAL_SERVER_ERROR",
  NOTIFICATION_UNSAFE_COPY: "INTERNAL_SERVER_ERROR",
  RECORD_INCOMPLETE: "INTERNAL_SERVER_ERROR",
  SERVICE_WRITE_ONLY: "INTERNAL_SERVER_ERROR",
};

/** Run a service call, mapping NotificationsError to the right transport code. */
function call<T>(fn: () => Promise<T> | T): Promise<T> {
  return guard(async () => {
    try {
      return await fn();
    } catch (err) {
      if (isNotificationsError(err)) {
        throw new TRPCError({ code: CODE_MAP[err.code], message: err.message, cause: err });
      }
      throw err;
    }
  });
}

// ── the memo (contracts §6) ──────────────────────────────────────────────────

const runtime = (config: AppConfig): NotificationsRuntime => notificationsRuntimeFor(config);

const SIGN_IN = "Sign in to see your notifications.";

/**
 * The viewer, or UNAUTHORIZED.
 *
 * There is no signed-out variant of any inbox procedure, and no fallback that
 * accepts a name instead. Two distinguishable situations, one code, because the
 * remedy is the same for both: sign in.
 */
async function requireViewer(rt: NotificationsRuntime, ctx: ViewerContext): Promise<string> {
  const viewer = await rt.viewer.resolve(ctx);
  if (viewer) return viewer;
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: hasCredential(ctx)
      ? "Your account isn't linked yet. Sign in again to finish setting it up."
      : SIGN_IN,
  });
}

/**
 * One derivation pass before an inbox read, when `deriveOnRead` is on (it is by
 * default). The pass is idempotent and bounded, so this is pull-to-refresh
 * semantics and not a write hidden in a query: running it twice produces the
 * same inbox, and running it never produces a duplicate. It is what lets the
 * packet deliver notifications before the integration owner schedules
 * `deriver.runOnce()` on a timer.
 */
function refresh(rt: NotificationsRuntime): void {
  if (rt.config.flags.deriveOnRead) rt.deriver.runOnce();
}

// ── notifications.* ──────────────────────────────────────────────────────────

const notificationsNamespace = router({
  /**
   * The caller's own inbox. The recipient is the session and CANNOT be named:
   * there is no `wallet`, no `userId` and no `recipient` field on this schema,
   * and `.strict()` makes an attempt to add one a loud BAD_REQUEST rather than
   * a silently stripped key (§8 findings 3 and 4).
   */
  list: publicProcedure
    .input(
      z
        .object({
          cursor: z.string().max(512).nullish(),
          limit: z.number().int().min(1).max(100).default(20),
          unreadOnly: z.boolean().default(false),
        })
        .strict()
        .default({ limit: 20, unreadOnly: false }),
    )
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(async () => {
        const viewer = await requireViewer(rt, ctx);
        refresh(rt);
        return rt.service.inbox(
          { cursor: input.cursor ?? null, limit: input.limit, unreadOnly: input.unreadOnly },
          viewer,
        );
      });
    }),

  /** The unread badge, for the caller's own inbox and nobody else's. */
  unreadCount: publicProcedure.input(z.object({}).strict().default({})).query(({ ctx }) => {
    const rt = runtime(ctx.app.config);
    return call(async () => {
      const viewer = await requireViewer(rt, ctx);
      refresh(rt);
      return rt.service.unreadCount(viewer);
    });
  }),

  /**
   * Mark notifications read. `ids` omitted (or null) marks everything in the
   * caller's own inbox; a named id that is not theirs is refused with the same
   * message as one that does not exist, so this is not a membership oracle for
   * other people's inboxes.
   */
  markRead: publicProcedure
    .input(
      z
        .object({ ids: z.array(z.string().min(1).max(256)).max(200).nullish() })
        .strict()
        .default({}),
    )
    .mutation(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(async () => {
        const viewer = await requireViewer(rt, ctx);
        return rt.service.markRead(input.ids ?? null, viewer);
      });
    }),
});

// ── record.* ─────────────────────────────────────────────────────────────────

const recordNamespace = router({
  /**
   * The caller's own record: resolved, correct, incorrect and void, per
   * category, with free and funded kept in separate bands.
   *
   * Below `minimumDecidedForAccuracy` decided calls, `display.mode` is
   * `"counts"` and there is NO accuracy field on the object at all — a client
   * cannot render a percentage it was never handed. Above it, `display.mode` is
   * `"accuracy"`. Both arms carry `incorrect`, so no rendering path can show a
   * record with the misses left out.
   */
  mine: publicProcedure.input(z.object({}).strict().default({})).query(({ ctx }) => {
    const rt = runtime(ctx.app.config);
    return call(async () => rt.service.myRecord(await requireViewer(rt, ctx)));
  }),

  /**
   * Somebody else's record. `personRef` is a canonical user id or a handle —
   * never a wallet (§0.3) — and it names a PUBLIC SUBJECT, exactly as
   * `people.get` does. It is not an identity: no authorisation decision reads
   * it, the viewer is still the session, and the answer is the same for every
   * caller.
   */
  get: publicProcedure
    .input(z.object({ personRef: z.string().min(1).max(128) }).strict())
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(() => rt.service.recordFor(input.personRef));
    }),
});

/**
 * The mountable surface. Two namespaces, so the procedure paths are
 * `notifications.list`, `notifications.unreadCount`, `notifications.markRead`,
 * `record.mine` and `record.get`.
 *
 * The sub-routers are exported individually as well, so the integration owner's
 * patch can add them as two plain keys without reaching inside this one.
 */
export const notificationsRouter = router({
  notifications: notificationsNamespace,
  record: recordNamespace,
});

export {
  notificationsNamespace as socialNotificationsRouter,
  recordNamespace as socialRecordRouter,
};

export type NotificationsRouter = typeof notificationsRouter;
