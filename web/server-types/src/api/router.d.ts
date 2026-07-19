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
            readiness: {
                eventLogPersistent: boolean;
                socialStore: boolean;
                socialNetwork: "devnet" | "mainnet-beta" | null;
                heliusWebhookAuth: boolean;
                txlineSettlement: boolean;
            };
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
    socialStatus: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: {
            enabled: boolean;
            wiring: string;
            network: "devnet" | "mainnet-beta" | null;
            heliusWebhookAuth: boolean;
        };
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
            stake: bigint;
            matchId: string;
        };
        output: string;
        meta: object;
    }>;
    myPositions: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
            limit?: number | undefined;
        };
        output: import("../social/SocialStore").PredictionPositionRow[];
        meta: object;
    }>;
    /** Settled positions with funds still to pull — powers the "claim your winnings" surface. */
    claimable: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
            limit?: number | undefined;
        };
        output: import("../social/SocialStore").PredictionPositionRow[];
        meta: object;
    }>;
    activity: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet?: string | undefined;
            limit?: number | undefined;
            matchId?: string | undefined;
        };
        output: import("../social/SocialStore").PredictionActivityRow[];
        meta: object;
    }>;
    /** The following feed: what the wallets you follow (+ friends) are calling. */
    followingFeed: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
            limit?: number | undefined;
        };
        output: import("../social/SocialStore").PredictionActivityRow[];
        meta: object;
    }>;
    followCounts: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
        };
        output: import("../social/SocialStore").FollowCounts;
        meta: object;
    }>;
    isFollowing: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            viewer: string;
            target: string;
        };
        output: boolean;
        meta: object;
    }>;
    /** Who called what on a fixture — the match callers board. */
    matchCallers: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            matchId: string;
            limit?: number | undefined;
        };
        output: import("../social/SocialStore").MatchCallerRow[];
        meta: object;
    }>;
    /** Record/PnL leaderboard from settled stats. */
    socialLeaderboard: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            limit?: number | undefined;
            by?: "pnl" | "streak" | "winrate" | undefined;
        };
        output: import("../social/SocialStore").LeaderboardRow[];
        meta: object;
    }>;
    /** Composite public profile: stats + follow counts + recent positions + activity. */
    profile: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
            limit?: number | undefined;
        };
        output: {
            wallet: string;
            stats: import("../social/SocialStore").UserStatsRow | null;
            counts: import("../social/SocialStore").FollowCounts;
            positions: import("../social/SocialStore").PredictionPositionRow[];
            activity: import("../social/SocialStore").PredictionActivityRow[];
        };
        meta: object;
    }>;
    /**
     * Follow / unfollow — authenticated by a WALLET SIGNATURE over a canonical,
     * timestamped message (proves the caller controls the follower wallet), so no
     * one can spam the graph on someone else's behalf. No session server needed.
     */
    follow: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wallet: string;
            signature: string;
            target: string;
            timestamp: number;
        };
        output: {
            ok: boolean;
            result?: unknown;
            reason?: string;
        };
        meta: object;
    }>;
    unfollow: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wallet: string;
            signature: string;
            target: string;
            timestamp: number;
        };
        output: {
            ok: boolean;
            result?: unknown;
            reason?: string;
        };
        meta: object;
    }>;
    /** A wallet's notifications (FOLLOWED_CALL, CLAIM_AVAILABLE, …), newest first. */
    notifications: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
            limit?: number | undefined;
            unreadOnly?: boolean | undefined;
        };
        output: import("../social/SocialStore").NotificationRow[];
        meta: object;
    }>;
    unreadCount: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
        };
        output: number;
        meta: object;
    }>;
    /** Mark notifications read — wallet-signature authed (only you mark your own). */
    markNotificationsRead: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wallet: string;
            signature: string;
            timestamp: number;
            ids?: string[] | undefined;
        };
        output: {
            ok: boolean;
            count?: number;
        };
        meta: object;
    }>;
    /**
     * Link a Google/X identity to a wallet. Doubly authenticated: `accessToken` is
     * the Supabase Auth session from the OAuth sign-in (verified against GoTrue, so
     * we trust the provider identity), and the wallet SIGNATURE proves wallet
     * ownership — so no one can attach someone else's social account to a wallet,
     * or a wallet they don't own to a social account.
     */
    linkIdentity: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wallet: string;
            signature: string;
            timestamp: number;
            accessToken: string;
        };
        output: {
            ok: boolean;
            result?: unknown;
        };
        meta: object;
    }>;
    /**
     * Web-only counterpart to linkIdentity: links ALL of the caller's already-
     * linked Privy X/Google identities to their wallet in one call. No separate
     * wallet-sig proof needed — unlike mobile's Supabase-Auth-based flow, the
     * Bearer token itself already IS Privy's proof of both the social identity
     * and wallet ownership (authedProcedure resolves ctx.wallet from the exact
     * same verified token). Fire-and-forget right after login; safe to call
     * repeatedly (link_identity is idempotent per provider+subject).
     */
    linkIdentityFromPrivy: import("@trpc/server").TRPCMutationProcedure<{
        input: void;
        output: {
            linked: string[];
        };
        meta: object;
    }>;
    /** Batch resolve wallets -> display (handle/name/avatar) for feed rendering. */
    walletProfiles: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallets: string[];
        };
        output: import("../social/SocialStore").WalletProfileRow[];
        meta: object;
    }>;
    /**
     * Add a pending "follow this X handle once they join" target — Venmo's
     * "send to a number that isn't registered yet" pattern applied to the social
     * graph. Wallet-signature authed, same posture as follow/unfollow: proves
     * the caller controls the wallet before recording the intent. Resolves
     * immediately if the handle already belongs to a joined user.
     */
    createPendingTarget: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wallet: string;
            signature: string;
            timestamp: number;
            providerUsername: string;
            provider?: "twitter" | undefined;
        };
        output: {
            id: string;
            resolvedWalletAddress: string | null;
            alreadyResolved: boolean;
        };
        meta: object;
    }>;
    /** A wallet's pending + resolved identity targets, newest first. */
    pendingTargets: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wallet: string;
            limit?: number | undefined;
        };
        output: import("../social/SocialStore").PendingTargetRow[];
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
            stake: bigint;
            matchId: string;
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
            stake: bigint;
            matchId: string;
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
    /**
     * Mobile MWA flow: the wallet signs/sends directly to chumbucket_arena, then
     * the app submits the tx signature here so the social read model can show the
     * call immediately. The indexer/reconciler later upgrades the record with slot
     * and parsed account data; the unique signature makes retries harmless.
     */
    recordPredictionCall: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            bucket: "HOME" | "DRAW" | "AWAY";
            wallet: string;
            signature: string;
            matchId: string;
            txSignature: string;
            timestamp: number;
            stakeBaseUnits: string;
            marketId?: string | undefined;
            slot?: number | undefined;
            positionAddress?: string | undefined;
            metadata?: Record<string, unknown> | undefined;
        };
        output: {
            ok: boolean;
            positionId?: string;
            reason?: string;
        };
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
    reconcile: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            key: string;
        };
        output: {
            ok: false;
            reason: string;
            summary?: undefined;
        } | {
            ok: true;
            summary: import("../indexer/ArenaReconciler").ReconcileSummary;
            reason?: undefined;
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
