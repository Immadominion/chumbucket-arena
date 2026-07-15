/**
 * Privy Sui signing — end-to-end TESTNET proof (custody hardening §1).
 *
 * Builds a REAL Sui transaction and signs it with Privy `rawSign` (MPC — no local
 * private key anywhere), then executes it on testnet. If this lands, Privy can
 * custody the Sessions wallet on mainnet and we delete the env-var key.
 *
 * SAFE: testnet only, a throwaway Privy wallet, faucet funds. No mainnet, no real
 * WAL, no .env reads/writes. Run with the backend's Privy creds (Bun auto-loads .env):
 *
 *   bun run scripts/privy-sui-sign-testnet.ts
 */

import { PrivyClient } from "@privy-io/node";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { Signer } from "@mysten/sui/cryptography";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
if (!appId || !appSecret) {
  console.error("Set PRIVY_APP_ID and PRIVY_APP_SECRET (the backend's Privy creds).");
  process.exit(1);
}

const privy = new PrivyClient({ appId, appSecret });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wallets = privy.wallets() as any;

/** A Sui Signer whose private key lives in Privy: sign() delegates to rawSign. */
class PrivySuiSigner extends Signer {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly api: any,
    private readonly walletId: string,
    private readonly pubkey: Ed25519PublicKey,
  ) {
    super();
  }
  getKeyScheme() {
    return "ED25519" as const;
  }
  getPublicKey() {
    return this.pubkey;
  }
  async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    // The SDK passes the 32-byte blake2b intent digest; Privy signs it raw (Ed25519).
    const hash = "0x" + Buffer.from(bytes).toString("hex");
    const res = await this.api.rawSign(this.walletId, { params: { hash } });
    const sig = Buffer.from(String(res.signature).replace(/^0x/, ""), "hex");
    const out = new Uint8Array(sig.length);
    out.set(sig);
    return out;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Get the throwaway Privy Sui wallet (same one the probe created).
const ext = "gaffer_privy_sui_probe";
const wallet = await wallets.create({
  chain_type: "sui",
  external_id: ext,
  idempotency_key: `gaffer:probe:${ext}`,
});
const walletId: string = wallet.id;
const address: string = wallet.address;
const pubHex: string = wallet.public_key; // 33 bytes: 0x00 (ED25519 flag) + 32-byte key
const rawPub = Buffer.from(pubHex, "hex").subarray(1); // strip the scheme flag → 32 bytes
const pubkey = new Ed25519PublicKey(Uint8Array.from(rawPub));

console.log("wallet id   :", walletId);
console.log("address     :", address);
// Hard safety check: the pubkey we parsed MUST derive Privy's address, or signing is wrong.
const derived = pubkey.toSuiAddress();
console.log("derived addr:", derived, derived === address ? "✓ matches" : "✗ MISMATCH");
if (derived !== address) {
  console.error("Pubkey parsing is wrong — aborting before any signing.");
  process.exit(1);
}

const signer = new PrivySuiSigner(wallets, walletId, pubkey);

// 2. THE PROOF (no gas needed): Privy signs a message, the Sui pubkey verifies it.
//    If this passes, rawSign produces valid Sui Ed25519 signatures — full stop.
const msg = new TextEncoder().encode("the-gaffer · privy sui custody proof");
const { signature: pmSig } = await signer.signPersonalMessage(msg);
const verified = await pubkey.verifyPersonalMessage(msg, pmSig);
console.log("\nprivy-signed message verifies under the Sui pubkey:", verified ? "✅ YES" : "❌ NO");
if (!verified) {
  console.error("rawSign did NOT produce a valid Sui Ed25519 signature — Privy path not viable.");
  process.exit(1);
}
console.log("→ Custody hardening is cryptographically PROVEN: Privy can sign Sui as the Sessions wallet.");

// 3. Bonus: a real on-chain testnet tx, if the faucet will fund gas (rate-limited
//    environments can skip this — the proof above already stands).
const client = new SuiJsonRpcClient({ network: "testnet", url: "https://fullnode.testnet.sui.io:443" });
let bal = BigInt((await client.getBalance({ owner: address })).totalBalance);
if (bal < 20_000_000n) {
  console.log(`\n(optional on-chain demo) requesting testnet gas for ${address}…`);
  try {
    await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: address });
  } catch (e) {
    console.log("faucet:", (e as Error).message);
  }
  for (let i = 0; i < 12 && bal < 20_000_000n; i++) {
    await sleep(3000);
    bal = BigInt((await client.getBalance({ owner: address })).totalBalance);
  }
}
if (bal < 20_000_000n) {
  console.log("(no testnet gas — skipping the on-chain demo; the cryptographic proof above is enough.)");
  process.exit(0);
}

const tx = new Transaction();
tx.setSender(address);
const [coin] = tx.splitCoins(tx.gas, [1000]);
tx.transferObjects([coin], address); // self-transfer — costs only gas
const res = await client.signAndExecuteTransaction({ signer, transaction: tx, options: { showEffects: true } });
await client.waitForTransaction({ digest: res.digest });
console.log("\non-chain testnet tx:", res.digest, "→", res.effects?.status?.status);
console.log("explorer:", `https://suiscan.xyz/testnet/tx/${res.digest}`);
