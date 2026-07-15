/**
 * TxlineSettlementVerifier — CPIs into TxLINE's read-only `validate_stat` view
 * instruction to corroborate a MatchDataProvider-reported final score against
 * TxLINE's Merkle-committed on-chain scores feed, before ChumBucket trusts it
 * for payout. No signer, no state change — a simulated view call, mirroring the
 * PROVEN devnet flow in onchain/…/devnet-lifecycle/lock-and-settle.ts exactly.
 *
 * Wire protocol (round-tripped live on devnet — do not "tidy" it):
 *   1. GET /api/scores/snapshot/{fixtureId}   → unordered event array; the match
 *      is finished only when some row has StatusId ∈ {5,10,13}; prove against
 *      the highest such Seq.
 *   2. GET /api/scores/stat-validation?fixtureId&seq&statKey=1&statKey2=2
 *      (the `statKeys=1,2` form 404s — that was this adapter's original bug).
 *      Response carries statToProve/statToProve2 + statProof/statProof2 +
 *      one shared eventStatRoot, and summary.updateStats.
 *   3. validate_stat(ts = summary.updateStats.minTimestamp — NOT the top-level
 *      ts — …) against the daily_scores_roots PDA for that ts's epoch day.
 *
 * Predicate: (home_goals − away_goals) == (reported.home − reported.away).
 * We additionally require the proof's exact goals to equal the reported score
 * off-chain first — the on-chain predicate proves the DIFF, so 3–2 vs 2–1 would
 * satisfy it; the equality cross-check closes that gap before any RPC is spent.
 *
 * IMPORTANT version note: @coral-xyz/anchor on npm is 0.32.x — there is no
 * published 1.x TypeScript client yet, even though anchor-cli/anchor-lang
 * (Rust) are on 1.x. Do not "upgrade" this import without checking npm first.
 */

import { Connection, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { AnchorProvider, Program, BN, type Idl, type Wallet as AnchorWallet } from "@coral-xyz/anchor";
import type { MatchId } from "../domain/ids.ts";
import {
  finalScoresEvent,
  STAT_KEY_P1_GOALS,
  STAT_KEY_P2_GOALS,
  type TxScoresEvent,
} from "./TxlineMatchData.ts";
import type {
  SettlementVerificationInput,
  SettlementVerificationResult,
  SettlementVerifier,
} from "./SettlementVerifier.ts";

export interface FixtureIdMap {
  resolve(matchId: MatchId): Promise<{ txlineFixtureId: number; participant1IsHome: boolean } | undefined>;
}

export interface TxlineSettlementVerifierConfig {
  rpcUrl: string;
  programId: string; // mainnet 9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA / devnet 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J
  apiBaseUrl: string;
  jwt: string;
  apiToken: string;
  fixtureMap: FixtureIdMap;
  /** Vendored copy of TxLINE's IDL (idl/txoracle.json from tx-on-chain). */
  idl: Idl;
  fetchImpl?: typeof fetch;
}

interface ProofNode {
  hash: number[];
  isRightSibling: boolean;
}
interface StatToProve {
  key: number;
  value: number;
  period: number;
}
/** Real /api/scores/stat-validation response shape (statKey + statKey2 form). */
export interface StatValidationResponse {
  statToProve?: StatToProve;
  statToProve2?: StatToProve;
  summary?: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: number[];
  };
  subTreeProof?: ProofNode[];
  mainTreeProof?: ProofNode[];
  eventStatRoot?: number[];
  statProof?: ProofNode[];
  statProof2?: ProofNode[];
}

const toBytes32 = (arr: number[] | undefined, label: string): number[] => {
  if (!arr || arr.length !== 32) throw new Error(`${label}: expected 32 bytes, got ${arr?.length ?? "none"}`);
  return arr;
};
const toProofNodes = (nodes: ProofNode[], label: string) =>
  nodes.map((n) => ({ hash: toBytes32(n.hash, label), isRightSibling: n.isRightSibling }));

