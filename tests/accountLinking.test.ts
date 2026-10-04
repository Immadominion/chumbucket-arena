/**
 * One account, many sign-ins: the BFF side of 20261004120000_account_sign_ins.sql.
 *
 * The SQL itself (every move, copy, refusal and grant) is proven on a real
 * PostgreSQL in accountSignIns.postgres.test.ts. Here: what Settings is shown
 * and may unlink, that both sides of a link are verified sessions, that the
 * ticket plaintext never reaches the store, that every switch is off unless
 * set, that a linked wallet's sign-in lands on its account only when linking
 * is on, that a wallet which already signs in elsewhere is never linked, and
 * the transport (no redirects, a missing function is never a guess).
 */

import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { authRouter } from "../src/api/authRoutes.ts";
import { AuthIdentityError } from "../src/auth/AuthIdentityError.ts";
import { AccountLinkService, signInMethodRows } from "../src/auth/AccountLinkService.ts";
import {
  SupabaseAccountLinkStore,
  type AccountCard,
  type AccountLinkStore,
  type AccountSignIns,
  type LinkMethod,
} from "../src/auth/AccountLinkStore.ts";
import { primeAuthIdentityRuntime } from "../src/auth/AuthIdentityRuntime.ts";
import { SupabaseIdentityStore, type StoreResult } from "../src/auth/IdentityStore.ts";
import { latestAmrMethod } from "../src/auth/SupabaseJwt.ts";
import { hashNonce, WalletLinkService } from "../src/auth/WalletLinkService.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import {
  FakeIdentityStore,
  FakeJwtVerifier,
  makeWallet,
  signMessage,
  TEST_DOMAIN,
  TEST_URI,
  testPolicy,
} from "./authIdentityFixtures.ts";

const policy = { ...testPolicy, allowedDomains: [...testPolicy.allowedDomains], allowedUris: [...testPolicy.allowedUris] };
const DEV_WALLET = "F7rhCwoPyU5H1p48sddDmGb1ax25CwmxiwHL8Xj5RJ3E";
const OTHER_WALLET = "7KGuuhZy8cYctGcGxjt91atS7A5aZobNhmUAxVLJgVCL";
const SIGN_IN = "5a1e0000-0000-4000-8000-000000000001";

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    if (e instanceof AuthIdentityError) return e.code;
    if (e instanceof TRPCError) return e.message;
    return `UNEXPECTED ${String(e)}`;
  }
}

/** The owner's account after the fold: the wallet's own sign-in, plus the
 *  Google+X sign-in that came with @dominion. */
const ownerSignIns = (): AccountSignIns => ({
  signIns: [
    {
      authUserId: "auth-dev",
      primary: true,
      signInId: null,
      via: "primary",
      identities: [{ identityId: "id-web3", provider: "web3", label: DEV_WALLET, lastSignInAt: "2026-10-04T09:00:00Z" }],
    },
    {
      authUserId: "auth-dominion",
      primary: false,
      signInId: SIGN_IN,
      via: "fold",
      identities: [
        { identityId: "id-google", provider: "google", label: "owner@example.com", lastSignInAt: "2026-10-03T09:00:00Z" },
        { identityId: "id-x", provider: "x", label: "ownerx", lastSignInAt: "2026-10-04T10:00:00Z" },
      ],
    },
  ],
  wallets: [{ address: DEV_WALLET, walletType: "mwa", isPrimary: true }],
});

