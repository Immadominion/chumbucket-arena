/**
 * The player actor. One per player, it owns that player's stream and is the only
 * writer to it. Every command is validated against the current Dossier and, if
 * it holds, turned into events appended under optimistic concurrency. Commands
 * run one at a time through the mailbox, so there are no races on a player.
 *
 * Settlement instructions (settleCall/voidCall) come from the settlement saga but
 * still flow through this actor's mailbox, preserving single-writer ordering.
 */

import type { GameConfig } from "../../config.ts";
import { DomainError, fail } from "../../domain/errors.ts";
import type { DomainEvent } from "../../domain/events.ts";
import {
  asBucket,
  formatWal,
  newCallId,
  newTakeId,
  newVerdictId,
  newWithdrawalId,
  playerStream,
  type Bucket,
  type CallId,
  type ChallengeId,
  type Frost,
  type MarketId,
  type MatchId,
  type Wallet,
} from "../../domain/ids.ts";
import type { VerdictTrigger } from "../../domain/model.ts";
import { difficultyOf, grDelta } from "../../game/rating.ts";
import { tierForGr, tierIndex } from "../../game/tiers.ts";
import type { Gaffer, Verdict } from "../../gaffer/Gaffer.ts";
import type { DossierView } from "../projections/DossierProjection.ts";
import type { ReadModel } from "../projections/ReadModel.ts";
import type { EventStore } from "../eventstore/EventStore.ts";
import type { Custody } from "../../ports/Custody.ts";
import { Mailbox } from "./Mailbox.ts";

export interface PlayerActorDeps {
  store: EventStore;
  readModel: ReadModel;
  custody: Custody;
  gaffer: Gaffer;
  config: GameConfig;
}

export interface MakeCallInput {
  matchId: MatchId;
  marketId: MarketId;
  bucket: string;
  stake: Frost;
  note?: string;
}

export interface LockChallengeStakeInput {
  challengeId: ChallengeId;
  matchId: MatchId;
  side: Bucket;
  stake: Frost;
  role: "CREATOR" | "OPPONENT";
}

export class PlayerActor {
  private readonly mailbox = new Mailbox();
  private readonly streamId: string;
  private version = -1; // -1 = not yet loaded from the store

  constructor(
    private readonly wallet: Wallet,
    private readonly deps: PlayerActorDeps,
  ) {
    this.streamId = playerStream(wallet);
  }

  // ── commands ───────────────────────────────────────────────────────────────

  signContract(handle?: string): Promise<{ wallet: Wallet }> {
    return this.mailbox.run(async () => {
      if (this.dossier()) fail("ALREADY_SIGNED", "you've already signed for the Gaffer");
      await this.append([
        { type: "PlayerSigned", wallet: this.wallet, ...(handle ? { handle } : {}) },
      ]);
      return { wallet: this.wallet };
    });
  }

  deposit(amount: Frost, proof?: string): Promise<{ balance: Frost }> {
    return this.mailbox.run(async () => {
      this.requireSigned();
      if (amount <= 0n) fail("INVALID", "deposit must be positive");
      // Replay guard: a real deposit's proof (tx digest) can only be credited once.
      if (proof && (await this.depositRefSeen(proof))) {
        fail("DUPLICATE_DEPOSIT", "this deposit has already been credited");
      }
      const { ref } = await this.deps.custody.confirmDeposit(this.wallet, amount, proof);
      await this.append([{ type: "Deposited", amount, custodyRef: ref }]);
      return { balance: this.requireSigned().balance };
    });
  }

