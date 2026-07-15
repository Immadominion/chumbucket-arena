/**
 * The event-sourcing spine.
 *
 * Every meaningful thing that ever happens is an immutable event appended to a
 * stream. The Dossier, the Pots, the Leaderboard, the Gaffer's read on you — all
 * of it is a *projection* of these events. The events are the source of truth and
 * they live on Walrus. Nothing is mutated; new facts are only ever appended.
 */

import type {
  Bucket,
  CallId,
  ChallengeId,
  EventId,
  Frost,
  MarketId,
  MatchId,
  TakeId,
  VerdictId,
  Wallet,
} from "./ids.ts";
import type { Fixture, MarketDef, Outcome, Tier, VerdictTrigger } from "./model.ts";

// ── Player stream events (namespace: gaffer:<wallet>) ────────────────────────
// This stream *is* the player's Walrus memory. It is what the judges score.

export interface PlayerSigned {
  type: "PlayerSigned";
  wallet: Wallet;
  handle?: string;
}

export interface Deposited {
  type: "Deposited";
  amount: Frost;
  custodyRef?: string; // tx digest from the Custody port
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
  amount: Frost; // gross — what leaves the player's balance
  fee?: Frost; // house fee kept in the Sessions wallet (covers gas)
  custodyRef?: string;
}

export interface WithdrawalInitiated {
  type: "WithdrawalInitiated";
  withdrawalId: string;
  amount: Frost; // gross — debited from balance NOW, before the send
  fee?: Frost; // recorded here, but only becomes house revenue on Settled
}

export interface WithdrawalSettled {
  type: "WithdrawalSettled";
  withdrawalId: string;
  amount: Frost;
  fee?: Frost; // house revenue is realised here, on a confirmed send
  custodyRef?: string; // the on-chain tx signature
}

export interface WithdrawalReversed {
  type: "WithdrawalReversed";
  withdrawalId: string;
  amount: Frost; // credited back — the send failed, player made whole
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
  subject?: string; // best-effort entity the take is about ("France")
}

export interface CallSettled {
  type: "CallSettled";
  callId: CallId;
  matchId: MatchId;
  marketId: MarketId;
  result: "WON" | "LOST";
  stake: Frost;
  payout: Frost; // total returned to the player (0 if lost)
  pnlDelta: Frost; // payout - stake (signed)
  grDelta: number; // change to Gaffer Rating (skill), stake-independent
  difficulty: number; // 0..1, how unlikely the crowd thought this was
}

export interface CallVoided {
  type: "CallVoided";
  callId: CallId;
  matchId: MatchId;
  marketId: MarketId;
  refund: Frost;
  reason: string; // "match abandoned", "thin pool", ...
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
  quotes: string[]; // past-self lines the Gaffer threw back
}

/** A chat turn with the Gaffer — the transcript is part of the player's memory. */
export interface ChatExchanged {
  type: "ChatExchanged";
  message: string; // the player's line
  reply: string; // the Gaffer's reply
}

// ── 1-v-1 challenge stakes (player-stream money legs) ────────────────────────
// A challenge is a private 2-party escrow (its lifecycle lives on its own
// gaffer:challenge:<id> stream). The MONEY moves on each player's own stream via
// these events, so every PlayerActor stays the single writer of its balance —
// exactly like CallMade/CallSettled/CallVoided, but isolated from the communal
// parimutuel pot (they never touch the Pots or the GR/skill ladder).

export interface ChallengeStakeLocked {
  type: "ChallengeStakeLocked";
  challengeId: ChallengeId;
  matchId: MatchId;
  side: Bucket; // the RESULT bucket this player backs (HOME/DRAW/AWAY)
  stake: Frost;
  role: "CREATOR" | "OPPONENT";
}

export interface ChallengeStakeSettled {
  type: "ChallengeStakeSettled";
  challengeId: ChallengeId;
  matchId: MatchId;
  result: "WON" | "LOST";
  stake: Frost;
  payout: Frost; // 2·stake − rake for the winner, 0 for the loser
  pnlDelta: Frost; // payout − stake (signed)
}

