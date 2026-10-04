/**
 * authRouter — Packet A's isolated tRPC surface: Supabase session -> canonical
 * user, wallet-proof issuance, and wallet linking.
 *
 * Mounting: this file exports `authRouter` and nothing else is required of it.
 * `src/api/router.ts` is integration-owned (contract §6), and nesting a
 * sub-router there is one added key (`auth: authRouter`) with no mergeRouters
 * and no registry. The exact one-line patch is filed at
 * docs/contracts/integration-requests/packet-a.md. Until it lands, every
 * procedure here is reachable (and fully tested) via
 * `authRouter.createCaller(ctx)`.
 *
 * Why the Supabase access token is a procedure INPUT rather than context:
 * `Context` lives in `src/api/trpc.ts`, which this packet may not edit. Taking
 * the credential as an input costs nothing in safety — it is verified against
 * the issuer on every call, exactly as a header would be — and it keeps Packet
 * A from needing a change to a shared file. When the integration owner adds a
 * `supabaseAccessToken` to `Context`, these procedures can read it from there
 * instead without any change to their behaviour.
 *
 * What is NOT trusted anywhere below: the `address` field. It is a claim until
 * a signature over a server-issued challenge proves it, and it is never used to
 * decide who the caller is.
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import { AuthIdentityError, type AuthIdentityErrorCode } from "../auth/AuthIdentityError.ts";
import { authIdentityRuntimeFor } from "../auth/AuthIdentityRuntime.ts";
import { WalletLinkService } from "../auth/WalletLinkService.ts";
import { chumbucketWalletEnabled } from "../wallet/tradingWallet.ts";
import { ExistingAccountClaimService } from "../auth/ExistingAccountClaimService.ts";
import { SIWS_PROOF_VERSION } from "../auth/SiwsMessage.ts";
import type { AppConfig } from "../config.ts";
import { existingCallsRuntime } from "../calls/runtime.ts";
import { authedProcedure, guard, publicProcedure, router } from "./trpc.ts";
import { accountProcedures, trustTrpcError } from "./trust.ts";
import { assertCleanText, isReservedHandle } from "../trust/contentFilter.ts";
import { isTrustError } from "../trust/errors.ts";

/**
 * One place where an identity failure becomes a transport status.
 *
 * The TRPCError `message` is always the bare code — machine-readable for the
 * client, and structurally incapable of carrying a nonce, a signature, a token
 * or a key. The human-readable `detail` stays on the cause, server-side.
 */
const TRPC_CODE: Record<AuthIdentityErrorCode, TRPC_ERROR_CODE_KEY> = {
  AUTH_TOKEN_MISSING: "UNAUTHORIZED",
  AUTH_TOKEN_INVALID: "UNAUTHORIZED",
  AUTH_USER_UNLINKED: "FORBIDDEN",
  AUTH_USER_AMBIGUOUS: "INTERNAL_SERVER_ERROR",
  IDENTITY_NOT_CONFIGURED: "PRECONDITION_FAILED",
  ACCOUNT_CLAIMS_DISABLED: "PRECONDITION_FAILED",
  ACCOUNT_CLAIM_UNAVAILABLE: "PRECONDITION_FAILED",
  ACCOUNT_CLAIM_CONFLICT: "CONFLICT",
  ACCOUNT_CLAIM_RATE_LIMITED: "TOO_MANY_REQUESTS",

  SIWS_MALFORMED_MESSAGE: "BAD_REQUEST",
  SIWS_UNSUPPORTED_VERSION: "BAD_REQUEST",
  SIWS_DOMAIN_NOT_ALLOWED: "BAD_REQUEST",
  SIWS_URI_NOT_ALLOWED: "BAD_REQUEST",
  SIWS_DOMAIN_MISMATCH: "BAD_REQUEST",
  SIWS_URI_MISMATCH: "BAD_REQUEST",
  SIWS_NETWORK_MISMATCH: "BAD_REQUEST",
  SIWS_ADDRESS_MISMATCH: "BAD_REQUEST",
  SIWS_STATEMENT_MISMATCH: "BAD_REQUEST",
  SIWS_PURPOSE_MISMATCH: "BAD_REQUEST",
  SIWS_BAD_SIGNATURE: "UNAUTHORIZED",

  NONCE_UNKNOWN: "BAD_REQUEST",
  NONCE_REUSED: "CONFLICT",
  NONCE_EXPIRED: "BAD_REQUEST",
  NONCE_USER_MISMATCH: "FORBIDDEN",
  NONCE_ISSUE_FAILED: "INTERNAL_SERVER_ERROR",

  WALLET_OWNED_BY_ANOTHER_USER: "CONFLICT",
  WALLET_REQUIRES_TRANSFER: "CONFLICT",
  WALLET_LINK_FAILED: "INTERNAL_SERVER_ERROR",
  WALLET_TYPE_UNAVAILABLE: "PRECONDITION_FAILED",

  LEGACY_EVIDENCE_UNVERIFIED: "FORBIDDEN",
  LEGACY_CLAIMED_BY_ANOTHER_USER: "CONFLICT",
  LEGACY_CLAIM_FAILED: "INTERNAL_SERVER_ERROR",

  IDENTITY_STORE_ERROR: "INTERNAL_SERVER_ERROR",

  USERNAME_INVALID: "BAD_REQUEST",
  USERNAME_RESERVED: "BAD_REQUEST",
  USERNAME_TAKEN: "CONFLICT",
  PROFILE_NAME_INVALID: "BAD_REQUEST",
  WALLET_HAS_PROFILE: "CONFLICT",
  HANDLE_ALREADY_SET: "CONFLICT",
};

