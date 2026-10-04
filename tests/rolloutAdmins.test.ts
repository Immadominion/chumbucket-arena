/**
 * Staged rollout (src/rollout.ts): MONEY_CALLS_ENABLED, CHUMBUCKET_WALLET_ENABLED,
 * ACCOUNT_LINKING_ENABLED and ACCOUNT_FOLD_ENABLED take "true", "admins" or
 * anything else (off). With "admins" an admin account gets the feature, and
 * every other account — or a session with no account — gets exactly the
 * flag-off behaviour on every route. Synthetic sessions, wallets and keys.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { moneyRouter } from "../src/api/money.ts";
import { walletRouter } from "../src/api/wallet.ts";
import { authRouter } from "../src/api/authRoutes.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { AccountLinkService } from "../src/auth/AccountLinkService.ts";
import type { AccountLinkStore, AccountSignIns } from "../src/auth/AccountLinkStore.ts";
import { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } from "../src/auth/AuthIdentityRuntime.ts";
import { perAccount } from "../src/auth/accountResolver.ts";
import type { StoreResult } from "../src/auth/IdentityStore.ts";
import { WalletLinkService } from "../src/auth/WalletLinkService.ts";
import { SessionDepositAccounts } from "../src/deposits/accounts.ts";
import { primeDepositsRuntime } from "../src/deposits/runtime.ts";
import { DepositRateLimiter } from "../src/deposits/service.ts";
import { setMoneyRuntime, type MoneyRuntime } from "../src/money/runtime.ts";
import { moneyCallsEnabled, moneyCallsFor } from "../src/money/visibility.ts";
import { parseRollout, rolloutAllows } from "../src/rollout.ts";
import { chumbucketWalletEnabled, chumbucketWalletFor } from "../src/wallet/tradingWallet.ts";
import { FakeIdentityStore, FakeJwtVerifier, makeWallet, signMessage, TEST_DOMAIN, TEST_URI, testPolicy } from "./authIdentityFixtures.ts";
import { depositPerson, moneyRig, own } from "./moneyCallsFixtures.ts";
import { CallsService } from "../src/calls/CallsService.ts";

const ADMIN = "10000000-0000-4000-8000-0000000000aa";
const OTHER = "10000000-0000-4000-8000-0000000000bb";
const ADMIN_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER_WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const UUID_KEY = "rollout-tap-key-0001";

describe("parsing", () => {
  test("only the exact words; unknown values are off", () => {
    expect(parseRollout("true")).toBe("on");
    expect(parseRollout("admins")).toBe("admins");
    for (const v of [undefined, "", "1", "TRUE", "Admins", "admin", "yes", "on"]) expect(parseRollout(v)).toBe("off");
    const cfg = loadConfig({ MONEY_CALLS_ENABLED: "Admins", CHUMBUCKET_WALLET_ENABLED: "1", TRUST_ADMIN_USER_IDS: ADMIN });
    expect(moneyCallsEnabled(cfg)).toBe(false);
    expect(moneyCallsFor(cfg, ADMIN)).toBe(false);
    expect(chumbucketWalletEnabled(cfg)).toBe(false);
    const admins = loadConfig({ MONEY_CALLS_ENABLED: "admins", TRUST_ADMIN_USER_IDS: ` ${ADMIN.toUpperCase()} , not-a-uuid` });
    expect(moneyCallsEnabled(admins)).toBe(true); // the machinery runs
    expect(moneyCallsFor(admins, ADMIN)).toBe(true);
    expect(moneyCallsFor(admins, OTHER)).toBe(false);
    expect(moneyCallsFor(admins, null)).toBe(false);
    expect(admins.money).toMatchObject({ callsEnabled: false, callsRollout: "admins" });
    expect(rolloutAllows(admins, "on", null)).toBe(true);
    expect(rolloutAllows(admins, "off", ADMIN)).toBe(false);
  });
});

/** One app: sessions "admin" and "other" resolve through the one resolver; wallets per account. */
async function rig(env: Record<string, string>) {
  const cfg = loadConfig({
    SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only",
    TRUST_ADMIN_USER_IDS: ADMIN, BFF_PUBLIC_URL: "https://bff.synthetic.invalid",
    PRIVY_JWT_PRIVATE_KEY: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ...env,
  });
  const app = await createApp({ config: cfg });
  const store = new FakeIdentityStore().addUser("auth-admin", ADMIN).addUser("auth-other", OTHER);
  const verifier = new FakeJwtVerifier().issue("admin", "auth-admin").issue("other", "auth-other").issue("nobody", "auth-nobody");
  primeAuthIdentityRuntime(cfg, { store, verifier, policy: resolveAuthIdentityPolicy(cfg) });
  primeDepositsRuntime(cfg, {
    readiness: { available: false, reason: { code: "PAUSED", message: "Paused" }, config: null },
    service: null,
    accounts: new SessionDepositAccounts(cfg, {
      activeVerified: async (userId) => [{ address: userId === ADMIN ? ADMIN_WALLET : OTHER_WALLET, walletType: "chumbucket", primary: true }],
    }, { confirmedEmail: async () => null }),
    balances: { async read(wallet) {
      return { wallet, network: "solana-mainnet", lamports: "5000000", usdcBaseUnits: "2500000", slot: 9, readAt: "2026-10-04T12:00:00.000Z" };
    } },
    limiter: new DepositRateLimiter(),
    admins: new Set(),
  });
  setMoneyRuntime(cfg, { calls: { defaultAmount: async () => "10000000" } } as unknown as MoneyRuntime);
  return { cfg, app, as: (token?: string) => ({ app, ...(token ? { supabaseAccessToken: token } : {}) }) };
}

