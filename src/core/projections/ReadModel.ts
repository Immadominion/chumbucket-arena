/**
 * The query side of CQRS. Owns every projection, hydrates them from the event
 * log on boot, then tails the store so reads are always current. Exposes the
 * derived views the API serves: dossiers, pots, leaderboards, the Manager's Pot.
 */

import type { StoredEvent } from "../../domain/events.ts";
import { isHouseWallet, type ChallengeId, type Frost, type Wallet } from "../../domain/ids.ts";
import type { Tier } from "../../domain/model.ts";
import type { FormState } from "../../game/form.ts";
import type { EventStore } from "../eventstore/EventStore.ts";
import { ChallengeProjection } from "./ChallengeProjection.ts";
import { ChatProjection } from "./ChatProjection.ts";
import { DossierProjection, type DossierView } from "./DossierProjection.ts";
import { PotProjection } from "./PotProjection.ts";
import { SettledCallsProjection } from "./SettledCallsProjection.ts";
import type { Projection } from "./Projection.ts";

export interface LeaderboardEntry {
  rank: number;
  wallet: Wallet;
  handle: string | undefined;
  gr: number;
  tier: Tier;
  pnl: Frost;
  record: { won: number; lost: number; voided: number };
  form: FormState;
}

export class ReadModel {
  readonly dossier = new DossierProjection();
  readonly pots = new PotProjection();
  readonly settled = new SettledCallsProjection();
  readonly chat = new ChatProjection();
  readonly challenges = new ChallengeProjection();
  private readonly projections: Projection[] = [
    this.dossier,
    this.pots,
    this.settled,
    this.chat,
    this.challenges,
  ];
  private managersPot: Frost = 0n;
  private houseRevenue: Frost = 0n; // accrued withdrawal fees (covers gas + margin)

  apply(event: StoredEvent): void {
    for (const p of this.projections) p.apply(event);
    if (event.payload.type === "PotSettled") this.managersPot += event.payload.rake;
    // A settled 1-v-1 rakes the loser's stake into the Manager's Pot too.
    if (event.payload.type === "ChallengeSettled") this.managersPot += event.payload.rake;
    // Withdrawal fees become house revenue only on a CONFIRMED send — legacy
    // single-phase Withdrawn, or the two-phase WithdrawalSettled.
    if (event.payload.type === "Withdrawn" && event.payload.fee) this.houseRevenue += event.payload.fee;
    if (event.payload.type === "WithdrawalSettled" && event.payload.fee) this.houseRevenue += event.payload.fee;
  }

  /** Replay the whole log, then subscribe to the live tail. */
  async hydrate(store: EventStore): Promise<void> {
    for (const e of await store.readAll()) this.apply(e);
    store.subscribe((e) => this.apply(e));
  }

  managersPotTotal(): Frost {
    return this.managersPot;
  }

  houseRevenueTotal(): Frost {
    return this.houseRevenue;
  }

  /** The Squad Ladder — by GR (skill). This is the canonical ranking. */
  leaderboardByGr(limit = 50): LeaderboardEntry[] {
    return this.dossier
      .all()
      .filter((d) => !isHouseWallet(d.wallet)) // house bots never appear on the ladder
      .sort((a, b) => b.gr - a.gr)
      .slice(0, limit)
      .map((d, i) => ({
        rank: i + 1,
        wallet: d.wallet,
        handle: d.handle,
        gr: d.gr,
        tier: d.tier,
        pnl: d.pnl,
        record: d.record,
        form: d.form,
      }));
  }

  /** The Winnings board — by realised P&L (money). Never drives rank. */
  leaderboardByPnl(limit = 50): LeaderboardEntry[] {
    return this.dossier
      .all()
      .filter((d) => !isHouseWallet(d.wallet)) // house bots never appear on the board
      .sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0))
      .slice(0, limit)
      .map((d, i) => ({
        rank: i + 1,
        wallet: d.wallet,
        handle: d.handle,
        gr: d.gr,
        tier: d.tier,
        pnl: d.pnl,
        record: d.record,
        form: d.form,
      }));
  }

  getDossier(wallet: Wallet): DossierView | undefined {
    return this.dossier.get(wallet);
  }

  getChallenge(challengeId: ChallengeId) {
    return this.challenges.get(challengeId);
  }

  myChallenges(wallet: Wallet) {
    return this.challenges.forWallet(wallet);
  }

  settledCalls(wallet: Wallet, limit = 50) {
    return this.settled.get(wallet, limit);
  }

  chatHistory(wallet: Wallet, limit = 50) {
    return this.chat.get(wallet, limit);
  }
}
