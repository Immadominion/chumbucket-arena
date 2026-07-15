/**
 * The Dossier — the Gaffer's file on a player, folded from their event stream.
 * This is the memory made legible: balance & P&L (money), GR & tier (skill),
 * record & form, open calls, distilled traits, hot takes, landmark calls.
 *
 * GR is the running sum of grDelta from BASE_GR; tier is *derived* from GR (you
 * can't buy rank). TierChanged events exist only to narrate the moment.
 */

import type { StoredEvent } from "../../domain/events.ts";
import type { CallId, ChallengeId, Frost, MarketId, MatchId, Wallet } from "../../domain/ids.ts";
import type { FormResult, Tier, Trait } from "../../domain/model.ts";
import { computeForm, type FormState } from "../../game/form.ts";
import { BASE_GR } from "../../game/rating.ts";
import { nextTierFloor, tierForGr } from "../../game/tiers.ts";
import type { Projection } from "./Projection.ts";

export interface OpenCallView {
  callId: CallId;
  matchId: MatchId;
  marketId: MarketId;
  bucket: string;
  stake: Frost;
  impliedProbAtCall: number;
  bold: boolean;
  at: number;
}

/** A stake locked into a live 1-v-1 challenge, awaiting the match result. */
export interface OpenChallengeStakeView {
  challengeId: ChallengeId;
  matchId: MatchId;
  side: string;
  stake: Frost;
  at: number;
}

interface DossierState {
  wallet: Wallet;
  handle?: string;
  signedAt: number;
  balance: Frost; // free, withdrawable
  locked: Frost; // staked, awaiting settlement
  bonus: Frost; // non-withdrawable starter bonus
  claimedGrant: boolean; // has the one-time welcome grant been claimed (onboarding marker)
  gr: number;
  pnl: Frost; // realised
  won: number;
  lost: number;
  voided: number;
  formResults: FormResult[];
  openCalls: Map<CallId, OpenCallView>;
  openChallengeStakes: Map<ChallengeId, OpenChallengeStakeView>;
  traits: Map<string, Trait>;
  hotTakes: { takeId: string; text: string; at: number }[];
  landmarks: { callId: CallId; matchId: MatchId; text: string; at: number }[];
  lastVerdict?: { text: string; at: number; trigger: string };
}

export interface DossierView {
  wallet: Wallet;
  handle: string | undefined;
  signedAt: number;
  balance: Frost;
  locked: Frost;
  bonus: Frost;
  claimedGrant: boolean;
  gr: number;
  tier: Tier;
  nextTier: { tier: Tier; min: number } | null;
  pnl: Frost;
  record: { won: number; lost: number; voided: number };
  form: FormState;
  openCalls: OpenCallView[];
  openChallengeStakes: OpenChallengeStakeView[];
  traits: Trait[];
  hotTakes: { takeId: string; text: string; at: number }[];
  landmarks: { callId: CallId; matchId: MatchId; text: string; at: number }[];
  lastVerdict: { text: string; at: number; trigger: string } | undefined;
}

export class DossierProjection implements Projection {
  readonly name = "dossier";
  private readonly byWallet = new Map<Wallet, DossierState>();

