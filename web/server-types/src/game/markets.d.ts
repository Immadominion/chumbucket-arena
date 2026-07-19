/**
 * Market construction + outcome derivation. The result market (1X2) is always
 * present; Bold markets (exact score, etc.) are added per fixture. Resolution
 * maps a final score to the winning bucket of each market.
 */
import { type Bucket, type MarketId } from "../domain/ids";
import { type LineMarketSpec, type MarketDef, type Outcome } from "../domain/model";
export declare const RESULT_MARKET: MarketId;
export declare function resultMarket(): MarketDef;
/** 1X2 winning bucket from a final score. */
export declare function resolveResult(score: {
    home: number;
    away: number;
}): Bucket;
/** Stable, human-readable market id for a line market, e.g. "OU-GOALS-FULL-2.5". */
export declare function lineMarketId(spec: LineMarketSpec): MarketId;
/** Over/Under total goals (home + away vs the line). */
export declare function overUnderGoalsMarket(line: number, period?: "FULL" | "H1"): MarketDef;
/** Home-side goal handicap (home - away vs the line). */
export declare function handicapGoalsMarket(line: number, home: string, away: string): MarketDef;
/**
 * A short, deterministic on-chain-matchId tag for a market's pot, e.g. RESULT ->
 * "" (uses the fixture matchId as-is), Over/Under 2.5 -> "OU25", handicap 1.5 ->
 * "H15". Kept compact so `${fixtureMatchId}#${tag}` stays under the 32-byte pot
 * seed limit.
 */
export declare function marketPotTag(m: MarketDef): string;
/**
 * The on-chain match_id of a market's pot: the fixture matchId for RESULT (kept
 * byte-identical to every live pot), else `${fixtureMatchId}#${tag}`. Throws if
 * it would exceed the 32-byte pot-seed limit (caught at match-open time, not on a
 * money path).
 */
export declare function derivePotMatchId(fixtureMatchId: string, m: MarketDef): string;
/**
 * Winning bucket of a line market from a final score. The line is a half-line,
 * so `value > floor(line)` is OVER and everything else is UNDER — no push. Only
 * GOALS resolve from a plain score today; CORNERS/CARDS need the extended stat
 * feed, so they VOID (refund) until that's wired — the same honest fallback the
 * BOLD markets use.
 */
export declare function resolveLine(spec: LineMarketSpec, score: {
    home: number;
    away: number;
}): Outcome;
/**
 * The default rival bucket for a 1-v-1 challenge. HOME↔AWAY are natural
 * opposites; a DRAW challenge has no single complementary bucket, so its default
 * rival is HOME (the creator can override opponentSide at create time, e.g. to
 * say "I take the draw, you take AWAY"). Any third outcome voids and refunds both.
 */
export declare function counterSide(side: Bucket): Bucket;
/**
 * Compute the outcome of every market on a fixture from its final score. Markets
 * we can't adjudicate from score alone resolve to VOID (stakes refunded).
 */
export declare function resolveOutcomes(markets: readonly {
    marketId: MarketId;
    line?: LineMarketSpec;
}[], score: {
    home: number;
    away: number;
}): Record<string, Outcome>;
