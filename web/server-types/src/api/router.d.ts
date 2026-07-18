/**
 * The API surface — typed RPC, not REST. Commands are mutations, reads are
 * queries, and the live views (a match's Pot, your Dossier, your settlement feed)
 * are subscriptions pushed over WebSocket. The exported AppRouter type is the
 * contract the frontend imports — no codegen, no drift.
 */
import { type MatchId } from "../domain/ids";
import type { DossierView } from "../core/projections/DossierProjection";
export declare const appRouter: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./trpc").Context;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: true;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    health: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: {
            ok: boolean;
            wiring: Record<string, string>;
            sessionsWallet: string;
            managersPot: bigint;
            houseRevenue: bigint;
            ledgerOnWalrus: number;
        };
        meta: object;
    }>;
    matchday: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: import("../core/projections/PotProjection").MatchView[];
        meta: object;
    }>;
    match: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            matchId: string;
        };
        output: import("../core/projections/PotProjection").MatchView | null;
        meta: object;
    }>;
    leaderboard: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            limit?: number | undefined;
            by?: "gr" | "pnl" | undefined;
        };
        output: import("../core/projections/ReadModel").LeaderboardEntry[];
        meta: object;
    }>;
    managersPot: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: bigint;
        meta: object;
    }>;
    dossier: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
        };
        output: {
            wallet: import("../domain/ids").Wallet;
            handle: string | undefined;
            signedAt: number;
            gr: number;
            tier: import("../domain/model").Tier;
            nextTier: {
                tier: import("../domain/model").Tier;
                min: number;
            } | null;
            pnl: import("../domain/ids").Frost;
            record: {
                won: number;
                lost: number;
                voided: number;
            };
            form: import("../game/form").FormState;
            openChallengeStakes: import("../core/projections/DossierProjection").OpenChallengeStakeView[];
            traits: import("../domain/model").Trait[];
            hotTakes: {
                takeId: string;
                text: string;
                at: number;
            }[];
            landmarks: {
                callId: import("../domain/ids").CallId;
                matchId: MatchId;
                text: string;
                at: number;
            }[];
            lastVerdict: {
                text: string;
                at: number;
                trigger: string;
            } | undefined;
        } | null;
        meta: object;
    }>;
    me: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: DossierView | null;
        meta: object;
    }>;
    /** Public challenge view — the payload the shareable accept link renders. */
    challenge: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            challengeId: string;
        };
        output: {
            fixture: import("../domain/model").Fixture | null;
            challengeId: import("../domain/ids").ChallengeId;
            matchId: MatchId;
            creator: import("../domain/ids").Wallet;
            opponent: import("../domain/ids").Wallet | null;
            creatorSide: string;
            opponentSide: string;
            stake: import("../domain/ids").Frost;
            status: import("../core/projections/ChallengeProjection").ChallengeStatus;
            winner: import("../domain/ids").Wallet | null;
            winningBucket: string | null;
            createdAt: number;
            settledAt: number | null;
        } | null;
        meta: object;
    }>;
    myChallenges: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: import("../core/projections/ChallengeProjection").ChallengeView[];
        meta: object;
    }>;
    settledCalls: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            limit?: number | undefined;
        } | undefined;
        output: import("../core/projections/SettledCallsProjection").SettledCallView[];
        meta: object;
    }>;
    chatHistory: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            limit?: number | undefined;
        } | undefined;
        output: import("../core/projections/ChatProjection").ChatEntry[];
        meta: object;
    }>;
    touchline: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: {
            dossier: DossierView | null;
            openFixtures: import("../domain/model").Fixture[];
            openCalls: import("../core/projections/DossierProjection").OpenCallView[];
            managersPot: bigint;
            leaderboardTop: import("../core/projections/ReadModel").LeaderboardEntry[];
        };
        meta: object;
    }>;
    preBetRead: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            marketId: string;
            bucket: string;
            matchId: string;
            stake: bigint;
        };
        output: string;
        meta: object;
    }>;
    signContract: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            handle?: string | undefined;
        };
        output: {
            wallet: import("../domain/ids").Wallet;
        };
        meta: object;
    }>;
    deposit: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            amount: bigint;
            proof?: string | undefined;
        };
        output: {
            balance: import("../domain/ids").Frost;
        };
        meta: object;
    }>;
    /** The player's deposit address (their own Privy Solana wallet) — send USDC here. */
    depositAddress: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: {
            address: import("../domain/ids").Wallet;
            available: boolean;
        };
        meta: object;
    }>;
    /** Sweep + credit any USDC that has arrived at the deposit address. Idempotent. */
    syncDeposit: import("@trpc/server").TRPCMutationProcedure<{
        input: void;
        output: {
            credited: import("../domain/ids").Frost;
            balance: import("../domain/ids").Frost;
        };
        meta: object;
    }>;
    claimWelcomeGrant: import("@trpc/server").TRPCMutationProcedure<{
        input: void;
        output: {
            bonus: import("../domain/ids").Frost;
        };
        meta: object;
    }>;
    withdraw: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            amount: bigint;
        };
        output: {
            balance: import("../domain/ids").Frost;
            ref: string;
            net: import("../domain/ids").Frost;
            fee: import("../domain/ids").Frost;
        };
        meta: object;
    }>;
    makeCall: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            bucket: string;
            matchId: string;
            stake: bigint;
            marketId?: string | undefined;
            note?: string | undefined;
        };
        output: {
            callId: import("../domain/ids").CallId;
            impliedProbAtCall: number;
        };
        meta: object;
    }>;
    createChallenge: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            matchId: string;
            stake: bigint;
            side: "HOME" | "DRAW" | "AWAY";
            opponentSide?: "HOME" | "DRAW" | "AWAY" | undefined;
        };
        output: {
            challengeId: import("../domain/ids").ChallengeId;
        };
        meta: object;
    }>;
    acceptChallenge: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            challengeId: string;
        };
        output: {
            challengeId: import("../domain/ids").ChallengeId;
        };
        meta: object;
    }>;
    cancelChallenge: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            challengeId: string;
        };
        output: {
            ok: true;
        };
        meta: object;
    }>;
    declareHotTake: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            text: string;
        };
        output: {
            takeId: string;
        };
        meta: object;
    }>;
    requestVerdict: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            trigger?: "BIG_RESULT" | "PROMOTION" | "DEMOTION" | "ON_DEMAND" | "SEASON_REVIEW" | undefined;
        };
        output: import("../gaffer/Gaffer").Verdict & {
            verdictId: string;
        };
        meta: object;
    }>;
    chat: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            message: string;
        };
        output: string;
        meta: object;
    }>;
    resolveMatchNow: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            key: string;
            home: number;
            away: number;
            matchId: string;
        };
        output: {
            ok: boolean;
            matchId: string;
            score: {
                home: number;
                away: number;
            };
        };
        meta: object;
    }>;
    onMatch: import("@trpc/server").TRPCSubscriptionProcedure<{
        input: {
            matchId: string;
        };
        output: AsyncIterable<import("../core/projections/PotProjection").MatchView | null, void, any>;
        meta: object;
    }>;
    onChallenge: import("@trpc/server").TRPCSubscriptionProcedure<{
        input: {
            challengeId: string;
        };
        output: AsyncIterable<import("../core/projections/ChallengeProjection").ChallengeView | null, void, any>;
        meta: object;
    }>;
    onDossier: import("@trpc/server").TRPCSubscriptionProcedure<{
        input: void;
        output: AsyncIterable<DossierView | null, void, any>;
        meta: object;
    }>;
    onFeed: import("@trpc/server").TRPCSubscriptionProcedure<{
        input: void;
        output: AsyncIterable<{
            type: "PlayerSigned" | "Deposited" | "Withdrawn" | "WithdrawalInitiated" | "WithdrawalSettled" | "WithdrawalReversed" | "WelcomeGranted" | "HouseSeeded" | "CallMade" | "HotTakeDeclared" | "CallSettled" | "CallVoided" | "TierChanged" | "TraitObserved" | "VerdictIssued" | "ChatExchanged" | "ChallengeStakeLocked" | "ChallengeStakeSettled" | "ChallengeStakeRefunded" | "MatchOpened" | "MatchLocked" | "MatchResolved" | "PotSettled" | "ChallengeCreated" | "ChallengeAccepted" | "ChallengeSettled" | "ChallengeVoided" | "ChallengeCancelled";
            at: number;
            payload: import("../domain/events").DomainEvent;
        }, void, any>;
        meta: object;
    }>;
}>>;
export type AppRouter = typeof appRouter;
