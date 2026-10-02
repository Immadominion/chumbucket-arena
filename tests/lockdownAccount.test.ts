/**
 * Lockdown, BFF side: session-keyed account writes (B1/M1/M9/B3), no wallet in
 * any social payload (M2), the legacy surface off the calls BFF (B2/B12), no
 * DevAuth in production (B2), and write rate limits (B2).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { setAccountRuntime } from "../src/account/runtime.ts";
import { InMemoryAccountStore } from "../src/account/store.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { redactWallets } from "../src/api/redactWallets.ts";
import { appRouter, callsBffRouter, LEGACY_ARENA_PROCEDURES, servedRouter } from "../src/api/router.ts";
import { clientIpFrom, startServer } from "../src/api/server.ts";
import {
  READ_ONLY_MUTATIONS,
  resetWriteLimiters,
  setWriteLimiter,
  WriteLimiter,
  type WriteLimitConfig,
} from "../src/api/writeLimits.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { asWallet } from "../src/domain/ids.ts";
import { harness, market, person, testApp } from "./socialCallsFixtures.ts";

// A real, holdable ed25519 public key (the Solana memo program's id is
// off-curve; this one is a normal account address).
const FRIEND_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

afterEach(() => resetWriteLimiters());

async function scene() {
  const h = harness({
    people: [
      person("u-ann", { walletAddress: "Wallet_u-ann", avatarId: 2 }),
      person("u-bob", { walletAddress: "Wallet_u-bob" }),
    ],
    markets: [market("mkt-1")],
  });
  const app = await testApp();
  setCallsRuntime(app.config, h.rt);
  const store = new InMemoryAccountStore();
  store.seed({ userId: "u-ann", displayName: "ANN", handle: "u-ann", walletAddress: "Wallet_u-ann", avatarId: 2 });
  store.seed({ userId: "u-bob", displayName: "BOB", handle: "u-bob", walletAddress: "Wallet_u-bob" });
  setAccountRuntime(app.config, {
    store,
    push: { enabled: false, reason: "test", maxAgeMs: 60_000 },
    sender: null,
  });
  return {
    h,
    app,
    store,
    anon: appRouter.createCaller({ app }),
    ann: appRouter.createCaller({ app, wallet: asWallet("Wallet_u-ann") }),
    bob: appRouter.createCaller({ app, wallet: asWallet("Wallet_u-bob") }),
  };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof TRPCError ? e.code : `THREW ${(e as Error).message}`;
  }
};

describe("account.* is keyed by the session, never by a client-named identity", () => {
  test("a signed-out caller can read nothing and change nothing", async () => {
    const s = await scene();
    expect(await code(s.anon.account.me({}))).toBe("UNAUTHORIZED");
    expect(await code(s.anon.account.updateProfile({ displayName: "x" }))).toBe("UNAUTHORIZED");
    expect(await code(s.anon.account.addWalletFriend({ walletAddress: FRIEND_WALLET }))).toBe("UNAUTHORIZED");
    expect(await code(s.anon.account.registerPushToken({ token: "t".repeat(40), platform: "android" }))).toBe("UNAUTHORIZED");
  });

  test("no input can name whose account is being edited", async () => {
    const s = await scene();
    for (const extra of [{ userId: "u-bob" }, { wallet: "Wallet_u-bob" }, { privyId: "Wallet_u-bob" }]) {
      expect(
        await code(s.ann.account.updateProfile({ displayName: "Vandal", ...extra } as { displayName: string })),
      ).toBe("BAD_REQUEST");
    }
    expect((await s.store.getOwnProfile("u-bob"))?.displayName).toBe("BOB");
  });

  test("me returns the caller's own profile, own wallet included", async () => {
    const s = await scene();
    const { profile } = await s.ann.account.me({});
    expect(profile).toEqual({
      userId: "u-ann", handle: "u-ann", displayName: "ANN", bio: null, avatarId: 2, walletAddress: "Wallet_u-ann",
    });
  });

  test("updateProfile edits name, bio and avatar for the caller only, and the feed shows it at once", async () => {
    const s = await scene();
    s.h.rt.service.createCall({ marketId: "mkt-1", side: "YES" }, "u-ann");
    const { profile } = await s.ann.account.updateProfile({ displayName: "  Ann Lee ", bio: "Backs her gut.\nOften right.", avatarId: 4 });
    expect(profile).toMatchObject({ displayName: "Ann Lee", bio: "Backs her gut.\nOften right.", avatarId: 4 });
    expect((await s.store.getOwnProfile("u-bob"))?.displayName).toBe("BOB");
    const feed = await s.anon.calls.feed({ mode: "global" });
    expect(feed.entries[0]?.author).toMatchObject({ id: "u-ann", displayName: "Ann Lee", avatarId: 4 });
    // An empty bio clears it; one field at a time is fine.
    expect((await s.ann.account.updateProfile({ bio: "" })).profile.bio).toBeNull();
  });

  test("updateProfile refuses what the SQL refuses, in words a person can read", async () => {
    const s = await scene();
    expect(await code(s.ann.account.updateProfile({}))).toBe("BAD_REQUEST");
    expect(await code(s.ann.account.updateProfile({ displayName: "   " }))).toBe("BAD_REQUEST");
    expect(await code(s.ann.account.updateProfile({ displayName: "x".repeat(61) }))).toBe("BAD_REQUEST");
    expect(await code(s.ann.account.updateProfile({ displayName: "bell\u0007" }))).toBe("BAD_REQUEST");
    expect(await code(s.ann.account.updateProfile({ bio: "x".repeat(281) }))).toBe("BAD_REQUEST");
    expect(await code(s.ann.account.updateProfile({ avatarId: 6 }))).toBe("BAD_REQUEST");
    expect(await code(s.ann.account.updateProfile({ avatarId: 0 }))).toBe("BAD_REQUEST");
    expect((await s.store.getOwnProfile("u-ann"))?.displayName).toBe("ANN");
  });

  test("addWalletFriend: the typed name is the adder's label, never the friend's profile", async () => {
    const s = await scene();
    const first = await s.ann.account.addWalletFriend({ walletAddress: FRIEND_WALLET, nickname: "Bob from work" });
    expect(first.alreadyFriends).toBe(false);
    const placeholder = await s.store.getOwnProfile(first.friendUserId);
    expect(placeholder).toMatchObject({ walletAddress: FRIEND_WALLET, displayName: null, handle: null });
    expect(s.store.friends).toContainEqual({ userId: "u-ann", friendUserId: first.friendUserId, nickname: "Bob from work" });
    expect((await s.ann.account.addWalletFriend({ walletAddress: FRIEND_WALLET })).alreadyFriends).toBe(true);
    // Not a holdable key / not base58 / yourself.
    expect(await code(s.ann.account.addWalletFriend({ walletAddress: "11111111111111111111111111111111" }))).toBe("BAD_REQUEST");
    expect(await code(s.ann.account.addWalletFriend({ walletAddress: "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl" }))).toBe("BAD_REQUEST");
  });

  test("push tokens belong to the person who registered them", async () => {
    const s = await scene();
    const token = "fcm:" + "A".repeat(60);
    expect(await s.ann.account.registerPushToken({ token, platform: "android" })).toEqual({
      registered: true,
      pushEnabled: false,
    });
    expect(await s.store.pushTokensFor("u-ann")).toEqual([{ token, userId: "u-ann", platform: "android" }]);
    // Bob cannot remove Ann's token; the same device signing in as Bob moves it.
    await s.bob.account.unregisterPushToken({ token });
    expect(await s.store.pushTokensFor("u-ann")).toHaveLength(1);
    await s.bob.account.registerPushToken({ token, platform: "android" });
    expect(await s.store.pushTokensFor("u-ann")).toHaveLength(0);
    expect(await s.store.pushTokensFor("u-bob")).toHaveLength(1);
    await s.bob.account.unregisterPushToken({ token });
    expect(await s.store.pushTokensFor("u-bob")).toHaveLength(0);
    expect(await code(s.ann.account.registerPushToken({ token: "short", platform: "android" }))).toBe("BAD_REQUEST");
    expect(await code(s.ann.account.registerPushToken({ token, platform: "web" as "android" }))).toBe("BAD_REQUEST");
  });
});

describe("no social payload names anybody's wallet (M2)", () => {
  test("feed authors, people pages and call details carry walletAddress: null, self included", async () => {
    const s = await scene();
    const entry = s.h.rt.service.createCall({ marketId: "mkt-1", side: "YES" }, "u-ann");
    const feed = await s.ann.calls.feed({ mode: "global" });
    expect(feed.entries[0]?.author.walletAddress).toBeNull();
    const detail = await s.anon.people.get({ personRef: "u-ann" });
    expect(detail.person.walletAddress).toBeNull();
    const call = await s.bob.calls.get({ callId: entry.call.id });
    expect(JSON.stringify(call)).not.toContain("Wallet_u-ann");
    // The directory itself still knows, server-side, and is untouched.
    expect(s.h.calls.getPerson("u-ann")?.walletAddress).toBe("Wallet_u-ann");
  });

  test("redactWallets copies instead of mutating and leaves other shapes alone", () => {
    const p: Record<string, unknown> = { id: "a", handle: "a", displayName: "A", walletAddress: "W", avatarUrl: null };
    const payload = { entries: [{ author: p, market: { id: "m", walletAddress: "not-a-person" } as Record<string, unknown> }] };
    const out = redactWallets(payload);
    expect(out.entries[0]!.author).toEqual({ ...p, walletAddress: null, avatarId: null });
    expect(p.walletAddress).toBe("W");
    expect(out.entries[0]!.market.walletAddress).toBe("not-a-person");
  });
});

describe("the calls BFF no longer serves the legacy engine (B2, B12)", () => {
  test("every legacy procedure is off the served router; the app's procedures are on it", () => {
    const served = Object.keys(callsBffRouter._def.procedures);
    for (const key of LEGACY_ARENA_PROCEDURES) {
      expect(served.some((p) => p === key || p.startsWith(`${key}.`))).toBe(false);
    }
    for (const p of [
      "calls.feed", "calls.create", "calls.respond", "markets.open", "people.get", "people.follow",
      "inbox.list", "inbox.unreadCount", "inbox.markRead", "record.mine", "auth.whoami",
      "auth.completeProfile", "pantaTrading.prepare", "predictions.catalog", "health",
      "account.me", "account.updateProfile", "account.addWalletFriend", "account.registerPushToken",
    ]) {
      expect(served).toContain(p);
    }
    // Everything in appRouter that is not legacy is served — nothing dropped by accident.
    const all = Object.keys(appRouter._def.record);
    expect(Object.keys(callsBffRouter._def.record).sort()).toEqual(all.filter((k) => !LEGACY_ARENA_PROCEDURES.has(k)).sort());
    expect(servedRouter({})).toBe(callsBffRouter);
    expect(servedRouter({ LEGACY_ARENA_ROUTES: "true" })).toBe(appRouter);
    expect(servedRouter({ LEGACY_ARENA_ROUTES: "1" })).toBe(callsBffRouter);
  });

  test("over HTTP: wallet-keyed reads, faucet and demo ops are 404; the feed is served", async () => {
    const s = await scene();
    const server = startServer(s.app, 0, "127.0.0.1");
    try {
      const address = server.http.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;
      const enc = (o: unknown) => encodeURIComponent(JSON.stringify({ json: o }));
      for (const path of [
        `notifications?input=${enc({ wallet: "Wallet_u-ann" })}`,
        `unreadCount?input=${enc({ wallet: "Wallet_u-ann" })}`,
        `myPositions?input=${enc({ wallet: "Wallet_u-ann" })}`,
        `followingFeed?input=${enc({ wallet: "Wallet_u-ann" })}`,
        `matchday`,
      ]) {
        expect((await fetch(`${base}/${path}`)).status).toBe(404);
      }
      for (const path of ["faucet", "resolveMatchNow", "reconcile", "signContract"]) {
        const res = await fetch(`${base}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
        });
        expect(res.status).toBe(404);
      }
      expect((await fetch(`${base}/calls.feed?input=${enc({ mode: "global" })}`)).status).toBe(200);
    } finally {
      server.http.close();
      server.wss.close();
    }
  });
});

describe("DevAuth never boots in production (B2)", () => {
  test("production without a verifying provider accepts no legacy credential", async () => {
    const app = await createApp({ config: loadConfig({}), production: true, allowDevAuth: false });
    expect(app.wiring.auth).toBe("none");
    expect(await app.auth.verify("AnyWalletString1111111111111111111")).toBeNull();
    const caller = appRouter.createCaller({ app });
    expect(await code(caller.me())).toBe("UNAUTHORIZED");
  });

  test("an explicit DevAuth request in production refuses to boot", async () => {
    await expect(createApp({ config: loadConfig({}), production: true, allowDevAuth: true })).rejects.toThrow(
      /Refusing to boot: DevAuth/,
    );
  });

  test("outside production, local dev keeps DevAuth", async () => {
    const app = await createApp({ config: loadConfig({}), production: false, allowDevAuth: false });
    expect(app.wiring.auth).toBe("dev");
  });
});

describe("write rate limits (B2)", () => {
  const tight: WriteLimitConfig = {
    ip: { capacity: 3, refillMs: 60_000 },
    session: { capacity: 2, refillMs: 60_000 },
    user: { capacity: 2, refillMs: 60_000 },
    maxKeys: 100,
  };

  test("buckets drain, refill, and stay bounded", () => {
    const l = new WriteLimiter({ ...tight, maxKeys: 3 });
    expect(l.take("ip", "a", 0).ok).toBe(true);
    expect(l.take("ip", "a", 0).ok).toBe(true);
    expect(l.take("ip", "a", 0).ok).toBe(true);
    const refused = l.take("ip", "a", 0);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBe(60_000);
    expect(l.take("ip", "a", 60_000).ok).toBe(true);
    for (const k of ["b", "c", "d", "e"]) l.take("ip", k, 0);
    expect(l.size).toBe(3);
  });

  test("a mutation pays per address and per session; queries and read-only mutations are free", async () => {
    const s = await scene();
    setWriteLimiter(s.app.config, new WriteLimiter(tight));
    const viaIp = appRouter.createCaller({ app: s.app, clientIp: "203.0.113.9" });
    for (let i = 0; i < 3; i++) expect(await code(viaIp.calls.respond({ targetCallId: "nope", kind: "back" }))).toBe("UNAUTHORIZED");
    expect(await code(viaIp.calls.respond({ targetCallId: "nope", kind: "back" }))).toBe("TOO_MANY_REQUESTS");
    // Reads are not writes.
    expect(await code(viaIp.calls.feed({ mode: "global" }))).toBe("OK");
    expect(READ_ONLY_MUTATIONS.has("auth.whoami")).toBe(true);

    // A session's budget is its own: another session from elsewhere is unaffected.
    const one = appRouter.createCaller({ app: s.app, supabaseAccessToken: "session-one" });
    const two = appRouter.createCaller({ app: s.app, supabaseAccessToken: "session-two" });
    await code(one.people.follow({ personRef: "u-bob" }));
    await code(one.people.follow({ personRef: "u-bob" }));
    expect(await code(one.people.follow({ personRef: "u-bob" }))).toBe("TOO_MANY_REQUESTS");
    expect(await code(two.people.follow({ personRef: "u-bob" }))).not.toBe("TOO_MANY_REQUESTS");
  });

  test("account writes also pay the person's own budget", async () => {
    const s = await scene();
    setWriteLimiter(s.app.config, new WriteLimiter(tight));
    expect(await code(s.ann.account.updateProfile({ avatarId: 1 }))).toBe("OK");
    expect(await code(s.ann.account.updateProfile({ avatarId: 2 }))).toBe("OK");
    expect(await code(s.ann.account.updateProfile({ avatarId: 3 }))).toBe("TOO_MANY_REQUESTS");
    expect(await code(s.bob.account.updateProfile({ avatarId: 3 }))).toBe("OK");
  });

  test("the client address is the one Railway's edge wrote, not the CDN's", () => {
    const req = (headers: Record<string, string>) =>
      ({ headers, socket: { remoteAddress: "100.64.0.9" } }) as unknown as Parameters<typeof clientIpFrom>[0];
    // Railway strips client-sent X-Forwarded-For; the connecting address is first.
    expect(clientIpFrom(req({ "x-forwarded-for": "198.51.100.8, 151.101.1.1", "x-real-ip": "151.101.1.1" }), undefined))
      .toBe("198.51.100.8");
    expect(clientIpFrom(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.8" }), "xff-last")).toBe("198.51.100.8");
    expect(clientIpFrom(req({ "x-real-ip": "198.51.100.7" }), "x-real-ip")).toBe("198.51.100.7");
    expect(clientIpFrom(req({}), undefined)).toBe("100.64.0.9");
  });
});
