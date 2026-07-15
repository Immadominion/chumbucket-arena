import { describe, expect, test } from "bun:test";
import {
  type CallStake,
  settleParimutuel,
  impliedProb,
} from "../src/game/parimutuel.ts";
import { grDelta, BASE_GR } from "../src/game/rating.ts";
import { computeForm } from "../src/game/form.ts";
import { tierForGr, nextTierFloor } from "../src/game/tiers.ts";
import { wal } from "../src/domain/ids.ts";
import type { Bucket, CallId, Wallet } from "../src/domain/ids.ts";

const c = (id: string, w: string, bucket: string, stake: bigint): CallStake => ({
  callId: id as CallId,
  wallet: w as Wallet,
  bucket: bucket as Bucket,
  stake,
});
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe("parimutuel", () => {
  test("winners split the pot and totals reconcile to gross - rake", () => {
    const calls = [
      c("a", "alice", "HOME", wal(10)),
      c("b", "bob", "HOME", wal(30)),
      c("d", "dave", "AWAY", wal(60)),
    ];
    const r = settleParimutuel({
      calls,
      winningBucket: "HOME" as Bucket,
      rakeBps: 250,
      minParticipants: 2,
    });
    expect(r.kind).toBe("PAID");
    if (r.kind !== "PAID") return;

    // losers' pool = 60 WAL; rake = 2.5% = 1.5 WAL; distributable = 58.5 WAL
    expect(r.rake).toBe(wal(1.5));
    expect(r.distributable).toBe(wal(58.5));

    // conservation: every frost is accounted for
    const paid = sum(r.payouts.map((p) => p.payout));
    expect(paid).toBe(r.grossPot - r.rake);

    // alice staked 10 of 40 winning → 25% of distributable + her stake back
    const alice = r.payouts.find((p) => p.wallet === "alice")!;
    expect(alice.payout).toBe(wal(10) + wal(58.5) / 4n);
    // loser gets nothing
    expect(r.payouts.find((p) => p.wallet === "dave")!.payout).toBe(0n);
  });

  test("dust from integer division is fully distributed", () => {
    // 3 equal winners share an indivisible distributable → 1 frost dust
    const calls = [
      c("a", "alice", "HOME", 1n),
      c("b", "bob", "HOME", 1n),
      c("e", "eve", "HOME", 1n),
      c("d", "dave", "AWAY", 1n),
    ];
    const r = settleParimutuel({
      calls,
      winningBucket: "HOME" as Bucket,
      rakeBps: 0,
      minParticipants: 2,
    });
    if (r.kind !== "PAID") throw new Error("expected PAID");
    expect(sum(r.payouts.map((p) => p.payout))).toBe(r.grossPot); // no rake → all returned
  });

  test("thin pool refunds everyone, no winners refunds everyone", () => {
    const calls = [c("a", "alice", "HOME", wal(5)), c("b", "bob", "AWAY", wal(5))];
    const thin = settleParimutuel({
      calls,
      winningBucket: "HOME" as Bucket,
      rakeBps: 250,
      minParticipants: 5,
    });
    expect(thin.kind).toBe("VOID");
    expect(sum(thin.payouts.map((p) => p.payout))).toBe(thin.grossPot);

    const noWinners = settleParimutuel({
      calls,
      winningBucket: "DRAW" as Bucket,
      rakeBps: 250,
      minParticipants: 2,
    });
    expect(noWinners.kind).toBe("VOID");
    expect(sum(noWinners.payouts.map((p) => p.payout))).toBe(noWinners.grossPot);
  });

  test("impliedProb is the bucket's share of the pot", () => {
    expect(impliedProb(wal(25), wal(100))).toBeCloseTo(0.25, 5);
    expect(impliedProb(0n, 0n)).toBe(0);
  });
});

describe("rating", () => {
  test("winning a longshot beats winning a favourite", () => {
    const longshot = grDelta({ impliedProbAtCall: 0.1, won: true, bold: false, formMultiplier: 1 });
    const favourite = grDelta({ impliedProbAtCall: 0.9, won: true, bold: false, formMultiplier: 1 });
    expect(longshot).toBeGreaterThan(favourite);
    expect(favourite).toBeGreaterThan(0);
  });

  test("losing a favourite hurts more than losing a longshot", () => {
    const favourite = grDelta({ impliedProbAtCall: 0.9, won: false, bold: false, formMultiplier: 1 });
    const longshot = grDelta({ impliedProbAtCall: 0.1, won: false, bold: false, formMultiplier: 1 });
    expect(favourite).toBeLessThan(longshot);
    expect(favourite).toBeLessThan(0);
  });

  test("bold and hot form amplify gains; form never amplifies losses", () => {
    const plain = grDelta({ impliedProbAtCall: 0.3, won: true, bold: false, formMultiplier: 1 });
    const bold = grDelta({ impliedProbAtCall: 0.3, won: true, bold: true, formMultiplier: 1 });
    const hot = grDelta({ impliedProbAtCall: 0.3, won: true, bold: false, formMultiplier: 1.15 });
    expect(bold).toBeGreaterThan(plain);
    expect(hot).toBeGreaterThan(plain);

    const loss = grDelta({ impliedProbAtCall: 0.3, won: false, bold: false, formMultiplier: 1 });
    const lossHot = grDelta({ impliedProbAtCall: 0.3, won: false, bold: false, formMultiplier: 1.15 });
    expect(lossHot).toBe(loss);
  });
});

describe("form", () => {
  test("counts the current streak and flags hot/cold, ignoring voids", () => {
    expect(computeForm(["L", "W", "VOID", "W", "W"]).streakKind).toBe("W");
    expect(computeForm(["W", "W", "W"]).hot).toBe(true);
    expect(computeForm(["L", "L", "L"]).cold).toBe(true);
    expect(computeForm(["W", "W", "W"]).multiplier).toBeGreaterThan(1);
    expect(computeForm([]).streakKind).toBe("none");
  });
});

describe("tiers", () => {
  test("GR bands map to the ladder and the climb is monotonic", () => {
    expect(tierForGr(BASE_GR)).toBe("Trialist");
    expect(tierForGr(1125)).toBe("First Team");
    expect(tierForGr(9999)).toBe("Director of Football");
    expect(nextTierFloor(BASE_GR)?.tier).toBe("Squad Player");
    expect(nextTierFloor(9999)).toBeNull();
  });
});
