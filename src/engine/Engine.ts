/**
 * The Engine — the application service. It owns the write side: player commands
 * route to actors; match lifecycle (open → lock → resolve) and the settlement
 * saga run here. The API talks to the Engine for commands and to the ReadModel
 * for queries. Match streams have a single writer (this Engine), player streams a
 * single writer each (their actor), so ordering is guaranteed everywhere.
 */

import type { GameConfig } from "../config.ts";
import { DomainError, fail } from "../domain/errors.ts";
import type { DomainEvent } from "../domain/events.ts";
import {
  asBucket,
  asCallId,
  challengeStream,
  formatWal,
  isHouseWallet,
  matchStream,
  newChallengeId,
  type Bucket,
  type ChallengeId,
  type Frost,
  type MarketId,
  type MatchId,
  type Wallet,
} from "../domain/ids.ts";
import { VOID, type Fixture, type MarketDef, type Outcome, type VerdictTrigger } from "../domain/model.ts";
import { counterSide, RESULT_MARKET, resolveResult, resultMarket } from "../game/markets.ts";
import { settleParimutuel, type CallStake } from "../game/parimutuel.ts";
import type { Gaffer } from "../gaffer/Gaffer.ts";
import { RateLimiter } from "./RateLimiter.ts";
import { HouseLiquidity } from "./HouseLiquidity.ts";
import { ActorRegistry } from "../core/actor/ActorRegistry.ts";
import type { EventStore } from "../core/eventstore/EventStore.ts";
import type { ReadModel } from "../core/projections/ReadModel.ts";
import type { Custody } from "../ports/Custody.ts";
import type { DepositGateway, PrivyPlayer } from "../ports/PrivyDepositGateway.ts";
import type { MatchDataProvider } from "../ports/MatchData.ts";
import type { SettlementVerifier } from "../ports/SettlementVerifier.ts";
import type { MakeCallInput } from "../core/actor/PlayerActor.ts";

export interface EngineDeps {
  store: EventStore;
  readModel: ReadModel;
  custody: Custody;
  gaffer: Gaffer;
  matchData: MatchDataProvider;
  /** On-chain corroboration gate before a reported score is trusted for payout. */
  settlementVerifier: SettlementVerifier;
  config: GameConfig;
  /** Custodial deposit sweeps (Privy). Absent → play-money/no on-chain deposits. */
  depositGateway?: DepositGateway;
}

export class Engine {
  readonly registry: ActorRegistry;
  private readonly matchVersions = new Map<MatchId, number>();
  private readonly challengeVersions = new Map<ChallengeId, number>();
  /** Per-wallet + global throttle on the paid (Anthropic) endpoints. */
  private readonly limiter: RateLimiter;
  /** Synthetic house bettors that seed each touched match with a counterparty. */
  readonly house: HouseLiquidity;

  constructor(private readonly deps: EngineDeps) {
    this.limiter = new RateLimiter(deps.config.rateLimits);
    this.registry = new ActorRegistry({
      store: deps.store,
      readModel: deps.readModel,
      custody: deps.custody,
      gaffer: deps.gaffer,
      config: deps.config,
    });
    this.house = new HouseLiquidity(this.registry, deps.readModel, deps.config);
  }

  get readModel(): ReadModel {
    return this.deps.readModel;
  }
  get custody(): Custody {
    return this.deps.custody;
  }

  // ── player commands ─────────────────────────────────────────────────────────

  signContract(wallet: Wallet, handle?: string) {
    return this.registry.for(wallet).signContract(handle);
  }
  deposit(wallet: Wallet, amount: Frost, proof?: string) {
    return this.registry.for(wallet).deposit(amount, proof);
  }

