/**
 * Sui custody check — exercises the real on-chain money seam against the
 * configured network (testnet by default). Reads .env (auto-loaded by Bun).
 *
 *   bun run scripts/sui-custody-check.ts                       # show Sessions balances
 *   bun run scripts/sui-custody-check.ts withdraw <to> <wal>   # pay WAL out of Sessions
 *   bun run scripts/sui-custody-check.ts verify-deposit <digest> <from> <wal>
 *
 * Needs SESSIONS_WALLET_ADDRESS, SESSIONS_WALLET_KEY and WAL_COIN_TYPE set.
 */

import { loadConfig } from "../src/config.ts";
import { SuiCustody } from "../src/ports/Custody.ts";
import { asWallet, formatWal, wal } from "../src/domain/ids.ts";

const cfg = loadConfig();
if (!cfg.sui.sessionsAddress || !cfg.sui.sessionsKey || !cfg.sui.walCoinType) {
  console.error("✗ Set SESSIONS_WALLET_ADDRESS, SESSIONS_WALLET_KEY and WAL_COIN_TYPE in .env first.");
  process.exit(1);
}

const custody = new SuiCustody({
  rpcUrl: cfg.sui.rpcUrl,
  sessionsAddress: cfg.sui.sessionsAddress,
  sessionsKey: cfg.sui.sessionsKey,
  walCoinType: cfg.sui.walCoinType,
});

console.log("RPC:            ", cfg.sui.rpcUrl);
console.log("Sessions wallet:", custody.sessionsAddress());
console.log("WAL coin type:  ", cfg.sui.walCoinType);

const b = await custody.balances();
console.log(`balances →  SUI(gas) ${b.sui}  |  WAL ${formatWal(b.wal)} (${b.wal} FROST)`);

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "withdraw") {
  const [to, amt] = rest;
  if (!to || !amt) throw new Error("usage: withdraw <to-address> <wal-amount>");
  console.log(`\nwithdrawing ${amt} WAL → ${to} …`);
  const { ref } = await custody.withdraw(asWallet(to), wal(Number(amt)));
  console.log("✓ payout digest:", ref);
} else if (cmd === "verify-deposit") {
  const [digest, from, amt] = rest;
  if (!digest || !from || !amt) throw new Error("usage: verify-deposit <digest> <from-address> <wal-amount>");
  console.log(`\nverifying deposit ${digest} (${amt} WAL from ${from}) …`);
  const { ref } = await custody.confirmDeposit(asWallet(from), wal(Number(amt)), digest);
  console.log("✓ deposit verified, ref:", ref);
} else if (cmd) {
  console.error(`unknown command "${cmd}" — use: withdraw | verify-deposit`);
  process.exit(1);
}
