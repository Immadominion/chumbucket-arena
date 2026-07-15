/**
 * Prove the custodial deposit sweep end-to-end on MAINNET. Funds a throwaway
 * "player" Privy wallet with a little WAL from the Sessions float, then runs the
 * real PrivyDepositGateway to sweep it back — exercising the gas top-up, the
 * player-signed (Privy MPC) sweep, and the credit digest. The WAL returns to
 * Sessions, so it's recoverable. Bun auto-loads .env for the Privy creds.
 *
 *   bun run scripts/verify-deposit-sweep.ts
 */

import { PrivyClient } from "@privy-io/node";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { loadConfig } from "../src/config.ts";
import { PrivyCustody } from "../src/ports/PrivyCustody.ts";
import { PrivyDepositGateway } from "../src/ports/PrivyDepositGateway.ts";
import { asWallet, type Frost } from "../src/domain/ids.ts";

const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";
const WAL = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";
const TEST_WAL = 500_000_000n; // 0.5 WAL round-trip

const cfg = loadConfig();
if (!cfg.privy?.appSecret) {
  console.error("Need PRIVY_APP_ID + PRIVY_APP_SECRET in the env.");
  process.exit(1);
}
const common = { appId: cfg.privy.appId, appSecret: cfg.privy.appSecret, rpcUrl: MAINNET_RPC, walCoinType: WAL };
const fmt = (b: bigint) => (Number(b) / 1e9).toFixed(4);

// 1. A throwaway "player" Privy wallet.
const privy = new PrivyClient({ appId: cfg.privy.appId, appSecret: cfg.privy.appSecret });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wallets = privy.wallets() as any;
const player = (await wallets.create({
  chain_type: "sui",
  external_id: "gaffer_deposit_test",
  idempotency_key: "gaffer:gaffer_deposit_test",
})) as { id: string; address: string; public_key: string };
console.log("test player wallet:", player.address);

const client = new SuiJsonRpcClient({ network: "mainnet", url: MAINNET_RPC });

// 2. Fund it with a little WAL from the Sessions float (Sessions → player).
const custody = await PrivyCustody.create(common);
console.log(`\nfunding test player with ${fmt(TEST_WAL)} WAL from the Sessions float…`);
const fund = await custody.withdraw(asWallet(player.address), TEST_WAL as Frost);
console.log("funded:", fund.ref);
const beforeWal = BigInt((await client.getBalance({ owner: player.address, coinType: WAL })).totalBalance);
console.log("player WAL now:", fmt(beforeWal));

// 3. Run the real deposit gateway — it should top up gas + sweep the WAL back.
const gateway = await PrivyDepositGateway.create(common);
console.log("\nrunning deposit sweep (gas top-up + player-signed Privy sweep)…");
const credits = await gateway.collect({ address: player.address, walletId: player.id, publicKey: player.public_key });
console.log("credits:", credits.map((c) => ({ digest: c.digest, wal: fmt(c.amount) })));

// 4. Verify the player wallet is swept and Sessions got the WAL back.
const afterWal = BigInt((await client.getBalance({ owner: player.address, coinType: WAL })).totalBalance);
console.log("\nplayer WAL after sweep:", fmt(afterWal), "(expect ~0)");
const ok = credits.length > 0 && afterWal === 0n;
console.log(ok ? "\n✅ Deposit sweep works end-to-end on mainnet." : "\n✗ Sweep did not complete cleanly — inspect above.");
if (!ok) process.exit(1);
