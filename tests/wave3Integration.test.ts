/**
 * Wave 3 integration: the seams between lockdown (account.*, server push),
 * trust (content policy, block/mute), fomo (people search, leaderboard, top
 * calls, the thesis thread) and money (the call cut-off), proven together.
 *
 *   - the content policy guards every public text a person writes: profile
 *     name and bio (account.updateProfile), a friend's name
 *     (account.addWalletFriend), a thesis update (calls.addUpdate) and a
 *     claimed @username (auth.claimUsername);
 *   - blocked and muted people disappear from people search, the
 *     leaderboard, top calls and the thread on a call, exactly as they do
 *     from the feed and the inbox, and are never pushed;
 *   - top calls only offers calls the viewer can still answer (M14 cut-off).
 */

import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { setAccountRuntime } from "../src/account/runtime.ts";
import { InMemoryAccountStore } from "../src/account/store.ts";
import { accountRouter } from "../src/api/account.ts";
import { authRouter } from "../src/api/authRoutes.ts";
import { callsRouter } from "../src/api/calls.ts";
import { trustRouter } from "../src/api/trust.ts";
import { primeAuthIdentityRuntime } from "../src/auth/AuthIdentityRuntime.ts";
import { PeopleDirectory } from "../src/calls/people.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { asWallet } from "../src/domain/ids.ts";
import { PushDispatcher } from "../src/push/dispatcher.ts";
import type { PushMessage, PushSender, SendOutcome } from "../src/push/fcm.ts";
import { resolveTrustConfig } from "../src/trust/config.ts";
import { buildTrustRuntime, setTrustRuntime } from "../src/trust/runtime.ts";
import { InMemoryTrustStore, RecordingAuthUserAdmin } from "../src/trust/store.ts";
import type { Resolution } from "../src/prediction/types.ts";
import { FakeIdentityStore, FakeJwtVerifier, testPolicy } from "./authIdentityFixtures.ts";
import { harness, market, person, testApp, type Harness } from "./socialCallsFixtures.ts";
import { harness as notificationsHarness } from "./socialNotificationsFixtures.ts";

const FRIEND_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof TRPCError ? `${e.code}:${e.message}` : `THREW ${(e as Error).message}`;
  }
}

/** Lock `n` calls for `userId` on fresh markets and settle them all correct. */
function settledRun(h: Harness, userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const id = `${userId}-m${i}`;
    h.venue.upsertMarket(market(id), null);
    h.venue.appendSnapshot({ marketId: id, yesProbability: 0.5, observedAt: h.clock.now(), source: "venue" });
    h.rt.service.createCall({ marketId: id, side: "YES" }, userId);
    h.resolve(id, "YES" as Resolution);
  }
  h.rt.sync.runOnce();
}

async function scene() {
  const h = harness({
    people: [
      person("u-ann", { handle: "ann", displayName: "Ann" }),
      person("u-bob", { handle: "bobby", displayName: "Bob" }),
      person("u-cid", { handle: "bobcat", displayName: "Cid" }),
      person("u-dee", { handle: "dee", displayName: "Dee" }),
    ],
    markets: [market("m-1"), market("m-2"), market("m-3")],
  });
  const app = await testApp();
  setCallsRuntime(app.config, h.rt);
  const trust = buildTrustRuntime(app.config, {
    config: resolveTrustConfig(app.config, {}),
    store: new InMemoryTrustStore(),
    authAdmin: new RecordingAuthUserAdmin(),
    now: () => h.clock.now(),
  });
  setTrustRuntime(app.config, trust);
  const accounts = new InMemoryAccountStore();
  accounts.seed({ userId: "u-ann", displayName: "Ann", handle: "ann", walletAddress: "Wallet_u-ann" });
  setAccountRuntime(app.config, { store: accounts, push: { enabled: false, reason: "test", maxAgeMs: 60_000 }, sender: null });
  const as = (who: string) => ({ app, wallet: asWallet(`Wallet_${who}`) });
  return {
    h,
    app,
    accounts,
    calls: (who: string) => callsRouter.createCaller(as(who)),
    account: (who: string) => accountRouter.createCaller(as(who)),
    safety: (who: string) => trustRouter.createCaller(as(who)),
  };
}

