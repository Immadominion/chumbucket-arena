/**
 * `callsRouter` — Packet D's isolated tRPC surface.
 *
 * EXACTLY the eight procedures declared in
 * docs/contracts/integration-requests/packet-c.md §5, with those input and
 * output shapes:
 *
 *   calls.feed · markets.open · markets.detail · calls.get
 *   people.get · calls.create · calls.respond · calls.invitations
 *
 * Deliberate properties:
 *  - it is ONE new file and touches no integration-owned file. Nesting it is
 *    three added keys in `src/api/router.ts` (§1/§6), filed as an exact patch in
 *    docs/contracts/integration-requests/packet-d.md.
 *  - it reads config through `ctx.app.config` and builds its store behind a
 *    module-level memo (§6) — nothing is constructed at import time.
 *  - NO PROCEDURE TAKES A USER ID, A VIEWER ID OR A WALLET AS INPUT. The
 *    acting/viewing user is derived from the verified session and mapped to a
 *    canonical `public.users.id` (§0.3). §8 finding 4 — "several tRPC read
 *    procedures take `wallet: z.string()` on `publicProcedure` with no proof at
 *    all" — is a live production defect, and a `viewerUserId` body field would
 *    be that same defect: it would let any caller read a `followers`-only call,
 *    read someone else's `viewerHasCalled`, or unlock a crowd split by naming a
 *    stranger who has already called.
 *  - READS never require a session; WRITES always do.
 *  - `calls.feed` in `following` mode with no resolvable session returns
 *    UNAUTHORIZED, not an empty page, so "you follow nobody" stays
 *    distinguishable from "we do not know who you are".
 *  - no TxLINE / API-Football / Arena-pot / keeper / Gaffer dependency appears
 *    anywhere in this module, by design.
 *
 * ERROR CONTRACT (what the mobile slice already distinguishes):
 *   UNAUTHORIZED                      -> CallsSignedOutException
 *   BAD_REQUEST / FORBIDDEN / NOT_FOUND / CONFLICT /
 *   PRECONDITION_FAILED / UNPROCESSABLE_CONTENT / TOO_MANY_REQUESTS
 *                                     -> CallsRejectedException, rendering
 *                                        `message` VERBATIM — so every message
 *                                        below is copy a person can read
 *   5xx                               -> CallsFailure
 *   transport failure                 -> CallsOfflineException (never us)
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import { callsRuntimeFor, type CallsRuntime } from "../calls/runtime.ts";
import { isCallsError, type CallsErrorCode } from "../calls/errors.ts";
import { hasCredential, type ViewerContext } from "../calls/viewer.ts";
import type { AppConfig } from "../config.ts";
import { authedProcedure, guard, publicProcedure, router } from "./trpc.ts";

// ── input schemas (the FROZEN §3 wire shapes, verbatim) ──────────────────────

const SIDE = z.enum(["YES", "NO"]);
const VISIBILITY = z.enum(["public", "followers"]);
const RESPONSE_KIND = z.enum(["back", "fade", "challenge"]);
const probability = z.number().min(0).max(1);
const thesis = z.string().max(280);

/**
 * `CreateCallInput.toJson()` from `lib/features/calls/data/call_models.dart`,
 * field for field. Note what is absent and must stay absent: no amount, no
 * wallet, no signature — and no viewerUserId.
 */
const createCallInput = z.object({
  marketId: z.string().min(1).max(256),
  side: SIDE,
  confidence: probability.nullish(),
  thesis: thesis.nullish(),
  visibility: VISIBILITY.default("public"),
  /**
   * Accepted because the client sends it, and then IGNORED. The server stamps
   * `entryProbability` and `snapshotId` from the price it actually holds, so a
   * client can never forge the probability it claims to have seen. (The SQL
   * side gets the same property from the column-level INSERT grant, which
   * withholds both columns from `authenticated`.)
   */
  snapshotId: z.string().max(256).nullish(),
  parentCallId: z.string().max(256).nullish(),
})
  // STRICT on purpose. A client that tries to pass `viewerUserId`, `userId` or
  // `wallet` gets a loud BAD_REQUEST instead of having the key silently
  // stripped — "this API does not take an identity" should be an error a
  // developer sees, not a subtlety they have to infer (§8 finding 4).
  .strict();