  withdraw(amount: Frost): Promise<{ balance: Frost; ref: string; net: Frost; fee: Frost }> {
    return this.mailbox.run(async () => {
      const d = this.requireSigned();
      if (amount <= 0n) fail("INVALID", "withdrawal must be positive");
      if (d.balance < amount) {
        fail("INSUFFICIENT_BALANCE", "only free balance is withdrawable", {
          free: formatWal(d.balance),
        });
      }
      // House fee covers the on-chain gas + margin: max(bps%, flat floor). The
      // player's balance drops by the gross `amount`; the chain sends `net`; the
      // `fee` stays in the Sessions wallet as house revenue.
      const pctFee = (amount * BigInt(this.deps.config.withdrawFeeBps)) / 10000n;
      const fee = pctFee > this.deps.config.withdrawFeeMin ? pctFee : this.deps.config.withdrawFeeMin;
      if (amount <= fee) fail("INVALID", "withdrawal too small to cover the network fee");
      const net = amount - fee;

      // Two-phase, debit-first: reserve the funds on the ledger BEFORE the
      // on-chain send. A crash after the send can then never let a second
      // withdrawal double-pay — the balance is already gone. On send failure we
      // reverse the debit; on success we mark it settled (and realise the fee).
      const withdrawalId = newWithdrawalId();
      await this.append([{ type: "WithdrawalInitiated", withdrawalId, amount, fee }]);
      let ref: string;
      try {
        ({ ref } = await this.deps.custody.withdraw(this.wallet, net));
      } catch (e) {
        await this.append([
          { type: "WithdrawalReversed", withdrawalId, amount, reason: e instanceof Error ? e.message : String(e) },
        ]);
        throw e;
      }
      await this.append([{ type: "WithdrawalSettled", withdrawalId, amount, fee, custodyRef: ref }]);
      return { balance: this.requireSigned().balance, ref, net, fee };
    });
  }

  /**
   * Idempotent house-bot setup: make sure this synthetic bettor is signed and
   * holds its one-time, float-backed bankroll. Safe to call before every seed —
   * it appends nothing once the bot is already set up, so it never double-funds
   * (the cap on house exposure relies on this).
   */
  ensureHouseFunded(amount: Frost): Promise<void> {
    return this.mailbox.run(async () => {
      const events = await this.deps.store.readStream(this.streamId);
      const signed = events.some((e) => e.payload.type === "PlayerSigned");
      const funded = events.some((e) => e.payload.type === "HouseSeeded");
      const toAppend: DomainEvent[] = [];
      if (!signed) toAppend.push({ type: "PlayerSigned", wallet: this.wallet, handle: "The House" });
      if (!funded) toAppend.push({ type: "HouseSeeded", amount });
      if (toAppend.length) await this.append(toAppend);
    });
  }

  /** One-time, non-withdrawable starter bonus. Idempotent per stream. */
  claimWelcomeGrant(amount: Frost): Promise<{ bonus: Frost }> {
    return this.mailbox.run(async () => {
      this.requireSigned();
      if (amount <= 0n) fail("INVALID", "grant must be positive");
      const events = await this.deps.store.readStream(this.streamId);
      if (events.some((e) => e.payload.type === "WelcomeGranted")) {
        fail("CONFLICT", "you've already claimed your starter balance");
      }
      await this.append([{ type: "WelcomeGranted", amount }]);
      return { bonus: this.requireSigned().bonus };
    });
  }

