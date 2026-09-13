/**
 * Legacy identity claims: idempotency, and the rule that a claim can never be
 * made from unverified client input alone.
 *
 * Two independent defences are asserted here, because one of them will
 * eventually be bypassed by a future caller:
 *
 *   1. Route level — `claimLegacyIdentity` has no `legacySubject` input at all.
 *      The subject is read off the server-verified auth context, so a client
 *      cannot name which legacy account it is claiming, and the route refuses
 *      outright when the wired Auth adapter is the `dev` one that verifies
 *      nothing.
 *   2. Store level — the evidence kind must be one of the four server-verified
 *      values. The SQL CHECK constraint enforces the same whitelist, so even a
 *      direct service-role call cannot record a client-asserted claim.
 */

import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { authRouter } from "../src/api/authRoutes.ts";
import { primeAuthIdentityRuntime } from "../src/auth/AuthIdentityRuntime.ts";
import { AuthIdentityError } from "../src/auth/AuthIdentityError.ts";
import { WalletLinkService } from "../src/auth/WalletLinkService.ts";
import type { Auth, AuthedUser } from "../src/auth/Auth.ts";
import type { OAuthIdentity } from "../src/social/SocialStore.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet } from "../src/domain/ids.ts";
import { FakeIdentityStore, FakeJwtVerifier, testPolicy } from "./authIdentityFixtures.ts";

const ALICE_WALLET = "AL1ceWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

function directService() {
  const store = new FakeIdentityStore();
  store.addUser("auth-alice", "user-alice");
  store.addUser("auth-bob", "user-bob");
  const verifier = new FakeJwtVerifier().issue("tok-alice", "auth-alice").issue("tok-bob", "auth-bob");
  const service = new WalletLinkService({
    store,
    verifier,
    policy: {
      ...testPolicy,
      allowedDomains: [...testPolicy.allowedDomains],
      allowedUris: [...testPolicy.allowedUris],
    },
  });
  return { store, service };
}

async function routerRig(opts: { devAuth: boolean }) {
  const config = loadConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    SOLANA_NETWORK: "devnet",
  });
  const app = await createApp({
    config,
    // Omitting `auth` leaves the dev adapter wired (wiring.auth === "dev").
    ...(opts.devAuth
      ? {}
      : { auth: new StubProviderAuth({ "privy-alice": { userId: "privy:alice", wallet: ALICE_WALLET } }) }),
  });

  const store = new FakeIdentityStore();
  store.addUser("auth-alice", "user-alice");
  const verifier = new FakeJwtVerifier().issue("tok-alice", "auth-alice");
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
  };
}

describe("legacy claims — idempotency", () => {
  test("claiming twice is a no-op: one row, unchanged state", async () => {
    const { store, service } = directService();

    const first = await service.claimLegacyIdentity({
      accessToken: "tok-alice",
      legacyProvider: "privy",
      legacySubject: "did:privy:alice",
      evidence: "privy_session",
    });
    expect(first).toMatchObject({ userId: "user-alice", state: "PENDING", outcome: "claimed" });

    const second = await service.claimLegacyIdentity({
      accessToken: "tok-alice",
      legacyProvider: "privy",
      legacySubject: "did:privy:alice",
      evidence: "privy_session",
    });
    expect(second).toMatchObject({ userId: "user-alice", state: "PENDING", outcome: "already_claimed" });
    expect(second.claimId).toBe(first.claimId as string);
    expect(store.claimCount()).toBe(1);
  });

  test("claiming twice through the router is also a no-op", async () => {
    const r = await routerRig({ devAuth: false });

    const a = await r.alice.claimLegacyIdentity({ supabaseAccessToken: "tok-alice", legacyProvider: "privy" });
    const b = await r.alice.claimLegacyIdentity({ supabaseAccessToken: "tok-alice", legacyProvider: "privy" });

    expect(a.outcome).toBe("claimed");
    expect(b.outcome).toBe("already_claimed");
    expect(b.claimId).toBe(a.claimId as string);
    expect(r.store.claimCount()).toBe(1);
  });

  test("a legacy subject already mapped to someone else is never repointed", async () => {
    const { store, service } = directService();

    await service.claimLegacyIdentity({
      accessToken: "tok-bob",
      legacyProvider: "privy",
      legacySubject: "did:privy:contested",
      evidence: "privy_session",
    });

    let caught: unknown;
    try {
      await service.claimLegacyIdentity({
        accessToken: "tok-alice",
        legacyProvider: "privy",
        legacySubject: "did:privy:contested",
        evidence: "privy_session",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthIdentityError);
    expect((caught as AuthIdentityError).code).toBe("LEGACY_CLAIMED_BY_ANOTHER_USER");
    expect(store.claimFor("privy", "did:privy:contested")?.userId).toBe("user-bob");
    expect(store.claimCount()).toBe(1);
  });
});

describe("legacy claims — a claim cannot rest on unverified client input", () => {
  test("the dev Auth adapter (which verifies nothing) cannot produce a claim", async () => {
    const r = await routerRig({ devAuth: true });
    expect(r.app.wiring.auth).toBe("dev");

    // The transport context is fully populated — the caller looks authenticated
    // in every way the router can see. It is still refused, because the adapter
    // behind that context treats the credential itself as the identity.
    let code = "NO_ERROR";
    let message = "NO_ERROR";
    try {
      await r.alice.claimLegacyIdentity({ supabaseAccessToken: "tok-alice", legacyProvider: "privy" });
    } catch (e) {
      if (e instanceof TRPCError) {
        code = e.code;
        message = e.message;
      }
    }
    expect({ code, message }).toEqual({ code: "FORBIDDEN", message: "LEGACY_EVIDENCE_UNVERIFIED" });
    expect(r.store.claimCount()).toBe(0);
  });

  test("an evidence kind outside the server-verified whitelist is refused at the store", async () => {
    const { store, service } = directService();

    let caught: unknown;
    try {
      await service.claimLegacyIdentity({
        accessToken: "tok-alice",
        legacyProvider: "privy",
        legacySubject: "did:privy:alice",
        // Deliberately outside the four permitted kinds. The SQL CHECK
        // constraint models the same whitelist, so this cannot be stored even
        // by a direct service-role call.
        evidence: "client_asserted" as never,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthIdentityError);
    expect((caught as AuthIdentityError).code).toBe("LEGACY_EVIDENCE_UNVERIFIED");
    expect(store.claimCount()).toBe(0);
  });

  test("an empty legacy subject is refused rather than stored as a blank mapping", async () => {
    const { store, service } = directService();
    let caught: unknown;
    try {
      await service.claimLegacyIdentity({
        accessToken: "tok-alice",
        legacyProvider: "privy",
        legacySubject: "   ",
        evidence: "privy_session",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthIdentityError);
    expect((caught as AuthIdentityError).code).toBe("LEGACY_CLAIM_FAILED");
    expect(store.claimCount()).toBe(0);
  });

  test("a claim still requires a valid Supabase session, not just a legacy one", async () => {
    const { store, service } = directService();
    let caught: unknown;
    try {
      await service.claimLegacyIdentity({
        accessToken: "tok-forged",
        legacyProvider: "privy",
        legacySubject: "did:privy:alice",
        evidence: "privy_session",
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as AuthIdentityError).code).toBe("AUTH_TOKEN_INVALID");
    expect(store.claimCount()).toBe(0);
  });
});
