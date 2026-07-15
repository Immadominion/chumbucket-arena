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

import { PrivyClient } from "@privy-io/node";
import { createSolanaKitSigner, type SolanaKitSigner } from "@privy-io/node/solana-kit";
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
import { getTransferCheckedInstruction, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Frost, Wallet } from "../domain/ids.ts";
import type { Custody, CustodyRef } from "./Custody.ts";

const USDC_DECIMALS = 6;
const SOL_GAS_FLOOR = 10_000_000n; // 0.01 SOL

export interface PrivyCustodyConfig {
  appId: string;
  appSecret: string;
  rpcUrl: string;
  rpcSubscriptionsUrl: string;
  usdcMint: string;
  /** Deterministic external_id for the Sessions Privy wallet. */
  sessionsExternalId?: string;
}

export class PrivyCustody implements Custody {
  private constructor(
    private readonly rpc: ReturnType<typeof createSolanaRpc>,
    private readonly sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
    private readonly signer: SolanaKitSigner,
    private readonly address: string,
    private readonly usdcMint: Address,
  ) {}

  /** Provision (get-or-create) the Sessions Privy wallet, then build the adapter. */
  static async create(cfg: PrivyCustodyConfig): Promise<PrivyCustody> {
    const privy = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
    const ext = cfg.sessionsExternalId ?? "gaffer_sessions";
    const w = await privy.wallets().create({
      chain_type: "solana",
      external_id: ext,
      idempotency_key: `gaffer:${ext}`,
    });

    const rpc = createSolanaRpc(cfg.rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(cfg.rpcSubscriptionsUrl);
    const signer = createSolanaKitSigner(privy, { walletId: w.id, address: address(w.address) });
    return new PrivyCustody(
      rpc,
      sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions }),
      signer,
      w.address,
      address(cfg.usdcMint),
    );
  }

  sessionsAddress(): string {
    return this.address;
  }

  /** Identical to SolanaCustody — read-only on-chain verification, no signing. */
  async confirmDeposit(wallet: Wallet, amount: Frost, proof?: string): Promise<CustodyRef> {
    if (!proof) throw new Error("on-chain deposit requires a proof (the USDC transfer's tx signature)");
    const tx = await this.rpc
      .getTransaction(proof as Parameters<typeof this.rpc.getTransaction>[0], {
        maxSupportedTransactionVersion: 0,
        encoding: "jsonParsed",
      })
      .send();
    if (!tx || tx.meta?.err) throw new Error(`deposit tx ${proof} did not finalise successfully`);
    const pre = tx.meta?.preTokenBalances ?? [];
    const post = tx.meta?.postTokenBalances ?? [];
    const deltaFor = (owner: string): bigint => {
      const before = pre.find((b) => b.owner === owner)?.uiTokenAmount.amount ?? "0";
      const after = post.find((b) => b.owner === owner)?.uiTokenAmount.amount ?? "0";
      return BigInt(after) - BigInt(before);
    };
    if (deltaFor(this.address) < amount) {
      throw new Error(`deposit tx ${proof} does not credit ${amount} FROST of USDC to the Sessions wallet`);
    }
    if (deltaFor(wallet) >= 0n) throw new Error(`deposit tx ${proof} did not move USDC out of ${wallet}`);
    return { ref: proof };
  }

  /** Pay `amount` FROST of USDC from the Sessions wallet to the player — Privy-signed. */
  async withdraw(wallet: Wallet, amount: Frost): Promise<CustodyRef> {
    const { sol, usdc } = await this.balances();
    if (usdc < amount) {
      throw new Error("Withdrawals are temporarily paused — the Sessions wallet float is being topped up. Try again shortly.");
    }
    if (sol < SOL_GAS_FLOOR) {
      throw new Error("Withdrawals are temporarily paused — the Sessions wallet is low on gas. Try again shortly.");
    }
    const [sourceAta] = await findAssociatedTokenPda({
      mint: this.usdcMint,
      owner: address(this.address),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destAta] = await findAssociatedTokenPda({
      mint: this.usdcMint,
      owner: address(wallet),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const transferIx = getTransferCheckedInstruction({
      source: sourceAta,
      mint: this.usdcMint,
      destination: destAta,
      authority: this.signer,
      amount,
      decimals: USDC_DECIMALS,
    });
    const { value: latestBlockhash } = await this.rpc.getLatestBlockhash().send();
    const message = appendTransactionMessageInstructions(
      [transferIx],
      setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        setTransactionMessageFeePayerSigner(this.signer, createTransactionMessage({ version: 0 })),
      ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(signed);
    await this.sendAndConfirm(signed, { commitment: "confirmed" });
    return { ref: getSignatureFromTransaction(signed) };
  }

  /** Ops helper (not part of the port): current Sessions balances in base units. */
  async balances(): Promise<{ sol: bigint; usdc: bigint }> {
    const [solBalance, [sessionsAta]] = await Promise.all([
      this.rpc.getBalance(address(this.address)).send(),
      findAssociatedTokenPda({ mint: this.usdcMint, owner: address(this.address), tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    ]);
    const usdcBalance = await this.rpc
      .getTokenAccountBalance(sessionsAta)
      .send()
      .catch(() => ({ value: { amount: "0" } }));
    return { sol: solBalance.value, usdc: BigInt(usdcBalance.value.amount) };
  }
}
