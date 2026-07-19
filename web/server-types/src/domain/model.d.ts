/**
 * Value objects shared across the domain: fixtures, markets, tiers, traits.
 * No behaviour here — just the shapes the events and projections speak in.
 */
import type { Bucket, MarketId, MatchId } from "./ids";
export declare const TIERS: readonly ["Trialist", "Squad Player", "First Team", "Captain", "Assistant Manager", "Director of Football"];
export type Tier = (typeof TIERS)[number];
/** Common World Cup stages — a hint, not a constraint (any competition's round string is valid). */
export type Stage = "GROUP" | "R32" | "R16" | "QF" | "SF" | "FINAL";
export interface Fixture {
    matchId: MatchId;
    home: string;
    away: string;
    competition: string;
    group?: string;
    stage: string;
    kickoff: number;
    /** TxLINE's own fixture numbering, once resolved — the seam SettlementVerifier reads. */
    txline?: {
        fixtureId: number;
        participant1IsHome: boolean;
    };
}
export type MarketKind = "RESULT" | "OVER_UNDER" | "HANDICAP" | "BOLD";
export interface BucketDef {
    bucket: Bucket;
    label: string;
}
/**
 * A two-outcome line/threshold market (over/under, handicap). `line` is the
 * half-line shown to users (e.g. 2.5); on-chain it is stored as its integer
 * floor (2) and settled via the MarketSpec + settle_market path. `stat` names
 * which match stat the line runs on (goals today; corners/cards later).
 */
export interface LineMarketSpec {
    op: "ADD" | "SUB";
    line: number;
    stat: "GOALS" | "CORNERS" | "CARDS";
    period: "FULL" | "H1";
}
export interface MarketDef {
    marketId: MarketId;
    kind: MarketKind;
    label: string;
    buckets: BucketDef[];
    /** Present on line/threshold markets (OVER_UNDER, HANDICAP). */
    line?: LineMarketSpec;
    /**
     * The on-chain match_id of THIS market's pot (≤32 ascii). Stamped by openMatch
     * from the fixture id + a per-market tag. The client derives the pot PDA from
     * it to place a call; the keeper creates/settles the same pot. RESULT's equals
     * the fixture matchId (backward compatible). Absent only before a match opens.
     */
    potMatchId?: string;
}
/** Line-market outcome buckets — index 0/1 map to on-chain BUCKET_OVER/UNDER. */
export declare const LINE_BUCKETS: {
    OVER: Bucket;
    UNDER: Bucket;
};
/** A market resolves to exactly one winning bucket, or VOID (refund all). */
export declare const VOID: "VOID";
export type Outcome = Bucket | typeof VOID;
export type FormResult = "W" | "L" | "VOID";
export type VerdictTrigger = "BIG_RESULT" | "PROMOTION" | "DEMOTION" | "ON_DEMAND" | "SEASON_REVIEW";
/**
 * A behavioural trait the Gaffer has distilled about a player — the psychology
 * layer of the memory. Written by the Gaffer's analyze pass, read before bets.
 */
export interface Trait {
    key: string;
    label: string;
    confidence: number;
    evidence: string;
    firstSeen: number;
    lastSeen: number;
}
/** Standard result-market buckets. */
export declare const RESULT_BUCKETS: {
    HOME: Bucket;
    DRAW: Bucket;
    AWAY: Bucket;
};
