/**
 * Deposit gateway — turns "USDC arrived in a player's Privy wallet" into a
 * credited ledger balance, the custodial way.
 *
 * A player's deposit address is their own Privy (server-custodied) Solana
 * wallet. They send USDC to it from anywhere; this sweeps that USDC into the
 * central Sessions float (signed by the player's Privy wallet via Privy's
 * native Solana signer) so the float can back withdrawals, and returns the
 * sweep tx signatures + amounts for the engine to credit. The sweep tx moves
 * USDC *out of the player's wallet into Sessions*, so the existing
 * SolanaCustody/PrivyCustody.confirmDeposit verification accepts the
 * signature unchanged.
 *
 * Robustness:
 *  - **Idempotent.** Each credit is keyed by the sweep tx signature; the player
 *    actor's replay guard credits a signature at most once.
 *  - **Reconciled.** Every call first re-collects recent player→Sessions USDC
 *    transfers, so a sweep that executed but crashed before crediting is healed on
 *    the next attempt (the signature is re-presented; already-credited ones no-op).
 *  - **Gas-safe.** A fresh player wallet has no SOL for fees/rent, so the Sessions
 *    wallet tops it up before the sweep; the top-up dust stays for the next sweep.
 */
export interface DepositCredit {
    signature: string;
    amount: bigint;
}
export interface PrivyPlayer {
    address: string;
    walletId: string;
}
/** The capability the Engine depends on — sweep + reconcile a player's deposits. */
export interface DepositGateway {
    collect(player: PrivyPlayer): Promise<DepositCredit[]>;
}
export interface PrivyDepositGatewayConfig {
    appId: string;
    appSecret: string;
    rpcUrl: string;
    rpcSubscriptionsUrl: string;
    usdcMint: string;
    sessionsExternalId?: string;
}
export declare class PrivyDepositGateway {
    private readonly rpc;
    private readonly sendAndConfirm;
    private readonly privy;
    private readonly sessionsSigner;
    private readonly sessionsAddress;
    private readonly usdcMint;
    private constructor();
    static create(cfg: PrivyDepositGatewayConfig): Promise<PrivyDepositGateway>;
    /**
     * Collect everything depositable for a player: recent (possibly uncredited)
     * sweeps plus a fresh sweep of whatever USDC is sitting in their wallet now.
     * Never throws on a single failure mid-batch — returns what it could collect.
     */
    collect(player: PrivyPlayer): Promise<DepositCredit[]>;
    /** Top the player's wallet up with SOL if it can't cover a sweep's fees/rent. */
    private ensureGas;
    /** Move all the player's USDC into the Sessions wallet; returns the tx signature. */
    private sweep;
}
