/**
 * Proves the product can read/write Walrus Memory mainnet end-to-end, using the
 * same SDK path the backend uses. Reads MEMWAL_* from the env (.env), writes a
 * throwaway memory to an isolated namespace, waits for the full
 * embed → encrypt → Walrus upload → index pipeline, then recalls it back.
 *
 *   bun run scripts/memwal-check.ts
 */

import { MemWal } from "@mysten-incubation/memwal";

const key = process.env.MEMWAL_PRIVATE_KEY;
const accountId = process.env.MEMWAL_ACCOUNT_ID;
const serverUrl = process.env.MEMWAL_SERVER_URL;

if (!key || !accountId) {
  console.error("Set MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID (run memwal-setup or memwal_login first).");
  process.exit(1);
}

const mw = MemWal.create({ key, accountId, ...(serverUrl ? { serverUrl } : {}) });

const health = await mw.health();
console.log("relayer health:", JSON.stringify({ status: health.status, version: health.version }));

const ns = "gaffer:_healthcheck";
const text = "Healthcheck: Bob backed Argentina at 9% and it lost — he chases longshots.";

console.log("writing to Walrus (waits for upload + index)…");
const stored = await mw.rememberAndWait(text, ns, { timeoutMs: 180_000 });
console.log("stored blob:", stored.blob_id, "namespace:", stored.namespace);

const hits = await mw.recall({ query: "what did Bob back?", limit: 3, namespace: ns });
console.log("recalled:");
for (const h of hits.results) {
  console.log(`  • (${h.distance.toFixed(3)}) ${h.text}`);
}
console.log(hits.results.length ? "✓ round-trip OK — memory is live on Walrus mainnet" : "✗ nothing recalled");
