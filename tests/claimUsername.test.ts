/**
 * `auth.claimUsername` — an existing account without a @username claims one.
 *
 * Accounts made before usernames, and wallet profiles carried over to wallet
 * sign-in, have no stored handle; every surface shows `user-xxxxxxxx`. This is
 * the one write that fixes that: the caller's OWN account (resolved from the
 * verified session, never named), only while it has none, never a rename.
 * `whoami` says which accounts need it by returning the stored handle or null.
 */

import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { authRouter } from "../src/api/authRoutes.ts";
import { primeAuthIdentityRuntime } from "../src/auth/AuthIdentityRuntime.ts";
import { SupabaseIdentityStore } from "../src/auth/IdentityStore.ts";
import { setCallsRuntime, buildCallsRuntime } from "../src/calls/runtime.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { FakeIdentityStore, FakeJwtVerifier, testPolicy } from "./authIdentityFixtures.ts";

const CARRIED_WALLET = "F7rhCwoPyU5H1p48sddDmGb1ax25CwmxiwHL8Xj5RJ3E";

async function rig(opts: { store?: FakeIdentityStore } = {}) {
  const config = loadConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    SOLANA_NETWORK: "devnet",
  });
  const app = await createApp({ config });
  const store =
    opts.store ??
    new FakeIdentityStore()
      // A pre-username Google account, and one that already has a handle.
      .addUser("auth-plain", "user-plain")
      .addUser("auth-named", "user-named")
      .setHandle("user-named", "named_one")
      .addUser("auth-other", "user-other")
      // An existing wallet profile with no handle, reachable by wallet sign-in.
      .addWalletAccount(CARRIED_WALLET, "user-carried");
  const verifier = new FakeJwtVerifier()
    .issue("tok-plain", "auth-plain")
    .issue("tok-named", "auth-named")
    .issue("tok-other", "auth-other")
    .issue("tok-carried", "auth-carried", CARRIED_WALLET)
    .issue("tok-nobody", "auth-nobody");
  primeAuthIdentityRuntime(config, {
    store,
    verifier,
    policy: { ...testPolicy, allowedDomains: [...testPolicy.allowedDomains], allowedUris: [...testPolicy.allowedUris] },
    walletProfileCarry: true,
  });
  return { app, config, store, caller: authRouter.createCaller({ app }) };
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return e instanceof TRPCError ? `${e.code}:${e.message}` : `UNEXPECTED ${String(e)}`;
  }
}

describe("whoami reports the stored @username", () => {
  test("null for an account without one, the handle for one with", async () => {
    const { caller } = await rig();
    expect(await caller.whoami({ supabaseAccessToken: "tok-plain" })).toEqual({
      userId: "user-plain",
      authUserId: "auth-plain",
      handle: null,
    });
    expect((await caller.whoami({ supabaseAccessToken: "tok-named" })).handle).toBe("named_one");
  });

  test("a carried-over wallet profile reports no handle, not its placeholder", async () => {
    const { caller } = await rig();
    const me = await caller.whoami({ supabaseAccessToken: "tok-carried" });
    expect(me.userId).toBe("user-carried");
    expect(me.handle).toBeNull();
  });

  test("a failed handle read omits the field instead of claiming there is none", async () => {
    const store = new FakeIdentityStore().addUser("auth-plain", "user-plain");
    store.handleForUser = async () => {
      throw new Error("store down");
    };
    const { caller } = await rig({ store });
    const me = await caller.whoami({ supabaseAccessToken: "tok-plain" });
    expect(me).toEqual({ userId: "user-plain", authUserId: "auth-plain" });
    expect("handle" in me).toBe(false);
  });
});

