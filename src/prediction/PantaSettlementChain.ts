/**
 * Read-only mainnet facts the funded lifecycle needs beyond `PantaChain`:
 *
 *  - can a signed approval still land at all (`neverLanded`), so a buy that
 *    was broadcast but dropped stops blocking a fresh funding of that call;
 *  - did a win claim actually pay the owner (`verifyClaim`), measured as a
 *    USDC credit to the owner's own token balance in the confirmed
 *    transaction, never inferred from a provider status or a signature alone.
 *
 * Kept beside PantaChain rather than inside it so this file is the only place
 * these reads live. It pins the same mainnet genesis before every read and
 * refuses an insecure or credential-bearing RPC URL, exactly as PantaChain does.
 * It never signs, never sends and never holds a key.
 */
import { createHash } from "node:crypto";
import { Connection } from "@solana/web3.js";
import { MAINNET_GENESIS_HASH, MAINNET_USDC_MINT } from "./PantaChain.ts";
import { VenueError } from "./errors.ts";

/** Blocks past `lastValidBlockHeight` before an unseen signature counts as dropped. */
export const DROPPED_SAFETY_BLOCKS = 150;

type TokenBalance = { owner?: string; mint: string; uiTokenAmount: { amount: string; decimals: number } };

/**
 * The owner's net native-USDC change in one transaction, in base units, or
 * null when the balances are missing or malformed. Positive means the owner
 * received USDC.
 */
export function usdcDeltaOf(meta: {
  preTokenBalances?: readonly TokenBalance[] | null;
  postTokenBalances?: readonly TokenBalance[] | null;
}, owner: string): bigint | null {
  try {
    if (!meta.preTokenBalances || !meta.postTokenBalances) return null;
    const total = (balances: readonly TokenBalance[]) => balances.reduce((sum, b) => {
      if (b.owner !== owner || b.mint !== MAINNET_USDC_MINT) return sum;
      if (b.uiTokenAmount.decimals !== 6 || !/^[0-9]+$/.test(b.uiTokenAmount.amount)) throw new Error();
      return sum + BigInt(b.uiTokenAmount.amount);
    }, 0n);
    return total(meta.postTokenBalances) - total(meta.preTokenBalances);
  } catch { return null; }
}

export interface ClaimProof { payoutBaseUnits: string; slot: number }

export class PantaSettlementChain {
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

  /**
   * True only when the signature is unknown to the ledger AND the finalized
   * block height is well past the approval's `lastValidBlockHeight`, checked
   * twice around the height read. Every block that could have carried the
   * transaction is then finalized or abandoned, so it can never land. A read
   * failure is never proof: it returns false and the guard stays in place.
   */
  async neverLanded(signature: string, lastValidBlockHeight: number): Promise<boolean> {
    if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) return false;
    await this.assertMainnet();
    try {
      const seen = async () => (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0] != null;
      if (await seen()) return false;
      const height = await this.connection.getBlockHeight("finalized");
      if (!(height > lastValidBlockHeight + DROPPED_SAFETY_BLOCKS)) return false;
      return !(await seen());
    } catch { return false; }
  }

  /**
   * Proof that a reviewed win claim paid its owner: the confirmed transaction
   * succeeded, is the exact reviewed message signed by the owner alone,
   * invoked the pinned Panta program on this market, and credited the owner's
   * native USDC. Anything else is null — "not proven yet", never "failed".
   */
  async verifyClaim(input: { signature: string; owner: string; market: string; programId: string; messageHash: string }): Promise<ClaimProof | null> {
    await this.assertMainnet();
    try {
      const result = await this.connection.getTransaction(input.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!result?.meta || result.meta.err !== null || result.transaction.signatures[0] !== input.signature) return null;
      const message = result.transaction.message;
      if (message.header.numRequiredSignatures !== 1 || message.staticAccountKeys[0]?.toBase58() !== input.owner) return null;
      if (createHash("sha256").update(message.serialize()).digest("hex") !== input.messageHash) return null;
      const keys = message.staticAccountKeys;
      if (!keys.some(key => key.toBase58() === input.market)) return null;
      if (!message.compiledInstructions.some(ix => keys[ix.programIdIndex]?.toBase58() === input.programId)) return null;
      const delta = usdcDeltaOf(result.meta, input.owner);
      if (delta === null || delta <= 0n) return null;
      return { payoutBaseUnits: delta.toString(), slot: result.slot };
    } catch { return null; }
  }
}
