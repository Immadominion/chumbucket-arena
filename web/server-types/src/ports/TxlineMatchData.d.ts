/**
 * MatchData over TxLINE (TxODDS) — the live World Cup 2026 feed, cryptographically
 * anchored on Solana. Same shape as FootballDataProvider/ApiFootballProvider (poll
 * + short-TTL cache), so it drops into the existing MatchDataProvider seam with no
 * changes to Engine.
 *
 * Auth is a pre-activated (jwt + apiToken) pair — the guest-JWT + on-chain-subscribe
 * + signed-activation dance is a one-time setup step (see scripts/), not something
 * this adapter re-runs per request.
 *
 * Field shapes here are ROUND-TRIPPED against the live devnet API (2026-07-11):
 * `/api/fixtures/snapshot` returns a bare PascalCase array (FixtureId, Participant1,
 * StartTime as epoch ms, GameState), and `/api/scores/snapshot/{id}` returns a bare,
 * UNORDERED array of score events. Do not "normalise" these to camelCase — that was
 * this adapter's original bug (every field read undefined → 0 fixtures).
 */
import { type MatchId } from "../domain/ids";
import type { Fixture } from "../domain/model";
import type { MatchDataProvider, MatchResult } from "./MatchData";
export interface TxlineConfig {
    apiBaseUrl: string;
    jwt: string;
    apiToken: string;
    cacheTtlMs: number;
}
/**
 * One row of /api/scores/snapshot/{fixtureId}. The response is a bare,
 * UNORDERED array — the last element is routinely a stale mid-match row, so
 * finished-ness must be decided by scanning the WHOLE array for a terminal
 * status (proven live in onchain/…/devnet-lifecycle/lock-and-settle.ts, which
 * once mistook a frozen in-play row for "the feed lags days").
 */
export interface TxScoresEvent {
    Seq?: number;
    StatusId?: number;
    Action?: string;
    Stats?: Record<string, number>;
}
/**
 * Soccer game-phase StatusId values that are genuinely terminal
 * (documentation/scores/soccer-feed): 5 = F (ended in regulation), 10 = FET
 * (ended after extra time), 13 = FPE (ended after penalties). Everything else
 * — half-time, in-play, suspensions — can still change; never settle on it.
 */
export declare const FINISHED_STATUS_IDS: ReadonlySet<number>;
/** Full-game stat keys: participant-1 / participant-2 total goals. */
export declare const STAT_KEY_P1_GOALS = 1;
export declare const STAT_KEY_P2_GOALS = 2;
/**
 * Pick the definitive final event out of an unordered scores-snapshot array:
 * the highest-Seq row whose StatusId is terminal. Returns undefined while the
 * match is still (or not yet) in play. Shared with TxlineSettlementVerifier so
 * "finished" means exactly one thing across the codebase.
 */
export declare function finalScoresEvent(events: TxScoresEvent[]): TxScoresEvent | undefined;
export declare class TxlineMatchData implements MatchDataProvider {
    private readonly cfg;
    private readonly fetchImpl;
    private fixturesCache;
    private readonly now;
    constructor(cfg: TxlineConfig, fetchImpl?: typeof fetch, now?: () => number);
    private headers;
    fixtures(): Promise<Fixture[]>;
    results(matchIds: MatchId[]): Promise<MatchResult[]>;
    private fetchFixtures;
    private toFixture;
}
