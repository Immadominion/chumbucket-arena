/**
 * Form — the streak mechanic. Hot Form gives a small, temporary GR multiplier
 * and unlocks sharper Gaffer banter; cold Form benches you in his eyes. Drives
 * loss-averse daily return: you don't want to break a run or stay benched.
 */
import type { FormResult } from "../domain/model";
export interface FormState {
    recent: FormResult[];
    streak: number;
    streakKind: "W" | "L" | "none";
    hot: boolean;
    cold: boolean;
    multiplier: number;
}
export declare function computeForm(results: FormResult[], window?: number): FormState;
