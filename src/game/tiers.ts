/**
 * The Squad Ladder. GR bands map to tiers; the Gaffer promotes and *demotes* you
 * across them. Driven by GR only — a whale can win money but cannot buy rank.
 */

import { TIERS, type Tier } from "../domain/model.ts";

export interface Band {
  tier: Tier;
  min: number; // inclusive GR floor for this tier
}

export const BANDS: Band[] = [
  { tier: "Trialist", min: 0 },
  { tier: "Squad Player", min: 1040 },
  { tier: "First Team", min: 1120 },
  { tier: "Captain", min: 1220 },
  { tier: "Assistant Manager", min: 1340 },
  { tier: "Director of Football", min: 1480 },
];

export function tierForGr(gr: number): Tier {
  let tier: Tier = "Trialist";
  for (const band of BANDS) {
    if (gr >= band.min) tier = band.tier;
  }
  return tier;
}

export const tierIndex = (t: Tier): number => TIERS.indexOf(t);

/** GR needed to reach the next tier up, or null at the top. */
export function nextTierFloor(gr: number): { tier: Tier; min: number } | null {
  for (const band of BANDS) {
    if (gr < band.min) return band;
  }
  return null;
}
