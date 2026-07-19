/**
 * On-chain keeper — drives chumbucket_arena's admin/permissionless instructions
 * (create_pot / lock_pot / settle_pot / sweep_rake) on devnet against the SAME
 * TxLINE fixtures the backend already tracks (via readModel.pots, fed by
 * TxlineMatchData). This is a NET-NEW, separate money path — it never reads
 * from or writes to the custodial Engine's off-chain ledger (deposit/withdraw/
 * makeCall/createChallenge/acceptChallenge stay exactly as they are).
 *
 * Mirrors the proven devnet lifecycle scripts byte-for-byte where it matters:
 *   onchain/gaffer_verifier/scripts/devnet-lifecycle/init-and-create-pot.ts  (connection/provider setup, matchIdBytes, create_pot accounts)
 *   onchain/gaffer_verifier/scripts/devnet-lifecycle/lock-and-settle.ts      (finished-match scan, proof fetch, settle_pot/sweep_rake accounts)
 * The settlement proof fetch + Anchor argument mapping is adapted directly from
 * TxlineSettlementVerifier.buildValidateStatArgs — chumbucket_arena's settle_pot
 * takes the same fixture_summary/fixture_proof/main_tree_proof/stat_home/stat_away
 * shapes as TxLINE's validate_stat (it just bakes the predicate from
 * winning_bucket instead of taking one as an argument), so that mapping is reused
 * as-is rather than re-derived.
 */
import { PublicKey } from "@solana/web3.js";
import type { App } from "../app";
import type { OnchainKeeperConfig } from "../config";
/**
 * ASCII bytes of `label`, LEFT-padded with zeros to exactly 32 bytes — byte-exact
 * with onchain/…/devnet-lifecycle/init-and-create-pot.ts's matchIdBytes(). The
 * backend's MatchId for a TxLINE fixture is the numeric fixture id as a string
 * (see TxlineMatchData.toFixture: `asMatchId(String(f.FixtureId))`).
 */
export declare function matchIdBytes(label: string): Buffer;
export declare function derivePdas(programId: PublicKey, matchId: Buffer): {
    configPda: PublicKey;
    potPda: PublicKey;
    vaultPda: PublicKey;
};
export declare class OnchainKeeper {
    private readonly app;
    private readonly cfg;
    private readonly connection;
    private readonly provider;
    private readonly program;
    private readonly keeper;
    private readonly programId;
    constructor(app: App, cfg: OnchainKeeperConfig);
    private headers;
    private ensureConfig;
    /**
     * One pass over every TxLINE-backed match the backend knows: open a Pot if
     * one doesn't exist yet, lock it once kickoff has passed, settle it once the
     * match is finished and a proof is available, sweep house rake off settled
     * pots. Safe to call on a timer — every step is idempotent / re-checks
     * on-chain state first.
     */
    tick(): Promise<void>;
    private tryCreatePot;
    private tryLockPot;
    private trySettlePot;
    /**
     * Fetch + map the TxLINE proof for a finished fixture into the shapes both
     * settle_pot and settle_market take (identical proof; only the predicate the
     * program bakes differs). Returns null (with a log) if the match isn't terminal
     * or the proof root isn't posted yet — the tick just retries next pass. Mirrors
     * trySettlePot's steps 1-3 exactly.
     */
    private fetchSettlementArgs;
    /**
     * Open a line-market pot AND attach its MarketSpec in ONE atomic transaction,
     * so a line pot never exists without the spec that lets settle_market run. The
     * spec fixes the predicate (op, line, stat leaves) on-chain before any calls, so
     * a permissionless settler can never change the line. Goals/full-time only for
     * now — that's the stat binding we've verified against a real proof.
     */
    private tryCreateLinePot;
    /**
     * Settle a locked line-market pot via settle_market: same proof as settle_pot,
     * winning bucket (OVER/UNDER) computed from the proven score by the same
     * resolveLine the read model uses. The on-chain predicate (from the MarketSpec)
     * re-proves it — a mismatch would just be rejected, never mis-settle.
     */
    private trySettleMarket;
    private trySweepRake;
}
