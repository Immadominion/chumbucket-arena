/**
 * TxLINE adapters — pinned to the REAL wire protocol (round-tripped live on
 * devnet; ground truth in onchain/…/devnet-lifecycle/lock-and-settle.ts).
 * These exist because the first version of both adapters was written against
 * an inferred camelCase schema and silently did nothing: 0 fixtures, finished
 * matches never detected, and a stat-validation query form that 404s.
 */

import { describe, expect, test } from "bun:test";
import { asMatchId } from "../src/domain/ids.ts";
import {
  TxlineMatchData,
  finalScoresEvent,
  type TxScoresEvent,
} from "../src/ports/TxlineMatchData.ts";
import {
  TxlineSettlementVerifier,
  isCompleteBundle,
  provenScore,
  buildValidateStatArgs,
  type StatValidationResponse,
} from "../src/ports/TxlineSettlementVerifier.ts";
import txoracleIdl from "../vendor/txline/idl/txoracle.json" with { type: "json" };
import type { Idl } from "@coral-xyz/anchor";

const DEVNET_TXORACLE = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";

// ── canned wire data (shapes from the live API) ─────────────────────────────

const FIXTURES = [
  { FixtureId: 111, Participant1: "Norway", Participant2: "England", Participant1IsHome: true, StartTime: 1783803600000, GameState: 1, Competition: "FIFA World Cup 2026" },
  { FixtureId: 222, Participant1: "England", Participant2: "France", Participant1IsHome: false, StartTime: 1783804600000, GameState: 1 },
  { FixtureId: 333, Participant1: "Australia", Participant2: "Brazil", StartTime: 1790348400000, GameState: undefined as unknown as number },
];

/** Unordered on purpose: the LAST element is a stale in-play row (the original footgun). */
const FINISHED_ROWS: TxScoresEvent[] = [
  { Seq: 900, StatusId: 1, Stats: { "1": 0, "2": 0 } },
  { Seq: 1040, StatusId: 5, Action: "game_finalised", Stats: { "1": 3, "2": 2 } },
  { Seq: 1011, StatusId: 4, Stats: { "1": 2, "2": 2 } }, // stale, mid-match, NOT last score
];

const IN_PLAY_ROWS: TxScoresEvent[] = [
  { Seq: 500, StatusId: 4, Stats: { "1": 1, "2": 0 } },
  { Seq: 400, StatusId: 2, Stats: { "1": 1, "2": 0 } },
];

const bytes32 = () => Array.from({ length: 32 }, () => 0);
const node = () => ({ hash: bytes32(), isRightSibling: false });

const BUNDLE: StatValidationResponse = {
  statToProve: { key: 1, value: 3, period: 5 },
  statToProve2: { key: 2, value: 2, period: 5 },
  summary: {
    fixtureId: 111,
    updateStats: { updateCount: 5, minTimestamp: 1783447502621, maxTimestamp: 1783447512560 },
    eventStatsSubTreeRoot: bytes32(),
  },
  subTreeProof: [node(), node()],
  mainTreeProof: [node()],
  eventStatRoot: bytes32(),
  statProof: [node()],
  statProof2: [node()],
};

