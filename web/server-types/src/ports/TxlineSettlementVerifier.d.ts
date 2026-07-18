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
import { PublicKey } from "@solana/web3.js";
import { type Idl } from "@coral-xyz/anchor";
import type { MatchId } from "../domain/ids";
import type { SettlementVerificationInput, SettlementVerificationResult, SettlementVerifier } from "./SettlementVerifier";
export interface FixtureIdMap {
    resolve(matchId: MatchId): Promise<{
        txlineFixtureId: number;
        participant1IsHome: boolean;
    } | undefined>;
}
export interface TxlineSettlementVerifierConfig {
    rpcUrl: string;
    programId: string;
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
        updateStats: {
            updateCount: number;
            minTimestamp: number;
            maxTimestamp: number;
        };
        eventStatsSubTreeRoot: number[];
    };
    subTreeProof?: ProofNode[];
    mainTreeProof?: ProofNode[];
    eventStatRoot?: number[];
    statProof?: ProofNode[];
    statProof2?: ProofNode[];
}
/** A completeness gate the raw response must pass before we touch the chain. */
export declare function isCompleteBundle(v: StatValidationResponse): v is Required<StatValidationResponse>;
/** The proof's own final score, oriented home/away. Pure — unit-tested. */
export declare function provenScore(v: Required<Pick<StatValidationResponse, "statToProve" | "statToProve2">>, participant1IsHome: boolean): {
    home: number;
    away: number;
};
/**
 * Map the REST bundle onto validate_stat's Anchor argument shapes — one-for-one
 * with the proven lock-and-settle.ts call. Pure (throws on malformed bytes) so
 * the mapping itself is unit-testable without a network.
 */
export declare function buildValidateStatArgs(v: Required<StatValidationResponse>, participant1IsHome: boolean, reportedDiff: number, programId: string): {
    targetTs: number;
    dailyScoresPda: PublicKey;
    args: unknown[];
};
export declare class TxlineSettlementVerifier implements SettlementVerifier {
    private readonly cfg;
    private readonly connection;
    private readonly program;
    private readonly fetchImpl;
    constructor(cfg: TxlineSettlementVerifierConfig);
    private headers;
    verify(input: SettlementVerificationInput): Promise<SettlementVerificationResult>;
}
export {};