describe("the content policy guards every public text (trust x lockdown x fomo x identity)", () => {
  test("account.updateProfile refuses a link or a slur in a name or bio and writes nothing", async () => {
    const s = await scene();
    expect(await code(s.account("u-ann").updateProfile({ displayName: "Ann at pump.fun" }))).toBe(
      "BAD_REQUEST:Links aren't allowed in your name. Remove the web address and try again.",
    );
    expect(await code(s.account("u-ann").updateProfile({ bio: "dm me t.me/rug" }))).toBe(
      "BAD_REQUEST:Links aren't allowed in your bio. Remove the web address and try again.",
    );
    expect(await code(s.account("u-ann").updateProfile({ displayName: "f.u.c.k" }))).toBe(
      "BAD_REQUEST:Your name includes language we don't allow. Please rephrase it.",
    );
    const own = await s.accounts.getOwnProfile("u-ann");
    expect(own).toMatchObject({ displayName: "Ann", bio: null });
    // Ordinary words, and a .sol name, are fine.
    const ok = await s.account("u-ann").updateProfile({ displayName: "Ann", bio: "toly.sol fan, damn good calls" });
    expect(ok.profile.bio).toBe("toly.sol fan, damn good calls");
  });

  test("account.addWalletFriend refuses a link in the name given to a friend", async () => {
    const s = await scene();
    expect(
      await code(s.account("u-ann").addWalletFriend({ walletAddress: FRIEND_WALLET, nickname: "claim at www.free.xyz" })),
    ).toBe("BAD_REQUEST:Links aren't allowed in that name. Remove the web address and try again.");
    expect((await s.account("u-ann").addWalletFriend({ walletAddress: FRIEND_WALLET, nickname: "Bob from work" })).alreadyFriends).toBe(false);
  });

  test("calls.addUpdate holds a thesis update to the thesis rules", async () => {
    const s = await scene();
    const entry = await s.calls("u-ann").calls.create({ marketId: "m-1", side: "YES" });
    expect(await code(s.calls("u-ann").calls.addUpdate({ callId: entry.call.id, body: "more at bit.ly/x" }))).toBe(
      "BAD_REQUEST:Links aren't allowed in your thesis. Remove the web address and try again.",
    );
    const update = await s.calls("u-ann").calls.addUpdate({ callId: entry.call.id, body: "Still on it." });
    expect(update.body).toBe("Still on it.");
  });

  test("auth.claimUsername refuses system names and slurs; usernameStatus never offers deleted_", async () => {
    const app = await testApp();
    const store = new FakeIdentityStore().addUser("auth-plain", "user-plain");
    primeAuthIdentityRuntime(app.config, {
      store,
      verifier: new FakeJwtVerifier().issue("tok-plain", "auth-plain"),
      policy: { ...testPolicy, allowedDomains: [...testPolicy.allowedDomains], allowedUris: [...testPolicy.allowedUris] },
    });
    const auth = authRouter.createCaller({ app });
    expect(await code(auth.claimUsername({ supabaseAccessToken: "tok-plain", handle: "deleted_0123456789ab" }))).toBe(
      "BAD_REQUEST:USERNAME_RESERVED",
    );
    expect((await code(auth.claimUsername({ supabaseAccessToken: "tok-plain", handle: "fuckface" }))).startsWith("BAD_REQUEST:")).toBe(true);
    expect((await auth.usernameStatus({ handle: "Deleted_abc" })).status).toBe("reserved");
    expect((await auth.claimUsername({ supabaseAccessToken: "tok-plain", handle: "ada" })).outcome).toBe("claimed");
  });
});