  /**
   * Custodial deposit: sweep any USDC that has arrived in the player's Privy
   * wallet into the Sessions float and credit their ledger. Idempotent +
   * reconciled — safe to call repeatedly (a "check for my deposit" button).
   * No-op without a gateway, for an unsigned player, or for a player without a
   * Privy wallet.
   */
  async syncDeposits(
    wallet: Wallet,
    player?: Partial<PrivyPlayer>,
  ): Promise<{ credited: Frost; balance: Frost }> {
    const balanceOf = (): Frost => (this.deps.readModel.getDossier(wallet)?.balance ?? 0n) as Frost;
    const gateway = this.deps.depositGateway;
    if (!gateway || !player?.walletId || !this.deps.readModel.getDossier(wallet)) {
      return { credited: 0n as Frost, balance: balanceOf() };
    }
    const credits = await gateway.collect({ address: wallet, walletId: player.walletId });
    let credited = 0n;
    for (const c of credits) {
      try {
        await this.registry.for(wallet).deposit(c.amount, c.signature);
        credited += c.amount;
      } catch (e) {
        // Already-credited sweeps are expected (reconcile re-presents them); ignore those.
        if (!(e instanceof DomainError && e.code === "DUPLICATE_DEPOSIT")) {
          console.error(`[deposit] crediting ${c.signature} failed:`, e);
        }
      }
    }
    return { credited: credited as Frost, balance: balanceOf() };
  }
  withdraw(wallet: Wallet, amount: Frost) {
    return this.registry.for(wallet).withdraw(amount);
  }
  claimWelcomeGrant(wallet: Wallet) {
    return this.registry.for(wallet).claimWelcomeGrant(this.deps.config.welcomeGrant);
  }
  async makeCall(wallet: Wallet, input: MakeCallInput) {
    const result = await this.registry.for(wallet).makeCall(input);
    // A real player's call seeds the match with house liquidity so they have a
    // counterparty and the pool can settle (bots calling don't re-trigger this).
    if (!isHouseWallet(wallet)) await this.house.ensureSeeded(input.matchId);
    return result;
  }
  declareHotTake(wallet: Wallet, text: string) {
    return this.registry.for(wallet).declareHotTake(text);
  }
  requestVerdict(wallet: Wallet, trigger: VerdictTrigger) {
    this.limiter.charge("verdict", wallet);
    return this.registry.for(wallet).requestVerdict(trigger);
  }

  async chat(wallet: Wallet, message: string): Promise<string> {
    this.limiter.charge("chat", wallet);
    const reply = await this.deps.gaffer.chat({ wallet, message });
    await this.registry.for(wallet).recordChat(message, reply);
    return reply;
  }

  /** Re-read a player's memory, distil behavioural traits, and persist them. */
  async refreshTraits(wallet: Wallet) {
    const traits = await this.deps.gaffer.distillTraits(wallet);
    for (const t of traits) await this.registry.for(wallet).observeTrait(t);
    return traits;
  }

  /** The pre-bet coaching read — built from live pot context + the player's memory. */
  async preBetRead(
    wallet: Wallet,
    input: { matchId: MatchId; marketId: MarketId; bucket: string; stake: Frost },
  ): Promise<string> {
    this.limiter.charge("preBetRead", wallet);
    const match = this.deps.readModel.pots.getMatch(input.matchId);
    if (!match) throw new Error("no such match");
    const market = match.markets.find((m) => m.marketId === input.marketId);
    const bucket = market?.buckets.find((b) => b.bucket === input.bucket);
    return this.deps.gaffer.preBetRead({
      wallet,
      fixture: match.fixture,
      marketLabel: market?.label ?? "the call",
      bucketLabel: bucket?.label ?? input.bucket,
      stakeWal: formatWal(input.stake),
      impliedProb: this.deps.readModel.pots.impliedProbFor(input.matchId, input.marketId, input.bucket),
    });
  }

  // ── 1-v-1 challenges ─────────────────────────────────────────────────────────
  // A private escrow between exactly two wallets, isolated from the communal pool
  // (its own stream/aggregate, settled with minParticipants=2 so a 2-person wager
  // never trips the pool's thin-pool guard). The two stakes move on each player's
  // own stream; the escrow lifecycle lives on gaffer:challenge:<id>.

