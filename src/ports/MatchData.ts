/**
 * MatchData — the football feed. Supplies fixtures to open for calls and the
 * results to resolve them. Behind a port so the same engine runs on a mock
 * (deterministic, for dev/demo) or a live World Cup API (football-data.org,
 * api-football, …) by swapping the adapter.
 */

import type { MatchId } from "../domain/ids.ts";
import type { Fixture } from "../domain/model.ts";

export interface MatchResult {
  matchId: MatchId;
  score: { home: number; away: number };
  finished: boolean;
}

/**
 * The live in-play state of a match — the CURRENT score and whether it's over,
 * as opposed to MatchResult which only ever describes a finished match. Read for
 * the live match strip; never used to settle (settlement stays gated on the
 * on-chain-verified final proof). `finished` marks that a terminal event exists.
 */
export interface LiveMatchState {
  matchId: MatchId;
  score: { home: number; away: number };
  finished: boolean;
  statusId?: number; // raw feed game-phase id (5/10/13 = terminal), for display only
}

export interface MatchDataProvider {
  /** Fixtures that should be open (or opened soon) for calls. */
  fixtures(): Promise<Fixture[]>;
  /** Finished results for the given fixtures (subset that have finished). */
  results(matchIds: MatchId[]): Promise<MatchResult[]>;
  /**
   * Current in-play score + phase for one match, or null if there's no live
   * snapshot yet (not kicked off) or the provider can't supply it. Optional —
   * only the live feed implements it; the mock/dev providers omit it.
   */
  liveScore?(matchId: MatchId): Promise<LiveMatchState | null>;
}

/**
 * Deterministic in-memory provider. Seed it with fixtures; set results to drive
 * resolution in tests, the smoke run, and a scripted demo. No randomness, so a
 * replay is identical every time.
 */
export class MockMatchData implements MatchDataProvider {
  private readonly seeded: Fixture[];
  private readonly resultsByMatch = new Map<MatchId, MatchResult>();

  constructor(fixtures: Fixture[]) {
    this.seeded = fixtures;
  }

  async fixtures(): Promise<Fixture[]> {
    return this.seeded.slice();
  }

  setResult(matchId: MatchId, score: { home: number; away: number }): void {
    this.resultsByMatch.set(matchId, { matchId, score, finished: true });
  }

  async results(matchIds: MatchId[]): Promise<MatchResult[]> {
    const wanted = new Set(matchIds);
    return [...this.resultsByMatch.values()].filter((r) => wanted.has(r.matchId));
  }
}
