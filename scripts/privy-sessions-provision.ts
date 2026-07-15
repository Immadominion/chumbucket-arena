/**
 * Provision the Privy-custodied Sessions wallet and print everything needed for
 * the custody cutover (ROADMAP §1). It creates the Privy `gaffer_sessions` wallet
 * (idempotent, starts empty) and shows the new address plus the on-chain balances
 * of BOTH the new and the old env-key wallet, so you know exactly what to move.
 *
 * SAFE: creates one empty wallet + reads chain balances. Makes NO transfers, signs
 * nothing, and does not read or write .env (Bun auto-loads it for the creds).
 *
 *   bun run scripts/privy-sessions-provision.ts
 */

import { PrivyClient } from "@privy-io/node";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { loadConfig } from "../src/config.ts";
import { networkOf } from "../src/ports/Custody.ts";

const cfg = loadConfig();
const appId = cfg.privy?.appId;
const appSecret = cfg.privy?.appSecret;
if (!appId || !appSecret) {
  console.error("Need PRIVY_APP_ID and PRIVY_APP_SECRET (the backend's Privy creds).");
  process.exit(1);
}

const privy = new PrivyClient({ appId, appSecret });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wallets = privy.wallets() as any;
const ext = cfg.sui.sessionsExternalId ?? "gaffer_sessions";
const w = (await wallets.create({
  chain_type: "sui",
  external_id: ext,
  idempotency_key: `gaffer:${ext}`,
})) as { id: string; address: string; public_key: string };

const pub = new Ed25519PublicKey(Uint8Array.from(Buffer.from(w.public_key, "hex").subarray(1)));
const pubOk = pub.toSuiAddress() === w.address;

console.log("\n=== NEW Privy-custodied Sessions wallet ===");
console.log("external_id :", ext);
console.log("wallet id   :", w.id);
console.log("address     :", w.address, pubOk ? "(pubkey ✓ derives this address)" : "(⚠ pubkey MISMATCH)");

const SUI = "0x2::sui::SUI";
const walType = cfg.sui.walCoinType;
const client = new SuiJsonRpcClient({ network: networkOf(cfg.sui.rpcUrl), url: cfg.sui.rpcUrl });
const fmt = (frost: bigint) => (Number(frost) / 1e9).toFixed(4);
async function bal(addr: string): Promise<{ sui: bigint; wal: bigint }> {
  const [s, wl] = await Promise.all([
    client.getBalance({ owner: addr, coinType: SUI }),
    walType ? client.getBalance({ owner: addr, coinType: walType }) : Promise.resolve({ totalBalance: "0" }),
  ]);
  return { sui: BigInt(s.totalBalance), wal: BigInt(wl.totalBalance) };
}

const newBal = await bal(w.address);
console.log(`balance     : ${fmt(newBal.wal)} WAL · ${fmt(newBal.sui)} SUI   (the destination — expect ~0)`);

if (cfg.sui.sessionsAddress) {
  const oldBal = await bal(cfg.sui.sessionsAddress);
  console.log("\n=== OLD env-key Sessions wallet (the float to move) ===");
  console.log("address     :", cfg.sui.sessionsAddress);
  console.log(`balance     : ${fmt(oldBal.wal)} WAL · ${fmt(oldBal.sui)} SUI`);
}

console.log("\n=== Cutover steps ===");
console.log(`1. Move WAL + a little SUI (for gas) from the OLD wallet → ${w.address}`);
console.log("2. On Railway: set  PRIVY_CUSTODY=true  and redeploy.");
console.log("3. Check /health.sessionsWallet shows the new address; do one tiny withdrawal.");
console.log("4. Delete SESSIONS_WALLET_KEY from the env. The raw key is now gone.");
