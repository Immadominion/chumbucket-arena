/**
 * Arena reconciler — the pull-based backstop that makes the social read model
 * chain-authoritative rather than dependent on the mobile app mirroring
 * signatures (or the Helius webhook firing). It walks chumbucket_arena's
 * transaction history forward from a durable cursor and, for each instruction:
 *
 *   place_call  -> confirm the mobile-mirrored position (PENDING -> OPEN), or
 *                  CREATE it from chain state if the app never mirrored it;
 *   settle_pot  -> settle every open position for the pot from ON-CHAIN Pot
 *                  state (winning bucket + parimutuel distributable/winners),
 *                  write the settlement receipt, stats, and claim notifications;
 *   claim       -> mark the position CLAIMED.
 *
 * Robustness contract:
 *   - Every DB write is idempotent (unique keys + status-gated transitions), so
 *     re-processing a signature — after a crash, a retry, or a chain reorg
 *     replaying the same tx — changes nothing.
 *   - The cursor only advances through a *contiguous* run of processed
 *     signatures. A transient RPC/DB error (or a not-yet-available tx) stops the
 *     advance, so the next pass resumes from exactly there instead of skipping.
 *   - Failed transactions (meta.err) are walked past but never applied.
 *   - Pot lookups are cached per pass (many place_calls share one pot).
 *
 * The chain access sits behind ArenaChainSource so the orchestration/money logic
 * is unit-testable against fakes; SolanaArenaChainSource is the production impl.
 */
import type { SocialStore } from "../social/SocialStore";
import { type ParsedArenaInstruction } from "./ArenaInstructionParser";
export interface SignatureRef {
    signature: string;
    slot: number;
    err: boolean;
}
export interface ArenaTx {
    /** true when the on-chain tx itself reverted — walked past, never applied. */
    err: boolean;
    instructions: ParsedArenaInstruction[];
}
export interface PotState {
    matchId: string;
    fixtureId: number;
    winningBucket: number;
    status: number;
    distributable: string;
    winnersStake: string;
}
/** The chain reads the reconciler needs, injectable for tests. */
export interface ArenaChainSource {
    /** The full delta of signatures strictly newer than `until`, newest-first. */
    signaturesSince(until: string | undefined): Promise<SignatureRef[]>;
    /** Parsed arena instructions for a signature; null when not available yet. */
    loadTx(signature: string): Promise<ArenaTx | null>;
    /** Decoded Pot account state, or undefined if it can't be read. */
    loadPot(potAddress: string): Promise<PotState | undefined>;
}
export interface ReconcileSummary {
    scanned: number;
    applied: number;
    placeCalls: number;
    created: number;
    settlements: number;
    claims: number;
    failedTxSkipped: number;
    errors: number;
    advancedTo?: string;
    stoppedEarly: boolean;
}
export declare class ArenaReconciler {
    private readonly social;
    private readonly source;
    private readonly maxPerPass;
    /** Per-signature null-fetch counters (in-memory; bounds the wedge in finding [4]). */
    private readonly nullRetries;
    constructor(social: SocialStore, source: ArenaChainSource, maxPerPass?: number);
    reconcile(): Promise<ReconcileSummary>;
    private processSignature;
    private applyPlaceCall;
    private applySettle;
    private applyClaim;
    private getPot;
}
export interface ArenaChainSourceConfig {
    rpcUrl: string;
    programId: string;
}
export declare class SolanaArenaChainSource implements ArenaChainSource {
    private readonly connection;
    private readonly program;
    private readonly programId;
    private readonly programIdStr;
    constructor(cfg: ArenaChainSourceConfig);
    signaturesSince(until: string | undefined): Promise<SignatureRef[]>;
    loadTx(signature: string): Promise<ArenaTx | null>;
    loadPot(potAddress: string): Promise<PotState | undefined>;
}
/** ASCII bytes of the fixture id, left-padded to 32 — strip the zero padding. */
export declare function decodeMatchId(bytes: number[] | undefined): string;