describe("blocked and muted people leave fomo's surfaces too (trust x fomo)", () => {
  test("people.search drops people the viewer blocked, muted or was blocked by", async () => {
    const s = await scene();
    const found = async () => (await s.calls("u-ann").people.search({ query: "bob" })).people.map((p) => p.id).sort();
    expect(await found()).toEqual(["u-bob", "u-cid"]);
    await s.safety("u-ann").mute({ personRef: "u-bob" });
    expect(await found()).toEqual(["u-cid"]);
    await s.safety("u-cid").block({ personRef: "u-ann" });
    expect(await found()).toEqual([]);
    // Signed out, nothing is hidden.
    const anon = callsRouter.createCaller({ app: s.app });
    expect((await anon.people.search({ query: "bob" })).people).toHaveLength(2);
  });

  test("people.leaderboard omits hidden people without renumbering anybody else", async () => {
    const s = await scene();
    settledRun(s.h, "u-bob", 12);
    settledRun(s.h, "u-cid", 11);
    settledRun(s.h, "u-dee", 10);
    const before = await s.calls("u-ann").people.leaderboard({ window: "all" });
    expect(before.ranked.map((r) => [r.person.id, r.rank])).toEqual([["u-bob", 1], ["u-cid", 2], ["u-dee", 3]]);
    await s.safety("u-ann").block({ personRef: "u-cid" });
    const after = await s.calls("u-ann").people.leaderboard({ window: "all" });
    expect(after.ranked.map((r) => [r.person.id, r.rank])).toEqual([["u-bob", 1], ["u-dee", 3]]);
    // Everyone else still sees the whole board.
    const bob = await s.calls("u-bob").people.leaderboard({ window: "all" });
    expect(bob.ranked).toHaveLength(3);
  });

  test("calls.top and the thread on a call carry nothing from a hidden person", async () => {
    const s = await scene();
    const bobsCall = await s.calls("u-bob").calls.create({ marketId: "m-1", side: "YES" });
    await s.calls("u-cid").calls.create({ marketId: "m-2", side: "NO" });
    const annsCall = await s.calls("u-ann").calls.create({ marketId: "m-3", side: "YES" });
    await s.calls("u-bob").calls.addUpdate({ callId: bobsCall.call.id, body: "Adding to it." });

    const top = async () => (await s.calls("u-ann").calls.top({})).entries.map((e) => e.author.id).sort();
    expect(await top()).toEqual(["u-bob", "u-cid"]);
    // Dee backs and Cid fades Ann's call: each is now a call of their own on m-3.
    await s.calls("u-dee").calls.respond({ targetCallId: annsCall.call.id, kind: "back" });
    await s.calls("u-cid").calls.respond({ targetCallId: annsCall.call.id, kind: "fade" });
    await s.safety("u-ann").mute({ personRef: "u-bob" });
    await s.safety("u-ann").block({ personRef: "u-cid" });
    // Filtered before the one-per-market pick, so m-3 still offers Dee's.
    expect(await top()).toEqual(["u-dee"]);

    // Ann's own call: Cid's fade is gone from her thread, Dee's back stays.
    const mine = await s.calls("u-ann").calls.get({ callId: annsCall.call.id });
    expect(mine.responses.map((r) => r.actorUserId)).toEqual(["u-dee"]);
    // Bob's call opened by its link still reads, without his later updates.
    const his = await s.calls("u-ann").calls.get({ callId: bobsCall.call.id });
    expect(his.entry.call.id).toBe(bobsCall.call.id);
    expect(his.updates).toEqual([]);
    // Anyone who did not hide Bob sees the update.
    expect((await s.calls("u-dee").calls.get({ callId: bobsCall.call.id })).updates.map((u) => u.body)).toEqual([
      "Adding to it.",
    ]);
  });
});

