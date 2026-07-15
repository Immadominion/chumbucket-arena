/**
 * House liquidity — synthetic "house" bettors that seed a match's pools so a real
 * player always has a counterparty.
 *
 * The problem it solves: parimutuel needs opponents. With too few distinct
 * bettors a market just voids and refunds (the `minParticipants` rule), so a solo
 * player can never actually win or lose — every bet is a wash. That makes the
 * product undemoable on your own.
 *
 * The fix: the first time a real player calls a match, the house places its own
 * calls across the result outcomes. That (a) clears the participant threshold and
 * (b) puts real, float-backed money on the other side — so a correct call wins
 * real WAL from the house and a wrong one loses to it.
 *
 * Money safety. A bot's stake is backed by the Sessions-wallet float. Each bot is
 * funded exactly once with a bounded bankroll (`bankrollPerBot`, itself clamped so
 * the total never exceeds `liquidityCap`), so the house's maximum possible loss is
 * fixed up front and can't drift the ledger into insolvency. The house bears the
 * bots' side of the risk by design — cap it and taper it as organic volume
 * arrives (see ROADMAP §7).
 *
 * Seeding is just-in-time (only matches a real player touches), idempotent, and
 * deduped against concurrent calls — and safe across restarts, since funding and
 * the bots' own calls are guarded by their durable event streams.
 */

import type { GameConfig } from "../config.ts";
import { RESULT_BUCKETS } from "../domain/model.ts";
import { houseWallet, type Frost, type MatchId, type MarketId } from "../domain/ids.ts";
import { RESULT_MARKET } from "../game/markets.ts";
import type { ActorRegistry } from "../core/actor/ActorRegistry.ts";
import type { ReadModel } from "../core/projections/ReadModel.ts";

// One bot per outcome → the result market always has money on every side.
const OUTCOMES = [RESULT_BUCKETS.HOME, RESULT_BUCKETS.AWAY, RESULT_BUCKETS.DRAW];

export class HouseLiquidity {
  private readonly inFlight = new Map<MatchId, Promise<void>>();

  constructor(
    private readonly registry: ActorRegistry,
    private readonly readModel: ReadModel,
    private readonly config: GameConfig,
  ) {}

  /**
   * Ensure a match has house liquidity. Idempotent per match and deduped against
   * concurrent callers; never throws — a seeding failure must not fail the real
   * player's bet that triggered it.
   */
  ensureSeeded(matchId: MatchId): Promise<void> {
    if (!this.config.house.enabled) return Promise.resolve();
    const existing = this.inFlight.get(matchId);
    if (existing) return existing;
    const p = this.seed(matchId).catch((err) => {
      console.error(`[house] failed to seed ${matchId}:`, err);
    });
    this.inFlight.set(matchId, p);
    return p;
  }

  private async seed(matchId: MatchId): Promise<void> {
    const match = this.readModel.pots.getMatch(matchId);
    if (!match) return;
    const market = match.markets.find((m) => m.marketId === RESULT_MARKET);
    if (!market || market.status !== "OPEN") return; // can only seed an open market

    const { botCount, seedStake, liquidityCap } = this.config.house;
    // Clamp each bot's one-time bankroll so botCount × perBot ≤ liquidityCap,
    // regardless of how the knobs are set — the hard ceiling on house exposure.
    const perBot = min(this.config.house.bankrollPerBot, liquidityCap / BigInt(Math.max(1, botCount)));

    for (let i = 0; i < botCount; i++) {
      const bot = houseWallet(i);
      const bucket = OUTCOMES[i % OUTCOMES.length]!;
      const actor = this.registry.for(bot);
      try {
        await actor.ensureHouseFunded(perBot); // sign + one-time bankroll (idempotent)
        await actor.makeCall({ matchId, marketId: RESULT_MARKET as MarketId, bucket, stake: seedStake });
      } catch {
        // Bot already called this market, market locked mid-seed, or bankroll
        // spent down — skip this bot and let the others carry the liquidity.
      }
    }
  }
}

const min = (a: Frost, b: Frost): Frost => (a < b ? a : b);
