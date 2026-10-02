/**
 * Trust & safety, legal and account routes.
 *
 *   trust.report · trust.block · trust.unblock · trust.mute · trust.unmute
 *   trust.lists · trust.legalStatus · trust.acceptFundedTrading
 *   trust.requestDeletion (the web form; no session)
 *   trust.admin.reports · trust.admin.hideCall · trust.admin.resolveReport
 *   auth.deleteAccount · auth.exportData   (spread into the auth namespace)
 *
 * Same rules as calls.ts: no procedure takes a user id, viewer or wallet as
 * input; the actor is the verified Supabase session mapped to public.users.id;
 * every input is `.strict()`; every refusal message is copy a person reads.
 * Admin access is an env allow-list of canonical user ids
 * (TRUST_ADMIN_USER_IDS) checked against that same session.
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import { authIdentityRuntimeFor } from "../auth/AuthIdentityRuntime.ts";
import { callsRuntimeFor } from "../calls/runtime.ts";
import { hasCredential, type ViewerContext } from "../calls/viewer.ts";
import type { AppConfig } from "../config.ts";
import { isTrustError, TrustError, type TrustErrorCode } from "../trust/errors.ts";
import { trustRuntimeFor } from "../trust/runtime.ts";
import { REPORT_REASONS } from "../trust/store.ts";
import type { Context } from "./trpc.ts";
import { guard, publicProcedure, router } from "./trpc.ts";

const CODE: Record<TrustErrorCode, TRPC_ERROR_CODE_KEY> = {
  TRUST_SIGNED_OUT: "UNAUTHORIZED",
  TRUST_NOT_ADMIN: "FORBIDDEN",
  TRUST_RATE_LIMITED: "TOO_MANY_REQUESTS",
  TRUST_CONTENT_REFUSED: "BAD_REQUEST",
  TRUST_PERSON_NOT_FOUND: "NOT_FOUND",
  TRUST_CALL_NOT_FOUND: "NOT_FOUND",
  TRUST_REPORT_NOT_FOUND: "NOT_FOUND",
  TRUST_SELF: "BAD_REQUEST",
  TRUST_BLOCKED: "FORBIDDEN",
  TRUST_ATTESTATION_REQUIRED: "PRECONDITION_FAILED",
  TRUST_TERMS_CHANGED: "CONFLICT",
  TRUST_CONFIRMATION_MISMATCH: "BAD_REQUEST",
  TRUST_DELETION_FAILED: "CONFLICT",
  TRUST_DELETION_RETRY: "SERVICE_UNAVAILABLE",
  TRUST_NOT_CONFIGURED: "PRECONDITION_FAILED",
  TRUST_STORE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
};

/** A TrustError as the transport error the mobile client renders verbatim. */
export function trustTrpcError(err: TrustError): TRPCError {
  return new TRPCError({ code: CODE[err.code], message: err.message, cause: err });
}

/**
 * Run a trust operation: TrustError -> its code; TRPCError passes through;
 * anything else (a database or network failure) becomes a plain 503 with no
 * internal detail, since those messages can carry row data.
 */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  return guard(async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      if (isTrustError(err)) throw trustTrpcError(err);
      console.error("[trust] operation failed:", err instanceof Error ? err.name : "unknown");
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "We couldn't complete that right now. Please try again shortly.",
      });
    }
  });
}

const trust = (config: AppConfig) => trustRuntimeFor(config).service;

async function viewerOf(ctx: ViewerContext & { app: { config: AppConfig } }): Promise<string | null> {
  // Signed out is an answer, not a reason to build (or wait on) the calls runtime.
  if (!hasCredential(ctx)) return null;
  const rt = callsRuntimeFor(ctx.app.config);
  await rt.ready;
  return rt.viewer.resolve(ctx);
}

async function requireViewer(ctx: Context, signIn = "Sign in to do that."): Promise<string> {
  const viewer = await viewerOf(ctx);
  if (viewer) return viewer;
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: hasCredential(ctx) ? "Your account isn't linked yet. Sign in again to finish setting it up." : signIn,
  });
}

const personRef = z.string().trim().min(1).max(128);
const id = z.string().min(1).max(256);

const relation = (kind: "block" | "mute", on: boolean) =>
  publicProcedure
    .input(z.object({ personRef }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => trust(ctx.app.config).setRelation(await requireViewer(ctx), kind, input.personRef, on)),
    );

