/**
 * Privy MPC custody — the Sessions wallet's key never exists as a raw secret.
 *
 * Where SolanaCustody loads a keypair signer from an env var (the #1 production
 * risk), here the Sessions wallet is a Privy server wallet and outbound payouts
 * are signed via Privy's native Solana signer — the key is held in Privy's MPC,
 * never in our process or environment. Deposit verification is byte-for-byte the
 * same as SolanaCustody (read-only chain reads, no signing); only the *signing*
 * seam differs.
 *
 * Unlike Sui (which needed a hand-rolled Signer subclass doing manual BLAKE2b
 * intent-digest signing — see git history), Solana is a Privy "native" chain:
 * `@privy-io/node/solana-kit`'s `createSolanaKitSigner` returns a real
 * `@solana/kit` KeyPairSigner-shaped signer directly. This adapter is
 * meaningfully simpler than its Sui predecessor as a result.
 */
import type { Frost, Wallet } from "../domain/ids";
import type { Custody, CustodyRef } from "./Custody";
export interface PrivyCustodyConfig {
    appId: string;
    appSecret: string;
    rpcUrl: string;
    rpcSubscriptionsUrl: string;
    usdcMint: string;
    /** Deterministic external_id for the Sessions Privy wallet. */
    sessionsExternalId?: string;
}
export declare class PrivyCustody implements Custody {
    private readonly rpc;
    private readonly sendAndConfirm;
    private readonly signer;
    private readonly address;
    private readonly usdcMint;
    private constructor();
    /** Provision (get-or-create) the Sessions Privy wallet, then build the adapter. */
    static create(cfg: PrivyCustodyConfig): Promise<PrivyCustody>;
    sessionsAddress(): string;
    /** Identical to SolanaCustody — read-only on-chain verification, no signing. */
    confirmDeposit(wallet: Wallet, amount: Frost, proof?: string): Promise<CustodyRef>;
    /** Pay `amount` FROST of USDC from the Sessions wallet to the player — Privy-signed. */
    withdraw(wallet: Wallet, amount: Frost): Promise<CustodyRef>;
    /** Ops helper (not part of the port): current Sessions balances in base units. */
    balances(): Promise<{
        sol: bigint;
        usdc: bigint;
    }>;
}
