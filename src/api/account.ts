/**
 * `account.*` — the signed-in person's own account, keyed by the VERIFIED
 * Supabase session and nothing else (B1, M1, M9, B3).
 *
 *   account.me                 own profile, including own wallet
 *   account.updateProfile      display name, bio, avatar (one of five)
 *   account.addWalletFriend    add a friend by wallet, server-side
 *   account.registerPushToken  this device's FCM token, for this person
 *   account.unregisterPushToken
 *
 * Wallet AND Google/X sessions work the same way: each is a Supabase session,
 * resolved to one canonical `public.users.id` exactly as calls.* resolves it.
 * No input names a user, a wallet as identity, or an auth id, and every schema
 * is `.strict()`, so trying to is a loud BAD_REQUEST.
 *
 * Every write here also pays the person's own write budget (`chargeUser`), on
 * top of the per-address and per-session budget every mutation pays.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { accountRuntimeFor } from "../account/runtime.ts";
import { isAvatarId, type OwnProfile } from "../account/store.ts";
import { isUsableSolanaAddress } from "../auth/SolanaKey.ts";
import { isSolanaAddress } from "../auth/WalletLinkService.ts";
import { callsRuntimeFor, type CallsRuntime } from "../calls/runtime.ts";
import { hasCredential } from "../calls/viewer.ts";
import { isPgrestError } from "../prediction/pgrest.ts";
import { assertCleanText, type TextField } from "../trust/contentFilter.ts";
import { isTrustError } from "../trust/errors.ts";
import type { Context } from "./trpc.ts";
import { publicProcedure, router } from "./trpc.ts";
import { trustTrpcError } from "./trust.ts";
import { chargeUser } from "./writeLimits.ts";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

const displayName = z
  .string()
  .trim()
  .min(1, "Your name can't be empty.")
  .max(60, "Keep your name to 60 characters.")
  .refine((v) => !CONTROL.test(v), "Your name has characters we can't show.");
const bio = z
  .string()
  .trim()
  .max(280, "Keep your bio to 280 characters.")
  .refine((v) => !CONTROL_BUT_NEWLINE.test(v), "Your bio has characters we can't show.");
const avatarId = z.number().int().refine(isAvatarId, "Pick one of the five pictures.");
// FCM registration tokens: long, URL-safe-ish. Never logged.
const fcmToken = z.string().min(20).max(4096).regex(/^[A-Za-z0-9:_-]+$/);

const PROFILE_COPY: Record<string, string> = {
  invalid_name: "Your name needs 1 to 60 characters we can show.",
  invalid_bio: "Keep your bio to 280 characters we can show.",
  invalid_avatar: "Pick one of the five pictures.",
  nothing_to_change: "There's nothing to save.",
  unknown_user: "Your account isn't set up yet. Sign in again to finish setting it up.",
};
const FRIEND_COPY: Record<string, string> = {
  invalid_wallet: "That isn't a Solana wallet address.",
  invalid_nickname: "Keep the name to 60 characters.",
  self: "That's your own wallet.",
  unknown_user: "Your account isn't set up yet. Sign in again to finish setting it up.",
};

/** The person, from the verified session only. */
async function requirePerson(rt: CallsRuntime, ctx: Context): Promise<string> {
  await rt.ready;
  const userId = await rt.viewer.resolve(ctx);
  if (userId) return userId;
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: hasCredential(ctx)
      ? "Your account isn't linked yet. Sign in again to finish setting it up."
      : "Sign in to do that.",
  });
}

/**
 * Names, bios and the names people give friends are public text, so they meet
 * the same content policy as theses and usernames (src/trust/contentFilter.ts):
 * no links, no slurs or strong profanity. Refused before anything is written,
 * with the reason the app shows as-is.
 */
function assertPublishable(fields: [string | null | undefined, TextField][]): void {
  try {
    for (const [text, field] of fields) assertCleanText(text, field);
  } catch (err) {
    if (isTrustError(err)) throw trustTrpcError(err);
    throw err;
  }
}

function storeFailure(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  // PgrestError messages are already redacted, but none of it is copy.
  void isPgrestError(err);
  throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "We couldn't save that. Please try again." });
}

/**
 * Keep the calls directory (feed authors, people pages) in step with an edit
 * at once, rather than at the next boot.
 */
async function syncDirectory(rt: CallsRuntime, profile: OwnProfile): Promise<void> {
  if (rt.durable) {
    await rt.durable.refreshPerson(profile.userId).catch(() => undefined);
    return;
  }
  const p = rt.store.getPerson(profile.userId);
  if (!p) return;
  rt.store.upsertPerson({
    ...p,
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    avatarId: profile.avatarId,
  });
}