/** What a procedure answered: its value, or its error's code and message. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try { return { value: await fn() }; } catch (e) { const err = e as { code?: string; message?: string }; return { code: err.code, message: err.message }; }
}

const moneyCalls = (c: ReturnType<typeof moneyRouter.createCaller>) => ({
  status: () => c.status(),
  prepareCall: () => c.prepareCall({ kind: "own", marketId: "m", side: "YES", amountBaseUnits: "5000000", idempotencyKey: UUID_KEY }),
  callStatus: () => c.callStatus({ callId: "30000000-0000-4000-8000-000000000001" }),
  retry: () => c.retry({ callId: "30000000-0000-4000-8000-000000000001" }),
  keepFree: () => c.keepFree({ callId: "30000000-0000-4000-8000-000000000001" }),
  discard: () => c.discard({ callId: "30000000-0000-4000-8000-000000000001" }),
  pending: () => c.pending(),
  wallet: () => c.wallet(),
  activity: () => c.activity(),
  winnings: () => c.winnings(),
  depositOptions: () => c.depositOptions(),
  cashOutPrepare: () => c.cashOutPrepare({ destination: OTHER_WALLET, amountBaseUnits: "1000000", idempotencyKey: UUID_KEY }),
  depositFromWalletPrepare: () => c.depositFromWalletPrepare({ fromWallet: OTHER_WALLET, amountBaseUnits: "1000000", idempotencyKey: UUID_KEY }),
  transferSubmit: () => c.transferSubmit({ transferId: "40000000-0000-4000-8000-000000000001", signedTransaction: "AAAA" }),
  transferStatus: () => c.transferStatus({ transferId: "40000000-0000-4000-8000-000000000001" }),
});

describe("MONEY_CALLS_ENABLED=admins", () => {
  test("a non-admin, and a session with no account, get exactly the flag-off answer on every route", async () => {
    const off = await rig({});
    const admins = await rig({ MONEY_CALLS_ENABLED: "admins" });
    for (const token of ["other", "nobody", undefined]) {
      const offCalls = moneyCalls(moneyRouter.createCaller(off.as(token)));
      const adminCalls = moneyCalls(moneyRouter.createCaller(admins.as(token)));
      for (const name of Object.keys(offCalls) as (keyof typeof offCalls)[]) {
        const expected = await outcome(offCalls[name]);
        expect({ token, name, got: await outcome(adminCalls[name]) }).toEqual({ token, name, got: expected });
      }
    }
    expect(await outcome(moneyCalls(moneyRouter.createCaller(off.as("other"))).wallet))
      .toEqual({ code: "PRECONDITION_FAILED", message: "Calls with money aren't available yet." });
  });

  test("an admin gets money calls: status per account, and the routes run", async () => {
    const r = await rig({ MONEY_CALLS_ENABLED: "admins" });
    const admin = moneyRouter.createCaller(r.as("admin"));
    const status = await admin.status();
    // On for this account; Panta trading itself is not configured on this test server.
    expect(status).toMatchObject({ reason: "Calls with money are paused right now.", defaultAmountBaseUnits: "10000000" });
    expect(await moneyRouter.createCaller(r.as("other")).status())
      .toMatchObject({ enabled: false, reason: "Calls with money aren't available yet.", defaultAmountBaseUnits: null });
    const options = await admin.depositOptions();
    expect(options.tradingWallet?.address).toBe(ADMIN_WALLET);
    expect(options.sendUsdc?.address).toBe(ADMIN_WALLET);
  });

  test("calls show money only to viewers the rollout includes; nobody else sees amounts, ordering or counts", async () => {
    const r = moneyRig();
    const calls = new CallsService({ store: r.h.calls, markets: r.h.rt.markets, clock: r.h.clock, moneyCalls: r.index, funding: r.funding,
      moneyFor: viewer => viewer === "ann" });
    const out = await r.money.prepareCall(depositPerson("ann"), own("m"));
    if (out.status !== "READY") throw new Error(out.status);
    r.h.clock.advance(60_000);
    const free = calls.createCall({ marketId: "n", side: "NO" }, "ann");
    r.panta.submit(out.trade.order.orderId);
    r.panta.fill(out.trade.order.orderId);
    await new Promise(resolve => setTimeout(resolve, 0));
    const id = out.call.call.id;
    expect(calls.getCall({ callId: id }, "ann").entry.funding).toMatchObject({ amountBaseUnits: "5000000", side: "YES" });
    expect(calls.getCall({ callId: id }, "bob").entry.funding).toEqual(expect.objectContaining({ state: "FILLED" }));
    expect(calls.getCall({ callId: id }, "bob").entry.funding).not.toHaveProperty("amountBaseUnits");
    expect(calls.getCall({ callId: id }, null).entry.funding).not.toHaveProperty("side");
    // Funded first only for the admin viewer; newest first for everyone else, as with it off.
    expect(calls.getPerson({ personRef: "ann" }, "ann").calls.map(e => e.call.id)).toEqual([id, free.call.id]);
    expect(calls.getPerson({ personRef: "ann" }, "bob").calls.map(e => e.call.id)).toEqual([free.call.id, id]);
    expect(calls.leaderboard({ window: "all" }, "ann").viewer?.fundedCalls).toBe(1);
    expect(calls.leaderboard({ window: "all" }, "bob").viewer).not.toHaveProperty("fundedCalls");
  });
});

describe("CHUMBUCKET_WALLET_ENABLED=admins", () => {
  const routes = (c: ReturnType<typeof walletRouter.createCaller>) => ({
    status: () => c.status(), balance: () => c.balance(), privyToken: () => c.privyToken(),
  });
  test("a non-admin, and a session with no account, get exactly the flag-off answer: no Privy, no balance", async () => {
    const off = await rig({});
    const admins = await rig({ CHUMBUCKET_WALLET_ENABLED: "admins" });
    for (const token of ["other", "nobody", undefined]) {
      const a = routes(walletRouter.createCaller(off.as(token)));
      const b = routes(walletRouter.createCaller(admins.as(token)));
      for (const name of ["status", "balance", "privyToken"] as const) {
        expect({ token, name, got: await outcome(b[name]) }).toEqual({ token, name, got: await outcome(a[name]) });
      }
    }
    expect(await walletRouter.createCaller(admins.as("other")).status()).toEqual({ enabled: false, account: null });
  });

  test("an admin gets the wallet, its balance and a Privy token for its own account", async () => {
    const r = await rig({ CHUMBUCKET_WALLET_ENABLED: "admins" });
    const admin = walletRouter.createCaller(r.as("admin"));
    expect(await admin.status()).toEqual({ enabled: true, account: { tradingWallet: { address: ADMIN_WALLET, walletType: "chumbucket" }, chumbucketWallet: ADMIN_WALLET } });
    expect(await admin.balance()).toMatchObject({ wallet: ADMIN_WALLET, usdcBaseUnits: "2500000" });
    const { token } = await admin.privyToken();
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { sub: string };
    expect(payload.sub).toBe(ADMIN);
    expect(chumbucketWalletFor(r.cfg, ADMIN)).toBe(true);
    expect(chumbucketWalletFor(r.cfg, OTHER)).toBe(false);
  });

  test("the chumbucket label is accepted for an admin's proof only", async () => {
    const cfg = loadConfig({ CHUMBUCKET_WALLET_ENABLED: "admins", TRUST_ADMIN_USER_IDS: ADMIN });
    const store = new FakeIdentityStore().addUser("auth-admin", ADMIN).addUser("auth-other", OTHER);
    const verifier = new FakeJwtVerifier().issue("admin", "auth-admin").issue("other", "auth-other");
    const service = new WalletLinkService({ store, verifier, policy: testPolicy, chumbucketWallet: perAccount(cfg, "admins") });
    for (const [token, expected] of [["other", "WALLET_TYPE_UNAVAILABLE"], ["admin", "linked"]] as const) {
      const wallet = makeWallet();
      const issued = await service.requestWalletNonce({ accessToken: token, address: wallet.address, domain: TEST_DOMAIN, uri: TEST_URI });
      const got = await outcome(() => service.linkWallet({ accessToken: token, address: wallet.address, message: issued.message,
        signature: signMessage(wallet.privateKey, issued.message), walletType: "chumbucket" }));
      expect(JSON.stringify(got)).toContain(expected);
    }
  });
});

/** Answers as the linking SQL would, and records what it was asked. */
class Links implements AccountLinkStore {
  calls: string[] = [];
  walletOwner: string | null = null;
  into = ADMIN;
  private data: AccountSignIns = { signIns: [], wallets: [] };
  async resolveWalletSignIn() { this.calls.push("resolveWalletSignIn"); return { ok: true, user_id: this.walletOwner ?? "", outcome: "linked" } as StoreResult; }
  async walletSignInConflict() { this.calls.push("walletSignInConflict"); return false; }
  async signIns() { this.calls.push("signIns"); return this.data; }
  async unlink() { this.calls.push("unlink"); return { ok: true, sign_ins: 0, wallets: 0 } as StoreResult; }
  async issueTicket() { this.calls.push("issueTicket"); return { ok: true, expires_at: "2026-10-04T10:10:00.000Z" } as StoreResult; }
  async preview() { this.calls.push("preview"); return { ok: true, outcome: "fold", into_user_id: this.into, other_user_id: OTHER, method: "x" } as StoreResult; }
  async complete(input: { allowLink: boolean; allowFold: boolean }) {
    this.calls.push(`complete:${input.allowLink}:${input.allowFold}`);
    return { ok: true, outcome: "folded", user_id: this.into, folded_user_id: OTHER } as StoreResult;
  }
  async cards(ids: string[]) { return ids.map(userId => ({ userId, handle: null, displayName: null })); }
  async walletAccount() { this.calls.push("walletAccount"); return this.walletOwner; }
}

