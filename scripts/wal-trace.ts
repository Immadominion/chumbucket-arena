/**
 * Trace WAL in/out of the old Sessions wallet — to answer "where did the float go?".
 * READ-ONLY: queries chain history, moves nothing. Bun auto-loads .env for config.
 *
 *   bun run scripts/wal-trace.ts
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { loadConfig } from "../src/config.ts";
import { networkOf, ownerAddress } from "../src/ports/Custody.ts";

const cfg = loadConfig();
const addr = cfg.sui.sessionsAddress?.toLowerCase();
const wal = cfg.sui.walCoinType;
if (!addr || !wal) {
  console.error("Need SESSIONS_WALLET_ADDRESS + WAL_COIN_TYPE in the env.");
  process.exit(1);
}
const client = new SuiJsonRpcClient({ network: networkOf(cfg.sui.rpcUrl), url: cfg.sui.rpcUrl });
const fmt = (frost: bigint) => (Number(frost) / 1e9).toFixed(4);

console.log(`Sessions wallet : ${addr}`);
console.log(`WAL coin type   : ${wal}\n`);

// Current WAL coin objects (if any remain).
const owned = await client.getCoins({ owner: addr, coinType: wal });
console.log(`WAL coin objects held now: ${owned.data.length}`);

async function dump(direction: "FromAddress" | "ToAddress") {
  const res = await client.queryTransactionBlocks({
    filter: { [direction]: addr } as never,
    options: { showBalanceChanges: true, showEffects: true },
    limit: 50,
    order: "descending",
  });
  console.log(`\n=== ${direction === "FromAddress" ? "SENT BY" : "RECEIVED BY"} the wallet (WAL-moving txs) ===`);
  let shown = 0;
  for (const tx of res.data) {
    const walChanges = (tx.balanceChanges ?? []).filter((c) => c.coinType === wal);
    if (walChanges.length === 0) continue;
    const ts = tx.timestampMs ? new Date(Number(tx.timestampMs)).toISOString() : "?";
    const status = tx.effects?.status?.status;
    console.log(`\n${ts}  ${tx.digest}  [${status}]`);
    for (const c of walChanges) {
      const who = ownerAddress(c.owner) ?? JSON.stringify(c.owner);
      const sign = BigInt(c.amount) < 0n ? "OUT" : "IN ";
      const tag = who === addr ? "(sessions)" : "← counterparty";
      console.log(`   ${sign} ${fmt(BigInt(c.amount).toString().replace("-", "") as unknown as bigint)} WAL  ${who} ${tag}`);
    }
    shown++;
  }
  if (shown === 0) console.log("  (none found in the last 50 txs)");
}

await dump("FromAddress");
await dump("ToAddress");
console.log("\nNote: nodes prune old history — if nothing shows, the movement may be older than the node retains.");
