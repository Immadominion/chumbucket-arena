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
    private trySweepRake;
}
