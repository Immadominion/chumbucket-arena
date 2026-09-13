/**
 * Duplicate-wallet ownership.
 *
 * The rule: one ACTIVE address maps to exactly one canonical user. Holding the
 * private key is necessary but NOT sufficient to take an address that someone
 * else already holds — otherwise a shared or sold key silently repoints another
 * person's identity, which is the failure mode the legacy
 * `sync_user_by_wallet ... ON CONFLICT DO UPDATE SET user_id = EXCLUDED.user_id`
 * path has today (contract §8 finding 2).
 *
 * Moving an address is possible, but only through an explicit, audited
 * transfer that names the current owner and states a reason.
 */

import { describe, expect, test } from "bun:test";
import { AuthIdentityError } from "../src/auth/AuthIdentityError.ts";
import { WalletLinkService } from "../src/auth/WalletLinkService.ts";
import {
  FakeIdentityStore,
  FakeJwtVerifier,
  makeWallet,
  signMessage,
  TEST_DOMAIN,
  TEST_URI,
  testPolicy,
  type TestWallet,
} from "./authIdentityFixtures.ts";

function rig() {
  const store = new FakeIdentityStore();
  store.addUser("auth-alice", "user-alice");
  store.addUser("auth-bob", "user-bob");
  const verifier = new FakeJwtVerifier().issue("tok-alice", "auth-alice").issue("tok-bob", "auth-bob");
  const service = new WalletLinkService({
    store,
    verifier,
    policy: {
      ...testPolicy,
      allowedDomains: [...testPolicy.allowedDomains],
      allowedUris: [...testPolicy.allowedUris],
    },
  });
  return { store, service };
}

async function link(service: WalletLinkService, token: string, wallet: TestWallet) {
  const issued = await service.requestWalletNonce({
    accessToken: token,
    address: wallet.address,
    domain: TEST_DOMAIN,
    uri: TEST_URI,
  });
  return service.linkWallet({
    accessToken: token,
    address: wallet.address,
    message: issued.message,
    signature: signMessage(wallet.privateKey, issued.message),
  });
}

describe("duplicate wallets", () => {
  test("the same active address cannot be attached to a second user", async () => {
    const { store, service } = rig();
    const shared = makeWallet();

    const first = await link(service, "tok-bob", shared);
    expect(first).toMatchObject({ userId: "user-bob", outcome: "linked" });

    // Alice presents a flawless, freshly-nonced, correctly-signed proof for the
    // very same key. It is refused on ownership, not on cryptography.
    let caught: unknown;
    try {
      await link(service, "tok-alice", shared);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthIdentityError);
    expect((caught as AuthIdentityError).code).toBe("WALLET_OWNED_BY_ANOTHER_USER");

    expect(store.walletOwner(shared.address)).toBe("user-bob");
    // No transfer was recorded, because none happened.
    expect(store.audit.filter((a) => a.action === "transferred")).toHaveLength(0);
  });

  test("the owner re-proving the same address is idempotent, not a duplicate", async () => {
    const { store, service } = rig();
    const w = makeWallet();

    expect((await link(service, "tok-bob", w)).outcome).toBe("linked");
    expect((await link(service, "tok-bob", w)).outcome).toBe("reaffirmed");
    expect(store.walletOwner(w.address)).toBe("user-bob");
    expect(store.audit.filter((a) => a.address === w.address && a.action === "linked")).toHaveLength(1);
  });

  test("an explicit audited transfer is the only way an address changes hands", async () => {
    const { store, service } = rig();
    const shared = makeWallet();

    await link(service, "tok-bob", shared);

    // The transfer names the current owner, the new owner, and a reason. All
    // three are required; the audit row is written in the same operation.
    const moved = store.transferWallet(shared.address, "user-bob", "user-alice", "support ticket #42: key handover");
    expect(moved.ok).toBe(true);
    expect(store.walletOwner(shared.address)).toBe("user-alice");

    const audited = store.audit.filter((a) => a.action === "transferred");
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      address: shared.address,
      fromUserId: "user-bob",
      toUserId: "user-alice",
      reason: "support ticket #42: key handover",
    });

    // And only now does Alice's own proof succeed.
    expect((await link(service, "tok-alice", shared)).outcome).toBe("reaffirmed");
    expect(store.walletOwner(shared.address)).toBe("user-alice");
  });

  test("a transfer that guesses the current owner wrong moves nothing", async () => {
    const { store } = rig();
    const shared = makeWallet();
    store.addUser("auth-carol", "user-carol");
    // Attach directly — the proof path is covered above, so this test is about
    // the transfer guard alone. Bob owns it.
    await store.attachVerifiedWallet({ userId: "user-bob", walletAddress: shared.address, proofVersion: 1 });

    expect(store.transferWallet(shared.address, "user-carol", "user-alice", "claims to own it")).toEqual({
      ok: false,
      reason: "not_owned_by_from_user",
    });
    expect(store.walletOwner(shared.address)).toBe("user-bob");
    expect(store.audit.filter((a) => a.action === "transferred")).toHaveLength(0);
  });

  test("a transfer with no stated reason is refused", async () => {
    const { store } = rig();
    const shared = makeWallet();
    await store.attachVerifiedWallet({ userId: "user-bob", walletAddress: shared.address, proofVersion: 1 });

    expect(store.transferWallet(shared.address, "user-bob", "user-alice", "   ")).toEqual({
      ok: false,
      reason: "reason_required",
    });
    expect(store.walletOwner(shared.address)).toBe("user-bob");
  });

  test("a transfer to the same user is refused rather than silently recorded", async () => {
    const { store } = rig();
    const shared = makeWallet();
    await store.attachVerifiedWallet({ userId: "user-bob", walletAddress: shared.address, proofVersion: 1 });

    expect(store.transferWallet(shared.address, "user-bob", "user-bob", "no-op")).toEqual({
      ok: false,
      reason: "same_user",
    });
    expect(store.audit.filter((a) => a.action === "transferred")).toHaveLength(0);
  });
});
