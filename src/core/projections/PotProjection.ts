/**
 * The Pots — live parimutuel markets, folded from the log. Per match, per market:
 * bucket totals, crowd-implied odds, who's in, status, and the resolved outcome.
 * Also the settlement saga's worklist: which resolved markets still owe payouts.
 */

import type { StoredEvent } from "../../domain/events.ts";
import type { Frost, MarketId, MatchId, Wallet } from "../../domain/ids.ts";
import type { Fixture, MarketKind } from "../../domain/model.ts";
import type { CallStake } from "../../game/parimutuel.ts";
import { impliedProb } from "../../game/parimutuel.ts";
import type { Projection } from "./Projection.ts";

type MarketStatus = "OPEN" | "LOCKED" | "RESOLVED";

/** Virtual stake per bucket (FROST) — the Laplace prior for difficulty scoring. */
const PRIOR_STAKE = 5_000_000_000n; // 5 WAL

interface BucketState {
  label: string;
  stake: Frost;
  callers: Set<Wallet>;
}

interface MarketState {
  matchId: MatchId;
  marketId: MarketId;
  kind: MarketKind;
  label: string;
  buckets: Map<string, BucketState>;
  calls: CallStake[];
  status: MarketStatus;
  winningBucket?: string; // set on resolve
  settled: boolean;
}

interface MatchState {
  fixture: Fixture;
  status: MarketStatus;
  markets: Map<MarketId, MarketState>;
  score?: { home: number; away: number }; // set on MatchResolved
}

export interface BucketView {
  bucket: string;
  label: string;
  stake: Frost;
  impliedProb: number;
  callerCount: number;
}

export interface MarketPotView {
  matchId: MatchId;
  marketId: MarketId;
  kind: MarketKind;
  label: string;
  status: MarketStatus;
  buckets: BucketView[];
  grossPot: Frost;
  participantCount: number;
  winningBucket: string | undefined;
  settled: boolean;
}

export interface MatchView {
  fixture: Fixture;
  status: MarketStatus;
  markets: MarketPotView[];
  score: { home: number; away: number } | null; // final score once resolved
}

export class PotProjection implements Projection {
  readonly name = "pots";
  private readonly matches = new Map<MatchId, MatchState>();

  apply(event: StoredEvent): void {
    const p = event.payload;
    switch (p.type) {
      case "MatchOpened": {
        const markets = new Map<MarketId, MarketState>();
        for (const def of p.markets) {
          markets.set(def.marketId, {
            matchId: p.fixture.matchId,
            marketId: def.marketId,
            kind: def.kind,
            label: def.label,
            buckets: new Map(
              def.buckets.map((b) => [
                b.bucket,
                { label: b.label, stake: 0n, callers: new Set<Wallet>() },
              ]),
            ),
            calls: [],
            status: "OPEN",
            settled: false,
          });
        }
        this.matches.set(p.fixture.matchId, {
          fixture: p.fixture,
          status: "OPEN",
          markets,
        });
        return;
      }
      case "MatchLocked": {
        const m = this.matches.get(p.matchId);
        if (!m) return;
        m.status = "LOCKED";
        for (const mk of m.markets.values()) if (mk.status === "OPEN") mk.status = "LOCKED";
        return;
      }
      case "CallMade": {
        const market = this.matches.get(p.matchId)?.markets.get(p.marketId);
        if (!market) return;
        const bucket = market.buckets.get(p.bucket);
        if (!bucket) return;
        bucket.stake += p.stake;
        const wallet = streamWallet(event.meta.streamId);
        if (wallet) {
          bucket.callers.add(wallet);
          market.calls.push({ callId: p.callId, wallet, bucket: p.bucket, stake: p.stake });
        }
        return;
      }
      case "MatchResolved": {
        const m = this.matches.get(p.matchId);
        if (!m) return;
        m.status = "RESOLVED";
        m.score = p.score;
        for (const [marketId, mk] of m.markets) {
          mk.status = "RESOLVED";
          const outcome = p.outcomes[marketId];
          if (outcome !== undefined) mk.winningBucket = outcome;
        }
        return;
      }
      case "PotSettled": {
        const mk = this.matches.get(p.matchId)?.markets.get(p.marketId);
        if (mk) mk.settled = true;
        return;
      }
      default:
        return;
    }
  }

