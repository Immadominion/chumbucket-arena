/**
 * Custody — the money seam. The in-app balance/Pots are a pure event-sourced
 * ledger; real USDC only crosses the chain on deposit and withdraw. This port
 * is the *only* place that knows whether stakes are real USDC settled by the
 * dedicated Sessions wallet, or a play-money season token.
 *
 *   - PlayLedgerCustody: no chain. Deposits are granted, withdrawals are notional.
 *                        Runs the whole game end-to-end with zero on-chain risk.
 *   - SolanaCustody:     real USDC via the Sessions wallet on Solana. Verifies
 *                        inbound deposits and signs outbound payouts. The
 *                        Sessions wallet key never leaves this adapter.
 */
import type { Frost, Wallet } from "../domain/ids";
export interface CustodyRef {
    ref: string;
}
export interface Custody {
    /** The dedicated Sessions wallet address (a hackathon requirement). */
    sessionsAddress(): string;
    /**
     * Confirm an inbound deposit (player → Sessions wallet). For real USDC this
     * verifies the on-chain transfer (identified by `proof`); for play money it
     * simply grants the credit.
     */
    confirmDeposit(wallet: Wallet, amount: Frost, proof?: string): Promise<CustodyRef>;
    /** Execute a withdrawal (Sessions wallet → player). */
    withdraw(wallet: Wallet, amount: Frost): Promise<CustodyRef>;
}
export declare class PlayLedgerCustody implements Custody {
    private readonly address;
    constructor(address?: string);
    sessionsAddress(): string;
    confirmDeposit(_wallet: Wallet, _amount: Frost, _proof?: string): Promise<CustodyRef>;
    withdraw(_wallet: Wallet, _amount: Frost): Promise<CustodyRef>;
}
export interface SolanaCustodyConfig {
    rpcUrl: string;
    rpcSubscriptionsUrl: string;
    sessionsAddress: string;
    sessionsKey: string;
    usdcMint: string;
}
export declare class SolanaCustody implements Custody {
    private readonly rpc;
    private readonly sendAndConfirm;
    private readonly signer;
    private readonly address;
    private readonly usdcMint;
    private constructor();
    /** Async factory — Kit's keypair loading is async, unlike the Sui SDK's. */
    static create(cfg: SolanaCustodyConfig): Promise<SolanaCustody>;
    sessionsAddress(): string;
    /**
     * Verify a player's inbound USDC deposit. `proof` is the signature of the
     * transfer the player (or their embedded wallet) submitted to the Sessions
     * wallet's USDC associated token account. We confirm on-chain that it
     * finalised successfully and moved at least `amount` USDC INTO the Sessions
     * ATA from the *player's own* ATA — so one player can't credit themselves
     * with another's deposit signature. The signature is returned as the ref;
     * the actor dedups it per player against replay.
     */
    confirmDeposit(wallet: Wallet, amount: Frost, proof?: string): Promise<CustodyRef>;
    /** Pay `amount` FROST of USDC from the Sessions wallet to the player. */
    withdraw(wallet: Wallet, amount: Frost): Promise<CustodyRef>;
    /** Ops helper (not part of the port): current Sessions balances in base units. */
    balances(): Promise<{
        sol: bigint;
        usdc: bigint;
    }>;
}