export interface ChallengeStakeRefunded {
  type: "ChallengeStakeRefunded";
  challengeId: ChallengeId;
  matchId: MatchId;
  refund: Frost;
  reason: string; // "challenge cancelled", "no correct calls", …
}

export type PlayerEvent =
  | PlayerSigned
  | Deposited
  | Withdrawn
  | WithdrawalInitiated
  | WithdrawalSettled
  | WithdrawalReversed
  | WelcomeGranted
  | HouseSeeded
  | CallMade
  | HotTakeDeclared
  | CallSettled
  | CallVoided
  | TierChanged
  | TraitObserved
  | VerdictIssued
  | ChatExchanged
  | ChallengeStakeLocked
  | ChallengeStakeSettled
  | ChallengeStakeRefunded;

// ── Match stream events (namespace: gaffer:match:<id>) ───────────────────────
// Shared game state for one fixture: its market, its Pots, its result.

export interface MatchOpened {
  type: "MatchOpened";
  fixture: Fixture;
  markets: MarketDef[];
}

export interface MatchLocked {
  type: "MatchLocked";
  matchId: MatchId;
}

export interface MatchResolved {
  type: "MatchResolved";
  matchId: MatchId;
  score: { home: number; away: number };
  /** marketId -> winning bucket, or VOID. */
  outcomes: Record<string, Outcome>;
  source: string; // provenance: which data feed adjudicated it
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

export type MatchEvent = MatchOpened | MatchLocked | MatchResolved | PotSettled;

// ── Challenge stream events (namespace: gaffer:challenge:<id>) ────────────────
// The escrow aggregate for one 1-v-1 wager: who created it, who accepted, and
// how it resolved. Single writer = the Engine (like a match stream). The money
// legs live on the two player streams (see ChallengeStake* above).

export interface ChallengeCreated {
  type: "ChallengeCreated";
  challengeId: ChallengeId;
  matchId: MatchId;
  creator: Wallet;
  creatorSide: Bucket; // the RESULT bucket the creator backs
  opponentSide: Bucket; // the (distinct) bucket the opponent auto-takes
  stake: Frost; // both sides stake this equally
}

export interface ChallengeAccepted {
  type: "ChallengeAccepted";
  challengeId: ChallengeId;
  opponent: Wallet;
}

export interface ChallengeSettled {
  type: "ChallengeSettled";
  challengeId: ChallengeId;
  winningBucket: Bucket; // the result bucket that decided it
  winner: Wallet;
  grossPot: Frost; // both stakes combined
  rake: Frost; // house cut of the loser's stake → Manager's Pot
  payout: Frost; // credited to the winner (grossPot − rake)
}

export interface ChallengeVoided {
  type: "ChallengeVoided";
  challengeId: ChallengeId;
  winningBucket: Outcome; // the result nobody picked (both stakes refunded)
  reason: string;
}

export interface ChallengeCancelled {
  type: "ChallengeCancelled";
  challengeId: ChallengeId;
}

export type ChallengeEvent =
  | ChallengeCreated
  | ChallengeAccepted
  | ChallengeSettled
  | ChallengeVoided
  | ChallengeCancelled;

// ── Envelope ─────────────────────────────────────────────────────────────────

export type DomainEvent = PlayerEvent | MatchEvent | ChallengeEvent;
export type DomainEventType = DomainEvent["type"];

/** Narrow a DomainEvent union member by its `type` tag. */
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

export interface EventMeta {
  id: EventId;
  streamId: string;
  version: number; // 0-based position within its stream
  at: number; // unix ms, assigned at append time
}

/** An event as it lives in the store: payload + position metadata. */
export interface StoredEvent<E extends DomainEvent = DomainEvent> {
  meta: EventMeta;
  payload: E;
}