  getMatch(matchId: MatchId): MatchView | undefined {
    const m = this.matches.get(matchId);
    return m ? toMatchView(m) : undefined;
  }

  getMarketCalls(matchId: MatchId, marketId: MarketId): CallStake[] {
    return this.matches.get(matchId)?.markets.get(marketId)?.calls.slice() ?? [];
  }

  /**
   * Crowd-implied probability used to score a call's difficulty at the moment
   * it's made. Laplace-smoothed with a uniform prior so the first callers into a
   * thin pool aren't treated as backing max-difficulty longshots — the prior
   * washes out as real money arrives. (Raw pool share is still what the bucket
   * views display; this is the estimator the rating trusts.)
   */
  impliedProbFor(matchId: MatchId, marketId: MarketId, bucket: string): number {
    const market = this.matches.get(matchId)?.markets.get(marketId);
    if (!market) return 0;
    const n = market.buckets.size || 1;
    const total = [...market.buckets.values()].reduce((s, b) => s + b.stake, 0n);
    const num = (market.buckets.get(bucket)?.stake ?? 0n) + PRIOR_STAKE;
    const den = total + PRIOR_STAKE * BigInt(n);
    return impliedProb(num, den);
  }

  isOpen(matchId: MatchId, marketId: MarketId): boolean {
    return this.matches.get(matchId)?.markets.get(marketId)?.status === "OPEN";
  }

  /** Fixtures currently open for calls — the Matchday list. */
  openFixtures(): Fixture[] {
    return [...this.matches.values()]
      .filter((m) => m.status === "OPEN")
      .map((m) => m.fixture)
      .sort((a, b) => a.kickoff - b.kickoff);
  }

  allMatches(): MatchView[] {
    return [...this.matches.values()]
      .map(toMatchView)
      .sort((a, b) => a.fixture.kickoff - b.fixture.kickoff);
  }

  /** Resolved markets that still owe a settlement — the saga's worklist. */
  pendingSettlements(): { matchId: MatchId; marketId: MarketId }[] {
    const out: { matchId: MatchId; marketId: MarketId }[] = [];
    for (const m of this.matches.values()) {
      for (const mk of m.markets.values()) {
        if (mk.status === "RESOLVED" && !mk.settled) {
          out.push({ matchId: mk.matchId, marketId: mk.marketId });
        }
      }
    }
    return out;
  }

  winningBucketOf(matchId: MatchId, marketId: MarketId): string | undefined {
    return this.matches.get(matchId)?.markets.get(marketId)?.winningBucket;
  }
}

const streamWallet = (streamId: string): Wallet | undefined =>
  streamId.startsWith("gaffer:") && !streamId.startsWith("gaffer:match:")
    ? (streamId.slice("gaffer:".length) as Wallet)
    : undefined;

function toMarketView(mk: MarketState): MarketPotView {
  const total = [...mk.buckets.values()].reduce((s, b) => s + b.stake, 0n);
  const participants = new Set<Wallet>();
  for (const b of mk.buckets.values()) for (const w of b.callers) participants.add(w);
  return {
    matchId: mk.matchId,
    marketId: mk.marketId,
    kind: mk.kind,
    label: mk.label,
    status: mk.status,
    buckets: [...mk.buckets.entries()].map(([bucket, b]) => ({
      bucket,
      label: b.label,
      stake: b.stake,
      impliedProb: impliedProb(b.stake, total),
      callerCount: b.callers.size,
    })),
    grossPot: total,
    participantCount: participants.size,
    winningBucket: mk.winningBucket,
    settled: mk.settled,
  };
}

function toMatchView(m: MatchState): MatchView {
  return {
    fixture: m.fixture,
    status: m.status,
    markets: [...m.markets.values()].map(toMarketView),
    score: m.score ?? null,
  };
}
