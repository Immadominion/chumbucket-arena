/**
 * Devnet test-USDC faucet. Mints the program's pinned USDC mint (our custom
 * devnet test mint — NOT Circle's) to any wallet on demand, so judges and
 * testers can fund themselves and actually place a bet, instead of us minting by
 * hand. The mint authority is the same admin/keeper keypair the on-chain keeper
 * already holds. Devnet only: this is play-money test USDC with no real value.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const USDC_DECIMALS = 6;

export interface FaucetResult {
  funded: boolean; // false = already had enough, nothing minted
  balanceUsdc: number; // resulting balance
  mint: string;
  signature?: string; // present only when a mint actually happened
}

export class Faucet {
  private readonly connection: Connection;
  private readonly lastRequest = new Map<string, number>();

  constructor(
    rpcUrl: string,
    private readonly authority: Keypair,
    private readonly mint: PublicKey,
    /** How much to grant per top-up. */
    private readonly grantUsdc = 100,
    /** Skip minting if the wallet already holds at least this much. */
    private readonly topUpBelowUsdc = 25,
    /** Per-wallet spam guard. */
    private readonly cooldownMs = 20_000,
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
  }

  /**
   * Mint test USDC to `wallet` (creating its token account first if needed).
   * No-op if the wallet already holds >= topUpBelow, so repeated taps don't
   * stack up. Rate-limited per wallet. Returns the resulting balance.
   */
  async fund(wallet: string): Promise<FaucetResult> {
    let owner: PublicKey;
    try {
      owner = new PublicKey(wallet);
    } catch {
      throw new Error("That doesn't look like a valid wallet address.");
    }

    const now = Date.now();
    const last = this.lastRequest.get(wallet) ?? 0;
    if (now - last < this.cooldownMs) {
      throw new Error("Just a moment — you already requested test USDC. Try again in a few seconds.");
    }
    this.lastRequest.set(wallet, now);

    const ata = getAssociatedTokenAddressSync(this.mint, owner);
    const info = await this.connection.getAccountInfo(ata);
    let existing = 0n;
    if (info) {
      existing = (await getAccount(this.connection, ata)).amount;
    }
    const existingUsdc = Number(existing) / 10 ** USDC_DECIMALS;
    if (existingUsdc >= this.topUpBelowUsdc) {
      // Already funded — don't keep piling it on.
      return { funded: false, balanceUsdc: existingUsdc, mint: this.mint.toBase58() };
    }

    const ixs = [];
    if (!info) {
      ixs.push(
        createAssociatedTokenAccountInstruction(this.authority.publicKey, ata, owner, this.mint, TOKEN_PROGRAM_ID),
      );
    }
    const grant = BigInt(Math.round(this.grantUsdc * 10 ** USDC_DECIMALS));
    ixs.push(createMintToInstruction(this.mint, ata, this.authority.publicKey, grant, [], TOKEN_PROGRAM_ID));

    const tx = new Transaction().add(...ixs);
    const signature = await sendAndConfirmTransaction(this.connection, tx, [this.authority], {
      commitment: "confirmed",
    });

    return {
      funded: true,
      balanceUsdc: existingUsdc + this.grantUsdc,
      mint: this.mint.toBase58(),
      signature,
    };
  }
}