  /**
   * Open a challenge on a match's RESULT market: lock the creator's stake and
   * publish an OPEN escrow anyone can accept via the returned challengeId. The
   * opponent auto-takes `opponentSide` (defaults to counterSide(side)); any third
   * outcome refunds both. Lock first, so a rejected lock writes no escrow.
   */
  async createChallenge(
    creator: Wallet,
    input: { matchId: MatchId; side: Bucket; stake: Frost; opponentSide?: Bucket },
  ): Promise<{ challengeId: ChallengeId }> {
    const match = this.deps.readModel.pots.getMatch(input.matchId);
    if (!match) throw new DomainError("MATCH_NOT_OPEN", "no such match");
    if (match.markets.find((m) => m.marketId === RESULT_MARKET)?.status !== "OPEN") {
      fail("MATCH_LOCKED", "challenges are closed on this match");
    }
    const side = asBucket(input.side);
    const opponentSide = input.opponentSide ? asBucket(input.opponentSide) : counterSide(side);
    if (opponentSide === side) fail("INVALID", "opponent must take a different side");

    const challengeId = newChallengeId();
    // Lock the creator's stake on THEIR stream first (single-writer, validated).
    await this.registry.for(creator).lockChallengeStake({
      challengeId,
      matchId: input.matchId,
      side,
      stake: input.stake,
      role: "CREATOR",
    });
    try {
      await this.challengeAppend(challengeId, [
        {
          type: "ChallengeCreated",
          challengeId,
          matchId: input.matchId,
          creator,
          creatorSide: side,
          opponentSide,
          stake: input.stake,
        },
      ]);
    } catch (e) {
      // The escrow never opened — return the just-locked stake so nothing strands.
      await this.registry.for(creator).refundChallengeStake(challengeId, "challenge create failed");
      throw e;
    }
    return { challengeId };
  }

  /**
   * Take the open side of a challenge, locking an equal stake. The expectedVersion
   * guard on the challenge stream makes accept single-winner: if two opponents
   * race, only the first ChallengeAccepted lands; the loser's stake is refunded.
   */
  async acceptChallenge(opponent: Wallet, challengeId: ChallengeId): Promise<{ challengeId: ChallengeId }> {
    const ch = this.deps.readModel.challenges.get(challengeId);
    if (!ch) throw new DomainError("INVALID", "no such challenge");
    if (ch.status !== "OPEN") fail("CONFLICT", "challenge is no longer open");
    if (ch.creator === opponent) fail("INVALID", "you can't accept your own challenge");
    if (
      this.deps.readModel.pots.getMatch(ch.matchId)?.markets.find((m) => m.marketId === RESULT_MARKET)?.status !==
      "OPEN"
    ) {
      fail("MATCH_LOCKED", "this match is locked");
    }

    await this.registry.for(opponent).lockChallengeStake({
      challengeId,
      matchId: ch.matchId,
      side: asBucket(ch.opponentSide),
      stake: ch.stake,
      role: "OPPONENT",
    });
    try {
      await this.challengeAppend(challengeId, [{ type: "ChallengeAccepted", challengeId, opponent }]);
    } catch (e) {
      // Lost the accept race (or a stale version) — hand the stake straight back.
      await this.registry.for(opponent).refundChallengeStake(challengeId, "challenge already taken");
      throw e;
    }
    return { challengeId };
  }

  /** Withdraw an un-accepted challenge — only the creator, only while OPEN. */
  async cancelChallenge(creator: Wallet, challengeId: ChallengeId): Promise<{ ok: true }> {
    const ch = this.deps.readModel.challenges.get(challengeId);
    if (!ch) throw new DomainError("INVALID", "no such challenge");
    if (ch.creator !== creator) fail("INVALID", "only the creator can cancel this challenge");
    if (ch.status !== "OPEN") fail("CONFLICT", "challenge can't be cancelled now");
    await this.registry.for(creator).refundChallengeStake(challengeId, "challenge cancelled");
    await this.challengeAppend(challengeId, [{ type: "ChallengeCancelled", challengeId }]);
    return { ok: true };
  }

