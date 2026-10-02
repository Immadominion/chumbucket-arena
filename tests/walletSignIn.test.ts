/**
 * Wallet sign-in and usernames through the real auth routes.
 *
 * A Supabase Web3 (Sign in with Solana) session carries the address Supabase
 * Auth verified. With it a person can claim a @username — attaching that
 * wallet, never one they name — or, once carry-over is switched on, reach the
 * account that wallet already has. Google sessions are unchanged.
 */

import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { authRouter } from "../src/api/authRoutes.ts";
import { primeAuthIdentityRuntime } from "../src/auth/AuthIdentityRuntime.ts";
import { hasUnusableSolanaIdentity, solanaWalletOf } from "../src/auth/SupabaseJwt.ts";
import { isUsableSolanaAddress } from "../src/auth/SolanaKey.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { FakeIdentityStore, FakeJwtVerifier, testPolicy } from "./authIdentityFixtures.ts";

/** Real ed25519 public keys: anything else is refused as a wallet. */
const OLD_WALLET = "F7rhCwoPyU5H1p48sddDmGb1ax25CwmxiwHL8Xj5RJ3E";
const NEW_WALLET = "7KGuuhZy8cYctGcGxjt91atS7A5aZobNhmUAxVLJgVCL";
/** A real ed25519 public key (the SPL Token program id). */
const REAL_KEY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

async function rig(opts: { carry?: boolean } = {}) {
  const config = loadConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    SOLANA_NETWORK: "devnet",
  });
  const app = await createApp({ config });
  const store = new FakeIdentityStore().addWalletAccount(OLD_WALLET, "user-old", "dominion");
  const verifier = new FakeJwtVerifier()
    .issue("tok-old-wallet", "auth-old-wallet", OLD_WALLET)
    .issue("tok-new-wallet", "auth-new-wallet", NEW_WALLET)
    .issue("tok-google", "auth-google")
    .issue("tok-other-at-old", "auth-other", OLD_WALLET);
  primeAuthIdentityRuntime(config, {
    store,
    verifier,
    policy: { ...testPolicy, allowedDomains: [...testPolicy.allowedDomains], allowedUris: [...testPolicy.allowedUris] },
    walletProfileCarry: opts.carry === true,
  });
  return { store, caller: authRouter.createCaller({ app }) };
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return e instanceof TRPCError ? e.message : `UNEXPECTED ${String(e)}`;
  }
}

describe("the verified wallet on a session", () => {
  const web3 = (address: string, extra: Record<string, unknown> = {}) => ({
    provider: "web3",
    identity_data: { sub: `web3:solana:${address}`, custom_claims: { address, chain: "solana" }, ...extra },
  });

  test("is read from a web3 identity, and only when both records agree", () => {
    expect(solanaWalletOf([web3(NEW_WALLET)])).toBe(NEW_WALLET);
    expect(solanaWalletOf([{ provider: "google", identity_data: { sub: "123" } }])).toBeUndefined();
    expect(
      solanaWalletOf([
        { provider: "web3", identity_data: { sub: `web3:solana:${NEW_WALLET}`, custom_claims: { address: OLD_WALLET, chain: "solana" } } },
      ]),
    ).toBeUndefined();
    expect(solanaWalletOf([{ provider: "web3", identity_data: { sub: "web3:ethereum:0xabc" } }])).toBeUndefined();
    expect(solanaWalletOf("not an array")).toBeUndefined();
  });

  test("an address nobody can hold is never a wallet, and its session is refused", () => {
    // The all-zero key is small-order: Supabase Auth accepted a forged
    // all-zero signature for it on 2026-10-02.
    const forged = [web3("11111111111111111111111111111111")];
    expect(solanaWalletOf(forged)).toBeUndefined();
    expect(hasUnusableSolanaIdentity(forged)).toBe(true);
    expect(hasUnusableSolanaIdentity([web3(REAL_KEY)])).toBe(false);
    expect(solanaWalletOf([web3(REAL_KEY)])).toBe(REAL_KEY);
    expect(isUsableSolanaAddress(REAL_KEY)).toBe(true);
  });
});

describe("claiming a username", () => {
  test("a new wallet claims @ada; the account carries that wallet; whoami reaches it", async () => {
    const { caller, store } = await rig();
    const created = await caller.completeProfile({
      supabaseAccessToken: "tok-new-wallet",
      displayName: "Ada",
      handle: "Ada",
    });
    expect(typeof created.userId).toBe("string");
    expect(await caller.usernameStatus({ handle: "ADA" })).toEqual({ handle: "ada", status: "taken" });
    const me = await caller.whoami({ supabaseAccessToken: "tok-new-wallet" });
    expect(me.userId).toBe(created.userId);
    // The wallet now belongs to that account; a second account cannot take it.
    expect(
      await store.createPersonWithUsername({ authUserId: "auth-x", displayName: "X", handle: "x_x_x", walletAddress: NEW_WALLET }),
    ).toEqual({ ok: false, reason: "wallet_has_profile" });
  });

  test("taken, reserved and malformed usernames are refused with their own codes", async () => {
    const { caller } = await rig();
    expect(await code(() => caller.completeProfile({ supabaseAccessToken: "tok-google", displayName: "G", handle: "Dominion" }))).toBe(
      "USERNAME_TAKEN",
    );
    expect(await code(() => caller.completeProfile({ supabaseAccessToken: "tok-google", displayName: "G", handle: "admin" }))).toBe(
      "USERNAME_RESERVED",
    );
    expect(await code(() => caller.completeProfile({ supabaseAccessToken: "tok-google", displayName: "G", handle: "a b" }))).toBe(
      "USERNAME_INVALID",
    );
    expect((await caller.usernameStatus({ handle: "fresh_name" })).status).toBe("available");
  });

  test("a wallet that already has an account is never given a second one", async () => {
    const { caller } = await rig();
    expect(
      await code(() => caller.completeProfile({ supabaseAccessToken: "tok-old-wallet", displayName: "Dup", handle: "dup_name" })),
    ).toBe("WALLET_HAS_PROFILE");
  });

  test("builds without usernames still complete a profile exactly as before", async () => {
    const { caller } = await rig();
    const created = await caller.completeProfile({ supabaseAccessToken: "tok-google", displayName: "Google person" });
    expect(typeof created.userId).toBe("string");
  });
});

describe("carrying an existing account over to a wallet sign-in", () => {
  test("off (the default): the old wallet's session is unlinked, nothing is bound", async () => {
    const { caller } = await rig();
    expect(await code(() => caller.whoami({ supabaseAccessToken: "tok-old-wallet" }))).toBe("AUTH_USER_UNLINKED");
    const status = await caller.identityStatus();
    expect(status.walletSignIn).toBe(true);
    expect(status.walletProfileCarry).toBe(false);
  });

  test("on: the wallet sign-in reaches its existing account, once", async () => {
    const { caller } = await rig({ carry: true });
    expect((await caller.whoami({ supabaseAccessToken: "tok-old-wallet" })).userId).toBe("user-old");
    expect((await caller.whoami({ supabaseAccessToken: "tok-old-wallet" })).userId).toBe("user-old");
    // Another sign-in at the same wallet cannot take an account already reached.
    expect(await code(() => caller.whoami({ supabaseAccessToken: "tok-other-at-old" }))).toBe("AUTH_USER_UNLINKED");
    // A Google session is never carried anywhere by this.
    expect(await code(() => caller.whoami({ supabaseAccessToken: "tok-google" }))).toBe("AUTH_USER_UNLINKED");
    expect((await caller.identityStatus()).walletProfileCarry).toBe(true);
  });
});
