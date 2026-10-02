/**
 * The wallet's real mainnet SOL and USDC, read on the server.
 *
 * Mainnet because that is what Panta spends, whatever the Crossmint
 * environment. The RPC's genesis hash is pinned before any read, exactly as
 * PantaChain does before a broadcast, so a devnet RPC can never be reported
 * as a mainnet balance. Amounts stay integer strings end to end.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { MAINNET_GENESIS_HASH, MAINNET_USDC_MINT } from "../prediction/PantaChain.ts";

export interface WalletBalance {
  wallet: string;
  network: "solana-mainnet";
  lamports: string;
  usdcBaseUnits: string;
  slot: number;
  readAt: string;
}

export interface WalletBalanceReader {
  read(wallet: string): Promise<WalletBalance>;
}

export class MainnetBalanceReader implements WalletBalanceReader {
  private readonly connection: Connection;
  private mainnet: Promise<void> | undefined;

  constructor(
    rpcUrl: string,
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Balance reads need a secure mainnet RPC");
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

  private assertMainnet(): Promise<void> {
    this.mainnet ??= this.connection.getGenesisHash().then((genesis) => {
      if (genesis !== MAINNET_GENESIS_HASH) throw new Error("not mainnet");
    }).catch((error) => {
      this.mainnet = undefined;
      throw error;
    });
    return this.mainnet;
  }

  async read(wallet: string): Promise<WalletBalance> {
    await this.assertMainnet();
    const owner = new PublicKey(wallet);
    const [sol, tokens] = await Promise.all([
      this.connection.getBalanceAndContext(owner, "confirmed"),
      this.connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(MAINNET_USDC_MINT) }, "confirmed"),
    ]);
    let usdc = 0n;
    for (const account of tokens.value) {
      const info = (account.account.data as { parsed?: { info?: { mint?: unknown; owner?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } } }).parsed?.info;
      if (info?.mint !== MAINNET_USDC_MINT || info.owner !== wallet) continue;
      const amount = info.tokenAmount?.amount;
      if (info.tokenAmount?.decimals !== 6 || typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
        throw new Error("unexpected USDC account shape");
      }
      usdc += BigInt(amount);
    }
    return {
      wallet,
      network: "solana-mainnet",
      lamports: String(sol.value),
      usdcBaseUnits: usdc.toString(),
      slot: Math.max(sol.context.slot, tokens.context.slot),
      readAt: new Date(this.now()).toISOString(),
    };
  }
}
