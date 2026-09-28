import { expect, test } from "bun:test";
import { authRouter } from "../src/api/authRoutes.ts";
import { primeAuthIdentityRuntime } from "../src/auth/AuthIdentityRuntime.ts";
import { AuthIdentityError } from "../src/auth/AuthIdentityError.ts";
import type { AccountProofBinding, AccountProofIssue, ExistingAccountStore } from "../src/auth/ExistingAccountStore.ts";
import { SupabaseExistingAccountStore } from "../src/auth/ExistingAccountStore.ts";
import { parseSiwsMessage } from "../src/auth/SiwsMessage.ts";
import { createApp } from "../src/app.ts";
import { startServer } from "../src/api/server.ts";
import { once } from "node:events";
import { WalletLinkService } from "../src/auth/WalletLinkService.ts";
import { loadConfig } from "../src/config.ts";
import { FakeIdentityStore, FakeJwtVerifier, makeWallet, signMessage, testPolicy, TEST_DOMAIN, TEST_URI } from "./authIdentityFixtures.ts";

const alice = "10000000-0000-4000-8000-000000000001";
const bob = "10000000-0000-4000-8000-000000000002";
const person = "20000000-0000-4000-8000-000000000001";
const otherPerson = "20000000-0000-4000-8000-000000000002";

// Authorization model only. Database grants/atomicity are tested separately.
class ClaimFixture extends FakeIdentityStore implements ExistingAccountStore {
  readonly proofs = new Map<string, AccountProofIssue & { consumed?: string; result?: string }>();
  readonly anchors = new Map<string, string>();
  readonly people = new Map<string, string | null>([[person, null], [otherPerson, null]]);
  claimWrites = 0;
  override async userIdForAuthUser(subject: string) {
    return [...this.people].find(([, owner]) => owner === subject)?.[0] ?? null;
  }
  override async createPersonForAuthUser(): Promise<string> { throw new Error("Claims must never create a person"); }
  async issue(input: AccountProofIssue) {
    for (const proof of this.proofs.values()) {
      if (proof.authUserId === input.authUserId && !proof.consumed) proof.consumed = "superseded";
    }
    this.proofs.set(input.nonceHash, { ...input });
  }
  async claim(input: AccountProofBinding) {
    const proof = this.proofs.get(input.nonceHash);
    if (!proof) throw new AuthIdentityError("NONCE_UNKNOWN");
    if (proof.authUserId !== input.authUserId) throw new AuthIdentityError("NONCE_USER_MISMATCH");
    if (proof.messageHash !== input.messageHash || proof.walletAddress !== input.walletAddress || proof.network !== input.network) throw new AuthIdentityError("NONCE_UNKNOWN");
    if (proof.consumed === "superseded") throw new AuthIdentityError("NONCE_REUSED");
    if (Date.parse(proof.expiresAt) <= Date.now()) throw new AuthIdentityError("NONCE_EXPIRED");
    const target = this.anchors.get(`${input.network}:${input.walletAddress}`);
    if (!target) throw new AuthIdentityError("ACCOUNT_CLAIM_UNAVAILABLE");
    const owner = this.people.get(target);
    const existing = [...this.people].find(([, auth]) => auth === input.authUserId)?.[0];
    if ((owner && owner !== input.authUserId) || (existing && existing !== target)) throw new AuthIdentityError("ACCOUNT_CLAIM_CONFLICT");
    if (proof.consumed) return { userId: proof.result!, outcome: "already_claimed" as const };
    this.people.set(target, input.authUserId);
    proof.consumed = "redeemed"; proof.result = target; this.claimWrites++;
    return { userId: target, outcome: owner ? "already_claimed" as const : "claimed" as const };
  }
}

async function rig(enabled = true) {
  const config = loadConfig(enabled ? { EXISTING_ACCOUNT_CLAIMS_ENABLED: "true" } : {});
  const app = await createApp({ config });
  const store = new ClaimFixture();
  const verifier = new FakeJwtVerifier().issue("alice-session", alice).issue("bob-session", bob);
  primeAuthIdentityRuntime(config, { store, existingAccounts: store, verifier, policy: testPolicy });
  const caller = authRouter.createCaller({ app });
  const wallet = makeWallet();
  const request = (token = "alice-session", address = wallet.address) => caller.requestExistingAccountProof({
    supabaseAccessToken: token, address, domain: TEST_DOMAIN, uri: TEST_URI,
  });
  const prove = async (token = "alice-session") => {
    const result = await request(token);
    return { supabaseAccessToken: token, address: wallet.address, message: result.message,
      signature: signMessage(wallet.privateKey, result.message) };
  };
  const approve = () => store.anchors.set(`devnet:${wallet.address}`, person);
  return { config, app, store, caller, wallet, request, prove, approve };
}

test("a verified, unlinked user can request proof without creating another profile", async () => {
  const r = await rig(); const result = await r.request();
  expect(parseSiwsMessage(result.message).purpose).toBe("claim_account");
  expect(await r.store.userIdForAuthUser(alice)).toBeNull();
  expect(r.store.people.size).toBe(2);
  const row = [...r.store.proofs.values()][0]!;
  expect(row.authUserId).toBe(alice);
  expect(row.nonceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(row)).not.toContain(parseSiwsMessage(result.message).nonce);
  expect(JSON.stringify(row)).not.toContain("alice-session");
});

