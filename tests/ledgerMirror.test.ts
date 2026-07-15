/**
 * The Walrus money-ledger mirror: balance-determining events are mirrored to
 * Walrus and the ledger is recoverable from there alone (bigint FROST intact).
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, wal, type MatchId } from "../src/domain/ids.ts";
import { recoverLedgerFromWalrus } from "../src/engine/WalrusLedgerMirror.ts";

const FIXED_NOW = 1_750_000_000_000;

async function freshApp() {
  const app = await createApp({ config: loadConfig({}), now: FIXED_NOW });
  await app.engine.syncFixtures();
  return app;
}

describe("Walrus ledger mirror", () => {
  test("mirrors money events to Walrus; ledger is recoverable + exact", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });

    await alice.signContract({ handle: "Alice" });
    await alice.deposit({ amount: wal(100) });
    await alice.makeCall({ matchId, bucket: "HOME", stake: wal(10) });
    await app.engine.resolveMatch(matchId, { home: 1, away: 0 });

    await app.ledgerMirror.drain();
    expect(app.ledgerMirror.count).toBeGreaterThan(0);

    // Recover the ledger from Walrus alone.
    const events = await recoverLedgerFromWalrus(app.memory, "gaffer:ledger");
    expect(events.length).toBe(app.ledgerMirror.count);

    const types = events.map((e) => e.payload.type);
    expect(types).toContain("Deposited");
    expect(types).toContain("CallMade");
    expect(types).toContain("CallSettled");

    // The bigint FROST amount survived the Walrus round-trip exactly.
    const dep = events.find((e) => e.payload.type === "Deposited");
    expect(dep && (dep.payload as { amount: bigint }).amount).toBe(wal(100));

    // Recovered events are ordered within a stream by version (re-foldable).
    const aliceStream = events.filter((e) => e.meta.streamId === "gaffer:0xalice");
    const versions = aliceStream.map((e) => e.meta.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  test("non-money events (a hot take) are not written to the ledger", async () => {
    const app = await freshApp();
    const eve = appRouter.createCaller({ app, wallet: asWallet("0xeve") });
    await eve.signContract({}); // PlayerSigned IS a ledger event
    await app.ledgerMirror.drain();
    const before = app.ledgerMirror.count;

    await eve.declareHotTake({ text: "France are finished" }); // not a money event
    await app.ledgerMirror.drain();
    expect(app.ledgerMirror.count).toBe(before);
  });
});
