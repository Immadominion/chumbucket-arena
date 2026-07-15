/**
 * The Challenges — private 1-v-1 escrows, folded from the log. Each challenge is
 * its own aggregate on a `gaffer:challenge:<id>` stream: who created it, which
 * sides the two players hold, its stake, and how it resolved. Deliberately kept
 * OUT of the communal Pots — a challenge is a 2-party wager, isolated from the
 * parimutuel pool and its thin-pool guard.
 *
 * Also the challenge settlement saga's worklist: `matchedFor(matchId)` lists the
 * MATCHED challenges a resolved match still owes a settlement.
 */

import type { StoredEvent } from "../../domain/events.ts";
import type { ChallengeId, Frost, MatchId, Wallet } from "../../domain/ids.ts";
import type { Projection } from "./Projection.ts";

export type ChallengeStatus = "OPEN" | "MATCHED" | "SETTLED" | "VOID" | "CANCELLED";

export interface ChallengeView {
  challengeId: ChallengeId;
  matchId: MatchId;
  creator: Wallet;
  opponent: Wallet | null; // null until accepted
  creatorSide: string; // HOME / DRAW / AWAY
  opponentSide: string;
  stake: Frost; // each side stakes this
  status: ChallengeStatus;
  winner: Wallet | null; // set on settle
  winningBucket: string | null; // the result that decided (or voided) it
  createdAt: number;
  settledAt: number | null;
}

export class ChallengeProjection implements Projection {
  readonly name = "challenges";
  private readonly byId = new Map<ChallengeId, ChallengeView>();

  apply(event: StoredEvent): void {
    const p = event.payload;
    switch (p.type) {
      case "ChallengeCreated": {
        this.byId.set(p.challengeId, {
          challengeId: p.challengeId,
          matchId: p.matchId,
          creator: p.creator,
          opponent: null,
          creatorSide: p.creatorSide,
          opponentSide: p.opponentSide,
          stake: p.stake,
          status: "OPEN",
          winner: null,
          winningBucket: null,
          createdAt: event.meta.at,
          settledAt: null,
        });
        return;
      }
      case "ChallengeAccepted": {
        const c = this.byId.get(p.challengeId);
        if (!c) return;
        c.opponent = p.opponent;
        c.status = "MATCHED";
        return;
      }
      case "ChallengeSettled": {
        const c = this.byId.get(p.challengeId);
        if (!c) return;
        c.status = "SETTLED";
        c.winner = p.winner;
        c.winningBucket = p.winningBucket;
        c.settledAt = event.meta.at;
        return;
      }
      case "ChallengeVoided": {
        const c = this.byId.get(p.challengeId);
        if (!c) return;
        c.status = "VOID";
        c.winningBucket = String(p.winningBucket);
        c.settledAt = event.meta.at;
        return;
      }
      case "ChallengeCancelled": {
        const c = this.byId.get(p.challengeId);
        if (!c) return;
        c.status = "CANCELLED";
        c.settledAt = event.meta.at;
        return;
      }
      default:
        return;
    }
  }

  get(challengeId: ChallengeId): ChallengeView | undefined {
    return this.byId.get(challengeId);
  }

  /** Every challenge this wallet is a party to (creator or opponent), newest first. */
  forWallet(wallet: Wallet): ChallengeView[] {
    return [...this.byId.values()]
      .filter((c) => c.creator === wallet || c.opponent === wallet)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** MATCHED challenges awaiting a result on this match — the settlement worklist. */
  matchedFor(matchId: MatchId): ChallengeView[] {
    return [...this.byId.values()].filter((c) => c.status === "MATCHED" && c.matchId === matchId);
  }
}
