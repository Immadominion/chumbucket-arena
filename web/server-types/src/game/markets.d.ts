/**
 * Market construction + outcome derivation. The result market (1X2) is always
 * present; Bold markets (exact score, etc.) are added per fixture. Resolution
 * maps a final score to the winning bucket of each market.
 */
import { type Bucket, type MarketId } from "../domain/ids";
import { type MarketDef, type Outcome } from "../domain/model";
export declare const RESULT_MARKET: MarketId;
export declare function resultMarket(): MarketDef;
/** 1X2 winning bucket from a final score. */
export declare function resolveResult(score: {
    home: number;
    away: number;
}): Bucket;
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
export declare function resolveOutcomes(markets: MarketDef[], score: {
    home: number;
    away: number;
}): Record<string, Outcome>;
