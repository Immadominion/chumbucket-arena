/**
 * Who is asking — derived from the VERIFIED SESSION and nothing else.
 *
 * The rule this file exists to keep (contracts §0.3, §8 finding 4):
 *
 *   No procedure in this packet takes a user id, a viewer id or a wallet as an
 *   INPUT. Ever. §8 finding 4 is a live production defect — "several tRPC read
 *   procedures take `wallet: z.string()` on `publicProcedure` with no proof at
 *   all" — and a `viewerUserId` body field would be exactly that defect again:
 *   it would let any caller read a `followers`-only call, read someone else's
 *   `viewerHasCalled`, or unlock a crowd split by naming a stranger who has
 *   already called.
 *
 * So the viewer is resolved from `ctx` only, and `ctx` is built by
 * `makeContext(app, token)` from the `Authorization: Bearer <token>` header,
 * which `app.auth.verify` has already checked. Two resolution paths, in order:
 *
 *   1. A SUPABASE SESSION on the context. This is Packet A's path, reused
 *      verbatim: GoTrue verifies the JWT, and `IdentityStore.userIdForAuthUser`
 *      maps auth.uid() -> exactly one `public.users.id`. It is the SQL
 *      `public.current_app_user_id()` expressed in TypeScript, and it is the
 *      only path that exists in production once the Context field lands.
 *
 *      `Context` lives in `src/api/trpc.ts`, which this packet may not edit
 *      (§6), so the field is read defensively — present, use it; absent, fall
 *      through. The exact patch that adds it is filed in
 *      docs/contracts/integration-requests/packet-d.md. When it lands, nothing
 *      here changes.
 *
 *   2. THE VERIFIED WALLET on the context. `app.auth.verify` already proved the
 *      caller controls it; this is only the credential -> canonical-user
 *      LOOKUP (the mirror of `public.users.wallet_address` /
 *      `linked_wallets`). It never mints a user, so an unknown wallet resolves
 *      to null rather than silently creating an account — which is precisely
 *      the hole §8 finding 2 describes in `sync_user_by_wallet`.
 *
 * Both paths end at a canonical `public.users.id`. A wallet is a linked
 * credential and is never the identity (§0.3).
 */

import { authIdentityRuntimeFor } from "../auth/AuthIdentityRuntime.ts";
import type { AppConfig } from "../config.ts";
import type { CallsStore } from "./store.ts";

/**
 * The subset of the tRPC Context this packet reads, plus the forward-compatible
 * field the integration request adds. Structural, so it needs no change to
 * `src/api/trpc.ts` to compile today and none to benefit tomorrow.
 */
export interface ViewerContext {
  /** Server-verified by `app.auth.verify` (never a client claim). */
  wallet?: string;
  /** The provider's own user id, server-verified. */
  privyUserId?: string;
  /**
   * The raw Supabase access token from `Authorization: Bearer`. Not on
   * `Context` yet — see the integration request. Read defensively.
   */
  supabaseAccessToken?: string;
}

export interface ViewerResolver {
  /** The caller's canonical public.users.id, or null when there is no session. */
  resolve(ctx: ViewerContext): Promise<string | null>;
}

/** No session can ever be resolved. The honest default for an unconfigured server. */
export const anonymousViewerResolver: ViewerResolver = {
  async resolve() {
    return null;
  },
};

/**
 * Packet A's Supabase path, reused rather than reimplemented: verify the JWT
 * against the issuer, then map auth.uid() to exactly one canonical user.
 * Returns null (never throws) for a missing/invalid/unlinked session, because a
 * logged-out read must still work (§ packet-c: "reading never requires a
 * session, only writing does").
 */
export function supabaseViewerResolver(config: AppConfig): ViewerResolver {
  return {
    async resolve(ctx) {
      const token = ctx.supabaseAccessToken;
      if (!token) return null;
      const rt = authIdentityRuntimeFor(config);
      if (!rt.store.enabled) return null;
      try {
        const session = await rt.verifier.verify(token);
        if (!session?.authUserId) return null;
        return await rt.store.userIdForAuthUser(session.authUserId);
      } catch {
        // An invalid or unverifiable token is "no session", not a 500.
        return null;
      }
    },
  };
}

/**
 * Map an ALREADY-VERIFIED wallet credential to its canonical user. This is a
 * lookup, not an authentication: `app.auth.verify` did the proving. It never
 * creates a user, so an unlinked wallet is null and not a new account.
 */
export function walletDirectoryViewerResolver(store: CallsStore): ViewerResolver {
  return {
    async resolve(ctx) {
      if (!ctx.wallet) return null;
      return store.getPersonByWallet(ctx.wallet)?.id ?? null;
    },
  };
}

/** Try each resolver in order; the first canonical id wins. */
export function chainViewerResolvers(...resolvers: ViewerResolver[]): ViewerResolver {
  return {
    async resolve(ctx) {
      for (const r of resolvers) {
        const id = await r.resolve(ctx);
        if (id) return id;
      }
      return null;
    },
  };
}

/**
 * Did the caller present ANY credential at all? Used to tell "we don't know who
 * you are" (UNAUTHORIZED -> the client's signed-out state) apart from "we know
 * you, but you have no canonical account yet".
 */
export const hasCredential = (ctx: ViewerContext): boolean =>
  Boolean(ctx.wallet || ctx.supabaseAccessToken || ctx.privyUserId);
