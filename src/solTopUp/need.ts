/**
 * How much SOL a Panta buy really needs, from mainnet's own numbers.
 *
 * Read from real Panta primary buys on mainnet (docs/gasless-sol-topup.md §3):
 * one signature (5,000 lamports), no priority fee, and — the first time a
 * wallet buys into a market — a 202-byte position account owned by Panta's
 * program, whose rent the buyer pays. The wallet must also stay rent-exempt
 * itself (a 0-byte system account) after paying. Rent comes from
 * `getMinimumBalanceForRentExemption`, never a constant, because the rent
 * rate has changed before (165 bytes cost 2,039,280 lamports for years; it
 * is 1,488,440 today).
 */

import { Connection } from "@solana/web3.js";
import { MAINNET_GENESIS_HASH } from "../prediction/PantaChain.ts";

/** Panta's user position account, as created by its primary buy. */
export const PANTA_POSITION_BYTES = 202;
/** One signature's base fee plus room for a modest priority fee. */
export const TRADE_FEE_ALLOWANCE_LAMPORTS = 10_000n;
/** Jupiter sponsors gas only for a taker holding less than 0.01 SOL. */
export const GASLESS_SOL_CEILING_LAMPORTS = 10_000_000n;

export interface RentReader {
  minimumBalance(bytes: number): Promise<bigint>;
}

export interface SolNeed {
  /** One new Panta position: its rent plus the fee allowance. */
  perTradeLamports: bigint;
  /** What the wallet itself must keep to stay rent-exempt. */
  floorLamports: bigint;
}

export async function solNeed(rent: RentReader): Promise<SolNeed> {
  const [floor, position] = await Promise.all([rent.minimumBalance(0), rent.minimumBalance(PANTA_POSITION_BYTES)]);
  return { perTradeLamports: position + TRADE_FEE_ALLOWANCE_LAMPORTS, floorLamports: floor };
}

/** New positions the SOL in a wallet can pay for, never negative. */
export function tradesCovered(lamports: bigint, need: SolNeed): number {
  if (lamports <= need.floorLamports) return 0;
  return Number((lamports - need.floorLamports) / need.perTradeLamports);
}

export class RpcRentReader implements RentReader {
  private readonly connection: Connection;
  private mainnet: Promise<void> | undefined;
  private readonly cache = new Map<number, { at: number; lamports: bigint }>();

  constructor(
    rpcUrl: string,
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60 * 60_000,
  ) {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Rent reads need a secure mainnet RPC");
    }
    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(8_000) }),
        { preconnect: fetchImpl.preconnect },
      ),
    });
  }

  async minimumBalance(bytes: number): Promise<bigint> {
    const hit = this.cache.get(bytes);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.lamports;
    this.mainnet ??= this.connection.getGenesisHash().then((genesis) => {
      if (genesis !== MAINNET_GENESIS_HASH) throw new Error("not mainnet");
    }).catch((error) => {
      this.mainnet = undefined;
      throw error;
    });
    await this.mainnet;
    const lamports = BigInt(await this.connection.getMinimumBalanceForRentExemption(bytes, "confirmed"));
    this.cache.set(bytes, { at: this.now(), lamports });
    return lamports;
  }
}