/** A completeness gate the raw response must pass before we touch the chain. */
export function isCompleteBundle(v: StatValidationResponse): v is Required<StatValidationResponse> {
  return !!(
    v.summary &&
    v.statToProve &&
    v.statToProve2 &&
    v.subTreeProof?.length &&
    v.mainTreeProof &&
    v.eventStatRoot &&
    v.statProof?.length &&
    v.statProof2?.length &&
    // trust nothing: the two proven stats must actually be the goal keys we asked for
    v.statToProve.key === STAT_KEY_P1_GOALS &&
    v.statToProve2.key === STAT_KEY_P2_GOALS
  );
}

/** The proof's own final score, oriented home/away. Pure — unit-tested. */
export function provenScore(
  v: Required<Pick<StatValidationResponse, "statToProve" | "statToProve2">>,
  participant1IsHome: boolean,
): { home: number; away: number } {
  const p1 = v.statToProve.value;
  const p2 = v.statToProve2.value;
  return participant1IsHome ? { home: p1, away: p2 } : { home: p2, away: p1 };
}

/**
 * Map the REST bundle onto validate_stat's Anchor argument shapes — one-for-one
 * with the proven lock-and-settle.ts call. Pure (throws on malformed bytes) so
 * the mapping itself is unit-testable without a network.
 */