const respondInput = z.object({
  targetCallId: z.string().min(1).max(256),
  kind: RESPONSE_KIND,
  confidence: probability.nullish(),
  thesis: thesis.nullish(),
  visibility: VISIBILITY.default("public"),
  /** Trash talk on a challenge. There is no sibling field that holds money. */
  note: thesis.nullish(),
})
  .strict();

// ── calls error -> transport error ───────────────────────────────────────────

const CALLS_CODE_MAP: Record<CallsErrorCode, TRPC_ERROR_CODE_KEY> = {
  // "we do not know who you are" -> the client's signed-out state
  CALLS_SIGNED_OUT: "UNAUTHORIZED",
  CALLS_USER_UNLINKED: "UNAUTHORIZED",

  // understood, legitimate refusals — the message is shown verbatim
  CALL_MARKET_UNKNOWN: "NOT_FOUND",
  CALL_MARKET_CLOSED: "PRECONDITION_FAILED",
  CALL_NOT_FOUND: "NOT_FOUND",
  CALL_HIDDEN: "NOT_FOUND",
  CALL_NOT_VISIBLE: "NOT_FOUND",
  CALL_ALREADY_MADE: "CONFLICT",
  CALL_INVALID: "BAD_REQUEST",
  CALL_PARENT_MISMATCH: "BAD_REQUEST",
  RESPONSE_SELF: "BAD_REQUEST",
  RESPONSE_DUPLICATE: "CONFLICT",
  PERSON_NOT_FOUND: "NOT_FOUND",

  // invariants. Reaching one of these from a route means OUR bug, so it is
  // loud rather than dressed up as a user-facing refusal.
  CALL_IMMUTABLE: "INTERNAL_SERVER_ERROR",
  CALL_NOT_DELETABLE: "INTERNAL_SERVER_ERROR",
  RESULT_SERVICE_WRITE_ONLY: "INTERNAL_SERVER_ERROR",
  RESULT_DERIVATION_VIOLATION: "INTERNAL_SERVER_ERROR",
};

/**
 * Run a service call, mapping CallsError to the right transport code. Nested in
 * guard() so a DomainError raised anywhere below still maps the usual way.
 */
function call<T>(fn: () => Promise<T> | T): Promise<T> {
  return guard(async () => {
    try {
      return await fn();
    } catch (err) {
      if (isCallsError(err)) {
        throw new TRPCError({ code: CALLS_CODE_MAP[err.code], message: err.message, cause: err });
      }
      throw err;
    }
  });
}

// ── the memo (contracts §6) ──────────────────────────────────────────────────

const runtime = (config: AppConfig): CallsRuntime => callsRuntimeFor(config);

const SIGN_IN = "Sign in to do that.";

/**
 * The viewer, from the VERIFIED SESSION only. Returns null for a signed-out
 * caller — reading must keep working (§ packet-c: "reading never requires a
 * session, only writing does").
 */
function viewerOf(rt: CallsRuntime, ctx: ViewerContext): Promise<string | null> {
  return rt.viewer.resolve(ctx);
}

/**
 * The viewer, or UNAUTHORIZED. Two distinguishable situations, one code,
 * because the client's remedy is the same for both: sign in.
 *   - no credential at all           -> "we do not know who you are"
 *   - a credential with no canonical
 *     `public.users.id` behind it    -> "we know your credential, but it is
 *                                        not linked to an account"
 */
async function requireViewer(rt: CallsRuntime, ctx: ViewerContext): Promise<string> {
  const viewer = await viewerOf(rt, ctx);
  if (viewer) return viewer;
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: hasCredential(ctx)
      ? "Your account isn't linked yet. Sign in again to finish setting it up."
      : SIGN_IN,
  });
}

// ── calls.* ──────────────────────────────────────────────────────────────────

