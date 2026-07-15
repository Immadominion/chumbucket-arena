/**
 * Commands are *intents* — what a player asks to do. The player actor validates
 * a command against current state and, if it holds, appends one or more events.
 * Commands can be rejected; events never are (they already happened).
 */

import type { Bucket, ChallengeId, Frost, MarketId, MatchId, TakeId, Wallet } from "./ids.ts";
import type { VerdictTrigger } from "./model.ts";

export interface SignContract {
  type: "SignContract";
  wallet: Wallet;
  handle?: string;
}

export interface Deposit {
  type: "Deposit";
  wallet: Wallet;
  amount: Frost;
}

export interface Withdraw {
  type: "Withdraw";
  wallet: Wallet;
  amount: Frost;
}

export interface MakeCall {
  type: "MakeCall";
  wallet: Wallet;
  matchId: MatchId;
  marketId: MarketId;
  bucket: Bucket;
  stake: Frost;
  note?: string;
}

export interface DeclareHotTake {
  type: "DeclareHotTake";
  wallet: Wallet;
  text: string;
}

export interface RequestVerdict {
  type: "RequestVerdict";
  wallet: Wallet;
  trigger: VerdictTrigger;
}

/** Open a 1-v-1 challenge on a match: lock the creator's stake, invite an opponent. */
export interface CreateChallenge {
  type: "CreateChallenge";
  wallet: Wallet;
  matchId: MatchId;
  side: Bucket;
  stake: Frost;
  opponentSide?: Bucket; // defaults to counterSide(side); overridable for DRAW challenges
}

/** Take the open side of a challenge, locking an equal stake. */
export interface AcceptChallenge {
  type: "AcceptChallenge";
  wallet: Wallet;
  challengeId: ChallengeId;
}

/** Withdraw an un-accepted challenge before anyone takes it — refunds the creator. */
export interface CancelChallenge {
  type: "CancelChallenge";
  wallet: Wallet;
  challengeId: ChallengeId;
}

export type Command =
  | SignContract
  | Deposit
  | Withdraw
  | MakeCall
  | DeclareHotTake
  | RequestVerdict
  | CreateChallenge
  | AcceptChallenge
  | CancelChallenge;

export type CommandType = Command["type"];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
