import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { createApp } from "../src/app.ts";
import { startServer } from "../src/api/server.ts";
import { makeContext } from "../src/api/trpc.ts";
import { authRouter } from "../src/api/authRoutes.ts";
import { primeAuthIdentityRuntime } from "../src/auth/AuthIdentityRuntime.ts";
import { SupabaseIdentityStore } from "../src/auth/IdentityStore.ts";
import { SupabaseCallsStore } from "../src/calls/supabaseStore.ts";
import { loadConfig } from "../src/config.ts";
import { buildCallsRuntime, setCallsRuntime } from "../src/calls/runtime.ts";
import { FakeIdentityStore, FakeJwtVerifier, testPolicy } from "./authIdentityFixtures.ts";
import { harness, market, person } from "./socialCallsFixtures.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

async function rig(legacyDev = false) {
  const config = loadConfig({});
  const app = await createApp({ config, ...(legacyDev ? {} : {
    auth: { verify: async () => null, fetchLinkedIdentities: async () => [] },
  }) });
  const identity = new FakeIdentityStore();
  identity.addUser("auth-alice", "alice");
  const verifier = new FakeJwtVerifier().issue("alice-session", "auth-alice")
    .issue("bob-session", "auth-bob");
  primeAuthIdentityRuntime(config, { store: identity, verifier, policy: testPolicy });
  const h = harness({ people: [person("alice", { walletAddress: null }), person("victim")], markets: [market("btc")] });
  const rt = buildCallsRuntime(config, { store: h.calls, markets: h.rt.markets, clock: h.clock });
  setCallsRuntime(config, rt);
  const server = startServer(app, 0);
  if (!server.http.listening) await once(server.http, "listening");
  const address = server.http.address();
  if (!address || typeof address === "string") throw new Error("no local test port");
  cleanups.push(async () => {
    server.wss.close();
    await new Promise<void>((resolve, reject) => server.http.close(err => err ? reject(err) : resolve()));
  });
  const base = `http://127.0.0.1:${address.port}`;
  async function post(path: string, input: object, bearer?: string) {
    const response = await fetch(`${base}/${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ json: input }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  return { app, rt, identity, post };
}

test("HTTP bearer -> verified walletless person -> immutable free call", async () => {
  const r = await rig();
  const ctx = await makeContext(r.app, "alice-session", "alice-session");
  expect(ctx.wallet).toBeUndefined();
  const result = await r.post("calls.create", { marketId: "btc", side: "YES" }, "alice-session");
  expect(result.status).toBe(200);
  expect(result.body.result.data.json.call.userId).toBe("alice");
  expect(result.body.result.data.json.call.fundingState).toBe("NONE");
});

test("verified walletless person follows by canonical id, with no client-selected actor", async () => {
  const r = await rig();
  const privateCall = r.rt.service.createCall({ marketId: "btc", side: "YES", visibility: "followers" }, "victim");
  expect(r.rt.service.getPerson({ personRef: "victim" }, "alice").calls).toHaveLength(0);
  const first = await r.post("people.follow", { personRef: "victim" }, "alice-session");
  expect(first.status).toBe(200);
  expect(first.body.result.data.json).toEqual({ personId: "victim", following: true });
  expect((await r.post("people.follow", { personRef: "victim" }, "alice-session")).status).toBe(200);
  expect(r.rt.store.followingOf("alice")).toEqual(["victim"]);
  expect(r.rt.service.getPerson({ personRef: "victim" }, "alice").calls[0]?.call.id).toBe(privateCall.call.id);
  expect(r.rt.service.getPerson({ personRef: "victim" }, "alice").viewerIsFollowing).toBe(true);
  expect(r.rt.service.getPerson({ personRef: "victim" }, null).calls).toHaveLength(0);
  for (const input of [
    { personRef: "victim", userId: "victim" },
    { personRef: "victim", viewerUserId: "victim" },
    { personRef: "victim", wallet: "Wallet_victim" },
  ]) expect((await r.post("people.follow", input, "alice-session")).status).toBe(400);
  expect((await r.post("people.follow", { personRef: "victim" }, "bob-session")).status).toBe(401);
  expect((await r.post("people.follow", { personRef: "alice" }, "alice-session")).status).toBe(400);
  expect((await r.post("people.follow", { personRef: "missing" }, "alice-session")).status).toBe(404);
  const removed = await r.post("people.unfollow", { personRef: "victim" }, "alice-session");
  expect(removed.status).toBe(200);
  expect(removed.body.result.data.json).toEqual({ personId: "victim", following: false });
  expect(r.rt.store.followingOf("alice")).toEqual([]);
  expect(r.rt.service.getPerson({ personRef: "victim" }, "alice").calls).toHaveLength(0);
});

test("DevAuth wallet impersonation is never a social session", async () => {
  const r = await rig(true);
  for (const bearer of [undefined, "Wallet_victim", "invalid-session"]) {
    const result = await r.post("calls.create", { marketId: "btc", side: "YES" }, bearer);
    expect(result.status).toBe(401);
  }
  expect(r.rt.store.listCalls()).toHaveLength(0);
});

test("onboarding uses the verified subject, replays idempotently, and whoami agrees", async () => {
  const r = await rig();
  const request = { supabaseAccessToken: "bob-session", displayName: " Bob " };
  const results = await Promise.all([r.post("auth.completeProfile", request), r.post("auth.completeProfile", request)]);
  expect(results.map(r => r.status)).toEqual([200, 200]);
  const id = results[0]!.body.result.data.json.userId;
  expect(id).not.toBe("auth-bob");
  expect(results[1]!.body.result.data.json.userId).toBe(id);
  expect(await r.identity.userIdForAuthUser("auth-alice")).toBe("alice");
  const who = await r.post("auth.whoami", { supabaseAccessToken: "bob-session" });
  // completeProfile without a handle (pre-username builds) leaves none stored.
  expect(who.body.result.data.json).toEqual({ userId: id, authUserId: "auth-bob", handle: null });
});

test("profile writes refuse forged sessions, client identity, blank/control/long names", async () => {
  const r = await rig();
  expect((await r.post("auth.completeProfile", { supabaseAccessToken: "forged", displayName: "Bob" })).status).toBe(401);
  for (const extra of [{ userId: "alice" }, { authUserId: "auth-alice" }, { wallet: "Wallet_victim" }]) {
    expect((await r.post("auth.completeProfile", { supabaseAccessToken: "bob-session", displayName: "Bob", ...extra })).status).toBe(400);
  }
  for (const displayName of ["  ", "a".repeat(61), "Bob\nAdmin"]) {
    expect((await r.post("auth.completeProfile", { supabaseAccessToken: "bob-session", displayName })).status).toBe(400);
  }
  expect(await r.identity.userIdForAuthUser("auth-bob")).toBeNull();
});

test("Supabase profile RPC returns only a committed canonical id", async () => {
  const id = crypto.randomUUID();
  const requests: Array<{ url: string; body: unknown }> = [];
  const store = new SupabaseIdentityStore({ supabaseUrl: "https://test.invalid", serviceRoleKey: "test-only", network: "devnet" },
    (async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json(id);
    }) as typeof fetch);
  expect(await store.createPersonForAuthUser("verified-subject", "Bob")).toBe(id);
  expect(requests).toEqual([{ url: "https://test.invalid/rest/v1/rpc/create_social_person_v1", body: {
    p_auth_user_id: "verified-subject", p_display_name: "Bob",
  } }]);
});

test("unconfigured deployment cannot report successful profile creation", async () => {
  const app = await createApp({ config: loadConfig({}) });
  await expect(authRouter.createCaller({ app }).completeProfile({ supabaseAccessToken: "any", displayName: "Bob" }))
    .rejects.toMatchObject({ message: "IDENTITY_NOT_CONFIGURED" });
});

test("verified person created after boot is read into the durable directory without writes", async () => {
  const app = await createApp({ config: loadConfig({}) });
  const identity = new FakeIdentityStore();
  const id = crypto.randomUUID();
  identity.addUser("auth-new", id);
  primeAuthIdentityRuntime(app.config, {
    store: identity, verifier: new FakeJwtVerifier().issue("new-session", "auth-new"), policy: testPolicy,
  });
  const requests: string[] = [];
  const store = new SupabaseCallsStore({
    config: { supabaseUrl: "https://test.invalid", serviceRoleKey: "test-only", network: "devnet" },
    fetchImpl: (async (url, init) => {
      expect(init?.method).toBe("GET");
      expect(new URL(String(url)).searchParams.get("id")).toBe(`eq.${id}`);
      requests.push(String(url));
      return Response.json([{ id, handle: "caller_new", full_name: "New caller", wallet_address: null, profile_picture: null, sns_domain: null }]);
    }) as typeof fetch,
  });
  const rt = buildCallsRuntime(app.config, { store, markets: harness().rt.markets });
  expect(store.getPerson(id)).toBeUndefined();
  expect(await rt.viewer.resolve({ supabaseAccessToken: "new-session" })).toBe(id);
  expect(store.getPerson(id)?.displayName).toBe("New caller");
  expect(store.getPerson(id)?.walletAddress).toBeNull();
  await rt.viewer.resolve({ supabaseAccessToken: "new-session" });
  expect(requests).toHaveLength(1);
  expect(store.queue.acceptedWrites).toBe(0);
});