describe("Settings → Sign-in methods rows", () => {
  test("signed in with the wallet: the wallet is current and stays; X and Google go together", () => {
    const rows = signInMethodRows(ownerSignIns(), { authUserId: "auth-dev", signInMethod: "web3" });
    expect(rows.map((r) => [r.kind, r.label, r.current])).toEqual([
      ["wallet", DEV_WALLET, true],
      ["x", "ownerx", false],
      ["google", "owner@example.com", false],
    ]);
    expect(rows[0]!.unlink).toBeNull();
    expect(rows[1]).toMatchObject({ unlink: { mode: "server", ref: `s:${SIGN_IN}` }, alsoUnlinks: ["google"] });
    expect(rows[2]).toMatchObject({ unlink: { mode: "server", ref: `s:${SIGN_IN}` }, alsoUnlinks: ["x"] });
  });

  test("signed in with X: X is current; X and Google unlink natively; the account's wallet never", () => {
    const rows = signInMethodRows(ownerSignIns(), { authUserId: "auth-dominion", signInMethod: "oauth" });
    expect(rows.find((r) => r.current)?.kind).toBe("x");
    expect(rows.find((r) => r.kind === "x")!.unlink).toEqual({ mode: "native", identityId: "id-x" });
    expect(rows.find((r) => r.kind === "google")!.unlink).toEqual({ mode: "native", identityId: "id-google" });
    expect(rows.find((r) => r.kind === "wallet")!.unlink).toBeNull();
  });

  test("the only way in can never be unlinked; a session with no amr still finds itself", () => {
    const data: AccountSignIns = {
      signIns: [{ ...ownerSignIns().signIns[0]! }],
      wallets: [],
    };
    const rows = signInMethodRows(data, { authUserId: "auth-dev" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "wallet", current: true, unlink: null });
  });

  test("a wallet linked with a proof but never signed in is a row of its own, unlinkable", () => {
    const data = ownerSignIns();
    data.wallets.push({ address: OTHER_WALLET, walletType: "mwa", isPrimary: false });
    const rows = signInMethodRows(data, { authUserId: "auth-dev", signInMethod: "web3" });
    const linked = rows.find((r) => r.label === OTHER_WALLET)!;
    expect(linked).toMatchObject({ id: `w:${OTHER_WALLET}`, kind: "wallet", current: false });
    expect(linked.unlink).toEqual({ mode: "server", ref: `w:${OTHER_WALLET}` });
    // Each wallet once, even when it is both a sign-in and a linked wallet.
    expect(rows.filter((r) => r.label === DEV_WALLET)).toHaveLength(1);
  });

  test("the token's newest amr entry is the method; junk is nothing", () => {
    const token = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    expect(latestAmrMethod(token({ amr: [{ method: "oauth", timestamp: 1 }, { method: "web3", timestamp: 2 }] }))).toBe("web3");
    expect(latestAmrMethod(token({ amr: [{ method: "<script>", timestamp: 3 }] }))).toBeUndefined();
    expect(latestAmrMethod(token({}))).toBeUndefined();
    expect(latestAmrMethod("not-a-jwt")).toBeUndefined();
  });
});

/** Records what the service hands the store; answers as the SQL would. */
class RecordingLinks implements AccountLinkStore {
  calls: { name: string; input: unknown }[] = [];
  answers: Partial<Record<string, StoreResult>> = {};
  conflict = false;
  constructor(private readonly data: AccountSignIns = ownerSignIns()) {}
  private answer(name: string, input: unknown, fallback: StoreResult): StoreResult {
    this.calls.push({ name, input });
    return this.answers[name] ?? fallback;
  }
  async resolveWalletSignIn(authUserId: string, walletAddress: string) {
    return this.answer("resolveWalletSignIn", { authUserId, walletAddress }, { ok: false, reason: "no_link" });
  }
  async walletSignInConflict(userId: string, walletAddress: string) {
    this.calls.push({ name: "walletSignInConflict", input: { userId, walletAddress } });
    return this.conflict;
  }
  async signIns(userId: string) {
    this.calls.push({ name: "signIns", input: userId });
    return this.data;
  }
  async unlink(input: unknown) {
    return this.answer("unlink", input, { ok: true, outcome: "unlinked", sign_ins: 1, wallets: 0 });
  }
  async issueTicket(input: { method: LinkMethod; ticketHash: string }) {
    return this.answer("issueTicket", input, { ok: true, expires_at: "2026-10-04T10:10:00.000Z" });
  }
  async preview(ticketHash: string, authUserId: string) {
    return this.answer("preview", { ticketHash, authUserId }, {
      ok: true, outcome: "fold", into_user_id: "user-dev", other_user_id: "user-dominion", refusal: null,
    });
  }
  async complete(input: unknown) {
    return this.answer("complete", input, {
      ok: true, outcome: "folded", user_id: "user-dev", folded_user_id: "user-dominion",
      summary: { follows: [["user-dev", "user-friend"], ["bad"]] },
    });
  }
  async cards(userIds: string[]): Promise<AccountCard[]> {
    this.calls.push({ name: "cards", input: userIds });
    return userIds.map((id) => ({ userId: id, handle: id.replace("user-", ""), displayName: null }));
  }
}