  makeCall(input: MakeCallInput): Promise<{ callId: CallId; impliedProbAtCall: number }> {
    return this.mailbox.run(async () => {
      const d = this.requireSigned();
      if (input.stake < this.deps.config.minStake) {
        fail("STAKE_TOO_SMALL", "stake below the minimum");
      }
      if (d.balance + d.bonus < input.stake) fail("INSUFFICIENT_BALANCE", "not enough balance to back this call");

      const match = this.deps.readModel.pots.getMatch(input.matchId);
      if (!match) throw new DomainError("MATCH_NOT_OPEN", "no such match");
      const market = match.markets.find((m) => m.marketId === input.marketId);
      if (!market) throw new DomainError("UNKNOWN_MARKET", "no such market on this match");
      if (market.status !== "OPEN") fail("MATCH_LOCKED", "calls are closed on this match");
      if (!market.buckets.some((b) => b.bucket === input.bucket)) {
        fail("UNKNOWN_BUCKET", "no such outcome on this market");
      }
      if (d.openCalls.some((c) => c.matchId === input.matchId && c.marketId === input.marketId)) {
        fail("DUPLICATE_CALL", "you've already called this market");
      }

      const impliedProbAtCall = this.deps.readModel.pots.impliedProbFor(
        input.matchId,
        input.marketId,
        input.bucket,
      );
      const callId = newCallId();
      await this.append([
        {
          type: "CallMade",
          callId,
          matchId: input.matchId,
          marketId: input.marketId,
          bucket: asBucket(input.bucket),
          stake: input.stake,
          impliedProbAtCall,
          bold: market.kind === "BOLD",
          ...(input.note ? { note: input.note } : {}),
        },
      ]);
      return { callId, impliedProbAtCall };
    });
  }

  /**
   * Lock this player's stake into a 1-v-1 challenge. Mirrors makeCall's balance
   * checks (spend the non-withdrawable bonus first, then free balance) but is
   * isolated from the communal pot — the escrow lives on its own challenge stream.
   * Idempotent per challenge, so a retry never double-locks.
   */
  lockChallengeStake(input: LockChallengeStakeInput): Promise<void> {
    return this.mailbox.run(async () => {
      const d = this.requireSigned();
      if (input.stake < this.deps.config.minStake) fail("STAKE_TOO_SMALL", "stake below the minimum");
      if (d.balance + d.bonus < input.stake) {
        fail("INSUFFICIENT_BALANCE", "not enough balance to back this challenge");
      }
      if (d.openChallengeStakes.some((s) => s.challengeId === input.challengeId)) return; // idempotent
      await this.append([
        {
          type: "ChallengeStakeLocked",
          challengeId: input.challengeId,
          matchId: input.matchId,
          side: input.side,
          stake: input.stake,
          role: input.role,
        },
      ]);
    });
  }

  declareHotTake(text: string): Promise<{ takeId: string }> {
    return this.mailbox.run(async () => {
      this.requireSigned();
      const trimmed = text.trim();
      if (!trimmed) fail("INVALID", "a hot take needs words");
      const takeId = newTakeId();
      await this.append([{ type: "HotTakeDeclared", takeId, text: trimmed }]);
      return { takeId };
    });
  }

  requestVerdict(trigger: VerdictTrigger): Promise<Verdict & { verdictId: string }> {
    return this.mailbox.run(async () => {
      this.requireSigned();
      const verdict = await this.deps.gaffer.composeVerdict({ wallet: this.wallet, trigger });
      const verdictId = newVerdictId();
      await this.append([
        {
          type: "VerdictIssued",
          verdictId,
          text: verdict.text,
          trigger,
          quotes: verdict.quotes,
        },
      ]);
      return { verdictId, ...verdict };
    });
  }

  /** Persist a chat turn (the reply is generated by the engine's Gaffer). */
  recordChat(message: string, reply: string): Promise<void> {
    return this.mailbox.run(async () => {
      if (!this.dossier()) return; // only signed players have a stream
      await this.append([{ type: "ChatExchanged", message, reply }]);
    });
  }

  // ── settlement instructions (from the saga) ─────────────────────────────────

