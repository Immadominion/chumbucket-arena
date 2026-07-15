/**
 * End-to-end smoke run of the whole loop with in-memory adapters and the
 * scripted Gaffer — no keys, no network. Proves: sign → deposit → call → resolve
 * → parimutuel settlement → memory written → GR/form/tier move → the Gaffer's
 * read changes from day 1 (blank) to day 2 (receipts). Run: `bun run smoke`.
 */

import { createApp } from "../src/app.ts";
import { asWallet, formatWal, wal } from "../src/domain/ids.ts";
import { RESULT_MARKET } from "../src/game/markets.ts";
import { RESULT_BUCKETS } from "../src/domain/model.ts";
import { MockMatchData } from "../src/ports/MatchData.ts";
import { seedFixtures } from "../src/data/fixtures.ts";

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(72));

const FIXED_NOW = 1_750_000_000_000; // deterministic clock for the demo

async function main() {
  // Force the mock feed so the smoke is deterministic regardless of .env keys.
  const app = await createApp({ now: FIXED_NOW, matchData: new MockMatchData(seedFixtures(FIXED_NOW)) });
  const { engine, readModel } = app;
  line(`wiring: ${JSON.stringify(app.wiring)}`);

  await engine.syncFixtures();
  const fixtures = readModel.pots.openFixtures();
  const m1 = fixtures[0]!; // Argentina v Croatia
  rule();
  line(`MATCHDAY: ${fixtures.map((f) => `${f.home} v ${f.away}`).join("  |  ")}`);

  const alice = asWallet("0xALICE");
  const bob = asWallet("0xBOB");
  const cara = asWallet("0xCARA");

  for (const [w, name] of [
    [alice, "Alice"],
    [bob, "Bob"],
    [cara, "Cara"],
  ] as const) {
    await engine.signContract(w, name);
    await engine.deposit(w, wal(100));
  }

  // ── Day 1: the blank-slate read ────────────────────────────────────────────
  rule();
  const day1Read = await engine.preBetRead(alice, {
    matchId: m1.matchId,
    marketId: RESULT_MARKET,
    bucket: RESULT_BUCKETS.HOME,
    stake: wal(10),
  });
  line(`GAFFER → Alice (DAY 1, before any history):`);
  line(`  "${day1Read}"`);

  // Calls: Alice backs Argentina (HOME), Cara joins HOME, Bob backs Croatia (AWAY)
  await engine.makeCall(alice, { matchId: m1.matchId, marketId: RESULT_MARKET, bucket: RESULT_BUCKETS.HOME, stake: wal(10) });
  await engine.makeCall(cara, { matchId: m1.matchId, marketId: RESULT_MARKET, bucket: RESULT_BUCKETS.HOME, stake: wal(30) });
  await engine.makeCall(bob, { matchId: m1.matchId, marketId: RESULT_MARKET, bucket: RESULT_BUCKETS.AWAY, stake: wal(40) });
  await engine.declareHotTake(bob, "Argentina are finished, Croatia walk this.");

  const potBefore = readModel.pots.getMatch(m1.matchId)!.markets.find((mk) => mk.marketId === RESULT_MARKET)!;
  line("");
  line(`POT (${m1.home} v ${m1.away}) before kickoff: ${formatWal(potBefore.grossPot)} WAL across ${potBefore.participantCount} players`);
  for (const b of potBefore.buckets) {
    line(`   ${b.bucket.padEnd(5)} ${formatWal(b.stake).padStart(6)} WAL  (${Math.round(b.impliedProb * 100)}% implied, ${b.callerCount} in)`);
  }

  // ── Resolve: Argentina win 2-0 → HOME ──────────────────────────────────────
  await engine.resolveMatch(m1.matchId, { home: 2, away: 0 });
  await app.memoryWriter.drain();

  rule();
  line(`RESULT: ${m1.home} 2-0 ${m1.away}  → HOME wins`);
  for (const [w, name] of [
    [alice, "Alice"],
    [bob, "Bob"],
    [cara, "Cara"],
  ] as const) {
    const d = readModel.getDossier(w)!;
    line(
      `   ${name.padEnd(5)} | ${d.tier.padEnd(13)} | GR ${String(d.gr).padStart(4)} | P&L ${formatWal(d.pnl).padStart(7)} WAL | bal ${formatWal(d.balance).padStart(7)} | form ${d.form.recent.join("") || "-"}`,
    );
  }
  line(`   Manager's Pot (rake): ${formatWal(readModel.managersPotTotal())} WAL`);

  // Distil traits from the new memory, then show how the read has changed.
  await engine.refreshTraits(bob);
  await app.memoryWriter.drain();

  // ── Day 2: a second match — the read now has receipts ──────────────────────
  const m2 = fixtures[1]!; // Brazil v Serbia
  await engine.makeCall(bob, { matchId: m2.matchId, marketId: RESULT_MARKET, bucket: RESULT_BUCKETS.HOME, stake: wal(20) });
  rule();
  const day2Read = await engine.preBetRead(bob, {
    matchId: m2.matchId,
    marketId: RESULT_MARKET,
    bucket: RESULT_BUCKETS.HOME,
    stake: wal(20),
  });
  line(`GAFFER → Bob (DAY 2, after losing his bold call):`);
  line(`  "${day2Read}"`);

  const verdict = await engine.requestVerdict(bob, "ON_DEMAND");
  line("");
  line(`THE VERDICT on Bob:`);
  line(`  "${verdict.text}"`);
  if (verdict.quotes.length) line(`  (quoting him: "${verdict.quotes[0]}")`);

  // ── Leaderboard ────────────────────────────────────────────────────────────
  rule();
  line("SQUAD LADDER (by Gaffer Rating):");
  for (const e of readModel.leaderboardByGr()) {
    line(`   #${e.rank} ${(e.handle ?? e.wallet).padEnd(6)} ${e.tier.padEnd(13)} GR ${e.gr}  (${e.record.won}W-${e.record.lost}L)`);
  }
  rule();
  line("✓ loop complete: sign → call → resolve → settle → remember → roast");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
