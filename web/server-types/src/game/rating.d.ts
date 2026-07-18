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
export declare const BASE_GR = 1000;
export interface RatingInput {
    /** Crowd-implied probability of the called bucket at call time (0..1). */
    impliedProbAtCall: number;
    won: boolean;
    bold: boolean;
    /** Hot-Form bonus, applied to *gains only* (>= 1). */
    formMultiplier: number;
}
export declare function grDelta(input: RatingInput): number;
/** How unlikely the crowd thought the call was (0..1) — stored on the record. */
export declare const difficultyOf: (impliedProb: number) => number;
