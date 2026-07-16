/**
 * End-to-end through the real tRPC router (createCaller) — exercises the auth
 * context, command mutations, the domain→tRPC error mapping, and the query side,
 * all against an in-memory app (no keys, no network).
 */

import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, wal, type MatchId } from "../src/domain/ids.ts";

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
});
