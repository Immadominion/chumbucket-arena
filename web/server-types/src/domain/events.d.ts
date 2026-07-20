/**
 * The event-sourcing spine.
 *
 * Every meaningful thing that ever happens is an immutable event appended to a
 * stream. The Dossier, the Pots, the Leaderboard, the Gaffer's read on you — all
 * of it is a *projection* of these events. The events are the source of truth and
 * they live on Walrus. Nothing is mutated; new facts are only ever appended.
 */
import type { Bucket, CallId, ChallengeId, EventId, Frost, MarketId, MatchId, TakeId, VerdictId, Wallet } from "./ids";
import type { Fixture, MarketDef, Outcome, Tier, VerdictTrigger } from "./model";
export interface PlayerSigned {
    type: "PlayerSigned";
    wallet: Wallet;
    handle?: string;
}
export interface Deposited {
    type: "Deposited";
    amount: Frost;
    custodyRef?: string;
}
/**
 * Legacy single-phase withdrawal (kept so old streams still replay). New
 * withdrawals are two-phase to close a crash-window double-pay: the balance is
 * debited by WithdrawalInitiated BEFORE the on-chain send, then the send's
 * outcome is recorded by WithdrawalSettled (success) or WithdrawalReversed
 * (failure → refund). A process crash between the send and its record leaves a
 * dangling Initiated: funds stay debited (never double-paid), pending reconcile.
 */
export interface Withdrawn {
    type: "Withdrawn";
    amount: Frost;
    fee?: Frost;
    custodyRef?: string;
}
export interface WithdrawalInitiated {
    type: "WithdrawalInitiated";
    withdrawalId: string;
    amount: Frost;
    fee?: Frost;
}
export interface WithdrawalSettled {
    type: "WithdrawalSettled";
    withdrawalId: string;
    amount: Frost;
    fee?: Frost;
    custodyRef?: string;
}
export interface WithdrawalReversed {
    type: "WithdrawalReversed";
    withdrawalId: string;
    amount: Frost;
    reason?: string;
}
/** One-time starter bonus — spendable on calls, NOT withdrawable. */
export interface WelcomeGranted {
    type: "WelcomeGranted";
    amount: Frost;
}
/** One-time house bankroll for a liquidity bot — float-backed betting capital. */
export interface HouseSeeded {
    type: "HouseSeeded";
    amount: Frost;
}
export interface CallMade {
    type: "CallMade";
    callId: CallId;
    matchId: MatchId;
    marketId: MarketId;
    bucket: Bucket;
    stake: Frost;
    /** Crowd-implied probability of this bucket at the moment of the call (0..1). */
    impliedProbAtCall: number;
    bold: boolean;
    note?: string;
}
export interface HotTakeDeclared {
    type: "HotTakeDeclared";
    takeId: TakeId;
    text: string;
    subject?: string;
}
export interface CallSettled {
    type: "CallSettled";
    callId: CallId;
    matchId: MatchId;
    marketId: MarketId;
    result: "WON" | "LOST";
    stake: Frost;
    payout: Frost;
    pnlDelta: Frost;
    grDelta: number;
    difficulty: number;
}
export interface CallVoided {
    type: "CallVoided";
    callId: CallId;
    matchId: MatchId;
    marketId: MarketId;
    refund: Frost;
    reason: string;
}
export interface TierChanged {
    type: "TierChanged";
    from: Tier;
    to: Tier;
    direction: "PROMOTION" | "DEMOTION";
    grAt: number;
}
export interface TraitObserved {
    type: "TraitObserved";
    traitKey: string;
    label: string;
    confidence: number;
    evidence: string;
}
export interface VerdictIssued {
    type: "VerdictIssued";
    verdictId: VerdictId;
    text: string;
    trigger: VerdictTrigger;
    quotes: string[];
}
/** A chat turn with the Gaffer — the transcript is part of the player's memory. */
export interface ChatExchanged {
    type: "ChatExchanged";
    message: string;
    reply: string;
}
export interface ChallengeStakeLocked {
    type: "ChallengeStakeLocked";
    challengeId: ChallengeId;
    matchId: MatchId;
    side: Bucket;
    stake: Frost;
    role: "CREATOR" | "OPPONENT";
}
export interface ChallengeStakeSettled {
    type: "ChallengeStakeSettled";
    challengeId: ChallengeId;
    matchId: MatchId;
    result: "WON" | "LOST";
    stake: Frost;
    payout: Frost;
    pnlDelta: Frost;
}
export interface ChallengeStakeRefunded {
    type: "ChallengeStakeRefunded";
    challengeId: ChallengeId;
    matchId: MatchId;
    refund: Frost;
    reason: string;
}
export type PlayerEvent = PlayerSigned | Deposited | Withdrawn | WithdrawalInitiated | WithdrawalSettled | WithdrawalReversed | WelcomeGranted | HouseSeeded | CallMade | HotTakeDeclared | CallSettled | CallVoided | TierChanged | TraitObserved | VerdictIssued | ChatExchanged | ChallengeStakeLocked | ChallengeStakeSettled | ChallengeStakeRefunded;
export interface MatchOpened {
    type: "MatchOpened";
    fixture: Fixture;
    markets: MarketDef[];
}
/**
 * Markets curated onto an ALREADY-open match after the fact. MatchOpened is
 * idempotent by matchId, so a fixture opened before a market existed could never
 * gain it; this event backfills the missing markets onto an open match (the
 * projection ignores it for locked/resolved matches and skips any market that
 * already exists). Purely additive — never touches an existing market's pot.
 */