function linkRig(opts: { linking?: boolean; fold?: boolean; links?: RecordingLinks } = {}) {
  const store = new FakeIdentityStore().addUser("auth-dev", "user-dev").addUser("auth-dominion", "user-dominion");
  const verifier = new FakeJwtVerifier()
    .issue("tok-dev", "auth-dev", DEV_WALLET)
    .issue("tok-dominion", "auth-dominion")
    .issue("tok-new", "auth-new");
  const links = opts.links ?? new RecordingLinks();
  const identity = new WalletLinkService({ store, verifier, policy, accountLinks: links, accountLinking: opts.linking ?? true });
  const service = new AccountLinkService({
    identity,
    links,
    verifier,
    linking: opts.linking ?? true,
    fold: opts.fold ?? true,
    makeTicket: () => "ab".repeat(32),
  });
  return { service, links, store };
}

describe("AccountLinkService", () => {
  test("every change is off unless linking is on; the list still answers", async () => {
    const { service, links } = linkRig({ linking: false });
    for (const fn of [
      () => service.unlink("tok-dev", `s:${SIGN_IN}`),
      () => service.startLink("tok-dev", "x"),
      () => service.previewLink("tok-dominion", "ab".repeat(32)),
      () => service.completeLink("tok-dominion", "ab".repeat(32)),
    ]) expect(await codeOf(fn)).toBe("ACCOUNT_LINKING_DISABLED");
    const listed = await service.signInMethods("tok-dev");
    expect(listed).toMatchObject({ linking: false, fold: false });
    expect(listed.methods).toHaveLength(3);
    expect(links.calls.map((c) => c.name)).toEqual(["signIns"]);
  });

  test("the list is the verified caller's own account, never one it names", async () => {
    const { service, links } = linkRig();
    expect(await codeOf(() => service.signInMethods("forged"))).toBe("AUTH_TOKEN_INVALID");
    expect(await codeOf(() => service.signInMethods("tok-new"))).toBe("AUTH_USER_UNLINKED");
    await service.signInMethods("tok-dominion");
    expect(links.calls.at(-1)).toEqual({ name: "signIns", input: "user-dominion" });
  });

  test("a ticket is issued to the verified account; only its hash reaches the store", async () => {
    const { service, links } = linkRig();
    const ticket = await service.startLink("tok-dev", "x");
    expect(ticket).toEqual({ ticket: "ab".repeat(32), method: "x", expiresAt: "2026-10-04T10:10:00.000Z" });
    const issued = links.calls.find((c) => c.name === "issueTicket")!.input as Record<string, unknown>;
    expect(issued).toEqual({
      userId: "user-dev", authUserId: "auth-dev", method: "x", ticketHash: hashNonce("ab".repeat(32)), ttlSeconds: 600,
    });
    expect(JSON.stringify(links.calls)).not.toContain(`"${"ab".repeat(32)}"`);
    links.answers.issueTicket = { ok: false, reason: "rate_limited" };
    expect(await codeOf(() => service.startLink("tok-dev", "x"))).toBe("LINK_RATE_LIMITED");
  });

  test("preview and complete need the other side's verified session, and say why not", async () => {
    const { service, links } = linkRig();
    const ticket = "ab".repeat(32);
    expect(await codeOf(() => service.previewLink("forged", ticket))).toBe("AUTH_TOKEN_INVALID");
    expect(await codeOf(() => service.completeLink("", ticket))).toBe("AUTH_TOKEN_MISSING");
    // The other side need not have an account (a sign-in about to be added).
    const preview = await service.previewLink("tok-new", ticket);
    expect(links.calls.find((c) => c.name === "preview")!.input).toEqual({ ticketHash: hashNonce(ticket), authUserId: "auth-new" });
    expect(preview).toMatchObject({
      outcome: "fold",
      into: { userId: "user-dev", handle: "dev" },
      from: { userId: "user-dominion", handle: "dominion" },
      refusal: null,
    });
    links.answers.preview = { ok: true, outcome: "fold", into_user_id: "user-dev", other_user_id: "user-money", refusal: "has_money" };
    expect((await service.previewLink("tok-new", ticket)).refusal).toBe("ACCOUNT_HAS_MONEY");
    links.answers.preview = { ok: false, reason: "ticket_expired" };
    expect(await codeOf(() => service.previewLink("tok-new", ticket))).toBe("LINK_TICKET_INVALID");

    const done = await service.completeLink("tok-dominion", ticket);
    expect(links.calls.find((c) => c.name === "complete")!.input).toEqual({
      ticketHash: hashNonce(ticket), authUserId: "auth-dominion", allowLink: true, allowFold: true,
    });
    expect(done).toEqual({ outcome: "folded", userId: "user-dev", foldedUserId: "user-dominion", follows: [["user-dev", "user-friend"]] });
    for (const [reason, code] of [
      ["has_money", "ACCOUNT_HAS_MONEY"],
      ["ticket_used", "LINK_TICKET_INVALID"],
      ["method_mismatch", "LINK_METHOD_MISMATCH"],
      ["fold_disabled", "ACCOUNT_FOLD_DISABLED"],
      ["already_folded", "ACCOUNT_NOT_FOLDABLE"],
    ] as const) {
      links.answers.complete = { ok: false, reason };
      expect(await codeOf(() => service.completeLink("tok-dominion", ticket))).toBe(code);
    }
  });

  test("folding is its own switch: off, the store is told so and the preview says so", async () => {
    const { service, links } = linkRig({ fold: false });
    expect((await service.previewLink("tok-dominion", "ab".repeat(32))).refusal).toBe("ACCOUNT_FOLD_DISABLED");
    await service.completeLink("tok-dominion", "ab".repeat(32));
    expect(links.calls.find((c) => c.name === "complete")!.input).toMatchObject({ allowLink: true, allowFold: false });
  });

  test("unlink takes only the refs the list gives, for the caller's own account", async () => {
    const { service, links } = linkRig();
    for (const ref of ["x", "s:not-a-uuid", "w:not-a-wallet", `u:${SIGN_IN}`]) {
      expect(await codeOf(() => service.unlink("tok-dev", ref))).toBe("SIGN_IN_NOT_FOUND");
    }
    expect(links.calls).toHaveLength(0);
    expect(await service.unlink("tok-dev", `s:${SIGN_IN}`)).toEqual({ signIns: 1, wallets: 0 });
    expect(links.calls[0]).toEqual({
      name: "unlink", input: { userId: "user-dev", sessionAuthUserId: "auth-dev", signInId: SIGN_IN },
    });
    await service.unlink("tok-dev", `w:${OTHER_WALLET}`);
    expect(links.calls[1]!.input).toEqual({ userId: "user-dev", sessionAuthUserId: "auth-dev", wallet: OTHER_WALLET });
    links.answers.unlink = { ok: false, reason: "current_sign_in" };
    expect(await codeOf(() => service.unlink("tok-dev", `s:${SIGN_IN}`))).toBe("SIGN_IN_IN_USE");
    links.answers.unlink = { ok: false, reason: "primary_sign_in" };
    expect(await codeOf(() => service.unlink("tok-dev", `w:${DEV_WALLET}`))).toBe("SIGN_IN_IN_USE");
  });
});

