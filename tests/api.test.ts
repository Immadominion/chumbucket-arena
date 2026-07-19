/**
 * End-to-end through the real tRPC router (createCaller) — exercises the auth
 * context, command mutations, the domain→tRPC error mapping, and the query side,
 * all against an in-memory app (no keys, no network).
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../src/api/router.ts";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, wal, type MatchId } from "../src/domain/ids.ts";
import { socialActionMessage } from "../src/auth/WalletSignature.ts";

const FIXED_NOW = 1_750_000_000_000;

async function freshApp() {
  // Empty env → in-memory store/memory, scripted Gaffer, dev auth, mock fixtures.
  const app = await createApp({ config: loadConfig({}), now: FIXED_NOW });
  await app.engine.syncFixtures();
  return app;
}

describe("tRPC API", () => {
  test("health exposes production readiness flags without secrets", async () => {
    const app = await createApp({
      config: loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
        SOLANA_NETWORK: "devnet",
        HELIUS_WEBHOOK_AUTH: "webhook-secret",
      }),
    });
    const anon = appRouter.createCaller({ app });

    const health = await anon.health();
    expect(health.readiness).toEqual({
      eventLogPersistent: false,
      socialStore: true,
      socialNetwork: "devnet",
      heliusWebhookAuth: true,
      txlineSettlement: false,
    });
    const exposedReadiness = JSON.stringify({ wiring: health.wiring, readiness: health.readiness });
    expect(exposedReadiness).not.toContain("service-role-secret");
    expect(exposedReadiness).not.toContain("webhook-secret");

    const socialStatus = await anon.socialStatus();
    expect(socialStatus).toEqual({
      enabled: true,
      wiring: "supabase",
      network: "devnet",
      heliusWebhookAuth: true,
    });
  });

  test("full loop through the router: sign → deposit → call → settle → read", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;

    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
    const bob = appRouter.createCaller({ app, wallet: asWallet("0xbob") });
    const cara = appRouter.createCaller({ app, wallet: asWallet("0xcara") });

    for (const [caller, name] of [
      [alice, "Alice"],
      [bob, "Bob"],
      [cara, "Cara"],
    ] as const) {
      await caller.signContract({ handle: name });
      await caller.deposit({ amount: wal(100) });
    }

    await alice.makeCall({ matchId, bucket: "HOME", stake: wal(10) });
    await cara.makeCall({ matchId, bucket: "HOME", stake: wal(30) });
    await bob.makeCall({ matchId, bucket: "AWAY", stake: wal(40) });

    // Resolve is a system op (ingestion), not a player command.
    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });
    await app.memoryWriter.drain();

    const me = await alice.me();
    expect(me?.record.won).toBe(1);
    expect(me!.balance).toBeGreaterThan(wal(100)); // got the pot share back

    const ladder = await alice.leaderboard({ by: "gr" });
    expect(ladder.length).toBe(3);
    expect(ladder[0]!.rank).toBe(1);
  });

  test("authed procedures reject a logged-out caller", async () => {
    const app = await freshApp();
    const anon = appRouter.createCaller({ app }); // no wallet
    await expect(anon.me()).rejects.toThrow(/wallet/i);
    await expect(anon.makeCall({ matchId: "x", bucket: "HOME", stake: wal(1) })).rejects.toThrow();
  });

  test("public dossier omits the private money columns", async () => {
    const app = await freshApp();
    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
    await alice.signContract({});
    const anon = appRouter.createCaller({ app });
    const pub = await anon.dossier({ wallet: "0xalice" });
    expect(pub).not.toBeNull();
    expect(pub as object).not.toHaveProperty("balance");
    expect(pub as object).not.toHaveProperty("bonus");
    expect(pub as object).not.toHaveProperty("openCalls");
  });

  test("domain errors map to tRPC codes (insufficient balance)", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const dave = appRouter.createCaller({ app, wallet: asWallet("0xdave") });
    await dave.signContract({});
    // no deposit → staking must fail
    await expect(dave.makeCall({ matchId, bucket: "HOME", stake: wal(10) })).rejects.toThrow();
  });

  test("welcome grant: spendable on calls, not withdrawable, one-time", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const eve = appRouter.createCaller({ app, wallet: asWallet("0xeve") });
    await eve.signContract({ handle: "Eve" });

    await eve.claimWelcomeGrant();
    let me = await eve.me();
    expect(me!.bonus).toBe(wal(50));
    expect(me!.balance).toBe(0n);

    // one-time: a second claim is rejected
    await expect(eve.claimWelcomeGrant()).rejects.toThrow();

    // bonus is spendable on a call with no deposit
    await eve.makeCall({ matchId, bucket: "HOME", stake: wal(10) });
    me = await eve.me();
    expect(me!.bonus).toBe(wal(40));
    expect(me!.locked).toBe(wal(10));
    expect(me!.balance).toBe(0n);

    // ...but it cannot be withdrawn — only free balance is
    await expect(eve.withdraw({ amount: wal(5) })).rejects.toThrow(/balance/i);
  });

  test("withdrawal takes a house fee that covers gas", async () => {
    const app = await freshApp();
    const al = appRouter.createCaller({ app, wallet: asWallet("0xfee") });
    await al.signContract({ handle: "Fee" });
    await al.deposit({ amount: wal(10) });
    const res = await al.withdraw({ amount: wal(5) });
    expect(res.fee).toBe(100_000n); // max(2% of 5 USDC, 0.05 USDC flat) = 0.1 USDC
    expect(res.net).toBe(4_900_000n); // 5 USDC − 0.1 USDC reaches the player
    const me = await al.me();
    expect(me!.balance).toBe(wal(5)); // gross 5 WAL left the balance
  });

  // A wallet-signature rejection is a CLIENT error. These mutations throw
  // DomainError("INVALID") directly (not via guard()); the mapDomainErrors
  // middleware must still translate that to BAD_REQUEST (400), so a bad proof
  // is never surfaced or logged as INTERNAL_SERVER_ERROR (500).
  test("a bad wallet-signature on follow maps to BAD_REQUEST, not INTERNAL_SERVER_ERROR", async () => {
    const app = await freshApp();
    const anon = appRouter.createCaller({ app });
    try {
      await anon.follow({
        wallet: "34cts2e8euGAHCNrkC9damXAcgyR9FpTiSbC9Sw1DYz9",
        target: "9b6qd61UqFaHgeCtZ1wFETiwBzkBvJaJavSvaNwiYqtz",
        timestamp: FIXED_NOW,
        signature: "1".repeat(64),
      });
      throw new Error("expected follow to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(TRPCError);
      expect((e as TRPCError).code).toBe("BAD_REQUEST");
      expect((e as TRPCError).message).toMatch(/follow rejected/i);
    }
  });

  describe("createPendingTarget / pendingTargets", () => {
    const bs58 = utils.bytes.bs58;
    function makeWallet() {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const der = publicKey.export({ format: "der", type: "spki" });
      const raw = new Uint8Array(der.subarray(der.length - 32));
      return { privateKey, walletB58: bs58.encode(raw) };
    }
    function signB58(privateKey: KeyObject, message: string): string {
      return bs58.encode(new Uint8Array(nodeSign(null, Buffer.from(message), privateKey)));
    }

    test("a valid wallet-signature proof creates a pending target through the social store", async () => {
      const calls: Array<{ wallet: string; provider: string; providerUsername: string }> = [];
      const fakeSocial = {
        enabled: true,
        async createPendingTarget(wallet: string, provider: string, providerUsername: string) {
          calls.push({ wallet, provider, providerUsername });
          return { id: "pt-1", resolvedWalletAddress: null, alreadyResolved: false };
        },
      };
      const app = await createApp({
        config: loadConfig({}),
        now: FIXED_NOW,
        social: fakeSocial as unknown as App["social"],
      });
      const anon = appRouter.createCaller({ app });

      const { privateKey, walletB58 } = makeWallet();
      const providerUsername = "satoshi";
      // The procedure freshness-checks against the real wall clock (Date.now()),
      // not the engine's FIXED_NOW — sign for "now", not the fixture's frozen time.
      const ts = Date.now();
      const signature = signB58(privateKey, socialActionMessage("add_pending_target", providerUsername, "devnet", ts));

      const result = await anon.createPendingTarget({
        wallet: walletB58,
        providerUsername,
        timestamp: ts,
        signature,
      });

      expect(result).toEqual({ id: "pt-1", resolvedWalletAddress: null, alreadyResolved: false });
      expect(calls).toEqual([{ wallet: walletB58, provider: "twitter", providerUsername: "satoshi" }]);
    });

    // Same well-established pattern as the follow rejection test above: a bad
    // proof throws DomainError("INVALID") directly (not via guard()), and the
    // mapDomainErrors middleware must still translate that to BAD_REQUEST.
    test("a bad wallet-signature on createPendingTarget maps to BAD_REQUEST, not INTERNAL_SERVER_ERROR", async () => {
      const app = await freshApp();
      const anon = appRouter.createCaller({ app });
      try {
        await anon.createPendingTarget({
          wallet: "34cts2e8euGAHCNrkC9damXAcgyR9FpTiSbC9Sw1DYz9",
          providerUsername: "satoshi",
          timestamp: FIXED_NOW,
          signature: "1".repeat(64),
        });
        throw new Error("expected createPendingTarget to reject");
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).code).toBe("BAD_REQUEST");
        expect((e as TRPCError).message).toMatch(/add-target rejected/i);
      }
    });

    // Even with a validly-signed proof, an empty (or whitespace-only) handle
    // must be rejected before it ever reaches the social store — otherwise a
    // direct API call bypassing the client's normalizeHandle() could create a
    // permanently-unresolvable blank-handle pending target.
    test("an empty providerUsername is rejected by input validation, not stored", async () => {
      const app = await freshApp();
      const anon = appRouter.createCaller({ app });

      const { privateKey, walletB58 } = makeWallet();
      const ts = Date.now();
      const signature = signB58(privateKey, socialActionMessage("add_pending_target", "  ", "devnet", ts));

      try {
        await anon.createPendingTarget({
          wallet: walletB58,
          providerUsername: "  ",
          timestamp: ts,
          signature,
        });
        throw new Error("expected createPendingTarget to reject an empty handle");
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).code).toBe("BAD_REQUEST");
      }
    });

    // Garbage that would never match a real OAuth-linked X screen name
    // (too long, or containing characters X handles can't have) should be
    // rejected as BAD_REQUEST by input validation, not silently stored as a
    // permanently-unresolvable pending_identity_targets row.
    test("a too-long providerUsername is rejected by input validation", async () => {
      const app = await freshApp();
      const anon = appRouter.createCaller({ app });

      const { privateKey, walletB58 } = makeWallet();
      const ts = Date.now();
      const tooLong = "a".repeat(16); // X handles max out at 15 chars
      const signature = signB58(privateKey, socialActionMessage("add_pending_target", tooLong, "devnet", ts));

      try {
        await anon.createPendingTarget({
          wallet: walletB58,
          providerUsername: tooLong,
          timestamp: ts,
          signature,
        });
        throw new Error("expected createPendingTarget to reject a too-long handle");
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).code).toBe("BAD_REQUEST");
      }
    });

    test("a providerUsername with disallowed characters is rejected by input validation", async () => {
      const app = await freshApp();
      const anon = appRouter.createCaller({ app });

      const { privateKey, walletB58 } = makeWallet();
      const ts = Date.now();
      const garbage = "my friend bob";
      const signature = signB58(privateKey, socialActionMessage("add_pending_target", garbage, "devnet", ts));

      try {
        await anon.createPendingTarget({
          wallet: walletB58,
          providerUsername: garbage,
          timestamp: ts,
          signature,
        });
        throw new Error("expected createPendingTarget to reject a handle with spaces");
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).code).toBe("BAD_REQUEST");
      }
    });

    test("pendingTargets reads through to the social store", async () => {
      const row = {
        id: "pt-1",
        network: "devnet",
        provider: "twitter",
        provider_username: "satoshi",
        created_by_wallet: "wallet1",
        target_type: "follow",
        target_ref: null,
        resolved_wallet_address: null,
        created_at: "2026-07-19T00:00:00Z",
        resolved_at: null,
      };
      const fakeSocial = {
        enabled: true,
        async pendingTargets(wallet: string, limit: number) {
          expect(wallet).toBe("wallet1");
          expect(limit).toBe(50);
          return [row];
        },
      };
      const app = await createApp({
        config: loadConfig({}),
        now: FIXED_NOW,
        social: fakeSocial as unknown as App["social"],
      });
      const anon = appRouter.createCaller({ app });
      const rows = await anon.pendingTargets({ wallet: "wallet1", limit: 50 });
      expect(rows).toEqual([row]);
    });
  });

  describe("linkIdentityFromPrivy", () => {
    test("links every X/Google identity Privy already reports for the caller", async () => {
      const linkCalls: Array<{ wallet: string; identity: unknown }> = [];
      const fakeAuth = {
        async verify() {
          return null;
        },
        async fetchLinkedIdentities(userId: string) {
          expect(userId).toBe("privy-user-1");
          return [
            { provider: "twitter", subject: "tw-1", username: "satoshi", displayName: "Satoshi" },
            { provider: "google", subject: "gg-1", displayName: "Alice", email: "a@b.com" },
          ];
        },
      };
      const fakeSocial = {
        enabled: true,
        async linkIdentity(wallet: string, identity: unknown) {
          linkCalls.push({ wallet, identity });
          return { ok: true };
        },
      };
      const app = await createApp({
        config: loadConfig({}),
        now: FIXED_NOW,
        auth: fakeAuth as unknown as App["auth"],
        social: fakeSocial as unknown as App["social"],
      });

      const caller = appRouter.createCaller({
        app,
        wallet: asWallet("0xalice"),
        privyUserId: "privy-user-1",
      });
      const result = await caller.linkIdentityFromPrivy();

      expect(result).toEqual({ linked: ["twitter", "google"] });
      expect(linkCalls.length).toBe(2);
      expect(linkCalls[0]).toEqual({
        wallet: "0xalice",
        identity: { provider: "twitter", subject: "tw-1", username: "satoshi", displayName: "Satoshi" },
      });
      expect(linkCalls[1]).toEqual({
        wallet: "0xalice",
        identity: { provider: "google", subject: "gg-1", displayName: "Alice", email: "a@b.com" },
      });
    });

    test("requires a wallet (authedProcedure) — anon rejects with UNAUTHORIZED", async () => {
      const app = await freshApp();
      const anon = appRouter.createCaller({ app, privyUserId: "privy-user-1" });
      try {
        await anon.linkIdentityFromPrivy();
        throw new Error("expected linkIdentityFromPrivy to reject");
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).code).toBe("UNAUTHORIZED");
      }
    });

    test("rejects when the context has no privyUserId at all (e.g. dev-auth wallet header)", async () => {
      const app = await freshApp();
      const caller = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
      try {
        await caller.linkIdentityFromPrivy();
        throw new Error("expected linkIdentityFromPrivy to reject");
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).code).toBe("BAD_REQUEST");
        expect((e as TRPCError).message).toMatch(/no privy session/i);
      }
    });
  });
});
