/**
 * Run the backend with the REAL adapters wired — Walrus memory (MemWal) + real
 * WAL custody on the Sessions wallet — for demos and recordings. Pulls the MemWal
 * delegate creds from ~/.memwal/credentials.json so no secrets live in the repo;
 * SESSIONS_WALLET_* come from .env. Plain `bun run dev` stays fully in-memory.
 *
 *   bun run dev:live
 *
 * Note: MemWal indexing latency is variable (~30s–2min) — a freshly written
 * memory becomes recallable a beat later, which is exactly the day-1→day-N shape.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// Testnet WAL today; set WAL_COIN_TYPE in the env to override (e.g. for mainnet).
const TESTNET_WAL = "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL";

try {
  const c = JSON.parse(readFileSync(`${homedir()}/.memwal/credentials.json`, "utf8"));
  process.env.MEMWAL_PRIVATE_KEY ||=c.delegatePrivateKey;
  process.env.MEMWAL_ACCOUNT_ID ||=c.accountId;
  if (c.relayerUrl) process.env.MEMWAL_SERVER_URL ||=c.relayerUrl;
  console.log(`[dev:live] Walrus memory: account ${c.accountId} via ${c.relayerUrl}`);
} catch {
  console.warn("[dev:live] ~/.memwal/credentials.json not found → memory stays in-memory");
}

process.env.WAL_COIN_TYPE ||=TESTNET_WAL;
console.log(`[dev:live] real WAL custody: ${process.env.SESSIONS_WALLET_ADDRESS ?? "(set SESSIONS_WALLET_* in .env)"}`);

await import("../src/index.ts");
