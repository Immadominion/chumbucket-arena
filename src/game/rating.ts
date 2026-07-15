/**
 * Gaffer Rating (GR) — the skill number. It moves on *correctness weighted by
 * difficulty*, independent of stake size. A £1 correct upset moves it exactly as
 * much as a £1,000 one; calling a heavy favourite barely moves it at all.
 *
 * The maths is a proper scoring rule (ELO-style): your call carries the crowd's
 * implied probability p as its "expected score". Win and you score 1, lose and
 * you score 0; GR moves by K·(actual − p). So:
 *   - win a longshot (low p)  → big gain
 *   - win a favourite (high p) → small gain
 *   - lose a favourite (high p) → big loss
 *   - lose a longshot (low p)   → small loss
 */

import { clamp } from "./util.ts";

export const BASE_GR = 1000;
const K = 40;
const BOLD_MULTIPLIER = 1.5; // Bold Calls are harder, so they move GR more.

export interface RatingInput {
  /** Crowd-implied probability of the called bucket at call time (0..1). */
  impliedProbAtCall: number;
  won: boolean;
  bold: boolean;
  /** Hot-Form bonus, applied to *gains only* (>= 1). */
  formMultiplier: number;
}

export function grDelta(input: RatingInput): number {
  const p = clamp(input.impliedProbAtCall, 0.01, 0.99);
  const actual = input.won ? 1 : 0;
  let delta = K * (input.bold ? BOLD_MULTIPLIER : 1) * (actual - p);
  if (delta > 0) delta *= Math.max(1, input.formMultiplier);
  return Math.round(delta);
}

/** How unlikely the crowd thought the call was (0..1) — stored on the record. */
export const difficultyOf = (impliedProb: number): number =>
  clamp(1 - impliedProb, 0, 1);
