/**
 * Branded identifiers and money units.
 *
 * Money is represented in FROST — the smallest unit staked in this game — as a
 * `bigint`, so the parimutuel maths never touches floating point. superjson
 * carries bigints across the tRPC boundary intact. On Solana the staked asset
 * is USDC (6 decimals), so FROST_PER_WAL is 1e6, not WAL's native 1e9 — the
 * name is kept internal/unchanged (see the plan: repoint, don't rename) since
 * it's an implementation detail no caller depends on the literal token for.
 */
export type Brand<T, B extends string> = T & {
    readonly __brand: B;
};
export type Wallet = Brand<string, "Wallet">;
export type MatchId = Brand<string, "MatchId">;
export type MarketId = Brand<string, "MarketId">;
export type Bucket = Brand<string, "Bucket">;
export type CallId = Brand<string, "CallId">;
export type TakeId = Brand<string, "TakeId">;
export type VerdictId = Brand<string, "VerdictId">;
export type ChallengeId = Brand<string, "ChallengeId">;
export type EventId = Brand<string, "EventId">;
export declare const FROST_PER_WAL = 1000000n;
/** Money, in FROST. */
export type Frost = bigint;
export declare const wal: (whole: number) => Frost;
export declare const formatWal: (frost: Frost) => string;
export declare const asWallet: (s: string) => Wallet;
export declare const asMatchId: (s: string) => MatchId;
export declare const asMarketId: (s: string) => MarketId;
export declare const asBucket: (s: string) => Bucket;
export declare const asChallengeId: (s: string) => ChallengeId;
export declare const asCallId: (s: string) => CallId;
export declare const newId: <T extends string>(prefix: string) => Brand<string, T>;
export declare const newWithdrawalId: () => string;
export declare const newCallId: () => Brand<string, "CallId">;
export declare const newTakeId: () => Brand<string, "TakeId">;
export declare const newVerdictId: () => Brand<string, "VerdictId">;
export declare const newChallengeId: () => Brand<string, "ChallengeId">;
export declare const newEventId: () => Brand<string, "EventId">;
/** The per-player Walrus namespace — one player, one continuous owned memory. */
export declare const playerStream: (w: Wallet) => string;
/** Shared game state for a single fixture. */
export declare const matchStream: (m: MatchId) => string;
/** A single 1-v-1 challenge escrow — a private 2-party aggregate, one per challenge. */
export declare const challengeStream: (c: ChallengeId) => string;
export declare const HOUSE_WALLET_PREFIX = "house:";
export declare const houseWallet: (i: number) => Wallet;
export declare const isHouseWallet: (w: Wallet) => boolean;
