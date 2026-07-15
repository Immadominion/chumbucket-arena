/**
 * Sui custody round-trip integration test (testnet). Proves the real money seam
 * end-to-end with an EPHEMERAL player keypair we generate here — no user wallets
 * are touched. Run with the real coin type:
 *
 *   WAL_COIN_TYPE=0x8270…::wal::WAL bun run scripts/sui-roundtrip-test.ts
 *
 * Flow: Sessions funds a fresh player (WAL via custody.withdraw + a little SUI for
 * gas) → player deposits WAL back to Sessions → custody.confirmDeposit verifies it,
 * and the two abuse cases (over-claim, wrong player) are asserted to fail.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { loadConfig } from "../src/config.ts";
import { SuiCustody } from "../src/ports/Custody.ts";
import { asWallet, formatWal, wal } from "../src/domain/ids.ts";

const cfg = loadConfig();
const WAL = cfg.sui.walCoinType;
if (!cfg.sui.sessionsAddress || !cfg.sui.sessionsKey || !WAL) {
  console.error("✗ Set SESSIONS_WALLET_ADDRESS, SESSIONS_WALLET_KEY and WAL_COIN_TYPE.");
  process.exit(1);
}

const client = new SuiJsonRpcClient({ network: "testnet", url: cfg.sui.rpcUrl });
const sessions = Ed25519Keypair.fromSecretKey(cfg.sui.sessionsKey.trim());
const sessionsAddr = sessions.getPublicKey().toSuiAddress();
const custody = new SuiCustody({
  rpcUrl: cfg.sui.rpcUrl,
  sessionsAddress: cfg.sui.sessionsAddress,
  sessionsKey: cfg.sui.sessionsKey,
  walCoinType: WAL,
});

const player = Ed25519Keypair.generate();
const playerAddr = player.getPublicKey().toSuiAddress();
console.log("Sessions :", sessionsAddr);
console.log("Player   :", playerAddr, "(ephemeral)\n");

const before = await custody.balances();
console.log(`Sessions before →  WAL ${formatWal(before.wal)} | SUI ${before.sui}`);

// 1) Fund the player: 0.2 WAL via the real payout path + 0.05 SUI for gas.
const fund = await custody.withdraw(asWallet(playerAddr), wal(0.2));
console.log(`[1] withdrew 0.2 WAL → player   (${fund.ref})`);

const gasTx = new Transaction();
gasTx.setSender(sessionsAddr);
const [gas] = gasTx.splitCoins(gasTx.gas, [50_000_000]); // 0.05 SUI
gasTx.transferObjects([gas], gasTx.pure.address(playerAddr));
const gasRes = await client.signAndExecuteTransaction({ signer: sessions, transaction: gasTx, options: { showEffects: true } });
await client.waitForTransaction({ digest: gasRes.digest });
console.log(`[2] sent 0.05 SUI gas → player  (${gasRes.digest})`);

// 2) Player deposits 0.1 WAL back to the Sessions wallet.
const depTx = new Transaction();
depTx.setSender(playerAddr);
depTx.transferObjects([coinWithBalance({ balance: wal(0.1), type: WAL })], depTx.pure.address(sessionsAddr));
const dep = await client.signAndExecuteTransaction({ signer: player, transaction: depTx, options: { showEffects: true } });
await client.waitForTransaction({ digest: dep.digest });
console.log(`[3] player deposited 0.1 WAL → Sessions  (${dep.digest})\n`);

// 3) confirmDeposit must accept the genuine deposit…
const ok = await custody.confirmDeposit(asWallet(playerAddr), wal(0.1), dep.digest);
console.log("✓ confirmDeposit accepted the genuine deposit, ref:", ok.ref);

// …reject an over-claim…
await custody
  .confirmDeposit(asWallet(playerAddr), wal(0.2), dep.digest)
  .then(() => console.log("✗ FAIL: over-claim of 0.2 WAL was accepted"))
  .catch((e) => console.log("✓ over-claim rejected:", (e as Error).message));

// …and reject a wrong-player claim (someone else's address on the same digest).
await custody
  .confirmDeposit(asWallet(sessionsAddr), wal(0.1), dep.digest)
  .then(() => console.log("✗ FAIL: wrong-player claim was accepted"))
  .catch((e) => console.log("✓ wrong-player rejected:", (e as Error).message));

const after = await custody.balances();
console.log(`\nSessions after  →  WAL ${formatWal(after.wal)} | SUI ${after.sui}`);
console.log("round-trip complete: withdraw ✓  deposit-verify ✓  abuse-checks ✓");
