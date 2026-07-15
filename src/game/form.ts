/**
 * Form — the streak mechanic. Hot Form gives a small, temporary GR multiplier
 * and unlocks sharper Gaffer banter; cold Form benches you in his eyes. Drives
 * loss-averse daily return: you don't want to break a run or stay benched.
 */

import type { FormResult } from "../domain/model.ts";

export interface FormState {
  recent: FormResult[]; // last N, oldest→newest
  streak: number; // length of the current run
  streakKind: "W" | "L" | "none";
  hot: boolean; // on a winning run
  cold: boolean; // on a losing run
  multiplier: number; // GR gain multiplier (>= 1)
}

const WINDOW = 5;

export function computeForm(results: FormResult[], window = WINDOW): FormState {
  const wl = results.filter((r): r is "W" | "L" => r !== "VOID");
  const recent = wl.slice(-window);

  let streak = 0;
  let kind: "W" | "L" | "none" = "none";
  for (let i = wl.length - 1; i >= 0; i--) {
    const r = wl[i];
    if (r === undefined) break;
    if (kind === "none") {
      kind = r;
      streak = 1;
    } else if (r === kind) {
      streak += 1;
    } else {
      break;
    }
  }

  const hot = kind === "W" && streak >= 3;
  const cold = kind === "L" && streak >= 3;
  // up to +15% on gains while hot; nothing while cold (cold is its own punishment)
  const multiplier = hot ? 1 + Math.min(streak - 2, 3) * 0.05 : 1;

  return { recent, streak: kind === "none" ? 0 : streak, streakKind: kind, hot, cold, multiplier };
}
