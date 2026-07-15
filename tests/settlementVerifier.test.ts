/**
 * The on-chain verification gate: resolveMatch() must never settle a match on
 * a reported score that hasn't been corroborated. StubSettlementVerifier lets
 * us force both outcomes deterministically, without any live devnet dependency.
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, wal, type MatchId } from "../src/domain/ids.ts";
import { StubSettlementVerifier } from "../src/ports/SettlementVerifier.ts";

const FIXED_NOW = 1_750_000_000_000;

async function freshApp(verifier: StubSettlementVerifier) {
  const app = await createApp({ config: loadConfig({}), now: FIXED_NOW, settlementVerifier: verifier });
  await app.engine.syncFixtures();
  return app;
}

describe("SettlementVerifier gate", () => {
  test("resolveMatch is a no-op when verification fails", async () => {
    const verifier = new StubSettlementVerifier();
    const app = await freshApp(verifier);
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    verifier.setVerified(matchId, false);

    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
    await alice.signContract({ handle: "Alice" });
    await alice.deposit({ amount: wal(100) });
    await alice.makeCall({ matchId, bucket: "HOME", stake: wal(10) });

    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });

    const match = app.readModel.pots.getMatch(matchId);
    expect(match?.status).not.toBe("RESOLVED"); // left exactly as-is, not settled on unverified data

    const me = await alice.me();
    expect(me!.record.won).toBe(0);
    expect(me!.record.lost).toBe(0); // no settlement happened at all
  });

  test("resolveMatch settles normally once verification passes", async () => {
    const verifier = new StubSettlementVerifier();
    const app = await freshApp(verifier);
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    verifier.setVerified(matchId, true);

    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
    const bob = appRouter.createCaller({ app, wallet: asWallet("0xbob") });
    await alice.signContract({ handle: "Alice" });
    await alice.deposit({ amount: wal(100) });
    await bob.signContract({ handle: "Bob" });
    await bob.deposit({ amount: wal(100) });
    await alice.makeCall({ matchId, bucket: "HOME", stake: wal(10) });
    await bob.makeCall({ matchId, bucket: "AWAY", stake: wal(10) });

    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });

    expect(app.readModel.pots.getMatch(matchId)?.status).toBe("RESOLVED");
    const me = await alice.me();
    expect(me!.record.won).toBe(1);
  });

  test("tick() naturally retries an unverified match on the next pass", async () => {
    const verifier = new StubSettlementVerifier();
    const app = await freshApp(verifier);
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    verifier.setVerified(matchId, false);

    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
    await alice.signContract({ handle: "Alice" });
    await alice.deposit({ amount: wal(100) });
    await alice.makeCall({ matchId, bucket: "HOME", stake: wal(10) });

    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });
    expect(app.readModel.pots.getMatch(matchId)?.status).not.toBe("RESOLVED");

    // TxLINE "posts the root" — flip the stub and resolve again.
    verifier.setVerified(matchId, true);
    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });
    expect(app.readModel.pots.getMatch(matchId)?.status).toBe("RESOLVED");
  });

  test("default wiring (no txline config) stubs verification to always-pass", async () => {
    // No settlementVerifier override, no TXLINE_* env — createApp must still
    // wire a StubSettlementVerifier(true) so existing behaviour is unchanged.
    const app = await createApp({ config: loadConfig({}), now: FIXED_NOW });
    await app.engine.syncFixtures();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;

    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
    await alice.signContract({ handle: "Alice" });
    await alice.deposit({ amount: wal(100) });
    await alice.makeCall({ matchId, bucket: "HOME", stake: wal(10) });

    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });
    expect(app.readModel.pots.getMatch(matchId)?.status).toBe("RESOLVED");
  });

  test("a 1-v-1 challenge stays escrowed until the score is verified, then pays the winner", async () => {
    const verifier = new StubSettlementVerifier();
    const app = await freshApp(verifier);
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    verifier.setVerified(matchId, false);

    const alice = appRouter.createCaller({ app, wallet: asWallet("0xchalA") });
    const bob = appRouter.createCaller({ app, wallet: asWallet("0xchalB") });
    for (const [c, h] of [[alice, "A"], [bob, "B"]] as const) {
      await c.signContract({ handle: h });
      await c.deposit({ amount: wal(100) });
    }
    const { challengeId } = await alice.createChallenge({ matchId, side: "HOME", stake: wal(10) });
    await bob.acceptChallenge({ challengeId });

    // Unverified: resolve must settle NOTHING — both stakes stay escrowed.
    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });
    expect((await alice.challenge({ challengeId }))!.status).toBe("MATCHED");
    expect((await alice.me())!.locked).toBe(wal(10));
    expect((await bob.me())!.locked).toBe(wal(10));

    // Root posts → verified → the challenge settles behind the same gate; HOME (Alice) wins.
    verifier.setVerified(matchId, true);
    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });
    expect((await alice.challenge({ challengeId }))!.status).toBe("SETTLED");
    expect((await alice.me())!.locked).toBe(wal(0));
    expect((await alice.me())!.balance).toBeGreaterThan(wal(100)); // won Bob's stake, less rake
    expect((await bob.me())!.balance).toBe(wal(90));
  });
});
