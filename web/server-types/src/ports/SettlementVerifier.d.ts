/**
 * SettlementVerifier — the on-chain truth check before a match's score is
 * trusted for payout. `Engine.resolveMatch()` calls this once per finished
 * fixture, right after MatchDataProvider reports a final score and right
 * before parimutuel settlement math runs. A `verified: false` result means
 * "not yet resolvable" — Engine leaves the match as-is and retries on the
 * next tick; it must never fall through to settleMarket() on unverified data.
 *
 * The real adapter (TxlineSettlementVerifier) CPIs into TxLINE's read-only
 * `validate_stat` view instruction: it fetches a Merkle proof bundle from
 * TxLINE's REST API, maps it onto the Anchor IDL argument shapes, and
 * simulates the call (no signature, no state change). The stub always
 * verifies as configured, for tests and demo without a live devnet dependency.
 */
import type { MatchId } from "../domain/ids";
export interface SettlementVerificationInput {
    matchId: MatchId;
    /** TxLINE's numeric fixture id for this match, if known yet. */
    txlineFixtureId: number;
    /** The final score MatchDataProvider reported, to be corroborated on-chain. */
    score: {
        home: number;
        away: number;
    };
}
export interface SettlementVerificationResult {
    verified: boolean;
    /** Diagnostic only — never used for control flow, safe to log/expose in /health. */
    detail?: string;
}
export interface SettlementVerifier {
    /**
     * Prove the reported score against TxLINE's on-chain Merkle roots. Returns
     * `{ verified: false }` — never throws — for "not yet available" conditions
     * (root not posted yet, proof bundle not ready, no fixture mapping) so the
     * caller can cleanly retry next tick.
     */
    verify(input: SettlementVerificationInput): Promise<SettlementVerificationResult>;
}
/**
 * Deterministic stand-in for tests and any deployment without TxLINE
 * configured. Defaults to `true` so existing settlement behaviour is
 * unchanged when no on-chain verifier is wired up; per-match overrides let
 * tests exercise the "not yet verified" retry path deliberately.
 */
export declare class StubSettlementVerifier implements SettlementVerifier {
    private readonly defaultVerified;
    private readonly overrides;
    constructor(defaultVerified?: boolean);
    setVerified(matchId: MatchId, verified: boolean): void;
    verify(input: SettlementVerificationInput): Promise<SettlementVerificationResult>;
}
