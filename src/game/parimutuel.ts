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

import type { Bucket, CallId, Frost, Wallet } from "../domain/ids.ts";

export interface CallStake {
  callId: CallId;
  wallet: Wallet;
  bucket: Bucket;
  stake: Frost;
}

export interface SettlementInput {
  calls: CallStake[];
  winningBucket: Bucket;
  rakeBps: number; // e.g. 250 = 2.50%
  minParticipants: number; // thin-pool threshold (distinct wallets)
}

export interface Payout {
  callId: CallId;
  wallet: Wallet;
  stake: Frost;
  payout: Frost; // total returned to the player
  won: boolean;
}

export type SettlementResult =
  | {
      kind: "PAID";
      winningBucket: Bucket;
      grossPot: Frost;
      rake: Frost;
      winnersStake: Frost;
      distributable: Frost; // losers' money handed to winners (after rake)
      payouts: Payout[];
    }
  | {
      kind: "VOID";
      reason: string;
      grossPot: Frost;
      payouts: Payout[]; // full refunds, won=false
    };

const byCallId = (a: { callId: CallId }, b: { callId: CallId }): number =>
  a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0;

export function settleParimutuel(input: SettlementInput): SettlementResult {
  const { calls, winningBucket, rakeBps, minParticipants } = input;
  const grossPot = calls.reduce((s, c) => s + c.stake, 0n);

  const refundAll = (reason: string): SettlementResult => ({
    kind: "VOID",
    reason,
    grossPot,
    payouts: calls.map((c) => ({
      callId: c.callId,
      wallet: c.wallet,
      stake: c.stake,
      payout: c.stake,
      won: false,
    })),
  });

  if (calls.length === 0) {
    return { kind: "VOID", reason: "no calls", grossPot: 0n, payouts: [] };
  }

  const participants = new Set(calls.map((c) => c.wallet)).size;
  if (participants < minParticipants) return refundAll("thin pool");

  const winners = calls.filter((c) => c.bucket === winningBucket);
  const winnersStake = winners.reduce((s, c) => s + c.stake, 0n);
  if (winnersStake === 0n) return refundAll("no correct calls");

  const losersStake = grossPot - winnersStake;
  const rake = (losersStake * BigInt(Math.round(rakeBps))) / 10000n;
  const distributable = losersStake - rake;

  // Pro-rata share of the distributable pool, by stake. Integer division floors;
  // the leftover dust is handed out 1 frost at a time, deterministically.
  //
  // RECONCILIATION with the on-chain engine (onchain/.../claim.rs): this instant
  // ledger FULLY distributes the pool (sum of payouts == grossPot - rake to the
  // last frost). The pull-based on-chain claim floors each winner and RETAINS the
  // dust in the vault (it can't redistribute without tracking claim order at CU
  // cost). So per-winner they agree to the floor; they diverge only by the dust
  // (< winners frost), which off-chain hands to winners and on-chain leaves in the
  // vault. When the on-chain pot becomes money-of-record (P1-F), THIS function
  // becomes a predictor and switches to floor-only to match exactly — not before,
  // since that would leak the dust out of the live authoritative ledger today.
  const sortedWinners = [...winners].sort(byCallId);
  const payoutByCall = new Map<CallId, Frost>();
  let allocated = 0n;
  for (const w of sortedWinners) {
    const share = (distributable * w.stake) / winnersStake;
    allocated += share;
    payoutByCall.set(w.callId, w.stake + share);
  }
  let dust = distributable - allocated; // >= 0
  for (const w of sortedWinners) {
    if (dust <= 0n) break;
    payoutByCall.set(w.callId, (payoutByCall.get(w.callId) ?? 0n) + 1n);
    dust -= 1n;
  }

  const winnerSet = new Set(winners.map((w) => w.callId));
  const payouts: Payout[] = calls.map((c) => {
    const won = winnerSet.has(c.callId);
    return {
      callId: c.callId,
      wallet: c.wallet,
      stake: c.stake,
      payout: won ? (payoutByCall.get(c.callId) ?? c.stake) : 0n,
      won,
    };
  });

  return {
    kind: "PAID",
    winningBucket,
    grossPot,
    rake,
    winnersStake,
    distributable,
    payouts,
  };
}

/**
 * Crowd-implied probability of a bucket = its share of the Pot. Used both to
 * show live odds and to score the difficulty of a call at the moment it's made.
 */
export function impliedProb(bucketStake: Frost, totalStake: Frost): number {
  if (totalStake <= 0n) return 0;
  // ratio of two bigints as a float, scaled for precision
  return Number((bucketStake * 1_000_000n) / totalStake) / 1_000_000;
}