export const accountRouter = router({
  /** A query is fine: the session travels in the Authorization header, never the URL. */
  me: publicProcedure.input(z.object({}).strict().default({})).query(async ({ ctx }) => {
    const calls = callsRuntimeFor(ctx.app.config);
    const userId = await requirePerson(calls, ctx);
    const { store } = accountRuntimeFor(ctx.app.config);
    let profile: OwnProfile | null;
    try {
      profile = await store.getOwnProfile(userId);
    } catch (err) {
      storeFailure(err);
    }
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: PROFILE_COPY.unknown_user! });
    }
    return { profile };
  }),

  updateProfile: publicProcedure
    .input(
      z
        .object({ displayName: displayName.optional(), bio: bio.optional(), avatarId: avatarId.optional() })
        .strict()
        .refine((v) => v.displayName !== undefined || v.bio !== undefined || v.avatarId !== undefined, {
          message: PROFILE_COPY.nothing_to_change!,
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const calls = callsRuntimeFor(ctx.app.config);
      const userId = await requirePerson(calls, ctx);
      assertPublishable([
        [input.displayName, "name"],
        [input.bio, "bio"],
      ]);
      chargeUser(ctx.app.config, userId);
      const { store } = accountRuntimeFor(ctx.app.config);
      if (!store.enabled) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Profiles can't be edited on this server." });
      }
      let result;
      try {
        result = await store.updateOwnProfile(userId, {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.bio !== undefined ? { bio: input.bio } : {}),
          ...(input.avatarId !== undefined ? { avatarId: input.avatarId } : {}),
        });
      } catch (err) {
        storeFailure(err);
      }
      if (!result.ok) {
        if (result.reason === "store_error") storeFailure(null);
        throw new TRPCError({
          code: result.reason === "unknown_user" ? "UNAUTHORIZED" : "BAD_REQUEST",
          message: PROFILE_COPY[result.reason] ?? "We couldn't save that.",
        });
      }
      await syncDirectory(calls, result.profile);
      return { profile: result.profile };
    }),

  /**
   * The name typed here is the adder's own label for the friend, stored on the
   * adder's edge (friends.nickname, which only this path can write). It is not
   * secret (the legacy friends table is readable), but it is never written
   * onto the friend's profile, and an unknown wallet gets only
   * an empty placeholder that its owner later carries over clean (M1).
   */
  addWalletFriend: publicProcedure
    .input(
      z
        .object({
          walletAddress: z.string().trim().min(32).max(44),
          nickname: z
            .string()
            .trim()
            .max(60)
            .refine((v) => !CONTROL.test(v), "That name has characters we can't show.")
            .optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const calls = callsRuntimeFor(ctx.app.config);
      const userId = await requirePerson(calls, ctx);
      assertPublishable([[input.nickname, "nickname"]]);
      chargeUser(ctx.app.config, userId);
      if (!isSolanaAddress(input.walletAddress) || !isUsableSolanaAddress(input.walletAddress)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: FRIEND_COPY.invalid_wallet! });
      }
      const { store } = accountRuntimeFor(ctx.app.config);
      let result;
      try {
        result = await store.addWalletFriend(userId, input.walletAddress, input.nickname ? input.nickname : null);
      } catch (err) {
        storeFailure(err);
      }
      if (!result.ok) {
        if (result.reason === "store_error") storeFailure(null);
        throw new TRPCError({
          code: result.reason === "unknown_user" ? "UNAUTHORIZED" : "BAD_REQUEST",
          message: FRIEND_COPY[result.reason] ?? "We couldn't add that friend.",
        });
      }
      return { friendUserId: result.friendUserId, alreadyFriends: result.alreadyFriends };
    }),

  /** Registered by the person, so Google/X accounts get pushes too (M3). */
  registerPushToken: publicProcedure
    .input(z.object({ token: fcmToken, platform: z.enum(["android", "ios"]) }).strict())
    .mutation(async ({ ctx, input }) => {
      const calls = callsRuntimeFor(ctx.app.config);
      const userId = await requirePerson(calls, ctx);
      chargeUser(ctx.app.config, userId);
      const rt = accountRuntimeFor(ctx.app.config);
      if (!rt.store.enabled) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Notifications aren't available on this server." });
      }
      try {
        await rt.store.registerPushToken(userId, input.token, input.platform);
      } catch (err) {
        storeFailure(err);
      }
      // Whether pushes will actually be sent is the server's honest answer,
      // not a guess the client makes.
      return { registered: true, pushEnabled: rt.sender !== null };
    }),

  unregisterPushToken: publicProcedure
    .input(z.object({ token: fcmToken }).strict())
    .mutation(async ({ ctx, input }) => {
      const calls = callsRuntimeFor(ctx.app.config);
      const userId = await requirePerson(calls, ctx);
      const { store } = accountRuntimeFor(ctx.app.config);
      try {
        await store.unregisterPushToken(userId, input.token);
      } catch (err) {
        storeFailure(err);
      }
      return { unregistered: true };
    }),
});

export type AccountRouter = typeof accountRouter;
