/** Wallet-authorized, exact-message Solana broadcasts. Never holds user keys. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { VenueError } from "./errors.ts";

// Verified against https://api.mainnet-beta.solana.com getGenesisHash 2026-09-29.
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const spki = Buffer.from("302a300506032b6570032100", "hex");

export function confirmsUsdcDeposit(meta: {
  preTokenBalances?: readonly { owner?: string; mint: string; uiTokenAmount: { amount: string; decimals: number } }[] | null;
  postTokenBalances?: readonly { owner?: string; mint: string; uiTokenAmount: { amount: string; decimals: number } }[] | null;
}, owner: string, expectedBaseUnits: string): boolean {
  try {
    if (!/^[1-9][0-9]*$/.test(expectedBaseUnits) || !meta.preTokenBalances || !meta.postTokenBalances) return false;
    const total = (balances: NonNullable<typeof meta.preTokenBalances>) => balances.reduce((sum, b) => {
      if (b.owner !== owner || b.mint !== MAINNET_USDC_MINT) return sum;
      if (b.uiTokenAmount.decimals !== 6 || !/^[0-9]+$/.test(b.uiTokenAmount.amount)) throw new Error();
      return sum + BigInt(b.uiTokenAmount.amount);
    }, 0n);
    return total(meta.preTokenBalances) - total(meta.postTokenBalances) === BigInt(expectedBaseUnits);
  } catch { return false; }
}

export interface SignedPantaTransaction { bytes: Uint8Array; signature: string; }
export function validateSignedPantaTransaction(payload: string, owner: string, messageHash: string): SignedPantaTransaction {
  try {
    const bytes = Buffer.from(payload, "base64");
    if (bytes.toString("base64") !== payload || bytes.length > 1232) throw new Error();
    const tx = VersionedTransaction.deserialize(bytes);
    if (tx.message.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1 ||
        tx.message.staticAccountKeys[0]?.toBase58() !== owner || hash(tx.message.serialize()) !== messageHash) throw new Error();
    const signature = tx.signatures[0]!;
    const key = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([spki, new PublicKey(owner).toBuffer()]) });
    if (!verify(null, tx.message.serialize(), key, signature)) throw new Error();
    return { bytes, signature: utils.bytes.bs58.encode(signature) };
  } catch {
    throw new VenueError("VENUE_BAD_REQUEST", "Wallet approval does not match the reviewed Panta transaction", { venue: "panta" });
  }
}

export class PantaChain {
  private readonly connection: Connection;
  private mainnet: Promise<void> | undefined;
  constructor(rpcUrl: string, fetchImpl: typeof fetch = fetch) {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new VenueError("VENUE_MISCONFIGURED", "Panta requires a secure mainnet RPC", { venue: "panta" });
    }
    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed", disableRetryOnRateLimit: true,
      fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }), { preconnect: fetchImpl.preconnect }),
    });
  }
  private async assertMainnet(): Promise<void> {
    this.mainnet ??= this.connection.getGenesisHash().then(genesis => {
      if (genesis !== MAINNET_GENESIS_HASH) throw new Error();
    }).catch(() => {
      this.mainnet = undefined;
      throw new VenueError("VENUE_MISCONFIGURED", "Panta RPC mainnet verification failed", { venue: "panta" });
    });
    await this.mainnet;
  }
  async broadcast(tx: SignedPantaTransaction): Promise<void> {
    await this.assertMainnet();
    try {
      const signature = await this.connection.sendRawTransaction(tx.bytes, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
      if (signature !== tx.signature) throw new Error();
    } catch {
      // The request may already have reached the RPC. Same signed bytes only on retry.
      throw new VenueError("VENUE_UNAVAILABLE", "Broadcast acknowledgement is missing; check this order or retry the same approval", { venue: "panta" });
    }
  }
  async verifyTransaction(input: { signature: string; owner: string; market: string; programId: string; amountBaseUnits: string; messageHash: string }): Promise<boolean> {
    await this.assertMainnet();
    try {
      const result = await this.connection.getTransaction(input.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!result?.meta || result.meta.err !== null || result.transaction.signatures[0] !== input.signature) return false;
      const message = result.transaction.message;
      if (message.header.numRequiredSignatures !== 1 || message.staticAccountKeys[0]?.toBase58() !== input.owner || hash(message.serialize()) !== input.messageHash) return false;
      if (!confirmsUsdcDeposit(result.meta, input.owner, input.amountBaseUnits)) return false;
      const keys = message.staticAccountKeys;
      return keys.some(key => key.toBase58() === input.market) && message.compiledInstructions.some(ix => keys[ix.programIdIndex]?.toBase58() === input.programId);
    } catch { return false; }
  }
  async failed(signature: string): Promise<boolean> {
    await this.assertMainnet();
    try {
      const statuses = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const s = statuses.value[0];
      return s != null && s.err != null && ["confirmed","finalized"].includes(s.confirmationStatus ?? "");
    } catch { return false; }
  }
}
