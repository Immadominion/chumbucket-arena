/**
 * Print the MEMWAL_AGENT_ID (the delegate's Ed25519 public key) derived from
 * MEMWAL_PRIVATE_KEY in the env. Only the public half is printed. Cross-check the
 * value against the dashboard's "delegate keys" section.
 *
 *   bun run scripts/memwal-agent-id.ts
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const h = (process.env.MEMWAL_PRIVATE_KEY ?? "").replace(/^0x/, "");
if (!h) {
  console.error("MEMWAL_PRIVATE_KEY not in env.");
  process.exit(1);
}
const kp = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(h, "hex")));
const pub = Buffer.from(kp.getPublicKey().toRawBytes()).toString("hex");
console.log("MEMWAL_AGENT_ID (Ed25519 public key, hex):", pub);
console.log("0x-prefixed                              : 0x" + pub);
console.log("delegate sui address (cross-check)       :", kp.getPublicKey().toSuiAddress());
