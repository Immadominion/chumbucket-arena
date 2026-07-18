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
import type { GameConfig } from "../config";
import { type MatchId } from "../domain/ids";
import type { ActorRegistry } from "../core/actor/ActorRegistry";
import type { ReadModel } from "../core/projections/ReadModel";
export declare class HouseLiquidity {
    private readonly registry;
    private readonly readModel;
    private readonly config;
    private readonly inFlight;
    constructor(registry: ActorRegistry, readModel: ReadModel, config: GameConfig);
    /**
     * Ensure a match has house liquidity. Idempotent per match and deduped against
     * concurrent callers; never throws — a seeding failure must not fail the real
     * player's bet that triggered it.
     */
    ensureSeeded(matchId: MatchId): Promise<void>;
    private seed;
}