describe("a wallet's sign-in and a wallet's link", () => {
  function walletRig(linking: boolean) {
    const store = new FakeIdentityStore().addUser("auth-x", "user-x");
    const wallet = makeWallet();
    const verifier = new FakeJwtVerifier().issue("tok-x", "auth-x").issue("tok-wallet", "auth-wallet", wallet.address);
    const links = new RecordingLinks();
    const service = new WalletLinkService({ store, verifier, policy, accountLinks: links, accountLinking: linking });
    return { store, links, service, wallet };
  }

  test("a wallet linked to an account signs in to it — only when linking is on", async () => {
    const off = walletRig(false);
    expect(await codeOf(() => off.service.authenticate("tok-wallet"))).toBe("AUTH_USER_UNLINKED");
    expect(off.links.calls).toHaveLength(0);

    const on = walletRig(true);
    on.links.answers.resolveWalletSignIn = { ok: true, user_id: "user-x", outcome: "linked" };
    expect(await on.service.authenticate("tok-wallet")).toEqual({ authUserId: "auth-wallet", userId: "user-x" });
    expect(on.links.calls[0]).toEqual({
      name: "resolveWalletSignIn", input: { authUserId: "auth-wallet", walletAddress: on.wallet.address },
    });
    // A Google/X session never asks.
    await on.service.authenticate("tok-x");
    expect(on.links.calls).toHaveLength(1);
  });

  test("a sign-in that already reaches an account never gets a second one", async () => {
    const r = walletRig(true);
    r.links.answers.resolveWalletSignIn = { ok: true, user_id: "user-x", outcome: "linked" };
    r.store.addUser("auth-wallet", "user-x");
    expect(await r.service.createProfile({ accessToken: "tok-wallet", displayName: "Again", handle: "again" }))
      .toEqual({ authUserId: "auth-wallet", userId: "user-x" });
    expect(await r.store.usernameStatus("again")).toBe("available");
  });

  test("a wallet that signs in to another account is refused before its challenge is spent", async () => {
    const r = walletRig(true);
    const issued = await r.service.requestWalletNonce({
      accessToken: "tok-x", address: r.wallet.address, domain: TEST_DOMAIN, uri: TEST_URI,
    });
    const signature = signMessage(r.wallet.privateKey, issued.message);
    const link = () => r.service.linkWallet({ accessToken: "tok-x", address: r.wallet.address, message: issued.message, signature });
    r.links.conflict = true;
    expect(await codeOf(link)).toBe("WALLET_OWNED_BY_ANOTHER_USER");
    expect(r.store.walletOwner(r.wallet.address)).toBeUndefined();
    // The same proof still works once there is no conflict: nothing was spent.
    r.links.conflict = false;
    expect((await link()).outcome).toBe("linked");
    expect(r.store.walletOwner(r.wallet.address)).toBe("user-x");
  });
});

