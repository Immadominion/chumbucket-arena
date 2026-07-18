/**
 * The Pots — live parimutuel markets, folded from the log. Per match, per market:
 * bucket totals, crowd-implied odds, who's in, status, and the resolved outcome.
 * Also the settlement saga's worklist: which resolved markets still owe payouts.
 */
import type { StoredEvent } from "../../domain/events";
import type { Frost, MarketId, MatchId } from "../../domain/ids";
import type { Fixture, MarketKind } from "../../domain/model";
import type { CallStake } from "../../game/parimutuel";
import type { Projection } from "./Projection";
type MarketStatus = "OPEN" | "LOCKED" | "RESOLVED";
export interface BucketView {
    bucket: string;
    label: string;
    stake: Frost;
    impliedProb: number;
    callerCount: number;
}
export interface MarketPotView {
    matchId: MatchId;
    marketId: MarketId;
    kind: MarketKind;
    label: string;
    status: MarketStatus;
    buckets: BucketView[];
    grossPot: Frost;
    participantCount: number;
    winningBucket: string | undefined;
    settled: boolean;
}
export interface MatchView {
    fixture: Fixture;
    status: MarketStatus;
    markets: MarketPotView[];
    score: {
        home: number;
        away: number;
    } | null;
}
export declare class PotProjection implements Projection {
    readonly name = "pots";
    private readonly matches;
    apply(event: StoredEvent): void;
    getMatch(matchId: MatchId): MatchView | undefined;
    getMarketCalls(matchId: MatchId, marketId: MarketId): CallStake[];
    /**
     * Crowd-implied probability used to score a call's difficulty at the moment
     * it's made. Laplace-smoothed with a uniform prior so the first callers into a
     * thin pool aren't treated as backing max-difficulty longshots — the prior
     * washes out as real money arrives. (Raw pool share is still what the bucket
     * views display; this is the estimator the rating trusts.)
     */
    impliedProbFor(matchId: MatchId, marketId: MarketId, bucket: string): number;
    isOpen(matchId: MatchId, marketId: MarketId): boolean;
    /** Fixtures currently open for calls — the Matchday list. */
    openFixtures(): Fixture[];
    allMatches(): MatchView[];
    /** Resolved markets that still owe a settlement — the saga's worklist. */
    pendingSettlements(): {
        matchId: MatchId;
        marketId: MarketId;
    }[];
    winningBucketOf(matchId: MatchId, marketId: MarketId): string | undefined;
}
export {};