const callsNamespace = router({
  /**
   * The feed. `global` is public. `following` REQUIRES a session — an empty
   * page would make "you follow nobody" indistinguishable from "we do not know
   * who you are", and the client needs to tell those apart.
   */
  feed: publicProcedure
    .input(
      z
        .object({
          mode: z.enum(["global", "following"]).default("global"),
          cursor: z.string().max(512).nullish(),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .strict()
        .default({ mode: "global", limit: 20 }),
    )
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(async () => {
        const viewer =
          input.mode === "following" ? await requireViewer(rt, ctx) : await viewerOf(rt, ctx);
        return rt.service.feed(
          { mode: input.mode, cursor: input.cursor ?? null, limit: input.limit },
          viewer,
        );
      });
    }),

  /** One call plus its lineage and responses. Used by deep links. */
  get: publicProcedure
    .input(z.object({ callId: z.string().min(1).max(256) }).strict())
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(async () =>
        rt.service.getCall({ callId: input.callId }, await viewerOf(rt, ctx)),
      );
    }),

  /**
   * Lock a new, free, immutable call. Returns ONE feed entry.
   *
   * `authedProcedure` is the transport gate (no credential -> UNAUTHORIZED);
   * `requireViewer` is the identity step that turns that verified credential
   * into a canonical `public.users.id`. Both are needed: the first proves a
   * session exists, the second proves it belongs to an account (§0.3).
   */
  create: authedProcedure.input(createCallInput).mutation(({ ctx, input }) => {
    const rt = runtime(ctx.app.config);
    return call(async () => {
      const actor = await requireViewer(rt, ctx);
      return rt.service.createCall(
        {
          marketId: input.marketId,
          side: input.side,
          confidence: input.confidence ?? null,
          thesis: input.thesis ?? null,
          visibility: input.visibility,
          // input.snapshotId is deliberately NOT forwarded — see the schema.
          parentCallId: input.parentCallId ?? null,
        },
        actor,
      );
    });
  }),

  /**
   * Back, Fade or Challenge.
   *   back  -> `resultingCall` is the actor's OWN call on the SAME side
   *   fade  -> `resultingCall` is the actor's OWN call on the OPPOSITE side
   *   challenge -> `resultingCall` is null and `invitation` is set. No amount,
   *                no escrow, no transaction — checked at runtime by
   *                `assertMoneyFree`, not merely by the type.
   */
  respond: authedProcedure.input(respondInput).mutation(({ ctx, input }) => {
    const rt = runtime(ctx.app.config);
    return call(async () => {
      const actor = await requireViewer(rt, ctx);
      return rt.service.respond(
        {
          targetCallId: input.targetCallId,
          kind: input.kind,
          confidence: input.confidence ?? null,
          thesis: input.thesis ?? null,
          visibility: input.visibility,
          note: input.note ?? null,
        },
        actor,
      );
    });
  }),

  /** Invitations addressed to the caller. No escrow, ever. Takes no input. */
  invitations: authedProcedure.input(z.object({}).strict().default({})).query(({ ctx }) => {
    const rt = runtime(ctx.app.config);
    return call(async () => rt.service.invitations(await requireViewer(rt, ctx)));
  }),
});

// ── markets.* ────────────────────────────────────────────────────────────────

const marketsNamespace = router({
  /** Markets a call can be made on right now. Public. */
  open: publicProcedure
    .input(z.object({ category: z.string().max(64).nullish() }).strict().default({}))
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(() => rt.service.openMarkets({ category: input.category ?? null }));
    }),

  /**
   * ★ `crowdSplit` is null until the CALLER has a locked call on this market.
   *   Withheld at the source: a client cannot see it early even if it asks,
   *   because it is never put on the wire.
   */
  detail: publicProcedure
    .input(z.object({ marketId: z.string().min(1).max(256) }).strict())
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(async () =>
        rt.service.marketDetail({ marketId: input.marketId }, await viewerOf(rt, ctx)),
      );
    }),
});

// ── people.* ─────────────────────────────────────────────────────────────────

const peopleNamespace = router({
  /** One person plus their calls. `personRef` is a canonical user id or a
   *  handle — never a wallet, because a wallet is a credential (§0.3). */
  get: publicProcedure
    .input(z.object({ personRef: z.string().min(1).max(128) }).strict())
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(async () =>
        rt.service.getPerson({ personRef: input.personRef }, await viewerOf(rt, ctx)),
      );
    }),
});

/**
 * The mountable surface. Three namespaces, so the procedure paths are exactly
 * the ones packet-c.md §5 names: `calls.feed`, `markets.open`, `people.get`, …
 *
 * The sub-routers are exported individually as well, so the integration owner's
 * patch can add them as three plain keys without reaching inside this one.
 */
export const callsRouter = router({
  calls: callsNamespace,
  markets: marketsNamespace,
  people: peopleNamespace,
});

export { callsNamespace as socialCallsRouter, marketsNamespace as socialMarketsRouter, peopleNamespace as socialPeopleRouter };

export type CallsRouter = typeof callsRouter;
