/**
 * Final custody proof: a REAL withdrawal through PrivyCustody on MAINNET. Sends a
 * tiny 0.1 WAL from the new Privy Sessions wallet → the old wallet (recoverable),
 * signed entirely by Privy MPC (no env key involved). If this lands, the new
 * custody is fully validated and SESSIONS_WALLET_KEY can be deleted.
 *
 *   bun run scripts/verify-privy-withdraw.ts
 */

import { PrivyCustody } from "../src/ports/PrivyCustody.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, type Frost } from "../src/domain/ids.ts";

const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";
const MAINNET_WAL = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";
const OLD = "0x5a53053fb609c617aa7c0f43bc14f4654d8dd5d27a93dd9f12b02b4c0630f747"; // recoverable destination

const cfg = loadConfig();
if (!cfg.privy?.appSecret) {
  console.error("Need PRIVY_APP_ID + PRIVY_APP_SECRET in the env.");
  process.exit(1);
}

const custody = await PrivyCustody.create({
  appId: cfg.privy.appId,
  appSecret: cfg.privy.appSecret,
  rpcUrl: MAINNET_RPC,
  walCoinType: MAINNET_WAL,
});
console.log("new Sessions wallet:", custody.sessionsAddress());
const before = await custody.balances();
console.log(`before: ${(Number(before.wal) / 1e9).toFixed(4)} WAL · ${(Number(before.sui) / 1e9).toFixed(4)} SUI`);

console.log("\nwithdrawing 0.1 WAL → old wallet, signed by Privy MPC…");
const ref = await custody.withdraw(asWallet(OLD), 100_000_000n as Frost); // 0.1 WAL
console.log("✅ withdrawal digest:", ref.ref);
console.log("explorer:", `https://suiscan.xyz/mainnet/tx/${ref.ref}`);

const after = await custody.balances();
console.log(`after : ${(Number(after.wal) / 1e9).toFixed(4)} WAL · ${(Number(after.sui) / 1e9).toFixed(4)} SUI`);
console.log("\nCustody is fully validated end-to-end on mainnet. You can now delete SESSIONS_WALLET_KEY.");