const adminNamespace = router({
  /** Open reports (or all), newest first, with who and what they concern. */
  reports: publicProcedure
    .input(
      z
        .object({
          status: z.enum(["open", "actioned", "dismissed", "all"]).default("open"),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .strict()
        .default({ status: "open", limit: 50 }),
    )
    .query(({ ctx, input }) =>
      run(async () => trust(ctx.app.config).adminReports(await requireViewer(ctx), input.status, input.limit)),
    ),

  /** Hide a call from distribution (CallsStore.hideCall); its result and records stay. */
  hideCall: publicProcedure
    .input(z.object({ callId: id, reportId: id.nullish(), note: z.string().max(200).nullish() }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => trust(ctx.app.config).adminHideCall(await requireViewer(ctx), input)),
    ),

  resolveReport: publicProcedure
    .input(
      z
        .object({ reportId: id, status: z.enum(["actioned", "dismissed"]), note: z.string().max(500).nullish() })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      run(async () => trust(ctx.app.config).adminResolveReport(await requireViewer(ctx), input)),
    ),
});

export const trustRouter = router({
  /** Report a call, the thesis on a call, or a person. Duplicate open reports are one report. */
  report: publicProcedure
    .input(
      z
        .object({
          subject: z.enum(["call", "thesis", "person"]),
          callId: id.nullish(),
          personRef: personRef.nullish(),
          reason: z.enum(REPORT_REASONS as unknown as [string, ...string[]]),
          details: z.string().max(500).nullish(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      run(async () =>
        trust(ctx.app.config).report(await requireViewer(ctx, "Sign in to report."), {
          subject: input.subject,
          callId: input.callId ?? null,
          personRef: input.personRef ?? null,
          reason: input.reason as (typeof REPORT_REASONS)[number],
          details: input.details ?? null,
        }),
      ),
    ),

  block: relation("block", true),
  unblock: relation("block", false),
  mute: relation("mute", true),
  unmute: relation("mute", false),

  /** The caller's own block and mute lists. */
  lists: publicProcedure
    .input(z.object({}).strict().default({}))
    .query(({ ctx }) => run(async () => trust(ctx.app.config).lists(await requireViewer(ctx)))),

  /**
   * Where the Terms and Privacy live, the version in force, and whether the
   * caller has made the funded-trading attestation for it. Signed out is a
   * valid answer (accepted: false), so the links work before sign-in.
   */
  legalStatus: publicProcedure
    .input(z.object({}).strict().default({}))
    .query(({ ctx }) => run(async () => trust(ctx.app.config).legalStatus(await viewerOf(ctx)))),

  /**
   * Record the 18+ / jurisdiction / venue-terms attestation against the
   * current terms version. Every field must be literally true: an unticked
   * box is not an acceptance and is never stored.
   */
  acceptFundedTrading: publicProcedure
    .input(
      z
        .object({
          termsVersion: z.string().min(1).max(64),
          over18: z.literal(true),
          eligibleJurisdiction: z.literal(true),
          acceptsVenueTerms: z.literal(true),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      run(async () => {
        const accepted = await trust(ctx.app.config).acceptFundedTrading(await requireViewer(ctx), input.termsVersion);
        return { accepted: true as const, termsVersion: accepted.termsVersion, acceptedAt: accepted.acceptedAt };
      }),
    ),

  /** The web deletion page's form. No session; limited per contact and overall. */
  requestDeletion: publicProcedure
    .input(
      z
        .object({
          contact: z.string().trim().min(3).max(254),
          handle: z.string().trim().max(40).nullish(),
          walletAddress: z.string().trim().max(64).nullish(),
          details: z.string().max(1000).nullish(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) => run(() => trust(ctx.app.config).requestDeletion(input))),

  admin: adminNamespace,
});

/** The JWT's `sub`, read WITHOUT verification. Only ever used to answer "was this deleted?". */
function unverifiedSubject(token: string): string | null {
  const body = token.split(".")[1];
  if (!body) return null;
  try {
    const claims = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" && /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Spread into `authRouter`, so the paths are `auth.deleteAccount` and
 * `auth.exportData`. Both are keyed on the verified Supabase session only.
 */
export const accountProcedures = {
  /**
   * Delete the caller's account. Works for any Supabase sign-in (wallet,
   * Google, X). Idempotent; a retry after a partial failure finishes it.
   */
  deleteAccount: publicProcedure
    .input(z.object({ confirm: z.literal("DELETE") }).strict())
    .mutation(({ ctx }) =>
      run(async () => {
        const token = ctx.supabaseAccessToken;
        if (!token) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to delete your account." });
        const identity = authIdentityRuntimeFor(ctx.app.config);
        if (!identity.store.enabled) {
          throw new TrustError(
            "TRUST_NOT_CONFIGURED",
            "Account deletion isn't available on this server yet. Use the deletion request page and we'll do it for you.",
          );
        }
        const service = trust(ctx.app.config);
        const session = await identity.verifier.verify(token);
        if (!session) {
          // A token for a sign-in we already removed: say it is done, rather
          // than "sign in", which the person can no longer do.
          // The token is unverified here, so the answer names no account.
          const sub = unverifiedSubject(token);
          const done = sub ? await service.completedDeletion(sub) : null;
          if (done) return { ...done, userId: null };
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to delete your account." });
        }
        const userId = await identity.store.userIdForAuthUser(session.authUserId);
        return service.deleteAccount({ authUserId: session.authUserId, userId });
      }),
    ),

  /** A JSON copy of the caller's profile, calls, follows and the rest. */
  exportData: publicProcedure
    .input(z.object({}).strict().default({}))
    .mutation(({ ctx }) =>
      run(async () => trust(ctx.app.config).exportData(await requireViewer(ctx, "Sign in to export your data."))),
    ),
};
