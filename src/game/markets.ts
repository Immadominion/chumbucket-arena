/**
 * Market construction + outcome derivation. The result market (1X2) is always
 * present; Bold markets (exact score, etc.) are added per fixture. Resolution
 * maps a final score to the winning bucket of each market.
 */

import { asMarketId, type Bucket, type MarketId } from "../domain/ids.ts";
import { RESULT_BUCKETS, VOID, type MarketDef, type Outcome } from "../domain/model.ts";

export const RESULT_MARKET: MarketId = asMarketId("RESULT");

export function resultMarket(): MarketDef {
  return {
    marketId: RESULT_MARKET,
    kind: "RESULT",
    label: "Full-time result",
    buckets: [
      { bucket: RESULT_BUCKETS.HOME, label: "Home win" },
      { bucket: RESULT_BUCKETS.DRAW, label: "Draw" },
      { bucket: RESULT_BUCKETS.AWAY, label: "Away win" },
    ],
  };
}

/** 1X2 winning bucket from a final score. */
export function resolveResult(score: { home: number; away: number }): Bucket {
  if (score.home > score.away) return RESULT_BUCKETS.HOME;
  if (score.home < score.away) return RESULT_BUCKETS.AWAY;
  return RESULT_BUCKETS.DRAW;
}

/**
 * The default rival bucket for a 1-v-1 challenge. HOME↔AWAY are natural
 * opposites; a DRAW challenge has no single complementary bucket, so its default
 * rival is HOME (the creator can override opponentSide at create time, e.g. to
 * say "I take the draw, you take AWAY"). Any third outcome voids and refunds both.
 */
export function counterSide(side: Bucket): Bucket {
  if (side === RESULT_BUCKETS.HOME) return RESULT_BUCKETS.AWAY;
  if (side === RESULT_BUCKETS.AWAY) return RESULT_BUCKETS.HOME;
  return RESULT_BUCKETS.HOME;
}

/**
 * Compute the outcome of every market on a fixture from its final score. Markets
 * we can't adjudicate from score alone resolve to VOID (stakes refunded).
 */
export function resolveOutcomes(
  markets: MarketDef[],
  score: { home: number; away: number },
): Record<string, Outcome> {
  const outcomes: Record<string, Outcome> = {};
  for (const m of markets) {
    if (m.marketId === RESULT_MARKET) {
      outcomes[m.marketId] = resolveResult(score);
    } else {
      // Bold markets need their own adjudication feed; refund until wired.
      outcomes[m.marketId] = VOID;
    }
  }
  return outcomes;
}
