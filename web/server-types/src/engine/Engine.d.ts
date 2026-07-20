/**
 * The Engine — the application service. It owns the write side: player commands
 * route to actors; match lifecycle (open → lock → resolve) and the settlement
 * saga run here. The API talks to the Engine for commands and to the ReadModel
 * for queries. Match streams have a single writer (this Engine), player streams a
 * single writer each (their actor), so ordering is guaranteed everywhere.
 */
import type { GameConfig } from "../config";
import { type Bucket, type ChallengeId, type Frost, type MarketId, type MatchId, type Wallet } from "../domain/ids";
import { type Fixture, type MarketDef, type VerdictTrigger } from "../domain/model";
import type { Gaffer } from "../gaffer/Gaffer";
import { HouseLiquidity } from "./HouseLiquidity";
import { ActorRegistry } from "../core/actor/ActorRegistry";
import type { EventStore } from "../core/eventstore/EventStore";
import type { ReadModel } from "../core/projections/ReadModel";
import type { Custody } from "../ports/Custody";
import type { DepositGateway, PrivyPlayer } from "../ports/PrivyDepositGateway";
import type { MatchDataProvider } from "../ports/MatchData";
import type { SettlementVerifier } from "../ports/SettlementVerifier";
import type { MakeCallInput } from "../core/actor/PlayerActor";
export interface EngineDeps {
    store: EventStore;
    readModel: ReadModel;
    custody: Custody;
    gaffer: Gaffer;
    matchData: MatchDataProvider;
    /** On-chain corroboration gate before a reported score is trusted for payout. */
    settlementVerifier: SettlementVerifier;
    config: GameConfig;
    /** Custodial deposit sweeps (Privy). Absent → play-money/no on-chain deposits. */
    depositGateway?: DepositGateway;
}
export declare class Engine {
    private readonly deps;
    readonly registry: ActorRegistry;
    private readonly matchVersions;
    private readonly challengeVersions;
    /** Per-wallet + global throttle on the paid (Anthropic) endpoints. */
    private readonly limiter;
    /** Synthetic house bettors that seed each touched match with a counterparty. */
    readonly house: HouseLiquidity;
    constructor(deps: EngineDeps);
    get readModel(): ReadModel;
    get custody(): Custody;
    signContract(wallet: Wallet, handle?: string): Promise<{
        wallet: Wallet;
    }>;
    deposit(wallet: Wallet, amount: Frost, proof?: string): Promise<{
        balance: Frost;
    }>;
    /**
     * Custodial deposit: sweep any USDC that has arrived in the player's Privy
     * wallet into the Sessions float and credit their ledger. Idempotent +
     * reconciled — safe to call repeatedly (a "check for my deposit" button).
     * No-op without a gateway, for an unsigned player, or for a player without a
     * Privy wallet.
     */
    syncDeposits(wallet: Wallet, player?: Partial<PrivyPlayer>): Promise<{
        credited: Frost;
        balance: Frost;
    }>;
    withdraw(wallet: Wallet, amount: Frost): Promise<{
        balance: Frost;
        ref: string;
        net: Frost;
        fee: Frost;
    }>;
    claimWelcomeGrant(wallet: Wallet): Promise<{
        bonus: Frost;
    }>;
    makeCall(wallet: Wallet, input: MakeCallInput): Promise<{
        callId: import("../domain/ids").CallId;
        impliedProbAtCall: number;
    }>;
    declareHotTake(wallet: Wallet, text: string): Promise<{
        takeId: string;
    }>;
    requestVerdict(wallet: Wallet, trigger: VerdictTrigger): Promise<import("../gaffer/Gaffer").Verdict & {
        verdictId: string;
    }>;
    chat(wallet: Wallet, message: string): Promise<string>;
    /** Re-read a player's memory, distil behavioural traits, and persist them. */
    refreshTraits(wallet: Wallet): Promise<import("../gaffer/Gaffer").DistilledTrait[]>;
    /** The pre-bet coaching read — built from live pot context + the player's memory. */
    preBetRead(wallet: Wallet, input: {
        matchId: MatchId;
        marketId: MarketId;
        bucket: string;
        stake: Frost;
    }): Promise<string>;
    /**
     * Open a challenge on a match's RESULT market: lock the creator's stake and
     * publish an OPEN escrow anyone can accept via the returned challengeId. The
     * opponent auto-takes `opponentSide` (defaults to counterSide(side)); any third
     * outcome refunds both. Lock first, so a rejected lock writes no escrow.
     */
    createChallenge(creator: Wallet, input: {
        matchId: MatchId;
        side: Bucket;
        stake: Frost;
        opponentSide?: Bucket;
    }): Promise<{
        challengeId: ChallengeId;
    }>;
    /**
     * Take the open side of a challenge, locking an equal stake. The expectedVersion
     * guard on the challenge stream makes accept single-winner: if two opponents
     * race, only the first ChallengeAccepted lands; the loser's stake is refunded.
     */
    acceptChallenge(opponent: Wallet, challengeId: ChallengeId): Promise<{
        challengeId: ChallengeId;
    }>;
    /** Withdraw an un-accepted challenge — only the creator, only while OPEN. */
    cancelChallenge(creator: Wallet, challengeId: ChallengeId): Promise<{
        ok: true;
    }>;
    /**
     * Settle every MATCHED challenge on a resolved match. Reuses the parimutuel
     * engine with the two stakes and minParticipants=2, so a 1-v-1 pays out with
     * exactly the pool's rake/rounding — and its VOID branch (winner bucket has no
     * staker) gives the "result nobody picked → refund both" case for free.
     * Idempotent: matchedFor() is empty once a challenge is settled/voided.
     */
    settleChallengesForMatch(matchId: MatchId, score: {
        home: number;
        away: number;
    }): Promise<void>;
    openMatch(fixture: Fixture, extraMarkets?: MarketDef[]): Promise<void>;
    /**
     * The curated line markets offered on every fixture alongside 1X2. Kept small
     * on purpose (UX §4 — choice overload kills conversion): the one universal
     * over/under line plus a home handicap. More lines are a later expand.
     */
    /**
     * The curated book of extra markets opened alongside RESULT on every fixture.
     * All settle from the full-time goals stat TxLINE proves on-chain (Over/Under
     * totals + home goal handicaps), so each is a single verified predicate — no
     * unprovable markets. Adding a line here automatically backfills onto every
     * already-open fixture too (see reconcileMarkets), so the book can grow without
     * re-seeding.
     */
    private lineMarketsFor;
    /**
     * Backfill newly-curated markets onto an already-open match. openMatch is
     * idempotent by matchId, so a fixture opened before a market existed would
     * never gain it; this appends the missing markets (with their on-chain pot ids
     * stamped) to any OPEN match. No-op for new matches (openMatch already gave
     * them the full book) and for locked/resolved matches (their book is frozen).
     */
    private reconcileMarkets;
    lockMatch(matchId: MatchId): Promise<void>;
    resolveMatch(matchId: MatchId, score: {
        home: number;
        away: number;
    }, source?: string): Promise<void>;
    private settleMarket;
    syncFixtures(): Promise<void>;
    /** Lock kicked-off matches; resolve finished ones. Safe to call on a timer. */
    tick(now?: number): Promise<void>;
    private matchAppend;
    /** Single-writer append to a challenge escrow stream, under optimistic concurrency. */
    private challengeAppend;
}
