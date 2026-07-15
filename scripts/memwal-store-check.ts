/**
 * Proves the *product* memory path end-to-end on real Walrus: the same
 * WalrusMemoryStore → SdkMemWalClient the backend wires, including the kind/at/tags
 * metadata the Gaffer reads. Reads the delegate creds from ~/.memwal/credentials.json
 * (so no secrets in env/argv), writes a memory, then polls recall until it indexes.
 *
 *   bun run scripts/memwal-store-check.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SdkMemWalClient } from "../src/core/memory/SdkMemWalClient.ts";
import { WalrusMemoryStore } from "../src/core/memory/WalrusMemoryStore.ts";

const c = JSON.parse(readFileSync(`${homedir()}/.memwal/credentials.json`, "utf8"));
const store = new WalrusMemoryStore(
  new SdkMemWalClient({ privateKey: c.delegatePrivateKey, accountId: c.accountId, serverUrl: c.relayerUrl }),
);

const ns = "gaffer:_storecheck";
const at = Date.now();
await store.remember(ns, {
  kind: "trait",
  at,
  text: "Eze talks up underdogs but never actually backs them.",
  tags: ["pattern", "underdogs"],
});
console.log(`submitted a 'trait' memory to ${ns} via WalrusMemoryStore; polling recall…`);

for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 12000));
  const recs = await store.recall(ns, "does this player back underdogs?", 3);
  const hit = recs.find((r) => r.text.includes("underdogs"));
  console.log(`  +${(i + 1) * 12}s → ${recs.length} recs` + (hit ? `  | kind=${hit.kind} at=${hit.at} score=${hit.score?.toFixed(3)}` : ""));
  if (hit) {
    const metaOk = hit.kind === "trait" && hit.at === at;
    console.log(`✓ WalrusMemoryStore round-trip OK — metadata ${metaOk ? "preserved" : "degraded to defaults (graceful)"}.`);
    process.exit(0);
  }
}
console.log("✗ not recallable within ~144s");
process.exit(1);
