/**
 * Two-user abuse tests, driven through the real `authRouter`.
 *
 * Why the authorisation layer and not the database: `SupabaseIdentityStore`,
 * like `SocialStore`, holds the service-role key and therefore bypasses RLS by
 * construction (contract §2). RLS is the second line — it protects reads the
 * device makes directly against PostgREST — and it is asserted separately, and
 * visibly, in authIdentityRls.test.ts. Neither layer substitutes for the other,
 * so both are tested; what is tested HERE is that the BFF never lets one user
 * reach another user's rows in the first place.
 *
 * The strongest result in this file is negative: there is no procedure, and no
 * input field, through which a caller can name a user other than themselves.
 */

import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { authRouter } from "../src/api/authRoutes.ts";
import { primeAuthIdentityRuntime } from "../src/auth/AuthIdentityRuntime.ts";
import { parseSiwsMessage } from "../src/auth/SiwsMessage.ts";
import type { Auth, AuthedUser } from "../src/auth/Auth.ts";
import type { OAuthIdentity } from "../src/social/SocialStore.ts";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet } from "../src/domain/ids.ts";
import {
  FakeIdentityStore,
  FakeJwtVerifier,
  makeWallet,
  signMessage,
  TEST_DOMAIN,
  TEST_URI,
  testPolicy,
  type TestWallet,
} from "./authIdentityFixtures.ts";

/**
 * A provider adapter that actually verifies its credential (unlike DevAuth,
 * where the credential IS the wallet string). Wiring a custom Auth makes
 * `app.wiring.auth === "custom"`, which is what the legacy-claim route requires
 * — it refuses only the `dev` adapter, the one that proves nothing.
 */
class StubProviderAuth implements Auth {
  constructor(private readonly sessions: Record<string, { userId: string; wallet: string }>) {}
  async verify(token: string): Promise<AuthedUser | null> {
    const s = this.sessions[token];
    return s ? { userId: s.userId, wallet: asWallet(s.wallet) } : null;
  }
  async fetchLinkedIdentities(): Promise<OAuthIdentity[]> {
    return [];
  }
}

interface Rig {
  app: App;
  store: FakeIdentityStore;
  alice: ReturnType<typeof authRouter.createCaller>;
  bob: ReturnType<typeof authRouter.createCaller>;
  anon: ReturnType<typeof authRouter.createCaller>;
}

const ALICE_WALLET = "AL1ceWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB_WALLET = "B0bWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

async function rig(): Promise<Rig> {
  const config = loadConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    SOLANA_NETWORK: "devnet",
  });
  const app = await createApp({
    config,
    auth: new StubProviderAuth({
      "privy-alice-session": { userId: "privy:alice", wallet: ALICE_WALLET },
      "privy-bob-session": { userId: "privy:bob", wallet: BOB_WALLET },
    }),
  });

  const store = new FakeIdentityStore();
  store.addUser("auth-alice", "user-alice");
  store.addUser("auth-bob", "user-bob");
  const verifier = new FakeJwtVerifier().issue("tok-alice", "auth-alice").issue("tok-bob", "auth-bob");

  primeAuthIdentityRuntime(config, {
    store,
    verifier,
    policy: {
      ...testPolicy,
      allowedDomains: [...testPolicy.allowedDomains],
      allowedUris: [...testPolicy.allowedUris],
    },
  });

  return {
    app,
    store,
    alice: authRouter.createCaller({ app, wallet: asWallet(ALICE_WALLET), privyUserId: "privy:alice" }),
    bob: authRouter.createCaller({ app, wallet: asWallet(BOB_WALLET), privyUserId: "privy:bob" }),
    anon: authRouter.createCaller({ app }),
  };
}

/** Sign a freshly-issued challenge exactly as the server produced it. */
async function proveFor(
  caller: ReturnType<typeof authRouter.createCaller>,
  token: string,
  wallet: TestWallet,
) {
  const issued = await caller.requestWalletNonce({
    supabaseAccessToken: token,
    address: wallet.address,
    domain: TEST_DOMAIN,
    uri: TEST_URI,
  });
  return { message: issued.message, signature: signMessage(wallet.privateKey, issued.message) };
}

