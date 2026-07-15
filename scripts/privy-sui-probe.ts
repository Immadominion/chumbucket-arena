/**
 * Privy Sui custody — feasibility probe. SAFE: no transactions, no funds, no
 * mainnet, no .env writes. It creates ONE throwaway Privy "sui" wallet (empty)
 * and signs a dummy hash, to answer the two questions static types can't:
 *
 *   1. Does a Privy `chain_type: "sui"` wallet expose its Ed25519 PUBLIC KEY?
 *      We need it to assemble a Sui signature — Ed25519 has no key recovery, and
 *      you can't derive the pubkey from a Sui address. This is the make-or-break.
 *   2. Does `rawSign` with a pre-computed hash return a usable signature?
 *
 * Run it with the SAME Privy creds the backend uses (it reads them from the
 * environment — it does not read or modify .env):
 *
 *   PRIVY_APP_ID=xxx PRIVY_APP_SECRET=yyy bun run scripts/privy-sui-probe.ts
 *
 * Paste the whole output back and I'll build the PrivyCustody signer around
 * exactly what Privy returns (or, if the pubkey isn't available, pivot to Turnkey).
 */

import { PrivyClient } from "@privy-io/node";

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
if (!appId || !appSecret) {
  console.error("Set PRIVY_APP_ID and PRIVY_APP_SECRET (the same values the backend uses).");
  process.exit(1);
}

const privy = new PrivyClient({ appId, appSecret });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wallets = privy.wallets() as any;

// 1. Create a dedicated throwaway Sui wallet for the probe (idempotent).
const ext = "gaffer_privy_sui_probe";
const wallet = await wallets.create({
  chain_type: "sui",
  external_id: ext,
  idempotency_key: `gaffer:probe:${ext}`,
});
console.log("\n=== wallet object (from create) ===");
console.log(JSON.stringify(wallet, null, 2));

const walletId: string = wallet.id;
const address: string | undefined = wallet.address;
let publicKey: string | undefined = wallet.public_key;

// 2. Try get(id) too — some SDKs only return the public key on a full fetch.
try {
  if (typeof wallets.get === "function") {
    const got = await wallets.get(walletId);
    console.log("\n=== wallet object (from get) ===");
    console.log(JSON.stringify(got, null, 2));
    publicKey = publicKey ?? got?.public_key;
  }
} catch (e) {
  console.log("\n(get() unavailable or failed:", (e as Error).message, ")");
}

// 3. rawSign a dummy 32-byte hash — the shape of a Sui intent digest.
const dummyHash = "0x" + "ab".repeat(32);
console.log("\n=== rawSign({ hash }) ===");
try {
  const res = await wallets.rawSign(walletId, { params: { hash: dummyHash } });
  console.log(JSON.stringify(res, null, 2));
} catch (e) {
  console.log("rawSign FAILED:", (e as Error).message);
}

// 4. Verdict.
console.log("\n=== VERDICT ===");
console.log("wallet id     :", walletId);
console.log("sui address   :", address);
console.log(
  "public key    :",
  publicKey ? `EXPOSED → ${publicKey}` : "NOT FOUND on the wallet object (the blocker to resolve)",
);
console.log(
  publicKey
    ? "→ Looks viable: pubkey available + rawSign works → I can build the Sui signer."
    : "→ Need another source for the Ed25519 pubkey, or we pivot custody to Turnkey.",
);
