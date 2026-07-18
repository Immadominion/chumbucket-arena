/**
 * SocialStore — durable social prediction read models.
 *
 * The Engine/event log is still the domain brain, and the on-chain program is
 * still the funds source of truth. This adapter writes/querys the Supabase
 * social read model that powers mobile feeds, profiles, positions, and
 * settlement history.
 */
export interface SocialStoreConfig {
    supabaseUrl: string;
    serviceRoleKey: string;
    network: "devnet" | "mainnet-beta";
}
export interface RecordPredictionCallInput {
    wallet: string;
    matchId: string;
    marketId: string;
    bucket: string;
    stakeBaseUnits: string;
    txSignature: string;
    positionAddress?: string;
    slot?: number;
    metadata?: Record<string, unknown>;
}
export interface ConfirmPredictionSignatureInput {
    source: string;
    txSignature: string;
    slot?: number;
    payload?: Record<string, unknown>;
}
export interface ApplySettlementInput {
    marketId: string;
    matchId: string;
    /** HOME | DRAW | AWAY */
    winningBucket: string;
    settleTxSignature: string;
    slot?: number;
    /** On-chain Pot.distributable (losers' pool minus rake), base units. */
    distributableBaseUnits: string;
    /** On-chain Pot.winners_stake, base units. 0 => the pot voided (refund all). */
    winnersStakeBaseUnits: string;
    scoreHome?: number;
    scoreAway?: number;
    fixtureId?: number;
    seq?: number;
    proofRef?: string;
    proof?: Record<string, unknown>;
}
export interface ApplyClaimInput {
    wallet: string;
    /** The Position PDA address the claim closed. */
    positionAddress: string;
    claimTxSignature: string;
    amountBaseUnits?: string;
    slot?: number;
}
export interface IndexerCursorRow {
    last_signature: string | null;
    last_slot: number | null;
}
export interface FollowCounts {
    followers: number;
    following: number;
}
export interface MatchCallerRow {
    wallet_address: string;
    handle: string | null;
    bucket: string;
    stake_base_units: string;
    status: string;
    payout_base_units: string | null;
    placed_at: string;
}
export interface LeaderboardRow {
    wallet_address: string;
    handle: string | null;
    display_name: string | null;
    calls_made: number;
    calls_won: number;
    calls_lost: number;
    calls_voided: number;
    pnl_base_units: string;
    current_streak: number;
    best_streak: number;
    win_rate: number;
}
export interface UserStatsRow {
    user_id: string;
    wallet_address: string | null;
    calls_made: number;
    calls_won: number;
    calls_lost: number;
    calls_voided: number;
    stake_base_units: string;
    pnl_base_units: string;
    current_streak: number;
    best_streak: number;
}
export interface NotificationRow {
    id: string;
    network: string;
    recipient_wallet_address: string | null;
    type: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    status: string;
    read_at: string | null;
    created_at: string;
}
export interface OAuthIdentity {
    provider: string;
    subject: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string;
    email?: string;
}
export interface WalletProfileRow {
    wallet_address: string;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
    x_handle: string | null;
    verified: boolean;
}
export interface PredictionPositionRow {
    id: string;
    network: string;
    wallet_address: string;
    market_id: string;
    match_id: string;
    position_address: string | null;
    bucket: string;
    stake_base_units: string;
    open_tx_signature: string;
    open_slot: number | null;
    status: string;
    payout_base_units: string | null;
    pnl_base_units: string | null;
    settlement_tx_signature: string | null;
    claim_tx_signature: string | null;
    claimed_at: string | null;
    placed_at: string;
    settled_at: string | null;
    metadata: Record<string, unknown>;
}
export interface PredictionActivityRow {
    id: string;
    network: string;
    actor_wallet_address: string;
    type: string;
    visibility: string;
    market_id: string | null;
    match_id: string | null;
    position_id: string | null;
    challenge_id: string | null;
    bucket: string | null;
    stake_base_units: string | null;
    tx_signature: string | null;
    slot: number | null;
    status: string;
    title: string | null;
    body: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
}
export interface SocialStore {
    readonly enabled: boolean;
    recordPredictionCall(input: RecordPredictionCallInput): Promise<{
        ok: boolean;
        positionId?: string;
        reason?: string;
    }>;
    confirmPredictionSignature(input: ConfirmPredictionSignatureInput): Promise<{
        ok: boolean;
        result?: unknown;
        reason?: string;
    }>;
    applySettlement(input: ApplySettlementInput): Promise<{
        ok: boolean;
        result?: unknown;
        reason?: string;
    }>;
    applyClaim(input: ApplyClaimInput): Promise<{
        ok: boolean;
        result?: unknown;
        reason?: string;
    }>;
    advanceCursor(source: string, cursorKey: string, signature: string, slot?: number): Promise<void>;
    readCursor(source: string, cursorKey: string): Promise<IndexerCursorRow | null>;
    myPositions(wallet: string, limit: number): Promise<PredictionPositionRow[]>;
    claimable(wallet: string, limit: number): Promise<PredictionPositionRow[]>;
    activity(input: {
        matchId?: string;
        wallet?: string;
        limit: number;
    }): Promise<PredictionActivityRow[]>;
    follow(follower: string, followee: string): Promise<{
        ok: boolean;
        result?: unknown;
        reason?: string;
    }>;
    unfollow(follower: string, followee: string): Promise<{
        ok: boolean;
        result?: unknown;
        reason?: string;
    }>;
    followingFeed(wallet: string, limit: number): Promise<PredictionActivityRow[]>;
    followCounts(wallet: string): Promise<FollowCounts>;
    isFollowing(viewer: string, target: string): Promise<boolean>;
    matchCallers(matchId: string, limit: number): Promise<MatchCallerRow[]>;
    socialLeaderboard(by: string, limit: number): Promise<LeaderboardRow[]>;
    userStats(wallet: string): Promise<UserStatsRow | null>;
    notifications(wallet: string, limit: number, unreadOnly: boolean): Promise<NotificationRow[]>;
    unreadCount(wallet: string): Promise<number>;
    markNotificationsRead(wallet: string, ids?: string[]): Promise<{
        ok: boolean;
        count?: number;
    }>;
    verifyOAuthUser(accessToken: string): Promise<OAuthIdentity | null>;
    linkIdentity(wallet: string, identity: OAuthIdentity): Promise<{
        ok: boolean;
        result?: unknown;
    }>;
    walletProfiles(wallets: string[]): Promise<WalletProfileRow[]>;
}
export declare class NoopSocialStore implements SocialStore {
    readonly enabled = false;
    recordPredictionCall(): Promise<{
        ok: boolean;
        reason: string;
    }>;
    confirmPredictionSignature(): Promise<{
        ok: boolean;
        reason: string;
    }>;
    applySettlement(): Promise<{
        ok: boolean;
        reason: string;
    }>;
    applyClaim(): Promise<{
        ok: boolean;
        reason: string;
    }>;
    advanceCursor(): Promise<void>;
    readCursor(): Promise<IndexerCursorRow | null>;
    myPositions(): Promise<PredictionPositionRow[]>;
    claimable(): Promise<PredictionPositionRow[]>;
    activity(): Promise<PredictionActivityRow[]>;
    follow(): Promise<{
        ok: boolean;
        reason: string;
    }>;
    unfollow(): Promise<{
        ok: boolean;
        reason: string;
    }>;
    followingFeed(): Promise<PredictionActivityRow[]>;
    followCounts(): Promise<FollowCounts>;
    isFollowing(): Promise<boolean>;
    matchCallers(): Promise<MatchCallerRow[]>;
    socialLeaderboard(): Promise<LeaderboardRow[]>;
    userStats(): Promise<UserStatsRow | null>;
    notifications(): Promise<NotificationRow[]>;
    unreadCount(): Promise<number>;
    markNotificationsRead(): Promise<{
        ok: boolean;
    }>;
    verifyOAuthUser(): Promise<OAuthIdentity | null>;
    linkIdentity(): Promise<{
        ok: boolean;
        reason: string;
    }>;
    walletProfiles(): Promise<WalletProfileRow[]>;
}
export declare class SupabaseSocialStore implements SocialStore {
    private readonly cfg;
    private readonly fetchImpl;
    readonly enabled = true;
    private readonly restBase;
    constructor(cfg: SocialStoreConfig, fetchImpl?: typeof fetch);
    recordPredictionCall(input: RecordPredictionCallInput): Promise<{
        ok: boolean;
        positionId?: string;
        reason?: string;
    }>;
    confirmPredictionSignature(input: ConfirmPredictionSignatureInput): Promise<{
        ok: boolean;
        result?: unknown;
        reason?: string;
    }>;
    myPositions(wallet: string, limit: number): Promise<PredictionPositionRow[]>;
    activity(input: {
        matchId?: string;
        wallet?: string;
        limit: number;
    }): Promise<PredictionActivityRow[]>;
    applySettlement(input: ApplySettlementInput): Promise<{
        ok: boolean;
        result?: unknown;
        reason?: string;
    }>;
    applyClaim(input: ApplyClaimInput): Promise<{
        ok: boolean;
        result?: unknown;
        reason?: string;
    }>;
    advanceCursor(source: string, cursorKey: string, signature: string, slot?: number): Promise<void>;
    readCursor(source: string, cursorKey: string): Promise<IndexerCursorRow | null>;
    claimable(wallet: string, limit: number): Promise<PredictionPositionRow[]>;
    follow(follower: string, followee: string): Promise<{
        ok: boolean;
        result?: unknown;
    }>;
    unfollow(follower: string, followee: string): Promise<{
        ok: boolean;
        result?: unknown;
    }>;
    followingFeed(wallet: string, limit: number): Promise<PredictionActivityRow[]>;
    followCounts(wallet: string): Promise<FollowCounts>;
    isFollowing(viewer: string, target: string): Promise<boolean>;
    matchCallers(matchId: string, limit: number): Promise<MatchCallerRow[]>;
    socialLeaderboard(by: string, limit: number): Promise<LeaderboardRow[]>;
    userStats(wallet: string): Promise<UserStatsRow | null>;
    notifications(wallet: string, limit: number, unreadOnly: boolean): Promise<NotificationRow[]>;
    unreadCount(wallet: string): Promise<number>;
    markNotificationsRead(wallet: string, ids?: string[]): Promise<{
        ok: boolean;
        count?: number;
    }>;
    /** Verify a Supabase Auth session token by asking GoTrue who it belongs to,
     *  then extract the Google/X identity. Returns null if the token is invalid. */
    verifyOAuthUser(accessToken: string): Promise<OAuthIdentity | null>;
    linkIdentity(wallet: string, identity: OAuthIdentity): Promise<{
        ok: boolean;
        result?: unknown;
    }>;
    walletProfiles(wallets: string[]): Promise<WalletProfileRow[]>;
    private rpc;
    private getRows;
    private headers;
    private decode;
}