async function trpcFailure(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
    return { code: "NO_ERROR", message: "NO_ERROR" };
  } catch (e) {
    if (e instanceof TRPCError) return { code: e.code, message: e.message };
    return { code: "UNEXPECTED", message: e instanceof Error ? e.message : String(e) };
  }
}

describe("authRouter — surface", () => {
  test("exposes exactly five procedures, none of which reads another user's rows", async () => {
    const names = Object.keys(
      (authRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures,
    ).sort();

    // This assertion is a tripwire. If a future change adds a read route here,
    // this test fails and the addition has to be argued for rather than
    // arriving quietly — which is how a private table becomes a public one.
    expect(names).toEqual(
      ["claimLegacyIdentity", "identityStatus", "linkWallet", "requestWalletNonce", "whoami"].sort(),
    );
  });

  test("identityStatus leaks no secret", async () => {
    const r = await rig();
    const status = await r.anon.identityStatus();
    expect(status.enabled).toBe(true);
    expect(status.network).toBe("devnet");
    expect(JSON.stringify(status)).not.toContain("service-role-secret");
    expect(JSON.stringify(status)).not.toContain("supabase.co");
  });
});

describe("authRouter — one user cannot reach another user's rows", () => {
  test("whoami resolves each session to its own canonical user only", async () => {
    const r = await rig();
    expect(await r.alice.whoami({ supabaseAccessToken: "tok-alice" })).toEqual({
      userId: "user-alice",
      authUserId: "auth-alice",
    });
    expect(await r.bob.whoami({ supabaseAccessToken: "tok-bob" })).toEqual({
      userId: "user-bob",
      authUserId: "auth-bob",
    });

    // A session Alice does not hold gets her nothing, even though she is a
    // perfectly valid caller in every other respect.
    expect(await trpcFailure(() => r.alice.whoami({ supabaseAccessToken: "tok-mallory" }))).toEqual({
      code: "UNAUTHORIZED",
      message: "AUTH_TOKEN_INVALID",
    });
  });

  test("a linked wallet is attributed to the SESSION's user, never to the tRPC wallet context", async () => {
    const r = await rig();
    const w = makeWallet();

    // Alice's transport context says her wallet is ALICE_WALLET. She links a
    // completely different key. The link follows her Supabase session's
    // canonical user — the wallet in context authorises nothing.
    const proof = await proveFor(r.alice, "tok-alice", w);
    const linked = await r.alice.linkWallet({
      supabaseAccessToken: "tok-alice",
      address: w.address,
      message: proof.message,
      signature: proof.signature,
    });

    expect(linked.userId).toBe("user-alice");
    expect(r.store.walletOwner(w.address)).toBe("user-alice");
  });

  test("Alice cannot redeem a challenge issued to Bob", async () => {
    const r = await rig();
    const bobKey = makeWallet();
    const proof = await proveFor(r.bob, "tok-bob", bobKey);

    expect(
      await trpcFailure(() =>
        r.alice.linkWallet({
          supabaseAccessToken: "tok-alice",
          address: bobKey.address,
          message: proof.message,
          signature: proof.signature,
        }),
      ),
    ).toEqual({ code: "FORBIDDEN", message: "NONCE_USER_MISMATCH" });

    expect(r.store.walletOwner(bobKey.address)).toBeUndefined();
  });

  test("Alice cannot take over an address Bob has already proven", async () => {
    const r = await rig();
    const shared = makeWallet();

    const bobProof = await proveFor(r.bob, "tok-bob", shared);
    await r.bob.linkWallet({
      supabaseAccessToken: "tok-bob",
      address: shared.address,
      message: bobProof.message,
      signature: bobProof.signature,
    });
    expect(r.store.walletOwner(shared.address)).toBe("user-bob");

    // Alice now holds the private key too (she "bought" it, or it was shared).
    // Her proof is cryptographically perfect. It still must not repoint the
    // address, because an active address maps to exactly one user.
    const aliceProof = await proveFor(r.alice, "tok-alice", shared);
    expect(
      await trpcFailure(() =>
        r.alice.linkWallet({
          supabaseAccessToken: "tok-alice",
          address: shared.address,
          message: aliceProof.message,
          signature: aliceProof.signature,
        }),
      ),
    ).toEqual({ code: "CONFLICT", message: "WALLET_OWNED_BY_ANOTHER_USER" });

    expect(r.store.walletOwner(shared.address)).toBe("user-bob");
  });

  test("a challenge Alice requests is bound to Alice even when she names Bob's address", async () => {
    const r = await rig();
    const bobKey = makeWallet();

    const issued = await r.alice.requestWalletNonce({
      supabaseAccessToken: "tok-alice",
      address: bobKey.address,
      domain: TEST_DOMAIN,
      uri: TEST_URI,
    });
    // Nothing in the issued message names Bob. Requesting a challenge for an
    // address is not a claim on it; only a signature is.
    expect(parseSiwsMessage(issued.message).address).toBe(bobKey.address);
    expect(r.store.walletOwner(bobKey.address)).toBeUndefined();

    // And if Bob's key does sign it, the link lands on ALICE — because the
    // challenge was issued to her session. It is her wallet claim to make.
    const linked = await r.alice.linkWallet({
      supabaseAccessToken: "tok-alice",
      address: bobKey.address,
      message: issued.message,
      signature: signMessage(bobKey.privateKey, issued.message),
    });
    expect(linked.userId).toBe("user-alice");
  });
});

describe("authRouter — legacy_identity_claims is unreachable by a client", () => {
  test("no procedure returns, counts, or confirms the existence of another user's claim", async () => {
    const r = await rig();

    // Bob records his own legacy mapping.
    const bobClaim = await r.bob.claimLegacyIdentity({
      supabaseAccessToken: "tok-bob",
      legacyProvider: "privy",
    });
    expect(bobClaim.outcome).toBe("claimed");
    expect(r.store.claimFor("privy", "privy:bob")?.userId).toBe("user-bob");

    // Alice's own claim tells her nothing at all about Bob's.
    const aliceClaim = await r.alice.claimLegacyIdentity({
      supabaseAccessToken: "tok-alice",
      legacyProvider: "privy",
    });
    expect(aliceClaim.userId).toBe("user-alice");
    expect(JSON.stringify(aliceClaim)).not.toContain("privy:bob");
    expect(JSON.stringify(aliceClaim)).not.toContain("user-bob");
  });

  test("the legacy subject is server-derived — a forged input field is inert", async () => {
    const r = await rig();
    await r.bob.claimLegacyIdentity({ supabaseAccessToken: "tok-bob", legacyProvider: "privy" });

    // Alice tries to name Bob's legacy identity. The input schema has no such
    // field, so zod strips it; the subject comes off her verified context.
    const forged = { supabaseAccessToken: "tok-alice", legacyProvider: "privy", legacySubject: "privy:bob" };
    const result = await r.alice.claimLegacyIdentity(
      forged as unknown as { supabaseAccessToken: string; legacyProvider: "privy" },
    );

    expect(result.userId).toBe("user-alice");
    // Bob's mapping is untouched, and Alice's landed on her OWN subject.
    expect(r.store.claimFor("privy", "privy:bob")?.userId).toBe("user-bob");
    expect(r.store.claimFor("privy", "privy:alice")?.userId).toBe("user-alice");
  });

  test("an anonymous caller cannot claim at all", async () => {
    const r = await rig();
    expect(
      await trpcFailure(() => r.anon.claimLegacyIdentity({ supabaseAccessToken: "tok-alice", legacyProvider: "privy" })),
    ).toMatchObject({ code: "UNAUTHORIZED" });
  });
});
