/**
 * One-time Walrus Memory provisioning. Run this ONCE with your Sui owner key to
 * mint the product's MemWal account and authorise a delegate key. The delegate
 * key is what the backend runs on — your owner key never touches production.
 *
 *   SUI_OWNER_KEY=suiprivkey1... \
 *   MEMWAL_PACKAGE_ID=0x...  MEMWAL_REGISTRY_ID=0x... \
 *   bun run scripts/memwal-setup.ts
 *
 * Get MEMWAL_PACKAGE_ID / MEMWAL_REGISTRY_ID from the Walrus Memory mainnet
 * deployment (their docs / Discord). If you already have an account, set
 * MEMWAL_ACCOUNT_ID to skip creation and just add a fresh delegate key.
 *
 * It prints MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID — paste those into .env /
 * Railway and the backend goes live on Walrus mainnet.
 */

import {
  addDelegateKey,
  createAccount,
  generateDelegateKey,
} from "@mysten-incubation/memwal/account";

const ownerKey = process.env.SUI_OWNER_KEY;
const packageId = process.env.MEMWAL_PACKAGE_ID;
const registryId = process.env.MEMWAL_REGISTRY_ID;
let accountId = process.env.MEMWAL_ACCOUNT_ID;
const suiNetwork = (process.env.SUI_NETWORK ?? "mainnet") as "mainnet" | "testnet";

if (!ownerKey || !packageId) {
  console.error("Required: SUI_OWNER_KEY (suiprivkey1...) and MEMWAL_PACKAGE_ID (0x...).");
  console.error("To create a new account you also need MEMWAL_REGISTRY_ID (0x...).");
  process.exit(1);
}

const delegate = await generateDelegateKey();
console.log(`Generated delegate key → ${delegate.suiAddress}`);

if (!accountId) {
  if (!registryId) {
    console.error("No MEMWAL_ACCOUNT_ID set and no MEMWAL_REGISTRY_ID to create one. Provide one.");
    process.exit(1);
  }
  const acct = await createAccount({ packageId, registryId, suiPrivateKey: ownerKey, suiNetwork });
  accountId = acct.accountId;
  console.log(`Created MemWal account → ${accountId}  (tx ${acct.digest})`);
}

const added = await addDelegateKey({
  packageId,
  accountId,
  publicKey: delegate.publicKey,
  label: "gaffer-prod",
  suiPrivateKey: ownerKey,
  suiNetwork,
});
console.log(`Authorised delegate on account  (tx ${added.digest})`);

console.log("\n# ── paste into .env / Railway ──────────────────────────────");
console.log(`MEMWAL_PRIVATE_KEY=${delegate.privateKey}`);
console.log(`MEMWAL_ACCOUNT_ID=${accountId}`);
console.log("# ───────────────────────────────────────────────────────────");
