/**
 * 1-v-1 Challenges — private two-party escrows settled by the match result.
 * The whole point: winner takes 2·stake − rake, a result nobody picked refunds
 * both, and none of it touches the communal parimutuel pool or its thin-pool
 * guard. These lock in the money math the on-chain settle_pot mirrors.
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, wal, type MatchId } from "../src/domain/ids.ts";

const FIXED_NOW = 1_750_000_000_000;

async function freshApp() {
  const app = await createApp({ config: loadConfig({}), now: FIXED_NOW });
  await app.engine.syncFixtures();
  return app;
}

/** A signed, funded player caller (no welcome grant → bonus stays 0, clean money math). */
async function player(app: Awaited<ReturnType<typeof freshApp>>, id: string, deposit = 10) {
  const caller = appRouter.createCaller({ app, wallet: asWallet(id) });
  await caller.signContract({ handle: id });
  await caller.deposit({ amount: wal(deposit) });
  return caller;
}

describe("1-v-1 challenges", () => {
  test("create → accept → creator's side wins: winner paid 2·stake − rake, loser loses stake", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const creator = await player(app, "0xcreator");
    const opponent = await player(app, "0xopponent");

    const { challengeId } = await creator.createChallenge({ matchId, side: "HOME", stake: wal(2) });
    await opponent.acceptChallenge({ challengeId });

    // Both stakes locked, nothing spent yet.
    expect((await creator.me())!.locked).toBe(wal(2));
    expect((await opponent.me())!.locked).toBe(wal(2));

    const rakeBefore = app.readModel.managersPotTotal();
    await app.engine.resolveMatch(matchId, { home: 1, away: 0 }); // HOME wins → creator wins

    const c = (await creator.me())!;
    const o = (await opponent.me())!;
    // winner: 8 left + (own 2 + opponent's 2 − 0.05 rake) = 11.95 ; loser: 8
    expect(c.balance).toBe(wal(11.95));
    expect(o.balance).toBe(wal(8));
    expect(c.locked).toBe(wal(0));
    expect(o.locked).toBe(wal(0));
    // money-only: a side wager doesn't touch the skill ladder
    expect(c.record.won).toBe(0);
    expect(o.record.lost).toBe(0);
    // rake (2.5% of the loser's 2) went to the Manager's Pot
    expect(app.readModel.managersPotTotal() - rakeBefore).toBe(wal(0.05));

    const ch = await creator.challenge({ challengeId });
    expect(ch!.status).toBe("SETTLED");
    expect(ch!.winner).toBe(asWallet("0xcreator"));
  });

  test("opponent's side wins: opponent is paid", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const creator = await player(app, "0xc2");
    const opponent = await player(app, "0xo2");

    const { challengeId } = await creator.createChallenge({ matchId, side: "HOME", stake: wal(2) });
    await opponent.acceptChallenge({ challengeId }); // opponent auto-takes AWAY

    await app.engine.resolveMatch(matchId, { home: 0, away: 2 }); // AWAY wins → opponent wins

    expect((await opponent.me())!.balance).toBe(wal(11.95));
    expect((await creator.me())!.balance).toBe(wal(8));
    expect((await creator.challenge({ challengeId }))!.winner).toBe(asWallet("0xo2"));
  });

  test("a result nobody picked (draw on HOME-vs-AWAY) voids and refunds both, no rake", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const creator = await player(app, "0xc3");
    const opponent = await player(app, "0xo3");

    const { challengeId } = await creator.createChallenge({ matchId, side: "HOME", stake: wal(2) });
    await opponent.acceptChallenge({ challengeId });

    const rakeBefore = app.readModel.managersPotTotal();
    await app.engine.resolveMatch(matchId, { home: 1, away: 1 }); // DRAW → neither side

    expect((await creator.me())!.balance).toBe(wal(10)); // fully refunded
    expect((await opponent.me())!.balance).toBe(wal(10));
    expect(app.readModel.managersPotTotal() - rakeBefore).toBe(wal(0)); // no rake on a void
    expect((await creator.challenge({ challengeId }))!.status).toBe("VOID");
  });

  test("a second accept is rejected and the loser's balance is untouched", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const creator = await player(app, "0xc4");
    const first = await player(app, "0xfirst");
    const second = await player(app, "0xsecond");

    const { challengeId } = await creator.createChallenge({ matchId, side: "AWAY", stake: wal(3) });
    await first.acceptChallenge({ challengeId });

    await expect(second.acceptChallenge({ challengeId })).rejects.toThrow();
    expect((await second.me())!.balance).toBe(wal(10)); // never locked
    expect((await second.me())!.locked).toBe(wal(0));
  });

  test("you can't accept your own challenge", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const creator = await player(app, "0xc5");
    const { challengeId } = await creator.createChallenge({ matchId, side: "HOME", stake: wal(2) });
    await expect(creator.acceptChallenge({ challengeId })).rejects.toThrow();
  });

  test("cancel before accept refunds the creator", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const creator = await player(app, "0xc6");

    const { challengeId } = await creator.createChallenge({ matchId, side: "HOME", stake: wal(2) });
    expect((await creator.me())!.locked).toBe(wal(2));

    await creator.cancelChallenge({ challengeId });
    expect((await creator.me())!.balance).toBe(wal(10));
    expect((await creator.me())!.locked).toBe(wal(0));
    expect((await creator.challenge({ challengeId }))!.status).toBe("CANCELLED");
  });
});