  /**
   * Settle every MATCHED challenge on a resolved match. Reuses the parimutuel
   * engine with the two stakes and minParticipants=2, so a 1-v-1 pays out with
   * exactly the pool's rake/rounding — and its VOID branch (winner bucket has no
   * staker) gives the "result nobody picked → refund both" case for free.
   * Idempotent: matchedFor() is empty once a challenge is settled/voided.
   */
  async settleChallengesForMatch(matchId: MatchId, score: { home: number; away: number }): Promise<void> {
    const winning = resolveResult(score);
    for (const ch of this.deps.readModel.challenges.matchedFor(matchId)) {
      if (!ch.opponent) continue; // MATCHED implies an opponent; defensive
      const calls: CallStake[] = [
        { callId: asCallId(`${ch.challengeId}:c`), wallet: ch.creator, bucket: asBucket(ch.creatorSide), stake: ch.stake },
        { callId: asCallId(`${ch.challengeId}:o`), wallet: ch.opponent, bucket: asBucket(ch.opponentSide), stake: ch.stake },
      ];
      const result = settleParimutuel({
        calls,
        winningBucket: winning,
        rakeBps: this.deps.config.rakeBps,
        minParticipants: 2,
      });

      if (result.kind === "VOID") {
        await this.registry.for(ch.creator).refundChallengeStake(ch.challengeId, result.reason);
        await this.registry.for(ch.opponent).refundChallengeStake(ch.challengeId, result.reason);
        await this.challengeAppend(ch.challengeId, [
          { type: "ChallengeVoided", challengeId: ch.challengeId, winningBucket: winning, reason: result.reason },
        ]);
        continue;
      }

      await Promise.all(
        result.payouts.map((p) =>
          this.registry.for(p.wallet).settleChallengeStake(ch.challengeId, p.won ? "WON" : "LOST", p.payout),
        ),
      );
      const win = result.payouts.find((p) => p.won);
      if (!win) continue; // unreachable for kind==="PAID", but keeps types honest
      await this.challengeAppend(ch.challengeId, [
        {
          type: "ChallengeSettled",
          challengeId: ch.challengeId,
          winningBucket: winning,
          winner: win.wallet,
          grossPot: result.grossPot,
          rake: result.rake,
          payout: win.payout,
        },
      ]);
    }
  }

  // ── match lifecycle ──────────────────────────────────────────────────────────

  async openMatch(fixture: Fixture, extraMarkets: MarketDef[] = []): Promise<void> {
    if (this.deps.readModel.pots.getMatch(fixture.matchId)) return; // idempotent
    await this.matchAppend(fixture.matchId, [
      { type: "MatchOpened", fixture, markets: [resultMarket(), ...extraMarkets] },
    ]);
  }

  async lockMatch(matchId: MatchId): Promise<void> {
    const m = this.deps.readModel.pots.getMatch(matchId);
    if (!m || m.status !== "OPEN") return;
    await this.matchAppend(matchId, [{ type: "MatchLocked", matchId }]);
  }

  async resolveMatch(
    matchId: MatchId,
    score: { home: number; away: number },
    source = "mock",
  ): Promise<void> {
    const m = this.deps.readModel.pots.getMatch(matchId);
    if (!m || m.status === "RESOLVED") return;

    // Gate settlement on TxLINE's on-chain corroboration of the reported
    // score. Unverified → leave the match exactly as-is; tick() will call
    // resolveMatch again next pass once TxLINE has posted the relevant
    // Merkle root. No state is mutated before this check.
    const verification = await this.deps.settlementVerifier.verify({
      matchId,
      txlineFixtureId: m.fixture.txline?.fixtureId ?? -1,
      score,
    });
    if (!verification.verified) {
      console.warn(`[resolveMatch] ${matchId} not yet verified on-chain (${verification.detail}); retrying next tick`);
      return;
    }

    if (m.status === "OPEN") await this.lockMatch(matchId);

    const outcomes: Record<string, Outcome> = {};
    for (const mk of m.markets) {
      outcomes[mk.marketId] = mk.marketId === RESULT_MARKET ? resolveResult(score) : VOID;
    }
    await this.matchAppend(matchId, [{ type: "MatchResolved", matchId, score, outcomes, source }]);

    await Promise.all(
      m.markets.map((mk) => this.settleMarket(matchId, mk.marketId, outcomes[mk.marketId] ?? VOID)),
    );
    // Settle the private 1-v-1s on this match behind the same verification gate.
    await this.settleChallengesForMatch(matchId, score);
  }