/** Run a procedure body: DomainError -> transport via guard(), then our own
 *  identity codes. Both mappings are idempotent and order-independent. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await guard(fn);
  } catch (e) {
    if (e instanceof AuthIdentityError) {
      throw new TRPCError({ code: TRPC_CODE[e.code], message: e.code, cause: e });
    }
    throw e;
  }
}

/** Build the service for this request from the app's own config. No wiring into
 *  createApp; the runtime is memoised per config object. */
function serviceFor(config: AppConfig): WalletLinkService {
  const rt = authIdentityRuntimeFor(config);
  return new WalletLinkService({
    store: rt.store,
    verifier: rt.verifier,
    policy: rt.policy,
    walletProfileCarry: rt.walletProfileCarry === true,
    chumbucketWallet: chumbucketWalletEnabled(config),
  });
}

function existingAccountService(config: AppConfig): ExistingAccountClaimService {
  const rt = authIdentityRuntimeFor(config);
  return new ExistingAccountClaimService({
    enabled: config.authIdentity?.existingAccountClaimsEnabled === true,
    store: rt.existingAccounts, verifier: rt.verifier, policy: rt.policy,
  });
}

/**
 * Tell an already-running calls mirror that this person's @username changed,
 * so feeds, profiles and `people.get` stop showing the placeholder at once.
 * Best effort: the claim is already durable, and a mirror that misses this
 * reads the row again on its next hydration.
 */
async function refreshCallsPerson(config: AppConfig, userId: string, handle: string): Promise<void> {
  try {
    const calls = existingCallsRuntime(config);
    if (!calls) return;
    if (calls.durable) {
      await calls.durable.refreshPerson(userId);
      return;
    }
    const person = calls.store.getPerson(userId);
    if (person) calls.store.upsertPerson({ ...person, handle });
  } catch {
    // Never fails the claim, and never surfaces a store error to the caller.
  }
}

const accessToken = z.string().min(1).max(8192);
// Base58 32-byte key: 32–44 chars. The real check is bs58-decode-to-32 bytes in
// WalletLinkService; this only keeps obvious junk out of the service.
const solanaAddress = z.string().min(32).max(44);
const purpose = z.enum(["link_wallet", "transfer_wallet"]);

