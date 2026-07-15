/**
 * Seed fixtures. Placeholder World Cup 2026 fixtures so the app is playable
 * before the live MatchData API is wired. Kickoffs are relative to "now" so the
 * Matchday always has something open. Swap for the real feed by setting
 * FOOTBALL_API_BASE and implementing a MatchDataProvider over it.
 */

import { asMatchId } from "../domain/ids.ts";
import type { Fixture } from "../domain/model.ts";

const HOUR = 3_600_000;
const C = "FIFA World Cup 2026";

export function seedFixtures(now: number): Fixture[] {
  return [
    { matchId: asMatchId("wc26-arg-cro"), home: "Argentina", away: "Croatia", competition: C, group: "Group A", stage: "GROUP", kickoff: now + 2 * HOUR },
    { matchId: asMatchId("wc26-bra-srb"), home: "Brazil", away: "Serbia", competition: C, group: "Group B", stage: "GROUP", kickoff: now + 4 * HOUR },
    { matchId: asMatchId("wc26-fra-mex"), home: "France", away: "Mexico", competition: C, group: "Group C", stage: "GROUP", kickoff: now + 6 * HOUR },
    { matchId: asMatchId("wc26-eng-usa"), home: "England", away: "USA", competition: C, group: "Group D", stage: "GROUP", kickoff: now + 26 * HOUR },
    { matchId: asMatchId("wc26-esp-ger"), home: "Spain", away: "Germany", competition: C, group: "Group E", stage: "GROUP", kickoff: now + 28 * HOUR },
  ];
}
