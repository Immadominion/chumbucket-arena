/**
 * One-time custody cutover: move the Sessions float (all WAL + most SUI) from the
 * OLD env-key wallet to the NEW Privy-custodied wallet, on MAINNET. Signs with
 * SESSIONS_WALLET_KEY (loaded from .env by Bun — never printed). Aborts unless the
 * key derives the old address. Irreversible — run once.
 *
 *   bun run scripts/migrate-float.ts
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";
const WAL = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";
const OLD = "0x5a53053fb609c617aa7c0f43bc14f4654d8dd5d27a93dd9f12b02b4c0630f747";
const NEW = "0xc616e8b4df6b0caa78e18c50d47c56e42da8065ac6a4ae7e66d288bbcb3808b2";
const SUI_RESERVE = 120_000_000n; // 0.12 SUI left on the old wallet to pay this tx's gas

const key = process.env.SESSIONS_WALLET_KEY;
if (!key) {
  console.error("SESSIONS_WALLET_KEY not in env — cannot sign the migration.");
  process.exit(1);
}
const keypair = Ed25519Keypair.fromSecretKey(key.trim());
const derived = keypair.getPublicKey().toSuiAddress().toLowerCase();
if (derived !== OLD.toLowerCase()) {
  console.error(`SAFETY ABORT: key derives ${derived}, expected old Sessions wallet ${OLD}.`);
  process.exit(1);
}
console.log("signer verified:", derived, "= old Sessions wallet ✓");

const client = new SuiJsonRpcClient({ network: "mainnet", url: MAINNET_RPC });
const fmt = (b: bigint) => (Number(b) / 1e9).toFixed(4);

const walBal = BigInt((await client.getBalance({ owner: OLD, coinType: WAL })).totalBalance);
const suiBal = BigInt((await client.getBalance({ owner: OLD })).totalBalance);
console.log(`old wallet now : ${fmt(walBal)} WAL · ${fmt(suiBal)} SUI`);
if (walBal === 0n) {
  console.error("No WAL in the old wallet — nothing to migrate.");
  process.exit(1);
}
const suiToSend = suiBal > SUI_RESERVE ? suiBal - SUI_RESERVE : 0n;

const walCoins = (await client.getCoins({ owner: OLD, coinType: WAL })).data;
const tx = new Transaction();
tx.setSender(OLD);
// Move every WAL coin object whole (no splitting / rounding).
tx.transferObjects(walCoins.map((c) => tx.object(c.coinObjectId)), tx.pure.address(NEW));
// Move most SUI; gas for this tx is paid from the reserve left behind.
if (suiToSend > 0n) {
  const [suiCoin] = tx.splitCoins(tx.gas, [suiToSend]);
  tx.transferObjects([suiCoin], tx.pure.address(NEW));
}

console.log(`\nMOVING  ${fmt(walBal)} WAL + ${fmt(suiToSend)} SUI  →  ${NEW}`);
const res = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx,
  options: { showEffects: true },
});
await client.waitForTransaction({ digest: res.digest });
const status = res.effects?.status?.status;
console.log("\ndigest :", res.digest);
console.log("status :", status);
console.log("explorer:", `https://suiscan.xyz/mainnet/tx/${res.digest}`);
if (status !== "success") {
  console.error("Migration tx FAILED:", res.effects?.status?.error);
  process.exit(1);
}

const newWal = BigInt((await client.getBalance({ owner: NEW, coinType: WAL })).totalBalance);
const newSui = BigInt((await client.getBalance({ owner: NEW })).totalBalance);
console.log(`\n✅ new Sessions wallet now holds: ${fmt(newWal)} WAL · ${fmt(newSui)} SUI`);
console.log("Custody is now fully on the Privy wallet. Next: verify a withdrawal, then delete SESSIONS_WALLET_KEY.");