  settleCall(callId: CallId, won: boolean, payout: Frost): Promise<void> {
    return this.mailbox.run(async () => {
      const d = this.dossier();
      const open = d?.openCalls.find((c) => c.callId === callId);
      if (!d || !open) return; // already settled / unknown → idempotent no-op

      const difficulty = difficultyOf(open.impliedProbAtCall);
      const delta = grDelta({
        impliedProbAtCall: open.impliedProbAtCall,
        won,
        bold: open.bold,
        formMultiplier: d.form.multiplier,
      });
      const events: DomainEvent[] = [
        {
          type: "CallSettled",
          callId,
          matchId: open.matchId,
          marketId: open.marketId,
          result: won ? "WON" : "LOST",
          stake: open.stake,
          payout,
          pnlDelta: payout - open.stake,
          grDelta: delta,
          difficulty,
        },
      ];

      const fromTier = tierForGr(d.gr);
      const toTier = tierForGr(d.gr + delta);
      if (fromTier !== toTier) {
        events.push({
          type: "TierChanged",
          from: fromTier,
          to: toTier,
          direction: tierIndex(toTier) > tierIndex(fromTier) ? "PROMOTION" : "DEMOTION",
          grAt: d.gr + delta,
        });
      }
      await this.append(events);
    });
  }

  voidCall(callId: CallId, reason: string): Promise<void> {
    return this.mailbox.run(async () => {
      const d = this.dossier();
      const open = d?.openCalls.find((c) => c.callId === callId);
      if (!d || !open) return;
      await this.append([
        {
          type: "CallVoided",
          callId,
          matchId: open.matchId,
          marketId: open.marketId,
          refund: open.stake,
          reason,
        },
      ]);
    });
  }

  /**
   * Credit the outcome of a settled challenge — the winner gets `payout`
   * (2·stake − rake), the loser gets 0. Mirrors settleCall but touches money
   * only (challenges don't move the GR/skill ladder). Idempotent: a no-op unless
   * the stake is still open, so a re-driven settlement never double-credits.
   */
  settleChallengeStake(challengeId: ChallengeId, result: "WON" | "LOST", payout: Frost): Promise<void> {
    return this.mailbox.run(async () => {
      const d = this.dossier();
      const open = d?.openChallengeStakes.find((s) => s.challengeId === challengeId);
      if (!d || !open) return; // already settled / unknown → idempotent no-op
      await this.append([
        {
          type: "ChallengeStakeSettled",
          challengeId,
          matchId: open.matchId,
          result,
          stake: open.stake,
          payout,
          pnlDelta: payout - open.stake,
        },
      ]);
    });
  }

  /** Return a challenge stake in full — on cancel, or a VOID (result nobody picked). */
  refundChallengeStake(challengeId: ChallengeId, reason: string): Promise<void> {
    return this.mailbox.run(async () => {
      const d = this.dossier();
      const open = d?.openChallengeStakes.find((s) => s.challengeId === challengeId);
      if (!d || !open) return; // idempotent
      await this.append([
        {
          type: "ChallengeStakeRefunded",
          challengeId,
          matchId: open.matchId,
          refund: open.stake,
          reason,
        },
      ]);
    });
  }

  observeTrait(trait: {
    key: string;
    label: string;
    confidence: number;
    evidence: string;
  }): Promise<void> {
    return this.mailbox.run(async () => {
      if (!this.dossier()) return;
      await this.append([
        {
          type: "TraitObserved",
          traitKey: trait.key,
          label: trait.label,
          confidence: trait.confidence,
          evidence: trait.evidence,
        },
      ]);
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Has this custody ref (deposit tx digest) already been credited on this stream? */
  private async depositRefSeen(ref: string): Promise<boolean> {
    const events = await this.deps.store.readStream(this.streamId);
    return events.some((e) => e.payload.type === "Deposited" && e.payload.custodyRef === ref);
  }

  private dossier(): DossierView | undefined {
    return this.deps.readModel.getDossier(this.wallet);
  }

  private requireSigned(): DossierView {
    const d = this.dossier();
    if (!d) throw new DomainError("NOT_SIGNED", "sign for the Gaffer first");
    return d;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.version >= 0) return;
    const events = await this.deps.store.readStream(this.streamId);
    this.version = events.length;
  }

  private async append(events: DomainEvent[]): Promise<void> {
    await this.ensureLoaded();
    const stored = await this.deps.store.append(this.streamId, events, {
      expectedVersion: this.version,
    });
    this.version += stored.length;
  }
}