  apply(event: StoredEvent): void {
    const p = event.payload;
    switch (p.type) {
      case "PlayerSigned": {
        if (this.byWallet.has(p.wallet)) return;
        this.byWallet.set(p.wallet, {
          wallet: p.wallet,
          ...(p.handle !== undefined ? { handle: p.handle } : {}),
          signedAt: event.meta.at,
          balance: 0n,
          locked: 0n,
          bonus: 0n,
          claimedGrant: false,
          gr: BASE_GR,
          pnl: 0n,
          won: 0,
          lost: 0,
          voided: 0,
          formResults: [],
          openCalls: new Map(),
          openChallengeStakes: new Map(),
          traits: new Map(),
          hotTakes: [],
          landmarks: [],
        });
        return;
      }
      case "Deposited": {
        const s = this.walletOf(event);
        if (s) s.balance += p.amount;
        return;
      }
      case "Withdrawn": {
        // Legacy single-phase (replays old streams).
        const s = this.walletOf(event);
        if (s) s.balance -= p.amount;
        return;
      }
      case "WithdrawalInitiated": {
        // Two-phase debit: balance drops BEFORE the on-chain send.
        const s = this.walletOf(event);
        if (s) s.balance -= p.amount;
        return;
      }
      case "WithdrawalReversed": {
        // The send failed — refund the gross, player made whole.
        const s = this.walletOf(event);
        if (s) s.balance += p.amount;
        return;
      }
      case "WithdrawalSettled":
        return; // balance already debited at Initiated; nothing to change here
      case "WelcomeGranted": {
        const s = this.walletOf(event);
        if (s) {
          s.bonus += p.amount;
          s.claimedGrant = true; // durable onboarding marker — survives any client
        }
        return;
      }
      case "HouseSeeded": {
        // House bankroll is real (float-backed) betting capital, not a bonus.
        const s = this.walletOf(event);
        if (s) s.balance += p.amount;
        return;
      }
      case "CallMade": {
        const s = this.walletOf(event);
        if (!s) return;
        // Spend the non-withdrawable bonus first, then free balance.
        const fromBonus = s.bonus < p.stake ? s.bonus : p.stake;
        s.bonus -= fromBonus;
        s.balance -= p.stake - fromBonus;
        s.locked += p.stake;
        s.openCalls.set(p.callId, {
          callId: p.callId,
          matchId: p.matchId,
          marketId: p.marketId,
          bucket: p.bucket,
          stake: p.stake,
          impliedProbAtCall: p.impliedProbAtCall,
          bold: p.bold,
          at: event.meta.at,
        });
        return;
      }
      case "CallSettled": {
        const s = this.walletOf(event);
        if (!s) return;
        s.openCalls.delete(p.callId);
        s.locked -= p.stake;
        s.balance += p.payout;
        s.pnl += p.pnlDelta;
        s.gr += p.grDelta;
        if (p.result === "WON") {
          s.won += 1;
          s.formResults.push("W");
          if (p.difficulty >= 0.6) {
            s.landmarks.push({
              callId: p.callId,
              matchId: p.matchId,
              text: `Called it at ${(p.difficulty * 100) | 0}% against — and it landed.`,
              at: event.meta.at,
            });
          }
        } else {
          s.lost += 1;
          s.formResults.push("L");
        }
        return;
      }
      case "CallVoided": {
        const s = this.walletOf(event);
        if (!s) return;
        s.openCalls.delete(p.callId);
        s.locked -= p.refund;
        s.balance += p.refund;
        s.voided += 1;
        s.formResults.push("VOID");
        return;
      }
      case "TraitObserved": {
        const s = this.walletOf(event);
        if (!s) return;
        const existing = s.traits.get(p.traitKey);
        s.traits.set(p.traitKey, {
          key: p.traitKey,
          label: p.label,
          confidence: p.confidence,
          evidence: p.evidence,
          firstSeen: existing?.firstSeen ?? event.meta.at,
          lastSeen: event.meta.at,
        });
        return;
      }
      case "HotTakeDeclared": {
        const s = this.walletOf(event);
        if (s) s.hotTakes.push({ takeId: p.takeId, text: p.text, at: event.meta.at });
        return;
      }
      case "VerdictIssued": {
        const s = this.walletOf(event);
        if (s) s.lastVerdict = { text: p.text, at: event.meta.at, trigger: p.trigger };
        return;
      }
      case "ChallengeStakeLocked": {
        const s = this.walletOf(event);
        if (!s) return;
        // Spend the non-withdrawable bonus first, then free balance (like CallMade).
        const fromBonus = s.bonus < p.stake ? s.bonus : p.stake;
        s.bonus -= fromBonus;
        s.balance -= p.stake - fromBonus;
        s.locked += p.stake;
        s.openChallengeStakes.set(p.challengeId, {
          challengeId: p.challengeId,
          matchId: p.matchId,
          side: p.side,
          stake: p.stake,
          at: event.meta.at,
        });
        return;
      }
      case "ChallengeStakeSettled": {
        const s = this.walletOf(event);
        if (!s) return;
        const open = s.openChallengeStakes.get(p.challengeId);
        if (!open) return;
        s.openChallengeStakes.delete(p.challengeId);
        s.locked -= open.stake;
        s.balance += p.payout;
        s.pnl += p.pnlDelta;
        return;
      }
      case "ChallengeStakeRefunded": {
        const s = this.walletOf(event);
        if (!s) return;
        const open = s.openChallengeStakes.get(p.challengeId);
        if (!open) return;
        s.openChallengeStakes.delete(p.challengeId);
        s.locked -= p.refund;
        s.balance += p.refund; // mirrors CallVoided (refund to free balance)
        return;
      }
      default:
        return; // match-stream / challenge-stream events don't touch the Dossier
    }
  }

  private walletOf(event: StoredEvent): DossierState | undefined {
    // Player events live in a player stream; their wallet is on the payload for
    // signing, but for the rest we resolve by stream id (gaffer:<wallet>).
    const w = event.meta.streamId.startsWith("gaffer:") &&
      !event.meta.streamId.startsWith("gaffer:match:")
      ? (event.meta.streamId.slice("gaffer:".length) as Wallet)
      : undefined;
    return w ? this.byWallet.get(w) : undefined;
  }

  get(wallet: Wallet): DossierView | undefined {
    const s = this.byWallet.get(wallet);
    return s ? toView(s) : undefined;
  }

  all(): DossierView[] {
    return [...this.byWallet.values()].map(toView);
  }
}

function toView(s: DossierState): DossierView {
  const tier = tierForGr(s.gr);
  return {
    wallet: s.wallet,
    handle: s.handle,
    signedAt: s.signedAt,
    balance: s.balance,
    locked: s.locked,
    bonus: s.bonus,
    claimedGrant: s.claimedGrant,
    gr: s.gr,
    tier,
    nextTier: nextTierFloor(s.gr),
    pnl: s.pnl,
    record: { won: s.won, lost: s.lost, voided: s.voided },
    form: computeForm(s.formResults),
    openCalls: [...s.openCalls.values()].sort((a, b) => a.at - b.at),
    openChallengeStakes: [...s.openChallengeStakes.values()].sort((a, b) => a.at - b.at),
    traits: [...s.traits.values()].sort((a, b) => b.confidence - a.confidence),
    hotTakes: [...s.hotTakes].sort((a, b) => b.at - a.at),
    landmarks: [...s.landmarks].sort((a, b) => b.at - a.at),
    lastVerdict: s.lastVerdict,
  };
}
