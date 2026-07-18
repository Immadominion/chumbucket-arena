/**
 * The Squad Ladder. GR bands map to tiers; the Gaffer promotes and *demotes* you
 * across them. Driven by GR only — a whale can win money but cannot buy rank.
 */
import { type Tier } from "../domain/model";
export interface Band {
    tier: Tier;
    min: number;
}
export declare const BANDS: Band[];
export declare function tierForGr(gr: number): Tier;
export declare const tierIndex: (t: Tier) => number;
/** GR needed to reach the next tier up, or null at the top. */
export declare function nextTierFloor(gr: number): {
    tier: Tier;
    min: number;
} | null;
