/**
 * Line-market resolution (over/under, handicap). The winning bucket a keeper
 * would settle on-chain via settle_market must agree with the off-chain
 * read-model resolution — same half-line rule, no push.
 */

import { describe, expect, test } from "bun:test";
import {
  handicapGoalsMarket,
  overUnderGoalsMarket,
  resolveLine,
  resolveOutcomes,
} from "../src/game/markets.ts";
import { LINE_BUCKETS, VOID } from "../src/domain/model.ts";

describe("over/under goals resolution", () => {
  const ou25 = overUnderGoalsMarket(2.5);
  test("5 goals is OVER 2.5", () => {
    expect(resolveLine(ou25.line!, { home: 3, away: 2 })).toBe(LINE_BUCKETS.OVER);
  });
  test("2 goals is UNDER 2.5", () => {
    expect(resolveLine(ou25.line!, { home: 1, away: 1 })).toBe(LINE_BUCKETS.UNDER);
  });
  test("exactly the floor (2) is UNDER, floor+1 (3) is OVER — no push", () => {
    expect(resolveLine(ou25.line!, { home: 2, away: 0 })).toBe(LINE_BUCKETS.UNDER);
    expect(resolveLine(ou25.line!, { home: 2, away: 1 })).toBe(LINE_BUCKETS.OVER);
  });
  test("every total resolves to exactly one side across the range", () => {
    for (let h = 0; h <= 5; h++) {
      for (let a = 0; a <= 5; a++) {
        const r = resolveLine(ou25.line!, { home: h, away: a });
        expect(r === LINE_BUCKETS.OVER || r === LINE_BUCKETS.UNDER).toBe(true);
      }
    }
  });
});

describe("handicap resolution", () => {
  const hcp = handicapGoalsMarket(1.5, "France", "Morocco");
  test("home wins by 2 covers -1.5", () => {
    expect(resolveLine(hcp.line!, { home: 3, away: 1 })).toBe(LINE_BUCKETS.OVER);
  });
  test("home wins by 1 does NOT cover -1.5 (away +1.5 wins)", () => {
    expect(resolveLine(hcp.line!, { home: 2, away: 1 })).toBe(LINE_BUCKETS.UNDER);
  });
  test("a draw is UNDER (away covers)", () => {
    expect(resolveLine(hcp.line!, { home: 1, away: 1 })).toBe(LINE_BUCKETS.UNDER);
  });
});

describe("resolveOutcomes across mixed markets", () => {
  test("resolves result + over/under together, corners void until wired", () => {
    const markets = [
      // result market via resultMarket() is added by the engine; here we test line + a stub
      overUnderGoalsMarket(2.5),
      { ...overUnderGoalsMarket(9.5), line: { op: "ADD", line: 9.5, stat: "CORNERS", period: "FULL" } as const },
    ];
    const out = resolveOutcomes(markets, { home: 3, away: 2 });
    expect(out[markets[0]!.marketId]).toBe(LINE_BUCKETS.OVER);
    // corners can't resolve from a goals-only score → VOID (honest refund)
    expect(out[markets[1]!.marketId]).toBe(VOID);
  });
});