export const authRouter = router({
  /** auth.deleteAccount and auth.exportData (src/api/trust.ts). */
  ...accountProcedures,

  // POST only. No client-selected user id, auth subject, evidence or review flag.
  requestExistingAccountProof: publicProcedure.input(z.object({
    supabaseAccessToken: accessToken, address: solanaAddress,
    domain: z.string().min(1).max(253), uri: z.string().min(1).max(2048),
  }).strict()).mutation(({ ctx, input }) => run(() => existingAccountService(ctx.app.config).request({
    accessToken: input.supabaseAccessToken, address: input.address, domain: input.domain, uri: input.uri,
  }))),

  claimExistingAccount: publicProcedure.input(z.object({
    supabaseAccessToken: accessToken, address: solanaAddress,
    message: z.string().min(1).max(4096), signature: z.string().min(1).max(256),
  }).strict()).mutation(({ ctx, input }) => run(() => existingAccountService(ctx.app.config).claim({
    accessToken: input.supabaseAccessToken, address: input.address,
    message: input.message, signature: input.signature,
  }))),
  /** Explicit onboarding, not an email/wallet-based legacy account claim. */
  completeProfile: publicProcedure
    .input(z.object({
      supabaseAccessToken: accessToken,
      displayName: z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f\u007f]+$/),
      /** The @username to claim. Builds that predate usernames omit it and
       *  get the generated handle, exactly as before. */
      handle: z.string().trim().min(1).max(40).optional(),
    }).strict())
    .mutation(({ ctx, input }) => run(async () => {
      // Names and usernames are public: no links, slurs or system names.
      try {
        assertCleanText(input.displayName, "name");
        if (input.handle !== undefined) assertCleanText(input.handle, "handle");
      } catch (e) {
        if (isTrustError(e)) throw trustTrpcError(e);
        throw e;
      }
      if (input.handle !== undefined && isReservedHandle(input.handle)) {
        throw new AuthIdentityError("USERNAME_RESERVED");
      }
      if (input.handle !== undefined) {
        return serviceFor(ctx.app.config).createProfile({
          accessToken: input.supabaseAccessToken,
          displayName: input.displayName,
          handle: input.handle,
        });
      }
      const rt = authIdentityRuntimeFor(ctx.app.config);
      if (!rt.store.enabled) throw new AuthIdentityError("IDENTITY_NOT_CONFIGURED");
      const session = await rt.verifier.verify(input.supabaseAccessToken);
      if (!session) throw new AuthIdentityError("AUTH_TOKEN_INVALID");
      const userId = await rt.store.createPersonForAuthUser(session.authUserId, input.displayName);
      return { userId, authUserId: session.authUserId };
    })),

  /**
   * An existing account without a @username (made before usernames, or carried
   * over from a wallet profile) claims one. Only the caller's own account, only
   * while it has none: a set handle is never renamed (`HANDLE_ALREADY_SET`).
   * POST only — the credential travels in the body, never a URL.
   */
  claimUsername: publicProcedure
    .input(z.object({
      supabaseAccessToken: accessToken,
      handle: z.string().trim().min(1).max(40),
    }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        // Same rules as completeProfile: usernames are public, so no links,
        // slurs or system names (a deleted account's `deleted_` handle).
        try {
          assertCleanText(input.handle, "handle");
        } catch (e) {
          if (isTrustError(e)) throw trustTrpcError(e);
          throw e;
        }
        if (isReservedHandle(input.handle)) throw new AuthIdentityError("USERNAME_RESERVED");
        const claimed = await serviceFor(ctx.app.config).claimHandle({
          accessToken: input.supabaseAccessToken,
          handle: input.handle,
        });
        await refreshCallsPerson(ctx.app.config, claimed.userId, claimed.handle);
        return {
          userId: claimed.userId,
          authUserId: claimed.authUserId,
          handle: claimed.handle,
          outcome: claimed.outcome,
        };
      }),
    ),

  /**
   * Everything a client needs to construct a request, and nothing else. No key,
   * no URL, no token. The allowed domains are already public — they appear in
   * the message the user signs.
   */
  /**
   * Whether a @username can be claimed. Usernames are public, so this says
   * nothing a profile page would not. Normalised to lowercase.
   */
  usernameStatus: publicProcedure
    .input(z.object({ handle: z.string().trim().min(1).max(40) }).strict())
    .query(({ ctx, input }) =>
      run(async () => {
        const rt = authIdentityRuntimeFor(ctx.app.config);
        if (!rt.store.enabled) throw new AuthIdentityError("IDENTITY_NOT_CONFIGURED");
        const handle = input.handle.toLowerCase();
        // `deleted_` names a deleted account's row; never offered as available.
        if (isReservedHandle(handle)) return { handle, status: "reserved" as const };
        return { handle, status: await rt.store.usernameStatus(handle) };
      }),
    ),

  identityStatus: publicProcedure.query(({ ctx }) => {
    const rt = authIdentityRuntimeFor(ctx.app.config);
    return {
      enabled: rt.store.enabled,
      /** A wallet signature (Supabase Web3, Sign in with Solana) is a sign-in. */
      walletSignIn: rt.store.enabled,
      /** A wallet sign-in carries over the account already at that wallet. */
      walletProfileCarry: rt.walletProfileCarry === true,
      existingAccountClaimsEnabled: ctx.app.config.authIdentity?.existingAccountClaimsEnabled === true && !!rt.existingAccounts,
      network: rt.policy.network,
      proofVersion: SIWS_PROOF_VERSION,
      allowedDomains: [...rt.policy.allowedDomains],
      allowedUris: [...rt.policy.allowedUris],
      nonceTtlSeconds: rt.policy.nonceTtlSeconds,
    };
  }),

  /**
   * Resolve the caller's Supabase session to exactly one canonical user id.
   *
   * A MUTATION, not a query, purely because of where tRPC puts the input.
   * tRPC derives the HTTP method from the procedure type, so a `.query` is a
   * GET and a GET carries `input` in the QUERY STRING — which would have put a
   * live Supabase JWT into the request URL, and from there into Railway's
   * access log and every proxy in between. It reads nothing and changes
   * nothing; `mutation` here buys a request body, and that is the whole reason.
   *
   * The three other token-taking routes below were already mutations. This was
   * the only one.
   */
  whoami: publicProcedure
    .input(z.object({ supabaseAccessToken: accessToken }))
    .mutation(({ ctx, input }) =>
      run(async () => {
        const identity = await serviceFor(ctx.app.config).authenticate(input.supabaseAccessToken);
        // The caller's own stored @username — null when the account has none,
        // which is the app's cue to ask for one. Omitted (not null) when it
        // could not be read, so a failed read never looks like "no username".
        let handle: string | null | undefined;
        try {
          handle = await authIdentityRuntimeFor(ctx.app.config).store.handleForUser(identity.userId);
        } catch {
          handle = undefined;
        }
        // authUserId is returned deliberately: it is the client's own auth.uid(),
        // which it already holds. It is not another user's identifier.
        return {
          userId: identity.userId,
          authUserId: identity.authUserId,
          ...(handle !== undefined ? { handle } : {}),
        };
      }),
    ),

  /**
   * Issue a single-use, short-lived challenge bound to this user, this address,
   * this purpose, this domain/uri and this network — and return the exact
   * message to sign.
   */
  requestWalletNonce: publicProcedure
    .input(
      z.object({
        supabaseAccessToken: accessToken,
        address: solanaAddress,
        domain: z.string().min(1).max(253),
        uri: z.string().min(1).max(2048),
        purpose: purpose.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      run(() =>
        serviceFor(ctx.app.config).requestWalletNonce({
          accessToken: input.supabaseAccessToken,
          address: input.address,
          domain: input.domain,
          uri: input.uri,
          ...(input.purpose ? { purpose: input.purpose } : {}),
        }),
      ),
    ),

  /**
   * Verify the signed SIWS message, consume its nonce atomically, and link the
   * address to the canonical user. Rejects with a distinct code for a reused
   * nonce, an expired nonce, a wrong domain, uri, network, address or
   * statement, a nonce issued to another user, and a bad signature.
   */
  linkWallet: publicProcedure
    .input(
      z.object({
        supabaseAccessToken: accessToken,
        address: solanaAddress,
        message: z.string().min(1).max(4096),
        signature: z.string().min(1).max(256),
        purpose: purpose.optional(),
        /** "embedded": a key the app generated on the phone; "chumbucket": the
         *  Chumbucket wallet (refused while CHUMBUCKET_WALLET_ENABLED is off). Label only. */
        walletType: z.enum(["mwa", "embedded", "chumbucket"]).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      run(() =>
        serviceFor(ctx.app.config).linkWallet({
          accessToken: input.supabaseAccessToken,
          address: input.address,
          message: input.message,
          signature: input.signature,
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(input.walletType ? { walletType: input.walletType } : {}),
        }),
      ),
    ),

  /**
   * Map the caller's LEGACY account onto their canonical user.
   *
   * `authedProcedure` on purpose: this needs TWO independently verified
   * credentials — the legacy provider session (already verified by the app's
   * Auth port, which is what populates ctx.wallet / ctx.privyUserId) and the
   * new Supabase session. Neither alone is enough.
   *
   * Note what is absent from the input: the legacy subject. The client cannot
   * name which legacy account it is claiming. The subject is read off the
   * server-verified context, so "I am privy user X" is never something a client
   * can assert — which is precisely the hole in the legacy sync_user_by_wallet
   * path (contract §8 finding 2).
   *
   * The dev Auth adapter treats the credential itself as the wallet, so it
   * proves nothing; the claim is refused whenever that is what is wired.
   */
  claimLegacyIdentity: authedProcedure
    .input(
      z.object({
        supabaseAccessToken: accessToken,
        legacyProvider: z.enum(["privy", "wallet"]).default("privy"),
      }),
    )
    .mutation(({ ctx, input }) =>
      run(async () => {
        // `dev` auth is the one adapter that verifies nothing — the credential
        // IS the wallet string. Accepting it here would mean a legacy claim
        // could be made from client input alone, which is the exact hole this
        // packet closes. Any adapter that actually verifies is acceptable.
        if (ctx.app.wiring.auth === "dev") {
          throw new AuthIdentityError(
            "LEGACY_EVIDENCE_UNVERIFIED",
            "legacy claims require a verifying auth provider",
          );
        }

        // Server-derived, never client-supplied.
        const subject = input.legacyProvider === "privy" ? ctx.privyUserId : ctx.wallet;
        if (!subject) {
          throw new AuthIdentityError("LEGACY_EVIDENCE_UNVERIFIED", "no verified legacy subject");
        }

        return serviceFor(ctx.app.config).claimLegacyIdentity({
          accessToken: input.supabaseAccessToken,
          legacyProvider: input.legacyProvider,
          legacySubject: subject,
          evidence: "privy_session",
          // A non-secret pointer to the verification, never the credential.
          evidenceRef: `auth:${ctx.app.wiring.auth}`,
        });
      }),
    ),
});

export type AuthRouter = typeof authRouter;
