/**
 * The Chumbucket wallet on the server (src/wallet/, src/api/wallet.ts): off
 * by default; when on, the account's trading wallet is its linked Chumbucket
 * wallet, and wallet.balance reads that wallet's mainnet balance. No input
 * ever names a wallet. Test doubles stand in for the session resolver and
 * the RPC; addresses are synthetic.
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { walletRouter } from "../src/api/wallet.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { DepositPerson, DepositWallet } from "../src/deposits/accounts.ts";
import type { WalletBalanceReader } from "../src/deposits/balance.ts";
import { primeDepositsRuntime } from "../src/deposits/runtime.ts";
import { DepositRateLimiter } from "../src/deposits/service.ts";
import { WalletLinkService } from "../src/auth/WalletLinkService.ts";
import { CHUMBUCKET_WALLET_TYPE, chooseTradingWallet, chumbucketWalletEnabled } from "../src/wallet/tradingWallet.ts";
import { FakeIdentityStore, FakeJwtVerifier, makeWallet, signMessage, TEST_DOMAIN, TEST_URI, testPolicy } from "./authIdentityFixtures.ts";

const user = "10000000-0000-4000-8000-000000000001";
const SESSION = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const CHUMBUCKET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

const w = (address: string, walletType: string, extra: Partial<DepositWallet> = {}): DepositWallet =>
  ({ address, walletType, primary: false, session: false, ...extra });
const personWith = (wallets: DepositWallet[]): DepositPerson => ({ userId: user, authUserId: "auth-1", wallets, email: null });

describe("the account's trading wallet", () => {
  test("the Chumbucket wallet when on and linked; otherwise sign-in, then primary, then any", () => {
    const all = personWith([w(SESSION, "web3", { session: true }), w(OTHER, "mwa", { primary: true }), w(CHUMBUCKET, CHUMBUCKET_WALLET_TYPE)]);
    expect(chooseTradingWallet(all, true)?.address).toBe(CHUMBUCKET);
    expect(chooseTradingWallet(all, false)?.address).toBe(SESSION);
    expect(chooseTradingWallet(personWith([w(CHUMBUCKET, "mwa"), w(OTHER, "mwa", { primary: true })]), true)?.address).toBe(OTHER);
    expect(chooseTradingWallet(personWith([w(OTHER, "embedded")]), true)?.address).toBe(OTHER);
    expect(chooseTradingWallet(personWith([]), true)).toBeNull();
  });

  test("the flag is off unless exactly true", () => {
    expect(chumbucketWalletEnabled(loadConfig({}))).toBe(false);
    expect(chumbucketWalletEnabled(loadConfig({ CHUMBUCKET_WALLET_ENABLED: "1" }))).toBe(false);
    expect(chumbucketWalletEnabled(loadConfig({ CHUMBUCKET_WALLET_ENABLED: "true" }))).toBe(true);
  });
});

describe("wallet router", () => {
  async function rig(env: Record<string, string>, wallets: DepositWallet[]) {
    const cfg = loadConfig(env);
    const app = await createApp({ config: cfg });
    const reads: string[] = [];
    let rpcDown = false;
    const balances: WalletBalanceReader = {
      async read(wallet) {
        reads.push(wallet);
        if (rpcDown) throw new Error("synthetic RPC failure");
        return { wallet, network: "solana-mainnet", lamports: "5000000", usdcBaseUnits: "2500000", slot: 9, readAt: "2026-10-04T12:00:00.000Z" };
      },
    };
    primeDepositsRuntime(cfg, {
      readiness: { available: false, reason: { code: "PAUSED", message: "Paused" }, config: null },
      service: null,
      accounts: {
        async resolve(token) {
          return token === "session-ok" ? { ok: true, person: personWith(wallets) } : { ok: false, reason: "SIGNED_OUT" };
        },
      },
      balances,
      limiter: new DepositRateLimiter(),
    });
    return {
      reads,
      rpcDown: () => (rpcDown = true),
      signedIn: walletRouter.createCaller({ app, supabaseAccessToken: "session-ok" }),
      anonymous: walletRouter.createCaller({ app }),
    };
  }
  const linked = [w(SESSION, "web3", { session: true }), w(CHUMBUCKET, CHUMBUCKET_WALLET_TYPE)];

  test("mounted as wallet.* POST mutations", () => {
    const procedures = appRouter._def.procedures as Record<string, { _def?: { type?: string } }>;
    for (const name of ["status", "balance"]) expect(procedures[`wallet.${name}`]?._def?.type).toBe("mutation");
  });

  test("off by default: says so and reads nothing", async () => {
    const h = await rig({}, linked);
    expect(await h.signedIn.status()).toEqual({ enabled: false, account: null });
    await expect(h.signedIn.balance()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(h.reads).toEqual([]);
  });

  test("on: the Chumbucket wallet trades, and its balance is read from it alone", async () => {
    const h = await rig({ CHUMBUCKET_WALLET_ENABLED: "true" }, linked);
    expect(await h.signedIn.status()).toEqual({
      enabled: true,
      account: { tradingWallet: { address: CHUMBUCKET, walletType: CHUMBUCKET_WALLET_TYPE }, chumbucketWallet: CHUMBUCKET },
    });
    expect(await h.signedIn.balance()).toEqual({
      wallet: CHUMBUCKET, walletType: CHUMBUCKET_WALLET_TYPE, network: "solana-mainnet", lamports: "5000000", usdcBaseUnits: "2500000", slot: 9,
    });
    expect(h.reads).toEqual([CHUMBUCKET]);
    // No input can point the read anywhere else.
    await expect(h.signedIn.balance({ wallet: OTHER } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("on, before the Chumbucket wallet exists: the sign-in wallet trades", async () => {
    const h = await rig({ CHUMBUCKET_WALLET_ENABLED: "true" }, [w(SESSION, "web3", { session: true })]);
    expect((await h.signedIn.status()).account).toEqual({ tradingWallet: { address: SESSION, walletType: "web3" }, chumbucketWallet: null });
    expect((await h.signedIn.balance()).wallet).toBe(SESSION);
  });

  test("signed out, no wallet, or an RPC failure: plain refusals, never a zero balance", async () => {
    const h = await rig({ CHUMBUCKET_WALLET_ENABLED: "true" }, []);
    expect(await h.anonymous.status()).toEqual({ enabled: true, account: null });
    await expect(h.anonymous.balance()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(h.signedIn.balance()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const down = await rig({ CHUMBUCKET_WALLET_ENABLED: "true" }, linked);
    down.rpcDown();
    await expect(down.signedIn.balance()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});

describe("linking the Chumbucket wallet", () => {
  function linker(chumbucketWallet: boolean) {
    const store = new FakeIdentityStore().addUser("auth-alice", "user-alice");
    const verifier = new FakeJwtVerifier().issue("tok-alice", "auth-alice");
    const service = new WalletLinkService({
      store, verifier, chumbucketWallet,
      policy: { ...testPolicy, allowedDomains: [...testPolicy.allowedDomains], allowedUris: [...testPolicy.allowedUris] },
    });
    return { store, service };
  }
  async function proof(service: WalletLinkService, wallet: ReturnType<typeof makeWallet>) {
    const issued = await service.requestWalletNonce({ accessToken: "tok-alice", address: wallet.address, domain: TEST_DOMAIN, uri: TEST_URI });
    return { message: issued.message, signature: signMessage(wallet.privateKey, issued.message) };
  }

  test("on: the same SIWS proof links it, labelled for what it is", async () => {
    const { store, service } = linker(true);
    const wallet = makeWallet();
    const p = await proof(service, wallet);
    const linked = await service.linkWallet({ accessToken: "tok-alice", address: wallet.address, ...p, walletType: CHUMBUCKET_WALLET_TYPE });
    expect(linked.outcome).toBe("linked");
    expect(store.walletOwner(wallet.address)).toBe("user-alice");
    expect(store.walletTypeOf(wallet.address)).toBe(CHUMBUCKET_WALLET_TYPE);
  });

  test("a wallet first linked under another label is relabelled by its Chumbucket re-proof, one way", async () => {
    const { store, service } = linker(true);
    const wallet = makeWallet();
    expect((await service.linkWallet({ accessToken: "tok-alice", address: wallet.address, ...(await proof(service, wallet)) })).outcome).toBe("linked");
    expect(store.walletTypeOf(wallet.address)).toBe("mwa");
    const again = await service.linkWallet({ accessToken: "tok-alice", address: wallet.address, ...(await proof(service, wallet)), walletType: CHUMBUCKET_WALLET_TYPE });
    expect(again.outcome).toBe("reaffirmed");
    expect(store.walletTypeOf(wallet.address)).toBe(CHUMBUCKET_WALLET_TYPE);
    await service.linkWallet({ accessToken: "tok-alice", address: wallet.address, ...(await proof(service, wallet)), walletType: "mwa" });
    expect(store.walletTypeOf(wallet.address)).toBe(CHUMBUCKET_WALLET_TYPE);
  });

  test("off: the label is refused before the challenge is spent, and the wallet can still link as itself", async () => {
    const { store, service } = linker(false);
    const wallet = makeWallet();
    const p = await proof(service, wallet);
    await expect(service.linkWallet({ accessToken: "tok-alice", address: wallet.address, ...p, walletType: CHUMBUCKET_WALLET_TYPE }))
      .rejects.toMatchObject({ code: "WALLET_TYPE_UNAVAILABLE" });
    expect(store.walletOwner(wallet.address)).toBeUndefined();
    // The unspent challenge still links it under the default label.
    expect((await service.linkWallet({ accessToken: "tok-alice", address: wallet.address, ...p })).outcome).toBe("linked");
    expect(store.walletTypeOf(wallet.address)).toBe("mwa");
  });
});