describe("routes and switches", () => {
  async function routeRig(env: Record<string, string>) {
    const config = loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      SOLANA_NETWORK: "devnet",
      ...env,
    });
    const app = await createApp({ config });
    const links = new RecordingLinks();
    const store = new FakeIdentityStore().addUser("auth-dev", "user-dev");
    const verifier = new FakeJwtVerifier().issue("tok-dev", "auth-dev", DEV_WALLET);
    primeAuthIdentityRuntime(config, {
      store, verifier, policy,
      accountLinks: links,
      accountLinking: config.authIdentity?.accountLinkingEnabled === true,
      accountFold: config.authIdentity?.accountFoldEnabled === true,
    });
    return { caller: authRouter.createCaller({ app }), links };
  }

  test("both switches are off by default, and only the exact word turns them on", async () => {
    expect(loadConfig({}).authIdentity?.accountLinkingEnabled ?? false).toBe(false);
    expect(loadConfig({ ACCOUNT_LINKING_ENABLED: "1", ACCOUNT_FOLD_ENABLED: "yes" }).authIdentity)
      .toMatchObject({ accountLinkingEnabled: false, accountFoldEnabled: false });
    const off = await routeRig({});
    expect(await off.caller.identityStatus()).toMatchObject({ accountLinking: false, accountFold: false });
    // Fold alone is not enough: there is nothing to fold into without linking.
    const foldOnly = await routeRig({ ACCOUNT_FOLD_ENABLED: "true" });
    expect(await foldOnly.caller.identityStatus()).toMatchObject({ accountLinking: false, accountFold: false });
    const on = await routeRig({ ACCOUNT_LINKING_ENABLED: "true", ACCOUNT_FOLD_ENABLED: "true" });
    expect(await on.caller.identityStatus()).toMatchObject({ accountLinking: true, accountFold: true });
  });

  test("inputs are strict: no account, user or auth id can be named", async () => {
    const { caller } = await routeRig({ ACCOUNT_LINKING_ENABLED: "true" });
    for (const extra of [{ userId: "user-x" }, { authUserId: "auth-x" }]) {
      expect(await codeOf(() => caller.signInMethods({ supabaseAccessToken: "tok-dev", ...extra } as never))).not.toBe("NO_ERROR");
      expect(await codeOf(() => caller.startSignInLink({ supabaseAccessToken: "tok-dev", method: "x", ...extra } as never))).not.toBe("NO_ERROR");
    }
    expect(await codeOf(() => caller.previewSignInLink({ supabaseAccessToken: "tok-dev", ticket: "short" }))).not.toBe("NO_ERROR");
    const listed = await caller.signInMethods({ supabaseAccessToken: "tok-dev" });
    expect(listed.linking).toBe(true);
    expect(listed.methods.find((m) => m.current)?.kind).toBe("wallet");
    const done = await caller.completeSignInLink({ supabaseAccessToken: "tok-dev", ticket: "ab".repeat(32) });
    // Only the outcome and the account: no follows, no ids of other sign-ins.
    expect(done).toEqual({ outcome: "folded", userId: "user-dev" });
  });
});

