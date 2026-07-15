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

import { PrivyClient } from "@privy-io/node";
import { createSolanaKitSigner } from "@privy-io/node/solana-kit";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  assertIsTransactionWithBlockhashLifetime,
  getSignatureFromTransaction,
  address,
  type Address,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getTransferCheckedInstruction, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

const USDC_DECIMALS = 6;
const GAS_MIN = 5_000_000n; // 0.005 SOL — below this, top the player wallet up
const GAS_TOPUP = 10_000_000n; // 0.01 SOL sent for rent + fees (dust stays for next time)

export interface DepositCredit {
  signature: string; // the sweep tx — also the custody proof
  amount: bigint; // USDC (FROST) swept into Sessions
}

export interface PrivyPlayer {
  address: string; // the player's Privy Solana wallet = their deposit address
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

export class PrivyDepositGateway {
  private constructor(
    private readonly rpc: ReturnType<typeof createSolanaRpc>,
    private readonly sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
    private readonly privy: PrivyClient,
    private readonly sessionsSigner: ReturnType<typeof createSolanaKitSigner>,
    private readonly sessionsAddress: string,
    private readonly usdcMint: Address,
  ) {}

  static async create(cfg: PrivyDepositGatewayConfig): Promise<PrivyDepositGateway> {
    const privy = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
    const ext = cfg.sessionsExternalId ?? "gaffer_sessions";
    const s = await privy.wallets().create({
      chain_type: "solana",
      external_id: ext,
      idempotency_key: `gaffer:${ext}`,
    });
    const rpc = createSolanaRpc(cfg.rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(cfg.rpcSubscriptionsUrl);
    const sessionsSigner = createSolanaKitSigner(privy, { walletId: s.id, address: address(s.address) });
    return new PrivyDepositGateway(
      rpc,
      sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions }),
      privy,
      sessionsSigner,
      s.address,
      address(cfg.usdcMint),
    );
  }

  /**
   * Collect everything depositable for a player: recent (possibly uncredited)
   * sweeps plus a fresh sweep of whatever USDC is sitting in their wallet now.
   * Never throws on a single failure mid-batch — returns what it could collect.
   */
  async collect(player: PrivyPlayer): Promise<DepositCredit[]> {
    const credits: DepositCredit[] = [];
    const [playerAta] = await findAssociatedTokenPda({
      mint: this.usdcMint,
      owner: address(player.address),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    // 1. Reconcile: recent USDC transfers player → Sessions (heal crashed credits).
    try {
      const recent = await this.rpc.getSignaturesForAddress(playerAta, { limit: 25 }).send();
      for (const sig of recent) {
        const tx = await this.rpc
          .getTransaction(sig.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" })
          .send();
        if (!tx || tx.meta?.err) continue;
        const pre = tx.meta?.preTokenBalances ?? [];
        const post = tx.meta?.postTokenBalances ?? [];
        const before = pre.find((b) => b.owner === this.sessionsAddress)?.uiTokenAmount.amount ?? "0";
        const after = post.find((b) => b.owner === this.sessionsAddress)?.uiTokenAmount.amount ?? "0";
        const delta = BigInt(after) - BigInt(before);
        if (delta > 0n) credits.push({ signature: sig.signature, amount: delta });
      }
    } catch (err) {
      console.error("[deposit] reconcile query failed:", err);
    }

    // 2. Sweep whatever USDC is in the player's wallet right now.
    try {
      const bal = await this.rpc
        .getTokenAccountBalance(playerAta)
        .send()
        .catch(() => ({ value: { amount: "0" } }));
      const usdcBal = BigInt(bal.value.amount);
      if (usdcBal > 0n) {
        await this.ensureGas(player.address);
        const signature = await this.sweep(player, usdcBal, playerAta);
        if (signature) credits.push({ signature, amount: usdcBal });
      }
    } catch (err) {
      console.error("[deposit] sweep failed:", err);
    }

    // De-dup by signature (the reconcile + fresh sweep can't overlap, but be safe).
    const seen = new Set<string>();
    return credits.filter((c) => (seen.has(c.signature) ? false : (seen.add(c.signature), true)));
  }

  /** Top the player's wallet up with SOL if it can't cover a sweep's fees/rent. */
  private async ensureGas(playerAddress: string): Promise<void> {
    const sol = (await this.rpc.getBalance(address(playerAddress)).send()).value;
    if (sol >= GAS_MIN) return;
    const transferIx = getTransferSolInstruction({
      source: this.sessionsSigner,
      destination: address(playerAddress),
      amount: GAS_TOPUP,
    });
    const { value: latestBlockhash } = await this.rpc.getLatestBlockhash().send();
    const message = appendTransactionMessageInstructions(
      [transferIx],
      setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        setTransactionMessageFeePayerSigner(this.sessionsSigner, createTransactionMessage({ version: 0 })),
      ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(signed);
    await this.sendAndConfirm(signed, { commitment: "confirmed" });
  }

  /** Move all the player's USDC into the Sessions wallet; returns the tx signature. */
  private async sweep(player: PrivyPlayer, amount: bigint, playerAta: Address): Promise<string | null> {
    const playerSigner = createSolanaKitSigner(this.privy, { walletId: player.walletId, address: address(player.address) });
    const [sessionsAta] = await findAssociatedTokenPda({
      mint: this.usdcMint,
      owner: address(this.sessionsAddress),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const transferIx = getTransferCheckedInstruction({
      source: playerAta,
      mint: this.usdcMint,
      destination: sessionsAta,
      authority: playerSigner,
      amount,
      decimals: USDC_DECIMALS,
    });
    const { value: latestBlockhash } = await this.rpc.getLatestBlockhash().send();
    const message = appendTransactionMessageInstructions(
      [transferIx],
      setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        setTransactionMessageFeePayerSigner(playerSigner, createTransactionMessage({ version: 0 })),
      ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(signed);
    await this.sendAndConfirm(signed, { commitment: "confirmed" });
    return getSignatureFromTransaction(signed);
  }
}