/** A store whose sessions may be ADDITIONAL sign-ins (linking), like resolve_auth_user_v1. */
class LinkedStore extends FakeIdentityStore {
  additional = new Map<string, string>();
  async resolveAuthUser(authUserId: string) {
    const primary = await this.userIdForAuthUser(authUserId);
    if (primary) return { userId: primary, additional: false };
    const extra = this.additional.get(authUserId) ?? null;
    return { userId: extra, additional: extra !== null };
  }
}

describe("ACCOUNT_LINKING_ENABLED / ACCOUNT_FOLD_ENABLED=admins", () => {
  function linkRig(foldRollout: "on" | "admins" | "off" = "admins") {
    const cfg = loadConfig({ ACCOUNT_LINKING_ENABLED: "admins", ACCOUNT_FOLD_ENABLED: foldRollout === "on" ? "true" : foldRollout, TRUST_ADMIN_USER_IDS: ADMIN });
    const store = new LinkedStore().addUser("auth-admin", ADMIN).addUser("auth-other", OTHER);
    store.additional.set("auth-admin-x", ADMIN).set("auth-other-x", OTHER);
    const wallet = makeWallet();
    const verifier = new FakeJwtVerifier().issue("admin", "auth-admin").issue("other", "auth-other")
      .issue("admin-x", "auth-admin-x").issue("other-x", "auth-other-x").issue("fresh-wallet", "auth-fresh", wallet.address).issue("new", "auth-new");
    const links = new Links();
    const identity = new WalletLinkService({ store, verifier, policy: testPolicy, accountLinks: links, accountLinking: perAccount(cfg, "admins") });
    const service = new AccountLinkService({ identity, links, verifier, linking: perAccount(cfg, "admins"),
      fold: perAccount(cfg, foldRollout), makeTicket: () => "ab".repeat(32) });
    const offIdentity = new WalletLinkService({ store, verifier, policy: testPolicy, accountLinks: links, accountLinking: false });
    const offService = new AccountLinkService({ identity: offIdentity, links, verifier, linking: false, fold: false, makeTicket: () => "ab".repeat(32) });
    return { cfg, store, links, identity, service, offIdentity, offService, wallet };
  }

  test("an additional sign-in reaches an admin's account; for anyone else it is exactly as with linking off", async () => {
    const r = linkRig();
    expect(await r.identity.authenticate("admin-x")).toEqual({ authUserId: "auth-admin-x", userId: ADMIN });
    expect(await outcome(() => r.identity.authenticate("other-x"))).toEqual(await outcome(() => r.offIdentity.authenticate("other-x")));
    expect(JSON.stringify(await outcome(() => r.identity.authenticate("other-x")))).toContain("AUTH_USER_UNLINKED");
    // Primary sign-ins are untouched either way.
    expect((await r.identity.authenticate("other")).userId).toBe(OTHER);
  });

  test("a linked wallet's sign-in lands on an admin's account; a non-admin's wallet binds nothing", async () => {
    const r = linkRig();
    r.links.walletOwner = OTHER;
    expect(JSON.stringify(await outcome(() => r.identity.authenticate("fresh-wallet", { carry: true })))).toContain("AUTH_USER_UNLINKED");
    expect(r.links.calls).toEqual(["walletAccount"]);
    r.links.calls = [];
    r.links.walletOwner = ADMIN;
    expect(await r.identity.authenticate("fresh-wallet", { carry: true })).toEqual({ authUserId: "auth-fresh", userId: ADMIN });
    expect(r.links.calls).toEqual(["walletAccount", "resolveWalletSignIn"]);
  });

  test("the sign-in methods status and every linking route answer per account", async () => {
    const r = linkRig();
    expect(await r.service.signInMethods("admin")).toMatchObject({ linking: true, fold: true });
    expect(await r.service.signInMethods("other")).toMatchObject({ linking: false, fold: false });
    expect(await r.service.signInMethods("other")).toEqual(await r.offService.signInMethods("other"));
    for (const [name, fn, offFn] of [
      ["startLink", () => r.service.startLink("other", "x"), () => r.offService.startLink("other", "x")],
      ["startLink signed out", () => r.service.startLink("nobody", "x"), () => r.offService.startLink("nobody", "x")],
      ["unlink", () => r.service.unlink("other", `w:${OTHER_WALLET}`), () => r.offService.unlink("other", `w:${OTHER_WALLET}`)],
    ] as const) {
      expect({ name, got: await outcome(fn) }).toEqual({ name, got: await outcome(offFn) });
    }
    expect(r.links.calls.filter(c => c === "issueTicket" || c === "unlink")).toEqual([]);
    expect((await r.service.startLink("admin", "x")).method).toBe("x");
    // A ticket into a non-admin account can't exist; if one is presented, the flag-off refusal.
    r.links.into = OTHER;
    expect(JSON.stringify(await outcome(() => r.service.previewLink("new", "ab".repeat(32))))).toContain("ACCOUNT_LINKING_DISABLED");
    expect(JSON.stringify(await outcome(() => r.service.completeLink("new", "ab".repeat(32), { outcome: "fold", otherUserId: OTHER }))))
      .toContain("ACCOUNT_LINKING_DISABLED");
    r.links.into = ADMIN;
    expect((await r.service.previewLink("new", "ab".repeat(32))).refusal).toBeNull();
    await r.service.completeLink("new", "ab".repeat(32), { outcome: "fold", otherUserId: OTHER });
    expect(r.links.calls.at(-1)).toBe("complete:true:true");
  });

  test("fold off while linking is admins: an admin links but never folds", async () => {
    const r = linkRig("off");
    expect(await r.service.signInMethods("admin")).toMatchObject({ linking: true, fold: false });
    expect((await r.service.previewLink("new", "ab".repeat(32))).refusal).toBe("ACCOUNT_FOLD_DISABLED");
    await r.service.completeLink("new", "ab".repeat(32), { outcome: "fold", otherUserId: OTHER });
    expect(r.links.calls.at(-1)).toBe("complete:true:false");
  });

  test("auth.identityStatus answers per account from the session; with no session, as flag-off", async () => {
    const cfg = loadConfig({ SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only",
      ACCOUNT_LINKING_ENABLED: "admins", ACCOUNT_FOLD_ENABLED: "admins", TRUST_ADMIN_USER_IDS: ADMIN });
    const app = await createApp({ config: cfg });
    const store = new FakeIdentityStore().addUser("auth-admin", ADMIN).addUser("auth-other", OTHER);
    const verifier = new FakeJwtVerifier().issue("admin", "auth-admin").issue("other", "auth-other");
    primeAuthIdentityRuntime(cfg, { store, verifier, policy: resolveAuthIdentityPolicy(cfg), accountLinks: new Links(),
      accountLinking: false, accountFold: false, accountLinkingRollout: "admins", accountFoldRollout: "admins" });
    const status = (token?: string) => authRouter.createCaller({ app, ...(token ? { supabaseAccessToken: token } : {}) }).identityStatus();
    expect(await status("admin")).toMatchObject({ accountLinking: true, accountFold: true });
    expect(await status("other")).toMatchObject({ accountLinking: false, accountFold: false });
    expect(await status()).toMatchObject({ accountLinking: false, accountFold: false });
  });
});