describe("transport", () => {
  const cfg = { supabaseUrl: "https://db.test.invalid", serviceRoleKey: "sk_test_service_role", network: "devnet" as const };
  function stub(respond: (name: string, body: Record<string, unknown>) => Response) {
    const seen: { name: string; body: Record<string, unknown>; redirect: RequestInit["redirect"] }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const name = url.pathname.replace("/rest/v1/rpc/", "").replace("/rest/v1/", "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      seen.push({ name, body, redirect: init?.redirect });
      return respond(name, body);
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const missing = () => new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 });

  test("an additional sign-in resolves through the database; before the migration, none", async () => {
    const id = "77777777-7777-4777-8777-777777777777";
    const s = stub((name) => (name === "users" ? ok([]) : ok({ ok: true, user_id: id, via: "additional" })));
    expect(await new SupabaseIdentityStore(cfg, s.fetchImpl).userIdForAuthUser("auth-b")).toBe(id);
    expect(s.seen.map((x) => x.name)).toEqual(["users", "resolve_auth_user_v1"]);
    expect(s.seen[1]!.body).toEqual({ p_auth_user_id: "auth-b" });
    const old = stub((name) => (name === "users" ? ok([]) : missing()));
    expect(await new SupabaseIdentityStore(cfg, old.fetchImpl).userIdForAuthUser("auth-b")).toBeNull();
    const broken = stub((name) => (name === "users" ? ok([]) : new Response("secret-ish", { status: 500 })));
    expect(await codeOf(() => new SupabaseIdentityStore(cfg, broken.fetchImpl).userIdForAuthUser("auth-b"))).toBe("IDENTITY_STORE_ERROR");
    // A primary sign-in never asks.
    const primary = stub(() => ok([{ id }]));
    await new SupabaseIdentityStore(cfg, primary.fetchImpl).userIdForAuthUser("auth-a");
    expect(primary.seen).toHaveLength(1);
  });

  test("the link store sends snake_case to the right functions, never follows a redirect", async () => {
    const s = stub((name) =>
      name === "account_sign_ins_v1"
        ? ok({
            ok: true,
            sign_ins: [{ auth_user_id: "a0000000-0000-4000-8000-000000000001", primary: true, sign_in_id: null, via: "primary",
              identities: [{ identity_id: "i1", provider: "web3", label: DEV_WALLET, last_sign_in_at: null }] },
              { auth_user_id: "not-a-uuid", identities: [] }],
            wallets: [{ address: DEV_WALLET, wallet_type: "mwa", is_primary: true }],
          })
        : name === "wallet_sign_in_conflict_v1" ? missing()
        : ok({ ok: true }),
    );
    const store = new SupabaseAccountLinkStore(cfg, s.fetchImpl);
    const listed = await store.signIns("user-dev");
    expect(listed.signIns).toHaveLength(1);
    expect(listed.signIns[0]!.identities[0]).toEqual({ identityId: "i1", provider: "web3", label: DEV_WALLET, lastSignInAt: null });
    expect(await store.walletSignInConflict("user-dev", DEV_WALLET)).toBe(false);
    await store.complete({ ticketHash: "c".repeat(64), authUserId: "auth-b", allowLink: true, allowFold: false });
    expect(s.seen.at(-1)).toMatchObject({
      name: "complete_account_link_v1",
      body: { p_ticket_hash: "c".repeat(64), p_auth_user_id: "auth-b", p_allow_link: true, p_allow_fold: false },
    });
    expect(s.seen.every((x) => x.redirect === "manual")).toBe(true);

    const moved = stub(() => new Response(null, { status: 302, headers: { location: "https://evil.invalid" } }));
    expect(await codeOf(() => new SupabaseAccountLinkStore(cfg, moved.fetchImpl).preview("c".repeat(64), "auth-b"))).toBe("IDENTITY_STORE_ERROR");
    const gone = stub(() => missing());
    expect(await codeOf(() => new SupabaseAccountLinkStore(cfg, gone.fetchImpl).signIns("user-dev"))).toBe("IDENTITY_STORE_ERROR");
    expect((await new SupabaseAccountLinkStore(cfg, gone.fetchImpl).resolveWalletSignIn("auth-b", DEV_WALLET)).ok).toBe(false);
  });
});

