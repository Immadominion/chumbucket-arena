/**
 * The settled-calls ledger — a per-player history of resolved calls, folded from
 * the log. Joins three event sources: CallMade (which bucket you backed),
 * CallSettled / CallVoided (the outcome + P&L + rating change), and the match's
 * MatchResolved (the actual score). This is what the Results + Verdict screens read.
 */

import type { StoredEvent } from "../../domain/events.ts";
import type { CallId, Frost, MarketId, MatchId, Wallet } from "../../domain/ids.ts";
import type { Projection } from "./Projection.ts";

export interface SettledCallView {
  callId: CallId;
  matchId: MatchId;
  marketId: MarketId;
  bucket: string; // what you backed: HOME / DRAW / AWAY
  result: "WON" | "LOST" | "VOID";
  stake: Frost;
  payout: Frost;
  pnlDelta: Frost;
  grDelta: number;
  difficulty: number; // 0..1, how unlikely the crowd thought it was
  score: { home: number; away: number } | undefined;
  at: number;
}

interface OpenRef {
  wallet: Wallet;
  matchId: MatchId;
  marketId: MarketId;
  bucket: string;
  stake: Frost;
}

const streamWallet = (streamId: string): Wallet | undefined =>
  streamId.startsWith("gaffer:") && !streamId.startsWith("gaffer:match:")
    ? (streamId.slice("gaffer:".length) as Wallet)
    : undefined;

export class SettledCallsProjection implements Projection {
  readonly name = "settledCalls";
  private readonly byWallet = new Map<Wallet, SettledCallView[]>();
  private readonly open = new Map<CallId, OpenRef>(); // CallMade not yet settled
  private readonly scores = new Map<MatchId, { home: number; away: number }>();

  apply(event: StoredEvent): void {
    const p = event.payload;
    switch (p.type) {
      case "MatchResolved":
        this.scores.set(p.matchId, p.score);
        return;
      case "CallMade": {
        const wallet = streamWallet(event.meta.streamId);
        if (wallet) {
          this.open.set(p.callId, { wallet, matchId: p.matchId, marketId: p.marketId, bucket: p.bucket, stake: p.stake });
        }
        return;
      }
      case "CallSettled": {
        const ref = this.open.get(p.callId);
        const wallet = streamWallet(event.meta.streamId);
        if (!wallet) return;
        this.record(wallet, {
          callId: p.callId,
          matchId: p.matchId,
          marketId: p.marketId,
          bucket: ref?.bucket ?? "—",
          result: p.result,
          stake: p.stake,
          payout: p.payout,
          pnlDelta: p.pnlDelta,
          grDelta: p.grDelta,
          difficulty: p.difficulty,
          score: this.scores.get(p.matchId),
          at: event.meta.at,
        });
        this.open.delete(p.callId);
        return;
      }
      case "CallVoided": {
        const ref = this.open.get(p.callId);
        const wallet = streamWallet(event.meta.streamId);
        if (!wallet) return;
        this.record(wallet, {
          callId: p.callId,
          matchId: p.matchId,
          marketId: p.marketId,
          bucket: ref?.bucket ?? "—",
          result: "VOID",
          stake: ref?.stake ?? p.refund,
          payout: p.refund,
          pnlDelta: 0n,
          grDelta: 0,
          difficulty: 0,
          score: this.scores.get(p.matchId),
          at: event.meta.at,
        });
        this.open.delete(p.callId);
        return;
      }
      default:
        return;
    }
  }

  private record(wallet: Wallet, view: SettledCallView): void {
    const list = this.byWallet.get(wallet) ?? [];
    list.unshift(view); // newest first
    this.byWallet.set(wallet, list);
  }

  get(wallet: Wallet, limit = 50): SettledCallView[] {
    return (this.byWallet.get(wallet) ?? []).slice(0, limit);
  }
}