test("approved claim preserves the existing id; whoami resolves it; retry does not write twice", async () => {
  const r = await rig(); r.approve(); const proof = await r.prove();
  expect(await r.caller.claimExistingAccount(proof)).toEqual({ userId: person, authUserId: alice, outcome: "claimed" });
  expect(await r.caller.whoami({ supabaseAccessToken: "alice-session" })).toEqual({ userId: person, authUserId: alice });
  expect((await r.caller.claimExistingAccount(proof)).outcome).toBe("already_claimed");
  expect(r.store.claimWrites).toBe(1); expect(r.store.people.size).toBe(2);
});

test("disabled by default, including truthy-looking flag strings", async () => {
  const r = await rig(false);
  expect((await r.caller.identityStatus()).existingAccountClaimsEnabled).toBe(false);
  await expect(r.request()).rejects.toThrow("ACCOUNT_CLAIMS_DISABLED");
  for (const value of ["1", "TRUE", "yes"]) {
    expect(loadConfig({ EXISTING_ACCOUNT_CLAIMS_ENABLED: value }).authIdentity?.existingAccountClaimsEnabled).toBe(false);
  }
});

test("a valid wallet signature without reviewed history cannot select an account", async () => {
  const r = await rig();
  await expect(r.caller.claimExistingAccount(await r.prove())).rejects.toThrow("ACCOUNT_CLAIM_UNAVAILABLE");
  expect(r.store.claimWrites).toBe(0);
});

