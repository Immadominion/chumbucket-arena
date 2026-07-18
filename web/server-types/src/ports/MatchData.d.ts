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
export interface MatchDataProvider {
    /** Fixtures that should be open (or opened soon) for calls. */
    fixtures(): Promise<Fixture[]>;
    /** Finished results for the given fixtures (subset that have finished). */
    results(matchIds: MatchId[]): Promise<MatchResult[]>;
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
