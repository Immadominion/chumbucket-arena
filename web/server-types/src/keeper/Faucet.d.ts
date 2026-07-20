/**
 * Devnet test-USDC faucet. Mints the program's pinned USDC mint (our custom
 * devnet test mint — NOT Circle's) to any wallet on demand, so judges and
 * testers can fund themselves and actually place a bet, instead of us minting by
 * hand. The mint authority is the same admin/keeper keypair the on-chain keeper
 * already holds. Devnet only: this is play-money test USDC with no real value.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
export interface FaucetResult {
    funded: boolean;
    balanceUsdc: number;
    mint: string;
    signature?: string;
}
export declare class Faucet {
    private readonly authority;
    private readonly mint;
    /** How much to grant per top-up. */
    private readonly grantUsdc;
    /** Skip minting if the wallet already holds at least this much. */
    private readonly topUpBelowUsdc;
    /** Per-wallet spam guard. */
    private readonly cooldownMs;
    private readonly connection;
    private readonly lastRequest;
    constructor(rpcUrl: string, authority: Keypair, mint: PublicKey, 
    /** How much to grant per top-up. */
    grantUsdc?: number, 
    /** Skip minting if the wallet already holds at least this much. */
    topUpBelowUsdc?: number, 
    /** Per-wallet spam guard. */
    cooldownMs?: number);
    /**
     * Mint test USDC to `wallet` (creating its token account first if needed).
     * No-op if the wallet already holds >= topUpBelow, so repeated taps don't
     * stack up. Rate-limited per wallet. Returns the resulting balance.
     */
    fund(wallet: string): Promise<FaucetResult>;
}
