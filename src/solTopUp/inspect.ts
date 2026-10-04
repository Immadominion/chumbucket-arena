/**
 * The server's second look at a swap, on mainnet, before it is shown to
 * anyone: resolve its lookup tables (so the USDC and WSOL mints in the route
 * are checked, not assumed) and simulate it unsigned to measure exactly what
 * it does to the person's SOL and USDC.
 *
 * Simulation is read-only (`simulateTransaction`, signatures not verified,
 * blockhash not replaced). Nothing is signed or sent. The RPC's genesis hash
 * is pinned first, as everywhere else that reads mainnet.
 */

import { Connection, PublicKey, type MessageV0, type VersionedTransaction } from "@solana/web3.js";
import { MAINNET_GENESIS_HASH } from "../prediction/PantaChain.ts";
import { ownerTokenAccount, SwapCheckError, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT, type CheckedSwap } from "./verify.ts";

export interface SwapEffect {
  /** Change in the person's own SOL account, in lamports. */
  lamportsDelta: bigint;
  /** Change in the person's canonical USDC account, in base units. */
  usdcDelta: bigint;
}

export interface SwapInspector {
  /** Throws SwapCheckError when a mint differs or the swap would fail. */
  inspect(tx: VersionedTransaction, owner: string, checked: CheckedSwap): Promise<SwapEffect>;
}

/** Reads a token account's amount from its raw 165-byte layout. */
export function tokenAmountOf(data: Buffer, mint: string, owner: string): bigint {
  if (data.length < 165) throw new SwapCheckError("token account layout");
  if (new PublicKey(data.subarray(0, 32)).toBase58() !== mint) throw new SwapCheckError("token account mint");
  if (new PublicKey(data.subarray(32, 64)).toBase58() !== owner) throw new SwapCheckError("token account owner");
  return data.readBigUInt64LE(64);
}

/** The loaded (lookup-table) keys of a v0 message, in account-index order. */
export function loadedKeys(message: MessageV0, tables: Map<string, PublicKey[]>): string[] {
  const writable: string[] = [];
  const readonly: string[] = [];
  for (const lookup of message.addressTableLookups) {
    const addresses = tables.get(lookup.accountKey.toBase58());
    if (!addresses) throw new SwapCheckError("lookup table missing");
    const pick = (i: number) => {
      const key = addresses[i];
      if (!key) throw new SwapCheckError("lookup table index");
      return key.toBase58();
    };
    writable.push(...lookup.writableIndexes.map(pick));
    readonly.push(...lookup.readonlyIndexes.map(pick));
  }
  return [...writable, ...readonly];
}

export class RpcSwapInspector implements SwapInspector {
  private readonly connection: Connection;
  private mainnet: Promise<void> | undefined;

  constructor(rpcUrl: string, fetchImpl: typeof fetch = fetch) {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Swap checks need a secure mainnet RPC");
    }
    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }),
        { preconnect: fetchImpl.preconnect },
      ),
    });
  }

  private assertMainnet(): Promise<void> {
    this.mainnet ??= this.connection.getGenesisHash().then((genesis) => {
      if (genesis !== MAINNET_GENESIS_HASH) throw new Error("not mainnet");
    }).catch((error) => {
      this.mainnet = undefined;
      throw error;
    });
    return this.mainnet;
  }

  async inspect(tx: VersionedTransaction, owner: string, checked: CheckedSwap): Promise<SwapEffect> {
    await this.assertMainnet();
    const message = tx.message as MessageV0;
    const tables = new Map<string, PublicKey[]>();
    for (const lookup of message.addressTableLookups) {
      const table = await this.connection.getAddressLookupTable(lookup.accountKey);
      if (!table.value) throw new SwapCheckError("lookup table missing");
      tables.set(lookup.accountKey.toBase58(), table.value.state.addresses);
    }
    const loaded = loadedKeys(message, tables);
    const statics = message.staticAccountKeys.length;
    for (const slot of checked.mintSlots) {
      if (loaded[slot.accountIndex - statics] !== slot.mint) throw new SwapCheckError("route mint");
    }

    const usdc = ownerTokenAccount(owner, USDC_MINT);
    const wsol = ownerTokenAccount(owner, WSOL_MINT);
    const [ownerInfo, usdcInfo, wsolInfo] = await this.connection.getMultipleAccountsInfo(
      [new PublicKey(owner), new PublicKey(usdc), new PublicKey(wsol)]);
    if (!usdcInfo || usdcInfo.owner.toBase58() !== TOKEN_PROGRAM) throw new SwapCheckError("no USDC account");
    // A rent repayment returns what the fee payer put into a WSOL account it
    // opened for this swap. If the person already had one, the create is a
    // no-op and the "repayment" would be the person's own rent: refused.
    if (checked.rentRepayLamports > 0n && wsolInfo) throw new SwapCheckError("rent repaid for the person's own account");
    const preLamports = BigInt(ownerInfo?.lamports ?? 0);
    const preUsdc = tokenAmountOf(Buffer.from(usdcInfo.data), USDC_MINT, owner);

    const simulated = await this.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [owner, usdc] },
    });
    const value = simulated.value;
    if (value.err) throw new SwapCheckError("the swap would fail right now");
    const [postOwner, postUsdc] = value.accounts ?? [];
    if (!postOwner || !postUsdc) throw new SwapCheckError("simulation accounts");
    const postUsdcData = Buffer.from(postUsdc.data[0] ?? "", "base64");
    return {
      lamportsDelta: BigInt(postOwner.lamports) - preLamports,
      usdcDelta: tokenAmountOf(postUsdcData, USDC_MINT, owner) - preUsdc,
    };
  }
}
