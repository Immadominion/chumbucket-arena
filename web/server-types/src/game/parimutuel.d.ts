/**
 * Parimutuel settlement. The crowd sets the odds: winners split the whole Pot
 * pro-rata to their stake. No house, no fixed odds, no oracle for prices.
 *
 * Money is FROST (bigint), so this is exact integer arithmetic. Rounding dust
 * from integer division is handed back to winners deterministically so the sum
 * of payouts always reconciles to (grossPot - rake) to the last frost.
 *
 * Rake is taken only from the *losers'* pool, never from a winner's own stake —
 * a winner is always made at least whole.
 */
import type { Bucket, CallId, Frost, Wallet } from "../domain/ids";
export interface CallStake {
    callId: CallId;
    wallet: Wallet;
    bucket: Bucket;
    stake: Frost;
}
export interface SettlementInput {
    calls: CallStake[];
    winningBucket: Bucket;
    rakeBps: number;
    minParticipants: number;
}
export interface Payout {
    callId: CallId;
    wallet: Wallet;
    stake: Frost;
    payout: Frost;
    won: boolean;
}
export type SettlementResult = {
    kind: "PAID";
    winningBucket: Bucket;
    grossPot: Frost;
    rake: Frost;
    winnersStake: Frost;
    distributable: Frost;
    payouts: Payout[];
} | {
    kind: "VOID";
    reason: string;
    grossPot: Frost;
    payouts: Payout[];
};
export declare function settleParimutuel(input: SettlementInput): SettlementResult;
/**
 * Crowd-implied probability of a bucket = its share of the Pot. Used both to
 * show live odds and to score the difficulty of a call at the moment it's made.
 */
export declare function impliedProb(bucketStake: Frost, totalStake: Frost): number;
