/**
 * Market backfill: a fixture opened before a market was curated must still gain
 * it. openMatch is idempotent by matchId, so reconcileMarkets (run inside
 * syncFixtures) appends the missing markets via MarketsAdded onto an OPEN match —
 * never onto a locked/resolved one, and never duplicating an existing market.
 *
 * This reproduces the live incident where every fixture showed only HOME/DRAW/AWAY:
 * they were opened with a single RESULT market before the line markets shipped, and
 * the idempotent opener could never add the new ones. reconcileMarkets is the fix.
 */

import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asMatchId } from "../src/domain/ids.ts";
import { overUnderGoalsMarket } from "../src/game/markets.ts";
import type { Fixture } from "../src/domain/model.ts";
import type { MatchDataProvider } from "../src/ports/MatchData.ts";

const FIXED_NOW = 1_750_000_000_000;

const FIXTURE: Fixture = {
  matchId: asMatchId("99999001"),
  home: "Brazil",
  away: "Argentina",
  competition: "Friendlies",
  stage: "GROUP",
  kickoff: FIXED_NOW + 3_600_000, // 1h in the future → stays OPEN
  txline: { fixtureId: 99999001, participant1IsHome: true },
};

const oneFixtureProvider = (fixture: Fixture): MatchDataProvider => ({
  fixtures: async () => [fixture],
  results: async () => [],
});

describe("market backfill onto already-open fixtures", () => {
  test("reconcile adds newly-curated markets to an OPEN match, idempotently", async () => {
    const app = await createApp({
      config: loadConfig({}),
      now: FIXED_NOW,
      matchData: oneFixtureProvider(FIXTURE),
    });

    // Simulate a fixture opened before the book grew: RESULT + only O/U 2.5.
    await app.engine.openMatch(FIXTURE, [overUnderGoalsMarket(2.5)]);
    let m = app.readModel.pots.getMatch(FIXTURE.matchId)!;
    expect(m.markets.map((x) => String(x.marketId)).sort()).toEqual(
      ["OU-GOALS-FULL-2.5", "RESULT"].sort(),
    );

    // syncFixtures: openMatch is a no-op (already exists), reconcile backfills the rest.
    await app.engine.syncFixtures();
    m = app.readModel.pots.getMatch(FIXTURE.matchId)!;
    const ids = m.markets.map((x) => String(x.marketId));
    expect(ids).toContain("RESULT");
    expect(ids.filter((id) => id.startsWith("OU-GOALS-FULL")).length).toBe(3);
    expect(ids.filter((id) => id.startsWith("HCP-GOALS-FULL")).length).toBe(2);
    expect(ids.length).toBe(6);
    expect(new Set(ids).size).toBe(6); // the pre-existing O/U 2.5 is not duplicated

    // Every backfilled line market carries its own on-chain pot id.
    for (const mk of m.markets) {
      if (mk.marketId !== "RESULT") {
        expect(mk.potMatchId).toBeDefined();
        expect(mk.potMatchId!.startsWith(`${FIXTURE.matchId}#`)).toBe(true);
      }
    }

    // A second sync must not duplicate anything.
    await app.engine.syncFixtures();
    m = app.readModel.pots.getMatch(FIXTURE.matchId)!;
    expect(m.markets.length).toBe(6);
  });

  test("a LOCKED match's book is frozen — reconcile adds nothing", async () => {
    const app = await createApp({
      config: loadConfig({}),
      now: FIXED_NOW,
      matchData: oneFixtureProvider(FIXTURE),
    });
    await app.engine.openMatch(FIXTURE, [overUnderGoalsMarket(2.5)]);
    await app.engine.lockMatch(FIXTURE.matchId);

    await app.engine.syncFixtures();
    const m = app.readModel.pots.getMatch(FIXTURE.matchId)!;
    expect(m.markets.length).toBe(2); // still RESULT + O/U 2.5 — no backfill onto a locked book
  });
});