describe("claimUsername", () => {
  test("an account without a handle claims one; whoami and usernameStatus agree", async () => {
    const { caller } = await rig();
    expect(await caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "  Ada_1 " })).toEqual({
      userId: "user-plain",
      authUserId: "auth-plain",
      handle: "ada_1",
      outcome: "claimed",
    });
    expect((await caller.whoami({ supabaseAccessToken: "tok-plain" })).handle).toBe("ada_1");
    expect((await caller.usernameStatus({ handle: "ADA_1" })).status).toBe("taken");
  });

  test("a carried-over wallet profile claims its first handle", async () => {
    const { caller } = await rig();
    const claimed = await caller.claimUsername({ supabaseAccessToken: "tok-carried", handle: "dominion" });
    expect(claimed).toMatchObject({ userId: "user-carried", handle: "dominion", outcome: "claimed" });
  });

  test("asking again for the same handle is a no-op; a different one never renames", async () => {
    const { caller } = await rig();
    await caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "ada_1" });
    expect((await caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "ADA_1" })).outcome).toBe("unchanged");
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "another" }))).toBe(
      "CONFLICT:HANDLE_ALREADY_SET",
    );
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "tok-named", handle: "fresh_name" }))).toBe(
      "CONFLICT:HANDLE_ALREADY_SET",
    );
    expect((await caller.whoami({ supabaseAccessToken: "tok-named" })).handle).toBe("named_one");
  });

  test("taken (any case), reserved and malformed handles are refused with their own codes", async () => {
    const { caller } = await rig();
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "NAMED_ONE" }))).toBe(
      "CONFLICT:USERNAME_TAKEN",
    );
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "admin" }))).toBe(
      "BAD_REQUEST:USERNAME_RESERVED",
    );
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "caller_abc" }))).toBe(
      "BAD_REQUEST:USERNAME_RESERVED",
    );
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "a b" }))).toBe(
      "BAD_REQUEST:USERNAME_INVALID",
    );
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "ab" }))).toBe(
      "BAD_REQUEST:USERNAME_INVALID",
    );
    // Nothing was written by any refusal.
    expect((await caller.whoami({ supabaseAccessToken: "tok-plain" })).handle).toBeNull();
  });

  test("two accounts racing for one handle: exactly one wins", async () => {
    const { caller } = await rig();
    const results = await Promise.all([
      code(() => caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "contested" })),
      code(() => caller.claimUsername({ supabaseAccessToken: "tok-other", handle: "contested" })),
    ]);
    expect(results.filter((r) => r === "NO_ERROR")).toHaveLength(1);
    expect(results.filter((r) => r === "CONFLICT:USERNAME_TAKEN")).toHaveLength(1);
  });

  test("no session, a forged session, or a session with no account writes nothing", async () => {
    const { caller } = await rig();
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "forged", handle: "squatter" }))).toBe(
      "UNAUTHORIZED:AUTH_TOKEN_INVALID",
    );
    expect(await code(() => caller.claimUsername({ supabaseAccessToken: "tok-nobody", handle: "squatter" }))).toBe(
      "FORBIDDEN:AUTH_USER_UNLINKED",
    );
    expect((await caller.usernameStatus({ handle: "squatter" })).status).toBe("available");
  });

  test("the input names no account: a user id or wallet in the body is refused", async () => {
    const { caller } = await rig();
    for (const extra of [{ userId: "user-named" }, { authUserId: "auth-named" }, { wallet: CARRIED_WALLET }]) {
      const input = { supabaseAccessToken: "tok-plain", handle: "sneaky", ...extra } as unknown as {
        supabaseAccessToken: string;
        handle: string;
      };
      expect(await code(() => caller.claimUsername(input))).toStartWith("BAD_REQUEST:");
    }
  });

  test("a running calls mirror shows the new handle at once", async () => {
    const { caller, config } = await rig();
    const calls = buildCallsRuntime(undefined, { store: new InMemoryCallsStore() });
    calls.store.upsertPerson({
      id: "user-plain",
      handle: "user-user-pla",
      displayName: "Plain",
      avatarUrl: null,
      walletAddress: null,
      settledCalls: 0,
      correctCalls: 0,
    });
    setCallsRuntime(config, calls);
    await caller.claimUsername({ supabaseAccessToken: "tok-plain", handle: "plain_person" });
    expect(calls.store.getPerson("user-plain")?.handle).toBe("plain_person");
    expect(calls.store.getPersonByHandle("@plain_person")?.id).toBe("user-plain");
  });
});

describe("SupabaseIdentityStore — the two new requests", () => {
  const cfg = { supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role-secret", network: "devnet" as const };

  test("claimOwnHandle calls the service-only function with the verified subject only", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, user_id: "u1", handle: "ada", outcome: "claimed" }));
    }) as typeof fetch;
    const result = await new SupabaseIdentityStore(cfg, fetcher).claimOwnHandle("auth-1", "Ada");
    expect(result).toEqual({ ok: true, user_id: "u1", handle: "ada", outcome: "claimed" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/claim_own_handle_v1");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.redirect).toBe("manual");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ p_auth_user_id: "auth-1", p_handle: "Ada" });
  });

  test("handleForUser reads only the handle column of that one row", async () => {
    const urls: string[] = [];
    let rows: unknown = [{ handle: "named_one" }];
    const fetcher = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify(rows));
    }) as typeof fetch;
    const store = new SupabaseIdentityStore(cfg, fetcher);
    expect(await store.handleForUser("u1")).toBe("named_one");
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/rest/v1/users");
    expect(url.searchParams.get("id")).toBe("eq.u1");
    expect(url.searchParams.get("select")).toBe("handle");
    rows = [{ handle: null }];
    expect(await store.handleForUser("u1")).toBeNull();
    rows = [];
    expect(await store.handleForUser("u1")).toBeNull();
  });

  test("a failed request is a sanitized store error, never the provider's text", async () => {
    const fetcher = (async () => new Response("synthetic-private-provider-error", { status: 500 })) as unknown as typeof fetch;
    const store = new SupabaseIdentityStore(cfg, fetcher);
    for (const op of [() => store.claimOwnHandle("auth-1", "ada"), () => store.handleForUser("u1")]) {
      let caught: unknown;
      try {
        await op();
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ code: "IDENTITY_STORE_ERROR" });
      expect(String(caught).includes("synthetic-private")).toBe(false);
    }
  });
});
