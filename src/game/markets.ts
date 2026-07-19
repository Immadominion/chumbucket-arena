/**
 * Market construction + outcome derivation. The result market (1X2) is always
 * present; Bold markets (exact score, etc.) are added per fixture. Resolution
 * maps a final score to the winning bucket of each market.
 */

import { asMarketId, type Bucket, type MarketId } from "../domain/ids.ts";
import {
  LINE_BUCKETS,
  RESULT_BUCKETS,
  VOID,
  type LineMarketSpec,
  type MarketDef,
  type Outcome,
} from "../domain/model.ts";

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

// ── Line markets (over/under, handicap) — settled on-chain via settle_market ──

/** Stable, human-readable market id for a line market, e.g. "OU-GOALS-FULL-2.5". */
export function lineMarketId(spec: LineMarketSpec): MarketId {
  const tag = spec.op === "ADD" ? "OU" : "HCP";
  return asMarketId(`${tag}-${spec.stat}-${spec.period}-${spec.line}`);
}

/** Over/Under total goals (home + away vs the line). */
export function overUnderGoalsMarket(line: number, period: "FULL" | "H1" = "FULL"): MarketDef {
  const spec: LineMarketSpec = { op: "ADD", line, stat: "GOALS", period };
  const scope = period === "H1" ? "first-half " : "";
  return {
    marketId: lineMarketId(spec),
    kind: "OVER_UNDER",
    label: `Over/Under ${line} ${scope}goals`,
    buckets: [
      { bucket: LINE_BUCKETS.OVER, label: `Over ${line}` },
      { bucket: LINE_BUCKETS.UNDER, label: `Under ${line}` },
    ],
    line: spec,
  };
}

/** Home-side goal handicap (home - away vs the line). */
export function handicapGoalsMarket(line: number, home: string, away: string): MarketDef {
  const spec: LineMarketSpec = { op: "SUB", line, stat: "GOALS", period: "FULL" };
  return {
    marketId: lineMarketId(spec),
    kind: "HANDICAP",
    label: `${home} -${line} handicap`,
    buckets: [
      { bucket: LINE_BUCKETS.OVER, label: `${home} -${line}` },
      { bucket: LINE_BUCKETS.UNDER, label: `${away} +${line}` },
    ],
    line: spec,
  };
}

/**
 * Winning bucket of a line market from a final score. The line is a half-line,
 * so `value > floor(line)` is OVER and everything else is UNDER — no push. Only
 * GOALS resolve from a plain score today; CORNERS/CARDS need the extended stat
 * feed, so they VOID (refund) until that's wired — the same honest fallback the
 * BOLD markets use.
 */
export function resolveLine(
  spec: LineMarketSpec,
  score: { home: number; away: number },
): Outcome {
  if (spec.stat !== "GOALS") return VOID;
  const value = spec.op === "ADD" ? score.home + score.away : score.home - score.away;
  return value > Math.floor(spec.line) ? LINE_BUCKETS.OVER : LINE_BUCKETS.UNDER;
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
    } else if (m.line) {
      // Line markets (over/under, handicap) resolve from the score directly.
      outcomes[m.marketId] = resolveLine(m.line, score);
    } else {
      // Bold markets need their own adjudication feed; refund until wired.
      outcomes[m.marketId] = VOID;
    }
  }
  return outcomes;
}