describe("a hidden actor is never pushed (trust x lockdown push)", () => {
  class RecordingSender implements PushSender {
    sent: { token: string; message: PushMessage }[] = [];
    async send(token: string, message: PushMessage): Promise<SendOutcome> {
      this.sent.push({ token, message });
      return "ok";
    }
  }

  test("a back from someone the recipient muted reaches neither the inbox badge nor the phone", async () => {
    const n = notificationsHarness({
      people: ["u-ann", "u-bob", "u-cid"].map((id) => person(id, { walletAddress: `Wallet_${id}` })),
      markets: [market("m1"), market("m2")],
    });
    const a1 = n.call("u-ann", "m1", "YES");
    const a2 = n.call("u-ann", "m2", "YES");
    n.respond("u-bob", a1.call.id, "back");
    n.respond("u-cid", a2.call.id, "back");
    const accounts = new InMemoryAccountStore();
    await accounts.registerPushToken("u-ann", "ann-device-" + "a".repeat(30), "android");
    const sender = new RecordingSender();
    const dispatcher = new PushDispatcher({
      accounts,
      graph: n.rt.graph,
      sender,
      maxAgeMs: 60_000,
      now: () => n.clock.now(),
      hiddenFor: async (recipient) => new Set(recipient === "u-ann" ? ["u-bob"] : []),
    });
    const report = await dispatcher.dispatch(n.rt.deriver.deriveNotifications().fresh);
    expect(report).toMatchObject({ considered: 2, suppressed: 1, pushed: 1 });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.message.data.call_id).toBe(a2.call.id);
  });

  test("a failing block list never stops a push", async () => {
    const n = notificationsHarness({
      people: ["u-ann", "u-bob"].map((id) => person(id, { walletAddress: `Wallet_${id}` })),
      markets: [market("m1")],
    });
    n.respond("u-bob", n.call("u-ann", "m1", "YES").call.id, "back");
    const accounts = new InMemoryAccountStore();
    await accounts.registerPushToken("u-ann", "ann-device-" + "a".repeat(30), "android");
    const dispatcher = new PushDispatcher({
      accounts,
      graph: n.rt.graph,
      sender: new RecordingSender(),
      maxAgeMs: 60_000,
      now: () => n.clock.now(),
      hiddenFor: async () => {
        throw new Error("trust store down");
      },
    });
    expect(await dispatcher.dispatch(n.rt.deriver.deriveNotifications().fresh)).toMatchObject({ pushed: 1, suppressed: 0 });
  });
});

describe("top calls follow the call cut-off (money x fomo)", () => {
  test("a call on a market inside its cut-off is not offered as one to answer", () => {
    const h = harness({ people: [person("u-ann"), person("u-bob")], markets: [market("m-soon"), market("m-later")] });
    h.rt.service.createCall({ marketId: "m-soon", side: "YES" }, "u-bob");
    h.rt.service.createCall({ marketId: "m-later", side: "YES" }, "u-bob");
    const soon = h.venue.getMarket("m-soon")!.market;
    const later = h.venue.getMarket("m-later")!.market;
    h.venue.upsertMarket({ ...soon, closesAt: h.clock.now() + 10 * 60_000 }, null);
    h.venue.upsertMarket({ ...later, closesAt: h.clock.now() + 120 * 60_000 }, null);
    const directory = new PeopleDirectory({ store: h.calls, markets: h.rt.markets, clock: h.clock, callCutoffMs: 30 * 60_000 });
    expect(directory.topCalls({ limit: 10 }, "u-ann").entries.map((e) => e.market.id)).toEqual(["m-later"]);
    const noCutoff = new PeopleDirectory({ store: h.calls, markets: h.rt.markets, clock: h.clock });
    expect(noCutoff.topCalls({ limit: 10 }, "u-ann").entries.map((e) => e.market.id).sort()).toEqual(["m-later", "m-soon"]);
  });
});
