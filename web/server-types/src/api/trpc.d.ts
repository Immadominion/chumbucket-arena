/**
 * tRPC setup: context, transformer, base procedures, and domain→transport error
 * mapping. superjson carries bigint (FROST) and Date across the wire intact, so
 * the frontend gets real types, not stringified money.
 */
import type { App } from "../app";
import type { Wallet } from "../domain/ids";
export interface Context {
    app: App;
    wallet?: Wallet;
    /** The player's Privy wallet handle (when provider-custodied) — for deposit sweeps. */
    privyWalletId?: string;
    /** The provider's own user id (e.g. Privy user id) — needed to ask the Auth
     *  port for that user's already-linked social identities (X/Google). */
    privyUserId?: string;
}
/**
 * Build a request context: verify the credential via the app's Auth port and, if
 * valid, attach the player's wallet. A missing/invalid token just yields a
 * logged-out context (public procedures still work; authed ones reject).
 */
export declare function makeContext(app: App, token: string | undefined): Promise<Context>;
export declare const router: import("@trpc/server").TRPCRouterBuilder<{
    ctx: Context;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}>;
export declare const publicProcedure: import("@trpc/server").TRPCProcedureBuilder<Context, object, {}, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, false>;
export declare const authedProcedure: import("@trpc/server").TRPCProcedureBuilder<Context, object, {
    wallet: Wallet;
    privyWalletId: string | undefined;
    app: App;
    privyUserId: string | undefined;
}, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, false>;
/** Run an engine command, translating DomainError into the right tRPC code. */
export declare function guard<T>(fn: () => Promise<T>): Promise<T>;