export function buildValidateStatArgs(
  v: Required<StatValidationResponse>,
  participant1IsHome: boolean,
  reportedDiff: number,
  programId: string,
): {
  targetTs: number;
  dailyScoresPda: PublicKey;
  args: unknown[];
} {
  // The ts validate_stat anchors on is the batch's minTimestamp — NOT the
  // response's top-level ts (that mismatch cost a live TimestampMismatch once).
  const targetTs = v.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(targetTs / 86_400_000);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    new PublicKey(programId),
  );

  const fixtureSummary = {
    fixtureId: new BN(v.summary.fixtureId),
    updateStats: {
      updateCount: v.summary.updateStats.updateCount,
      minTimestamp: new BN(v.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: toBytes32(v.summary.eventStatsSubTreeRoot, "eventStatsSubTreeRoot"),
  };
  const fixtureProof = toProofNodes(v.subTreeProof, "subTreeProof");
  const mainTreeProof = toProofNodes(v.mainTreeProof, "mainTreeProof");
  const term1 = {
    statToProve: v.statToProve,
    eventStatRoot: toBytes32(v.eventStatRoot, "eventStatRoot"),
    statProof: toProofNodes(v.statProof, "statProof"),
  };
  const term2 = {
    statToProve: v.statToProve2,
    eventStatRoot: toBytes32(v.eventStatRoot, "eventStatRoot"),
    statProof: toProofNodes(v.statProof2, "statProof2"),
  };
  // home − away: statHome must be whichever participant is actually home.
  const statHome = participant1IsHome ? term1 : term2;
  const statAway = participant1IsHome ? term2 : term1;
  const predicate = { threshold: reportedDiff, comparison: { equalTo: {} } };

  return {
    targetTs,
    dailyScoresPda,
    args: [new BN(targetTs), fixtureSummary, fixtureProof, mainTreeProof, predicate, statHome, statAway, { subtract: {} }],
  };
}

export class TxlineSettlementVerifier implements SettlementVerifier {
  private readonly connection: Connection;
  private readonly program: Program;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: TxlineSettlementVerifierConfig) {
    this.connection = new Connection(cfg.rpcUrl, "confirmed");
    // validate_stat never signs — a keypair-less provider is sufficient for .view().
    const provider = new AnchorProvider(this.connection, {} as unknown as AnchorWallet, AnchorProvider.defaultOptions());
    // Anchor 0.32 derives Program.programId strictly from idl.address — but the
    // vendored IDL's baked address is TxLINE's MAINNET id regardless of which
    // network we're actually configured for. Override it to cfg.programId so the
    // constructed program identity always matches the network this verifier is
    // wired to (and therefore the daily_scores_roots PDA derived under
    // cfg.programId) — mixing them silently targets the wrong program.
    this.program = new Program({ ...cfg.idl, address: cfg.programId }, provider);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    // Accept-Encoding: identity — Bun's fetch can't decompress TxLINE's zstd; force plain.
    return { Authorization: `Bearer ${this.cfg.jwt}`, "X-Api-Token": this.cfg.apiToken, "Accept-Encoding": "identity" };
  }

  async verify(input: SettlementVerificationInput): Promise<SettlementVerificationResult> {
    const mapped = await this.cfg.fixtureMap.resolve(input.matchId);
    if (!mapped) return { verified: false, detail: "no TxLINE fixture mapping yet" };
    const { txlineFixtureId, participant1IsHome } = mapped;

    try {
      // 1. Independently confirm the match is TERMINAL on TxLINE and find the
      //    definitive Seq — never mint a proof off an in-play row, whatever the
      //    match-data provider claimed.
      const snapRes = await this.fetchImpl(
        `${this.cfg.apiBaseUrl}/api/scores/snapshot/${txlineFixtureId}?asOf=${Date.now()}`,
        { headers: this.headers() },
      );
      if (!snapRes.ok) return { verified: false, detail: `scores snapshot HTTP ${snapRes.status}` };
      const rows = (await snapRes.json()) as TxScoresEvent[] | null;
      const finalEvent = finalScoresEvent(Array.isArray(rows) ? rows : []);
      if (!finalEvent || finalEvent.Seq == null) {
        return { verified: false, detail: "match not terminal on TxLINE yet (no StatusId in {5,10,13})" };
      }

      // 2. Fetch the Merkle proof bundle for exactly that terminal event.
      const url =
        `${this.cfg.apiBaseUrl}/api/scores/stat-validation` +
        `?fixtureId=${txlineFixtureId}&seq=${finalEvent.Seq}&statKey=${STAT_KEY_P1_GOALS}&statKey2=${STAT_KEY_P2_GOALS}`;
      const res = await this.fetchImpl(url, { headers: this.headers() });
      if (!res.ok) return { verified: false, detail: `stat-validation HTTP ${res.status} (seq=${finalEvent.Seq})` };
      const bundle = (await res.json()) as StatValidationResponse;
      if (!isCompleteBundle(bundle)) {
        return { verified: false, detail: "proof bundle incomplete (root not posted yet)" };
      }

      // 3. Exact-score cross-check BEFORE the chain call. The on-chain predicate
      //    proves the goal DIFFERENCE; requiring goal-for-goal equality here is
      //    strictly stronger and catches a stale/mismatched reported score early.
      const proven = provenScore(bundle, participant1IsHome);
      if (proven.home !== input.score.home || proven.away !== input.score.away) {
        return {
          verified: false,
          detail: `score mismatch: reported ${input.score.home}-${input.score.away}, proof says ${proven.home}-${proven.away}`,
        };
      }

      // 4. The one trust-critical call: prove the diff on-chain via validate_stat.
      const reportedDiff = input.score.home - input.score.away;
      const { dailyScoresPda, args } = buildValidateStatArgs(bundle, participant1IsHome, reportedDiff, this.cfg.programId);

      // The vendored IDL is raw JSON, not codegen'd TS types, so `.methods` is an
      // untyped runtime namespace — cast at this one call site rather than losing
      // type safety across the whole adapter.
      type ValidateStatMethods = {
        validateStat: (...a: unknown[]) => {
          accounts: (acc: Record<string, unknown>) => { preInstructions: (ixs: unknown[]) => { view: () => Promise<boolean> } };
        };
      };
      const isValid: boolean = await (this.program.methods as unknown as ValidateStatMethods)
        .validateStat(...args)
        .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
        .view();

      return isValid
        ? { verified: true, detail: `validate_stat confirmed ${proven.home}-${proven.away} (seq=${finalEvent.Seq})` }
        : { verified: false, detail: "validate_stat rejected the predicate" };
    } catch (err) {
      // RPC error, malformed proof, root not yet available — all "not verified";
      // the Engine leaves the match unresolved and retries next tick.
      return { verified: false, detail: `verification error: ${(err as Error).message}` };
    }
  }
}
