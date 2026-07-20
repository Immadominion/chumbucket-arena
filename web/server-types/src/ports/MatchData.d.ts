/**
 * MatchData — the football feed. Supplies fixtures to open for calls and the
 * results to resolve them. Behind a port so the same engine runs on a mock
 * (deterministic, for dev/demo) or a live World Cup API (football-data.org,
 * api-football, …) by swapping the adapter.
 */
import type { MatchId } from "../domain/ids";
import type { Fixture } from "../domain/model";
export interface MatchResult {
    matchId: MatchId;
    score: {
        home: number;
        away: number;
    };
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
    score: {
        home: number;
        away: number;
    };
    finished: boolean;
    statusId?: number;
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
export declare class MockMatchData implements MatchDataProvider {
    private readonly seeded;
    private readonly resultsByMatch;
    constructor(fixtures: Fixture[]);
    fixtures(): Promise<Fixture[]>;
    setResult(matchId: MatchId, score: {
        home: number;
        away: number;
    }): void;
    results(matchIds: MatchId[]): Promise<MatchResult[]>;
}