test("forged identity/evidence input is rejected, not used or silently stripped", async () => {
  const r = await rig(); const proof = await r.prove();
  for (const extra of [{ userId: person }, { authUserId: bob }, { approved: true }, { evidence: "operator_manual" }]) {
    await expect(r.caller.claimExistingAccount({ ...proof, ...extra })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(r.store.claimWrites).toBe(0);
});

test("another session cannot redeem a borrowed signed proof", async () => {
  const r = await rig(); r.approve(); const proof = await r.prove();
  await expect(r.caller.claimExistingAccount({ ...proof, supabaseAccessToken: "bob-session" })).rejects.toThrow("NONCE_USER_MISMATCH");
  expect((await r.caller.claimExistingAccount(proof)).userId).toBe(person);
});

test("another auth owner and an already-linked different profile both forbid merging", async () => {
  for (const existing of ["target-owned", "subject-already-linked"]) {
    const r = await rig(); r.approve();
    r.store.people.set(existing === "target-owned" ? person : otherPerson, existing === "target-owned" ? bob : alice);
    await expect(r.caller.claimExistingAccount(await r.prove())).rejects.toThrow("ACCOUNT_CLAIM_CONFLICT");
    expect(r.store.claimWrites).toBe(0);
  }
});

test("two sessions racing for one profile cannot both win", async () => {
  const r = await rig(); r.approve();
  const [a, b] = await Promise.all([r.prove(), r.prove("bob-session")]);
  const results = await Promise.allSettled([r.caller.claimExistingAccount(a), r.caller.claimExistingAccount(b)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(r.store.claimWrites).toBe(1);
});

test("invalid credential or signature cannot consume a proof", async () => {
  const r = await rig(); r.approve();
  await expect(r.request("unverified")).rejects.toThrow("AUTH_TOKEN_INVALID");
  const proof = await r.prove(); const wrongKey = makeWallet();
  await expect(r.caller.claimExistingAccount({ ...proof, signature: signMessage(wrongKey.privateKey, proof.message) })).rejects.toThrow("SIWS_BAD_SIGNATURE");
  expect((await r.caller.claimExistingAccount(proof)).outcome).toBe("claimed");
});

test("superseding, stored expiry and altered signed timestamps fail closed", async () => {
  const r = await rig(); r.approve(); const old = await r.prove();
  await r.request();
  await expect(r.caller.claimExistingAccount(old)).rejects.toThrow("NONCE_REUSED");
  const fresh = await r.prove();
  const altered = fresh.message.replace(/Expiration Time: .+/, `Expiration Time: ${new Date(Date.now() + 500_000).toISOString()}`);
  await expect(r.caller.claimExistingAccount({ ...fresh, message: altered, signature: signMessage(r.wallet.privateKey, altered) })).rejects.toThrow("NONCE_UNKNOWN");
  for (const row of r.store.proofs.values()) row.expiresAt = new Date(0).toISOString();
  await expect(r.caller.claimExistingAccount(fresh)).rejects.toThrow("NONCE_EXPIRED");
  expect(r.store.claimWrites).toBe(0);
});

test("a claim proof is not a normal wallet attachment proof", async () => {
  const r = await rig(); r.approve(); const proof = await r.prove();
  await r.caller.claimExistingAccount(proof);
  await expect(r.caller.linkWallet(proof)).rejects.toThrow("SIWS_PURPOSE_MISMATCH");
});

test("wallet attachment service cannot issue or redeem the bootstrap purpose", async () => {
  const r = await rig(); r.approve(); const proof = await r.prove();
  await r.caller.claimExistingAccount(proof);
  const service = new WalletLinkService({ store: r.store,
    verifier: new FakeJwtVerifier().issue('alice-session', alice), policy: testPolicy });
  const purpose = 'claim_account' as 'link_wallet'; // Simulate an untyped internal caller.
  await expect(service.requestWalletNonce({ accessToken: 'alice-session', address: r.wallet.address,
    domain: TEST_DOMAIN, uri: TEST_URI, purpose })).rejects.toThrow('SIWS_PURPOSE_MISMATCH');
  await expect(service.linkWallet({ ...proof, accessToken: 'alice-session', purpose })).rejects.toThrow('SIWS_PURPOSE_MISMATCH');
});

test("mounted HTTP mutations keep proofs in POST bodies and preserve the original person", async () => {
  const r = await rig(); r.approve();
  const server = startServer(r.app, 0);
  try {
    if (!server.http.listening) await once(server.http, 'listening');
    const address = server.http.address();
    if (!address || typeof address === 'string') throw new Error('missing local test port');
    const base = `http://127.0.0.1:${address.port}`;
    const post = async (path: string, input: object) => {
      const response = await fetch(`${base}/${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
      return { status: response.status, body: await response.json() as any };
    };
    for (const path of ['auth.requestExistingAccountProof', 'auth.claimExistingAccount']) {
      expect((await fetch(`${base}/${path}`)).status).toBe(405);
    }
    expect(r.store.proofs.size).toBe(0);
    const issued = await post('auth.requestExistingAccountProof', { supabaseAccessToken: 'alice-session',
      address: r.wallet.address, domain: TEST_DOMAIN, uri: TEST_URI });
    expect(issued.status).toBe(200);
    const message = issued.body.result.data.json.message as string;
    const result = await post('auth.claimExistingAccount', { supabaseAccessToken: 'alice-session',
      address: r.wallet.address, message, signature: signMessage(r.wallet.privateKey, message) });
    expect(result.status).toBe(200);
    expect(result.body.result.data.json).toEqual({ userId: person, authUserId: alice, outcome: 'claimed' });
    const who = await post('auth.whoami', { supabaseAccessToken: 'alice-session' });
    expect(who.body.result.data.json.userId).toBe(person);
    expect(r.store.people.size).toBe(2);
  } finally {
    server.wss.close();
    await new Promise<void>((resolve, reject) => server.http.close(error => error ? reject(error) : resolve()));
  }
});

for (const [needle, replacement, error] of [
  [TEST_DOMAIN + " wants", "attacker.invalid wants", "SIWS_DOMAIN_MISMATCH"],
  ["URI: " + TEST_URI, "URI: https://attacker.invalid", "SIWS_URI_MISMATCH"],
  ["Chain ID: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "Chain ID: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "SIWS_NETWORK_MISMATCH"],
  ["purpose:claim_account", "purpose:link_wallet", "SIWS_PURPOSE_MISMATCH"],
]) test(`claim rejects ${error}`, async () => {
  const r = await rig(); r.approve(); const proof = await r.prove();
  const message = proof.message.replace(needle!, replacement!);
  await expect(r.caller.claimExistingAccount({ ...proof, message, signature: signMessage(r.wallet.privateKey, message) })).rejects.toThrow(error!);
  expect(r.store.claimWrites).toBe(0);
});

const binding: AccountProofBinding = { authUserId: alice, walletAddress: "1".repeat(32), network: "devnet", nonceHash: "a".repeat(64), messageHash: "b".repeat(64) };
test("claim RPC uses POST and hashes; malformed response never becomes success", async () => {
  let requestBody: unknown;
  const store = new SupabaseExistingAccountStore({ supabaseUrl: "https://test.invalid", serviceRoleKey: "synthetic-server-key", network: "devnet" }, (async (url, init) => {
    expect(String(url)).toBe("https://test.invalid/rest/v1/rpc/claim_existing_account_v1");
    expect(init?.method).toBe("POST"); requestBody = JSON.parse(init?.body as string);
    return Response.json({ ok: true, user_id: "not-a-uuid", outcome: "claimed" });
  }) as typeof fetch);
  await expect(store.claim(binding)).rejects.toThrow("IDENTITY_STORE_ERROR");
  expect(Object.keys(requestBody as object).sort()).toEqual(["p_auth_user_id", "p_wallet_address", "p_network", "p_nonce_hash", "p_message_hash"].sort());
});
for (const response of [new Response("synthetic-private-error", { status: 500 }), new Response("not-json")]) test("provider errors do not leak their body", async () => {
  const store = new SupabaseExistingAccountStore({ supabaseUrl: "https://test.invalid", serviceRoleKey: "synthetic-server-key", network: "devnet" }, (async () => response) as unknown as typeof fetch);
  await expect(store.claim(binding)).rejects.toMatchObject({ message: "IDENTITY_STORE_ERROR" });
});