  private async settleMarket(matchId: MatchId, marketId: MarketId, outcome: Outcome): Promise<void> {
    const calls = this.deps.readModel.pots.getMarketCalls(matchId, marketId);
    const grossPot = calls.reduce((s, c) => s + c.stake, 0n);

    if (outcome === VOID) {
      await Promise.all(calls.map((c) => this.registry.for(c.wallet).voidCall(c.callId, "market voided")));
      await this.matchAppend(matchId, [
        {
          type: "PotSettled",
          matchId,
          marketId,
          winningBucket: VOID,
          grossPot,
          rake: 0n,
          winnersStake: 0n,
          settledCount: calls.length,
        },
      ]);
      return;
    }

    const result = settleParimutuel({
      calls,
      winningBucket: outcome,
      rakeBps: this.deps.config.rakeBps,
      minParticipants: this.deps.config.minParticipants,
    });

    if (result.kind === "VOID") {
      await Promise.all(calls.map((c) => this.registry.for(c.wallet).voidCall(c.callId, result.reason)));
      await this.matchAppend(matchId, [
        {
          type: "PotSettled",
          matchId,
          marketId,
          winningBucket: outcome,
          grossPot,
          rake: 0n,
          winnersStake: 0n,
          settledCount: calls.length,
        },
      ]);
      return;
    }

    await Promise.all(
      result.payouts.map((p) => this.registry.for(p.wallet).settleCall(p.callId, p.won, p.payout)),
    );
    await this.matchAppend(matchId, [
      {
        type: "PotSettled",
        matchId,
        marketId,
        winningBucket: outcome,
        grossPot: result.grossPot,
        rake: result.rake,
        winnersStake: result.winnersStake,
        settledCount: result.payouts.length,
      },
    ]);
  }

  // ── ingestion ────────────────────────────────────────────────────────────────

  async syncFixtures(): Promise<void> {
    for (const fixture of await this.deps.matchData.fixtures()) {
      await this.openMatch(fixture);
    }
  }

  /** Lock kicked-off matches; resolve finished ones. Safe to call on a timer. */
  async tick(now: number = Date.now()): Promise<void> {
    const matches = this.deps.readModel.pots.allMatches();
    for (const m of matches) {
      if (m.status === "OPEN" && m.fixture.kickoff <= now) await this.lockMatch(m.fixture.matchId);
    }
    const pending = this.deps.readModel.pots
      .allMatches()
      .filter((m) => m.status !== "RESOLVED")
      .map((m) => m.fixture.matchId);
    for (const r of await this.deps.matchData.results(pending)) {
      if (r.finished) await this.resolveMatch(r.matchId, r.score, "matchdata");
    }
    // Re-drive challenge settlements stranded by a crash mid-saga: a match can be
    // RESOLVED (so resolveMatch early-returns) yet still owe MATCHED challenges.
    // settleChallengesForMatch is idempotent, so this is a safe backstop.
    for (const m of this.deps.readModel.pots.allMatches()) {
      if (m.status === "RESOLVED" && m.score && this.deps.readModel.challenges.matchedFor(m.fixture.matchId).length) {
        await this.settleChallengesForMatch(m.fixture.matchId, m.score);
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async matchAppend(matchId: MatchId, events: DomainEvent[]): Promise<void> {
    const streamId = matchStream(matchId);
    let version = this.matchVersions.get(matchId);
    if (version === undefined) {
      version = (await this.deps.store.readStream(streamId)).length;
    }
    const stored = await this.deps.store.append(streamId, events, { expectedVersion: version });
    this.matchVersions.set(matchId, version + stored.length);
  }

  /** Single-writer append to a challenge escrow stream, under optimistic concurrency. */
  private async challengeAppend(challengeId: ChallengeId, events: DomainEvent[]): Promise<void> {
    const streamId = challengeStream(challengeId);
    let version = this.challengeVersions.get(challengeId);
    if (version === undefined) {
      version = (await this.deps.store.readStream(streamId)).length;
    }
    const stored = await this.deps.store.append(streamId, events, { expectedVersion: version });
    this.challengeVersions.set(challengeId, version + stored.length);
  }
}
