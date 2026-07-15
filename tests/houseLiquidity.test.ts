/**
 * House liquidity + the demo "resolve now" endpoint. The point of house bots is
 * that a SOLO player's bet actually settles (wins or loses real WAL) instead of
 * voiding for a thin pool — the thing that makes the product demoable alone.
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asMarketId, asWallet, isHouseWallet, wal, type MatchId } from "../src/domain/ids.ts";

const FIXED_NOW = 1_750_000_000_000;

async function freshApp(env: Record<string, string | undefined> = {}) {
  const app = await createApp({ config: loadConfig(env), now: FIXED_NOW });
  await app.engine.syncFixtures();
  return app;
}

describe("house liquidity", () => {
  test("a solo player's bet settles for real instead of voiding", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;

    const solo = appRouter.createCaller({ app, wallet: asWallet("0xsolo") });
    await solo.signContract({ handle: "Solo" });
    await solo.deposit({ amount: wal(10) });

    // Only ONE real player bets. Without house liquidity this voids (minParticipants=3).
    await solo.makeCall({ matchId, bucket: "HOME", stake: wal(2) });

    // The house seeded the other outcomes → real money on the other side.
    const market = app.readModel.pots.getMatch(matchId)!.markets.find((m) => m.marketId === "RESULT")!;
    expect(market.grossPot).toBeGreaterThan(wal(2));

    // HOME wins → the solo player wins real WAL from the house's losing stakes.
    await app.engine.resolveMatch(matchId, { home: 1, away: 0 });

    const me = await solo.me();
    expect(me!.record.won).toBe(1); // settled as a WIN…
    expect(me!.record.voided).toBe(0); // …not voided
    expect(me!.balance).toBeGreaterThan(wal(10)); // profited beyond the 10 deposited
  });

  test("a losing solo bet actually loses to the house", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;

    const solo = appRouter.createCaller({ app, wallet: asWallet("0xsolo2") });
    await solo.signContract({ handle: "Solo2" });
    await solo.deposit({ amount: wal(10) });
    await solo.makeCall({ matchId, bucket: "HOME", stake: wal(2) });

    // HOME loses (away win) → stake is gone, not refunded.
    await app.engine.resolveMatch(matchId, { home: 0, away: 1 });

    const me = await solo.me();
    expect(me!.record.lost).toBe(1);
    expect(me!.record.voided).toBe(0);
    expect(me!.balance).toBe(wal(8)); // 10 − 2 staked, nothing back
  });

  test("house bots never appear on the leaderboard", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const solo = appRouter.createCaller({ app, wallet: asWallet("0xsolo3") });
    await solo.signContract({});
    await solo.deposit({ amount: wal(10) });
    await solo.makeCall({ matchId, bucket: "HOME", stake: wal(2) });

    const ladder = await solo.leaderboard({ by: "gr" });
    expect(ladder.length).toBe(1); // only the real player
    expect(ladder.every((e) => !isHouseWallet(e.wallet))).toBe(true);
  });

  test("house exposure stays within the liquidity cap", async () => {
    // Cap 5 USDC, 3 bots → each clamped to 5/3 ≈ 1.66 USDC, never 10.
    const app = await freshApp({ HOUSE_LIQUIDITY_CAP_FROST: "5000000", HOUSE_BANKROLL_FROST: "10000000" });
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const solo = appRouter.createCaller({ app, wallet: asWallet("0xsolo4") });
    await solo.signContract({});
    await solo.deposit({ amount: wal(10) });
    await solo.makeCall({ matchId, bucket: "HOME", stake: wal(1) });

    const botBankrolls = [0, 1, 2]
      .map((i) => app.readModel.getDossier(asWallet(`house:bot:${i}`)))
      .filter(Boolean)
      .map((d) => d!.balance + d!.locked); // funded capital = free + staked
    const total = botBankrolls.reduce((a, b) => a + b, 0n);
    expect(total).toBeLessThanOrEqual(wal(5)); // never exceeds the cap
  });

  test("disabling house liquidity reverts to thin-pool voids", async () => {
    const app = await freshApp({ HOUSE_LIQUIDITY_ENABLED: "false" });
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const solo = appRouter.createCaller({ app, wallet: asWallet("0xsolo5") });
    await solo.signContract({});
    await solo.deposit({ amount: wal(10) });
    await solo.makeCall({ matchId, bucket: "HOME", stake: wal(2) });

    await app.engine.resolveMatch(matchId, { home: 1, away: 0 });
    const me = await solo.me();
    expect(me!.record.voided).toBe(1); // no counterparty → thin-pool void + refund
    expect(me!.balance).toBe(wal(10)); // stake refunded
  });
});

describe("demo resolve endpoint", () => {
  test("rejects when no admin key is configured", async () => {
    const app = await freshApp(); // no DEMO_ADMIN_KEY
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const ops = appRouter.createCaller({ app });
    await expect(ops.resolveMatchNow({ matchId, home: 1, away: 0, key: "anything" })).rejects.toThrow();
  });

  test("settles a match when the key matches, rejects when it doesn't", async () => {
    const app = await freshApp({ DEMO_ADMIN_KEY: "s3cret" });
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const solo = appRouter.createCaller({ app, wallet: asWallet("0xsolo6") });
    await solo.signContract({});
    await solo.deposit({ amount: wal(10) });
    await solo.makeCall({ matchId, bucket: "AWAY", stake: wal(2) });

    const ops = appRouter.createCaller({ app });
    await expect(ops.resolveMatchNow({ matchId, home: 1, away: 0, key: "wrong" })).rejects.toThrow();

    const res = await ops.resolveMatchNow({ matchId, home: 0, away: 2, key: "s3cret" });
    expect(res.ok).toBe(true);
    const me = await solo.me();
    expect(me!.record.won).toBe(1); // AWAY won 0–2
  });

  test("seeds a counterparty before settling, rescuing an unseeded solo bet", async () => {
    const app = await freshApp({ DEMO_ADMIN_KEY: "k" }); // house enabled
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const w = asWallet("0xstranded");
    const solo = appRouter.createCaller({ app, wallet: w });
    await solo.signContract({});
    await solo.deposit({ amount: wal(10) });

    // Bet straight through the actor → bypasses engine.makeCall's just-in-time
    // seeding, simulating a bet placed before house liquidity existed.
    await app.engine.registry.for(w).makeCall({ matchId, marketId: asMarketId("RESULT"), bucket: "HOME", stake: wal(2) });

    // On its own this would void. The resolve endpoint seeds a counterparty first.
    const ops = appRouter.createCaller({ app });
    await ops.resolveMatchNow({ matchId, home: 1, away: 0, key: "k" });

    const me = await solo.me();
    expect(me!.record.won).toBe(1); // settled for real…
    expect(me!.record.voided).toBe(0); // …not voided
  });
});