export interface MarketsAdded {
    type: "MarketsAdded";
    matchId: MatchId;
    markets: MarketDef[];
}
export interface MatchLocked {
    type: "MatchLocked";
    matchId: MatchId;
}
export interface MatchResolved {
    type: "MatchResolved";
    matchId: MatchId;
    score: {
        home: number;
        away: number;
    };
    /** marketId -> winning bucket, or VOID. */
    outcomes: Record<string, Outcome>;
    source: string;
}
export interface PotSettled {
    type: "PotSettled";
    matchId: MatchId;
    marketId: MarketId;
    winningBucket: Outcome;
    grossPot: Frost;
    rake: Frost;
    winnersStake: Frost;
    settledCount: number;
}
export type MatchEvent = MatchOpened | MarketsAdded | MatchLocked | MatchResolved | PotSettled;
export interface ChallengeCreated {
    type: "ChallengeCreated";
    challengeId: ChallengeId;
    matchId: MatchId;
    creator: Wallet;
    creatorSide: Bucket;
    opponentSide: Bucket;
    stake: Frost;
}
export interface ChallengeAccepted {
    type: "ChallengeAccepted";
    challengeId: ChallengeId;
    opponent: Wallet;
}
export interface ChallengeSettled {
    type: "ChallengeSettled";
    challengeId: ChallengeId;
    winningBucket: Bucket;
    winner: Wallet;
    grossPot: Frost;
    rake: Frost;
    payout: Frost;
}
export interface ChallengeVoided {
    type: "ChallengeVoided";
    challengeId: ChallengeId;
    winningBucket: Outcome;
    reason: string;
}
export interface ChallengeCancelled {
    type: "ChallengeCancelled";
    challengeId: ChallengeId;
}
export type ChallengeEvent = ChallengeCreated | ChallengeAccepted | ChallengeSettled | ChallengeVoided | ChallengeCancelled;
export type DomainEvent = PlayerEvent | MatchEvent | ChallengeEvent;
export type DomainEventType = DomainEvent["type"];
/** Narrow a DomainEvent union member by its `type` tag. */
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, {
    type: T;
}>;
export interface EventMeta {
    id: EventId;
    streamId: string;
    version: number;
    at: number;
}
/** An event as it lives in the store: payload + position metadata. */
export interface StoredEvent<E extends DomainEvent = DomainEvent> {
    meta: EventMeta;
    payload: E;
}