/** Route-by-URL fetch mock that records every request. */
function mockFetch(routes: Record<string, unknown>, calls: string[] = []) {
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.includes(prefix)) {
        if (body instanceof Response) return body;
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const matchDataWith = (routes: Record<string, unknown>, calls: string[] = []) =>
  new TxlineMatchData(
    { apiBaseUrl: "https://tx.test", jwt: "x.y.z", apiToken: "t", cacheTtlMs: 0 },
    mockFetch(routes, calls).impl,
  );

// ── TxlineMatchData ──────────────────────────────────────────────────────────

describe("TxlineMatchData against the real wire shapes", () => {
  test("fixtures(): bare PascalCase array → Fixture; GameState!==1 filtered out", async () => {
    const md = matchDataWith({ "/api/fixtures/snapshot": FIXTURES });
    const fx = await md.fixtures();
    expect(fx.map((f) => f.home)).toEqual(["Norway", "England"]);
    expect(fx[0]!.kickoff).toBe(1783803600000); // StartTime is already epoch ms
    expect(fx[0]!.txline).toEqual({ fixtureId: 111, participant1IsHome: true });
    expect(fx[1]!.txline!.participant1IsHome).toBe(false);
  });

  test("results(): finds the terminal row in an UNORDERED array (stale last element)", async () => {
    const md = matchDataWith({
      "/api/fixtures/snapshot": FIXTURES,
      "/api/scores/snapshot/111": FINISHED_ROWS,
    });
    const res = await md.results([asMatchId("111")]);
    expect(res).toEqual([{ matchId: asMatchId("111"), score: { home: 3, away: 2 }, finished: true }]);
  });

  test("results(): in-play only → no result (never settles a live match)", async () => {
    const md = matchDataWith({
      "/api/fixtures/snapshot": FIXTURES,
      "/api/scores/snapshot/111": IN_PLAY_ROWS,
    });
    expect(await md.results([asMatchId("111")])).toEqual([]);
  });

  test("results(): Participant1IsHome=false flips the score to true home/away", async () => {
    const md = matchDataWith({
      "/api/fixtures/snapshot": FIXTURES,
      // participant1 (England, away side) scored 3; participant2 (France, home) scored 2
      "/api/scores/snapshot/222": [{ Seq: 10, StatusId: 5, Stats: { "1": 3, "2": 2 } }],
    });
    const res = await md.results([asMatchId("222")]);
    expect(res[0]!.score).toEqual({ home: 2, away: 3 });
  });

  test("results(): penalties-final (StatusId 13) is terminal; 404 snapshot is not", async () => {
    const md = matchDataWith({
      "/api/fixtures/snapshot": FIXTURES,
      "/api/scores/snapshot/111": [{ Seq: 2000, StatusId: 13, Stats: { "1": 1, "2": 1 } }],
      // fixture 222 has no snapshot route → 404 → skipped
    });
    const res = await md.results([asMatchId("111"), asMatchId("222")]);
    expect(res).toHaveLength(1);
    expect(res[0]!.score).toEqual({ home: 1, away: 1 });
  });

  test("results(): terminal row missing goal stats is NOT resolved (no 0-0 fabrication)", async () => {
    const md = matchDataWith({
      "/api/fixtures/snapshot": FIXTURES,
      "/api/scores/snapshot/111": [{ Seq: 50, StatusId: 5 }],
    });
    expect(await md.results([asMatchId("111")])).toEqual([]);
  });
});

// ── pure settlement helpers ──────────────────────────────────────────────────

describe("finalScoresEvent", () => {
  test("highest-Seq terminal row wins; non-terminal Seqs ignored even when higher", () => {
    const rows: TxScoresEvent[] = [
      { Seq: 99, StatusId: 5, Stats: { "1": 1, "2": 0 } },
      { Seq: 150, StatusId: 4 }, // higher Seq but in-play — must not win
      { Seq: 120, StatusId: 10, Stats: { "1": 2, "2": 2 } },
    ];
    expect(finalScoresEvent(rows)?.Seq).toBe(120);
  });
  test("no terminal rows → undefined", () => {
    expect(finalScoresEvent(IN_PLAY_ROWS)).toBeUndefined();
  });
});

describe("stat-validation bundle handling", () => {
  test("isCompleteBundle rejects a missing statProof2 and wrong stat keys", () => {
    expect(isCompleteBundle(BUNDLE)).toBe(true);
    expect(isCompleteBundle({ ...BUNDLE, statProof2: undefined })).toBe(false);
    expect(isCompleteBundle({ ...BUNDLE, statToProve: { key: 7, value: 3, period: 5 } })).toBe(false);
  });

  test("provenScore orients by participant1IsHome", () => {
    const b = BUNDLE as Required<Pick<StatValidationResponse, "statToProve" | "statToProve2">>;
    expect(provenScore(b, true)).toEqual({ home: 3, away: 2 });
    expect(provenScore(b, false)).toEqual({ home: 2, away: 3 });
  });

  test("buildValidateStatArgs: ts = summary minTimestamp; PDA from its epoch day; sides swap", () => {
    const full = BUNDLE as Required<StatValidationResponse>;
    const a = buildValidateStatArgs(full, true, 1, DEVNET_TXORACLE);
    expect(a.targetTs).toBe(1783447502621);
    // matches the live-proven Argentina–Egypt root account for epoch day 20641
    expect(a.dailyScoresPda.toBase58()).toBe("GRJBcG6G9CnvvNZPQagxietR7caFtAG8sFRZ2mg5n8QZ");
    const [, , , , predicate, statHome] = a.args as [unknown, unknown, unknown, unknown, { threshold: number }, { statToProve: { key: number } }];
    expect(predicate.threshold).toBe(1);
    expect(statHome.statToProve.key).toBe(1); // participant1 is home ⇒ home term is key 1

    const flipped = buildValidateStatArgs(full, false, -1, DEVNET_TXORACLE);
    const [, , , , , flippedHome] = flipped.args as [unknown, unknown, unknown, unknown, unknown, { statToProve: { key: number } }];
    expect(flippedHome.statToProve.key).toBe(2); // participant2 is home ⇒ home term is key 2
  });

  test("buildValidateStatArgs throws on a malformed (non-32-byte) root", () => {
    const bad = { ...BUNDLE, eventStatRoot: [1, 2, 3] } as Required<StatValidationResponse>;
    expect(() => buildValidateStatArgs(bad, true, 1, DEVNET_TXORACLE)).toThrow(/32 bytes/);
  });
});

// ── verifier orchestration (everything up to the chain call) ────────────────

const verifierWith = (routes: Record<string, unknown>, calls: string[]) =>
  new TxlineSettlementVerifier({
    rpcUrl: "https://api.devnet.solana.com",
    programId: DEVNET_TXORACLE,
    apiBaseUrl: "https://tx.test",
    jwt: "x.y.z",
    apiToken: "t",
    fixtureMap: { resolve: async () => ({ txlineFixtureId: 111, participant1IsHome: true }) },
    idl: txoracleIdl as Idl,
    fetchImpl: mockFetch(routes, calls).impl,
  });

describe("TxlineSettlementVerifier orchestration", () => {
  test("refuses to verify while TxLINE shows the match in play — and never asks for a proof", async () => {
    const calls: string[] = [];
    const v = verifierWith({ "/api/scores/snapshot/111": IN_PLAY_ROWS }, calls);
    const r = await v.verify({ matchId: asMatchId("111"), txlineFixtureId: 111, score: { home: 1, away: 0 } });
    expect(r.verified).toBe(false);
    expect(r.detail).toContain("not terminal");
    expect(calls.some((u) => u.includes("stat-validation"))).toBe(false);
  });

  test("requests the proof with the WORKING query form: seq + statKey + statKey2 (never statKeys)", async () => {
    const calls: string[] = [];
    const v = verifierWith(
      {
        "/api/scores/snapshot/111": FINISHED_ROWS,
        "/api/scores/stat-validation": {}, // incomplete bundle — stops after the fetch we're inspecting
      },
      calls,
    );
    const r = await v.verify({ matchId: asMatchId("111"), txlineFixtureId: 111, score: { home: 3, away: 2 } });
    const proofUrl = calls.find((u) => u.includes("stat-validation"))!;
    expect(proofUrl).toContain("fixtureId=111");
    expect(proofUrl).toContain("seq=1040"); // the terminal event's Seq, not the max array index
    expect(proofUrl).toContain("statKey=1");
    expect(proofUrl).toContain("statKey2=2");
    expect(proofUrl).not.toContain("statKeys");
    expect(r).toEqual({ verified: false, detail: "proof bundle incomplete (root not posted yet)" });
  });

  test("exact-score cross-check rejects a diff-preserving wrong score BEFORE any chain call", async () => {
    const calls: string[] = [];
    const v = verifierWith(
      { "/api/scores/snapshot/111": FINISHED_ROWS, "/api/scores/stat-validation": BUNDLE },
      calls,
    );
    // proof says 3-2 (diff +1); report 2-1 (also diff +1) — on-chain predicate alone would pass this!
    const r = await v.verify({ matchId: asMatchId("111"), txlineFixtureId: 111, score: { home: 2, away: 1 } });
    expect(r.verified).toBe(false);
    expect(r.detail).toContain("score mismatch");
    expect(r.detail).toContain("3-2");
  });
});
