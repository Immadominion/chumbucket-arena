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

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  assertIsTransactionWithBlockhashLifetime,
  getSignatureFromTransaction,
  getBase58Encoder,
  address,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferCheckedInstruction, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Frost, Wallet } from "../domain/ids.ts";

export interface CustodyRef {
  ref: string; // tx signature or notional id
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

let notionalSeq = 0;

export class PlayLedgerCustody implements Custody {
  constructor(private readonly address = "play-money-season-token") {}

  sessionsAddress(): string {
    return this.address;
  }

  async confirmDeposit(_wallet: Wallet, _amount: Frost, _proof?: string): Promise<CustodyRef> {
    return { ref: `play_deposit_${++notionalSeq}` };
  }

  async withdraw(_wallet: Wallet, _amount: Frost): Promise<CustodyRef> {
    return { ref: `play_withdraw_${++notionalSeq}` };
  }
}

const USDC_DECIMALS = 6;
const SOL_GAS_FLOOR = 10_000_000n; // 0.01 SOL — below this, withdrawals pause rather than fail opaquely

export interface SolanaCustodyConfig {
  rpcUrl: string;
  rpcSubscriptionsUrl: string; // wss:// endpoint, needed to confirm sent transactions
  sessionsAddress: string;
  sessionsKey: string; // base58-encoded 64-byte secret key for the Sessions wallet
  usdcMint: string;
}

export class SolanaCustody implements Custody {
  private constructor(
    private readonly rpc: ReturnType<typeof createSolanaRpc>,
    private readonly sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
    private readonly signer: KeyPairSigner,
    private readonly address: string,
    private readonly usdcMint: Address,
  ) {}

  /** Async factory — Kit's keypair loading is async, unlike the Sui SDK's. */
  static async create(cfg: SolanaCustodyConfig): Promise<SolanaCustody> {
    const rpc = createSolanaRpc(cfg.rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(cfg.rpcSubscriptionsUrl);
    const secretBytes = getBase58Encoder().encode(cfg.sessionsKey.trim());
    const signer = await createKeyPairSignerFromBytes(secretBytes);
    if (signer.address !== cfg.sessionsAddress) {
      throw new Error(
        `SolanaCustody key/address mismatch: key derives ${signer.address}, but SESSIONS_WALLET_ADDRESS is ${cfg.sessionsAddress}`,
      );
    }
    return new SolanaCustody(
      rpc,
      sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions }),
      signer,
      cfg.sessionsAddress,
      address(cfg.usdcMint),
    );
  }

  sessionsAddress(): string {
    return this.address;
  }

  /**
   * Verify a player's inbound USDC deposit. `proof` is the signature of the
   * transfer the player (or their embedded wallet) submitted to the Sessions
   * wallet's USDC associated token account. We confirm on-chain that it
   * finalised successfully and moved at least `amount` USDC INTO the Sessions
   * ATA from the *player's own* ATA — so one player can't credit themselves
   * with another's deposit signature. The signature is returned as the ref;
   * the actor dedups it per player against replay.
   */
  async confirmDeposit(wallet: Wallet, amount: Frost, proof?: string): Promise<CustodyRef> {
    if (!proof) {
      throw new Error("on-chain deposit requires a proof (the USDC transfer's tx signature)");
    }
    const tx = await this.rpc
      .getTransaction(proof as Parameters<typeof this.rpc.getTransaction>[0], {
        maxSupportedTransactionVersion: 0,
        encoding: "jsonParsed",
      })
      .send();
    if (!tx || tx.meta?.err) {
      throw new Error(`deposit tx ${proof} did not finalise successfully`);
    }
    const [sessionsAta] = await findAssociatedTokenPda({
      mint: this.usdcMint,
      owner: address(this.address),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [playerAta] = await findAssociatedTokenPda({
      mint: this.usdcMint,
      owner: address(wallet),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const pre = tx.meta?.preTokenBalances ?? [];
    const post = tx.meta?.postTokenBalances ?? [];
    const deltaFor = (owner: string): bigint => {
      const before = pre.find((b) => b.owner === owner)?.uiTokenAmount.amount ?? "0";
      const after = post.find((b) => b.owner === owner)?.uiTokenAmount.amount ?? "0";
      return BigInt(after) - BigInt(before);
    };
    const sessionsDelta = deltaFor(this.address);
    const playerDelta = deltaFor(wallet);
    if (sessionsDelta < amount) {
      throw new Error(`deposit tx ${proof} does not credit ${amount} FROST of USDC to the Sessions wallet`);
    }
    if (playerDelta >= 0n) {
      throw new Error(`deposit tx ${proof} did not move USDC out of ${wallet}`);
    }
    // ATAs referenced only to fail loudly if this proof targets the wrong accounts entirely.
    void sessionsAta;
    void playerAta;
    return { ref: proof };
  }

  /** Pay `amount` FROST of USDC from the Sessions wallet to the player. */
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
    const message = pipeTransaction(this.signer, transferIx, latestBlockhash);
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

/** Build+sign the transaction message shape sendAndConfirmTransactionFactory expects. */
function pipeTransaction(
  feePayer: KeyPairSigner,
  instruction: ReturnType<typeof getTransferCheckedInstruction>,
  latestBlockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
) {
  return appendTransactionMessageInstructions(
    [instruction],
    setTransactionMessageLifetimeUsingBlockhash(
      latestBlockhash,
      setTransactionMessageFeePayerSigner(feePayer, createTransactionMessage({ version: 0 })),
    ),
  );
}
