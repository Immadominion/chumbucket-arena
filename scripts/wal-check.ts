/**
 * Check the TRUE WAL + SUI balances of the old and new Sessions wallets, using
 * the real mainnet WAL coin type even when WAL_COIN_TYPE isn't in the local env.
 * READ-ONLY. Bun auto-loads .env.
 *
 *   bun run scripts/wal-check.ts
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { loadConfig } from "../src/config.ts";
import { networkOf } from "../src/ports/Custody.ts";

const MAINNET_WAL = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";
const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";
const cfg = loadConfig();
const WAL = MAINNET_WAL; // force mainnet — the local env's SUI_RPC_URL may point at testnet
const client = new SuiJsonRpcClient({ network: "mainnet", url: MAINNET_RPC });
void networkOf;
const fmt = (b: string | bigint) => (Number(b) / 1e9).toFixed(4);

const wallets: Record<string, string> = {
  OLD: cfg.sui.sessionsAddress ?? "0x5a53053fb609c617aa7c0f43bc14f4654d8dd5d27a93dd9f12b02b4c0630f747",
  NEW: "0xc616e8b4df6b0caa78e18c50d47c56e42da8065ac6a4ae7e66d288bbcb3808b2",
};

console.log("RPC          :", MAINNET_RPC, "(forced mainnet)");
console.log("WAL coin type:", WAL);
console.log("");

for (const [name, a] of Object.entries(wallets)) {
  const [wal, sui, coins] = await Promise.all([
    client.getBalance({ owner: a, coinType: WAL }),
    client.getBalance({ owner: a }),
    client.getCoins({ owner: a, coinType: WAL }),
  ]);
  console.log(`${name}  ${a}`);
  console.log(`     WAL: ${fmt(wal.totalBalance)}  (${coins.data.length} coin objects)   SUI: ${fmt(sui.totalBalance)}`);
}
