/**
 * Trust & safety, legal and account lifecycle, end to end through
 * createCaller with in-memory stores — no network, no database.
 *
 *   - content policy and per-person write limits on calls.create / respond /
 *     people.follow
 *   - report (call, thesis, person) and the admin hide that uses hideCall
 *   - block and mute filtered out of the feed, invitations and inbox
 *   - the funded-trading attestation
 *   - auth.deleteAccount (idempotent, session-keyed) and auth.exportData
 */

import { describe, expect, test } from "bun:test";
import { authRouter } from "../src/api/authRoutes.ts";
import { callsRouter } from "../src/api/calls.ts";
import { notificationsRouter } from "../src/api/notifications.ts";
import { trustRouter } from "../src/api/trust.ts";
import { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } from "../src/auth/AuthIdentityRuntime.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { asWallet } from "../src/domain/ids.ts";
import { checkText, isReservedHandle } from "../src/trust/contentFilter.ts";
import { DEFAULT_RATE_LIMITS, resolveTrustConfig, type TrustConfig } from "../src/trust/config.ts";
import { WriteRateLimiter } from "../src/trust/rateLimit.ts";
import { buildTrustRuntime, setTrustRuntime } from "../src/trust/runtime.ts";
import { InMemoryTrustStore, RecordingAuthUserAdmin } from "../src/trust/store.ts";
import { FakeIdentityStore, FakeJwtVerifier } from "./authIdentityFixtures.ts";
import { harness, market, person, testApp } from "./socialCallsFixtures.ts";

const OPEN = "mkt-open";

async function scene(opts: { admins?: string[] } = {}) {
  const h = harness({
    people: [person("u-ann"), person("u-bob"), person("u-cid")],
    markets: [market(OPEN), market("mkt-2"), market("mkt-3")],
  });
  const app = await testApp();
  setCallsRuntime(app.config, h.rt);
  const config: TrustConfig = {
    ...resolveTrustConfig(app.config, {}),
    adminUserIds: new Set(opts.admins ?? ["u-cid"]),
  };
  const store = new InMemoryTrustStore();
  const authAdmin = new RecordingAuthUserAdmin();
  const trust = buildTrustRuntime(app.config, { config, store, authAdmin, now: () => h.clock.now() });
  setTrustRuntime(app.config, trust);

  const identity = new FakeIdentityStore().addUser("auth-ann", "u-ann").addUser("auth-bob", "u-bob");
  const verifier = new FakeJwtVerifier().issue("tok-ann", "auth-ann").issue("tok-bob", "auth-bob");
  primeAuthIdentityRuntime(app.config, { store: identity, verifier, policy: resolveAuthIdentityPolicy(app.config) });

  const as = (who: string) => ({ app, wallet: asWallet(`Wallet_${who}`) });
  return {
    h,
    app,
    trust,
    store,
    authAdmin,
    verifier,
    calls: (who: string) => callsRouter.createCaller(as(who)),
    safety: (who: string) => trustRouter.createCaller(as(who)),
    inbox: (who: string) => notificationsRouter.createCaller(as(who)),
    anonSafety: trustRouter.createCaller({ app }),
    account: (token: string) => authRouter.createCaller({ app, supabaseAccessToken: token }),
    accountAs: (who: string) => authRouter.createCaller(as(who)),
  };
}

describe("content policy", () => {
  test("refuses links, with a reason a person can act on", () => {
    for (const t of ["see https://x.co", "www.scam.xyz now", "claim at pump.fun", "dm me t.me/rug", "bit.ly/abc", "free.money here", "OpenAI.com style hype", "go to SCAM.COM now"]) {
      const v = checkText(t, "thesis");
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toBe("Links aren't allowed in your thesis. Remove the web address and try again.");
    }
  });

  test("refuses slurs and strong profanity, including common disguises", () => {
    for (const t of ["what a fucking call", "F U C K this", "fuuuuck", "f.u.c.k", "you c*nt? no: cunt", "sh1t is fine but b1tch is not", "kys"]) {
      expect(checkText(t, "thesis").ok).toBe(false);
    }
    const v = checkText("total motherfucker", "name");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toBe("Your name includes language we don't allow. Please rephrase it.");
  });

  test("lets ordinary writing through", () => {
    for (const t of [
      "BTC breaks 100k by Friday. So it goes.",
      "Damn, this is a hell of a market. I'm 70% sure.",
      "toly.sol called this first",
      "U.S. CPI comes in at 2.9, e.g. below consensus",
      "Scunthorpe United win; the therapist agrees",
      // A missed space before a capitalised word is a typo, not a link.
      "Arsenal win.So easy",
      "Going up.To the moon",
      "Messi to score.Co-favourites",
      "",
      null,
    ]) {
      expect(checkText(t as string | null, "thesis").ok).toBe(true);
    }
  });

  test("a live person cannot claim a deleted account's username", () => {
    expect(isReservedHandle("deleted_1234abcd5678")).toBe(true);
    expect(isReservedHandle("@Deleted_x")).toBe(true);
    expect(isReservedHandle("ann")).toBe(false);
  });
});

describe("per-person write limits", () => {
  test("every window applies, the wait is in words, and a refusal costs nothing", () => {
    let now = 1_000_000;
    const limiter = new WriteRateLimiter(DEFAULT_RATE_LIMITS, () => now);
    for (let i = 0; i < 6; i++) limiter.charge("calls.create", "u-ann");
    expect(() => limiter.charge("calls.create", "u-ann")).toThrow("You're making calls very quickly. Try again in a minute.");
    // Someone else is unaffected.
    limiter.charge("calls.create", "u-bob");
    now += 61_000;
    limiter.charge("calls.create", "u-ann");
  });

  test("calls.create and calls.respond answer TOO_MANY_REQUESTS past the limit", async () => {
    const s = await scene();
    for (const m of [OPEN, "mkt-2", "mkt-3"]) await s.calls("u-ann").calls.create({ marketId: m, side: "YES" });
    // Three more creates would pass the per-minute window of six; spend it.
    for (let i = 0; i < 3; i++) s.trust.limiter.charge("calls.create", "u-ann");
    await expect(s.calls("u-ann").calls.create({ marketId: OPEN, side: "NO" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "You're making calls very quickly. Try again in a minute.",
    });
  });

  test("a thesis with a link is refused before anything is locked", async () => {
    const s = await scene();
    await expect(
      s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES", thesis: "buy at rug.xyz" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Links aren't allowed in your thesis. Remove the web address and try again." });
    expect(s.h.calls.listCalls()).toHaveLength(0);
    const own = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES", thesis: "clean" });
    await expect(
      s.calls("u-bob").calls.respond({ targetCallId: own.call.id, kind: "challenge", note: "you fucking clown" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("report", () => {
  test("a call, its thesis or a person; a repeat is the same report", async () => {
    const s = await scene();
    const call = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES", thesis: "a thesis" });
    const first = await s.safety("u-bob").report({ subject: "call", callId: call.call.id, reason: "spam" });
    expect(first.status).toBe("received");
    const again = await s.safety("u-bob").report({ subject: "call", callId: call.call.id, reason: "scam" });
    expect(again).toEqual({ reportId: first.reportId, status: "already_reported" });
    expect((await s.safety("u-bob").report({ subject: "thesis", callId: call.call.id, reason: "hate" })).status).toBe("received");
    expect((await s.safety("u-bob").report({ subject: "person", personRef: "u-ann", reason: "harassment", details: "dms" })).status).toBe("received");
    expect(await s.store.listReports({ status: "open", limit: 10 })).toHaveLength(3);
  });

  test("refuses signed-out callers, self reports and calls the reporter cannot see", async () => {
    const s = await scene();
    const call = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES", visibility: "followers" });
    await expect(s.anonSafety.report({ subject: "person", personRef: "u-ann", reason: "spam" })).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Sign in to report." });
    await expect(s.safety("u-ann").report({ subject: "person", personRef: "u-ann", reason: "spam" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(s.safety("u-bob").report({ subject: "call", callId: call.call.id, reason: "spam" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(s.safety("u-bob").report({ subject: "call", callId: call.call.id, reason: "nope" as "spam" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // No identity may be smuggled in.
    await expect(
      s.safety("u-bob").report({ subject: "person", personRef: "u-ann", reason: "spam", reporterUserId: "u-cid" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("admin: only the allow-listed account reads reports and hides the call", async () => {
    const s = await scene({ admins: ["u-cid"] });
    const call = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES", thesis: "bad" });
    const { reportId } = await s.safety("u-bob").report({ subject: "thesis", callId: call.call.id, reason: "hate" });

    await expect(s.safety("u-bob").admin.reports({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(s.safety("u-bob").admin.hideCall({ callId: call.call.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const open = await s.safety("u-cid").admin.reports({});
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: reportId, subject: { userId: "u-ann" }, call: { id: call.call.id, hidden: false } });

    const hidden = await s.safety("u-cid").admin.hideCall({ callId: call.call.id, reportId, note: "slur" });
    expect(hidden.hiddenAt).not.toBeNull();
    expect(hidden.report?.status).toBe("actioned");
    // Gone from distribution; the author still sees their own record.
    expect((await s.calls("u-bob").calls.feed({})).entries).toHaveLength(0);
    await expect(s.calls("u-bob").calls.get({ callId: call.call.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await s.calls("u-ann").calls.get({ callId: call.call.id })).entry.call.id).toBe(call.call.id);
    // Results survive a hide (§3).
    expect(s.h.calls.getResult(call.call.id)).toBeDefined();
    expect(await s.safety("u-cid").admin.reports({})).toHaveLength(0);
  });
});

describe("block and mute", () => {
  test("block hides both people from each other's feed and stops interaction both ways", async () => {
    const s = await scene();
    const annCall = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES" });
    const bobCall = await s.calls("u-bob").calls.create({ marketId: "mkt-2", side: "NO" });
    await s.calls("u-ann").people.follow({ personRef: "u-bob" });
    await s.calls("u-bob").people.follow({ personRef: "u-ann" });

    expect(await s.safety("u-ann").block({ personRef: "u-bob" })).toEqual({ personId: "u-bob", blocked: true });

    const feedIds = async (who: string) => (await s.calls(who).calls.feed({})).entries.map((e) => e.call.id);
    expect(await feedIds("u-ann")).toEqual([annCall.call.id]);
    expect(await feedIds("u-bob")).toEqual([bobCall.call.id]);
    expect(await feedIds("u-cid")).toHaveLength(2);
    // Following ended in both directions.
    expect(s.h.calls.isFollowing("u-ann", "u-bob")).toBe(false);
    expect(s.h.calls.isFollowing("u-bob", "u-ann")).toBe(false);

    await expect(s.calls("u-bob").calls.respond({ targetCallId: annCall.call.id, kind: "back" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You can't respond to this person's calls.",
    });
    await expect(s.calls("u-ann").calls.respond({ targetCallId: bobCall.call.id, kind: "fade" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You've blocked this person. Unblock them in Settings to respond to their calls.",
    });
    await expect(s.calls("u-bob").people.follow({ personRef: "u-ann" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const lists = await s.safety("u-ann").lists({});
    expect(lists.blocked.map((p) => p.userId)).toEqual(["u-bob"]);
    expect(lists.blocked[0]?.handle).toBe("u-bob");

    await s.safety("u-ann").unblock({ personRef: "u-bob" });
    expect(await feedIds("u-bob")).toHaveLength(2);
    await s.calls("u-bob").calls.respond({ targetCallId: annCall.call.id, kind: "back" });
  });

  test("mute hides only for the muter, and their notifications stop counting", async () => {
    const s = await scene();
    const annCall = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES" });
    await s.calls("u-bob").calls.respond({ targetCallId: annCall.call.id, kind: "challenge", note: "rematch?" });
    await s.calls("u-cid").calls.respond({ targetCallId: annCall.call.id, kind: "back" });

    const before = await s.inbox("u-ann").notifications.list({});
    expect(before.items.map((n) => n.actor?.userId).sort()).toEqual(["u-bob", "u-cid"]);
    expect((await s.inbox("u-ann").notifications.unreadCount({})).unread).toBe(2);

    await s.safety("u-ann").mute({ personRef: "u-bob" });
    expect((await s.inbox("u-ann").notifications.unreadCount({})).unread).toBe(1);
    const after = await s.inbox("u-ann").notifications.list({});
    expect(after.items.map((n) => n.actor?.userId)).toEqual(["u-cid"]);
    expect(await s.calls("u-ann").calls.invitations({})).toHaveLength(0);
    // Bob still sees Ann; muting is one-way and silent.
    expect((await s.calls("u-bob").calls.feed({})).entries.some((e) => e.call.id === annCall.call.id)).toBe(true);
    expect((await s.safety("u-ann").lists({})).muted.map((p) => p.userId)).toEqual(["u-bob"]);
    await expect(s.safety("u-ann").mute({ personRef: "u-ann" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(s.safety("u-ann").mute({ personRef: "nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("funded-trading attestation", () => {
  test("is recorded against the current terms version and nothing less", async () => {
    const s = await scene();
    const signedOut = await s.anonSafety.legalStatus({});
    expect(signedOut.fundedTrading.accepted).toBe(false);
    expect(signedOut.termsUrl).toBe("https://chumbucket.fun/terms");
    expect(signedOut.privacyUrl).toBe("https://chumbucket.fun/privacy");
    expect(signedOut.deletionUrl).toBe("https://chumbucket.fun/delete-account");

    await expect(s.trust.service.assertFundedTradingAccepted("u-ann")).rejects.toThrow("18 or older");
    await expect(
      s.safety("u-ann").acceptFundedTrading({ termsVersion: "old", over18: true, eligibleJurisdiction: true, acceptsVenueTerms: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      s.safety("u-ann").acceptFundedTrading({ termsVersion: signedOut.termsVersion, over18: false, eligibleJurisdiction: true, acceptsVenueTerms: true } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ok = await s.safety("u-ann").acceptFundedTrading({
      termsVersion: signedOut.termsVersion,
      over18: true,
      eligibleJurisdiction: true,
      acceptsVenueTerms: true,
    });
    expect(ok.accepted).toBe(true);
    expect((await s.safety("u-ann").legalStatus({})).fundedTrading.accepted).toBe(true);
    await s.trust.service.assertFundedTradingAccepted("u-ann");
    await expect(s.trust.service.assertFundedTradingAccepted("u-bob")).rejects.toThrow();
  });
});

describe("auth.deleteAccount", () => {
  test("anonymises the person, keeps their calls, removes the sign-in, and is idempotent", async () => {
    const s = await scene();
    const annCall = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES", thesis: "mine" });
    await s.calls("u-ann").people.follow({ personRef: "u-bob" });
    await s.calls("u-cid").people.follow({ personRef: "u-ann" });
    await s.safety("u-ann").block({ personRef: "u-cid" });

    await expect(s.account("tok-ann").deleteAccount({ confirm: "delete" as "DELETE" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const done = await s.account("tok-ann").deleteAccount({ confirm: "DELETE" });
    expect(done).toMatchObject({ status: "deleted", userId: "u-ann", alreadyDeleted: false });
    expect(s.authAdmin.deleted).toEqual(["auth-ann"]);

    // The call stays, now from "Deleted account", with no wallet.
    const entry = (await s.calls("u-bob").calls.get({ callId: annCall.call.id })).entry;
    expect(entry.author).toMatchObject({ displayName: "Deleted account", walletAddress: null, avatarUrl: null });
    expect(entry.author.handle).toMatch(/^deleted_/);
    expect(s.h.calls.isFollowing("u-ann", "u-bob")).toBe(false);
    expect(s.h.calls.isFollowing("u-cid", "u-ann")).toBe(false);
    expect((await s.store.relationsOf("u-cid")).blockedBy).toEqual([]);

    const again = await s.account("tok-ann").deleteAccount({ confirm: "DELETE" });
    expect(again).toMatchObject({ status: "deleted", userId: "u-ann", alreadyDeleted: true });
    expect(s.authAdmin.deleted).toEqual(["auth-ann"]);
  });

  test("finishes on retry when removing the sign-in failed the first time", async () => {
    const s = await scene();
    s.authAdmin.failNext = true;
    await expect(s.account("tok-bob").deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Your profile has been removed, but we couldn't finish removing your sign-in. Try again in a moment. It's safe to retry.",
    });
    const retry = await s.account("tok-bob").deleteAccount({ confirm: "DELETE" });
    expect(retry).toMatchObject({ status: "deleted", userId: "u-bob" });
    expect(s.authAdmin.deleted).toEqual(["auth-bob"]);
  });

  test("a sign-in with no profile is still deleted", async () => {
    const s = await scene();
    s.verifier.issue("tok-new", "auth-new");
    expect(await s.account("tok-new").deleteAccount({ confirm: "DELETE" })).toMatchObject({ status: "deleted", userId: null });
    expect(s.authAdmin.deleted).toEqual(["auth-new"]);
  });

  test("a token for a sign-in already removed is told it is done; anything else must sign in", async () => {
    const s = await scene();
    const jwt = (sub: string) =>
      `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`;
    const sub = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    s.verifier.issue("tok-gone", sub);
    await s.account("tok-gone").deleteAccount({ confirm: "DELETE" });
    // GoTrue no longer verifies a removed user's token.
    // Unverified, so it names no account.
    expect(await s.account(jwt(sub)).deleteAccount({ confirm: "DELETE" })).toMatchObject({ status: "deleted", alreadyDeleted: true, userId: null });
    await expect(s.account(jwt("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")).deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(s.accountAs("u-ann").deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("auth.exportData", () => {
  test("returns the caller's own profile, calls and follows — and nobody else's", async () => {
    const s = await scene();
    const c = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES", thesis: "my reasons" });
    await s.calls("u-ann").people.follow({ personRef: "u-bob" });
    await s.calls("u-cid").people.follow({ personRef: "u-ann" });
    await s.calls("u-bob").calls.create({ marketId: "mkt-2", side: "NO" });
    await s.safety("u-ann").mute({ personRef: "u-cid" });

    const out = (await s.accountAs("u-ann").exportData({})) as Record<string, unknown> & {
      calls: { id: string; thesis: string }[];
      following: { userId: string }[];
      followers: { userId: string }[];
      muted: { userId: string }[];
    };
    expect(out.format).toBe("chumbucket-account-export/v1");
    expect(out.account).toMatchObject({ userId: "u-ann", handle: "u-ann" });
    expect(out.calls.map((x) => x.id)).toEqual([c.call.id]);
    expect(out.calls[0]?.thesis).toBe("my reasons");
    expect(out.following.map((p) => p.userId)).toEqual(["u-bob"]);
    expect(out.followers.map((p) => p.userId)).toEqual(["u-cid"]);
    expect(out.muted.map((p) => p.userId)).toEqual(["u-cid"]);
    await expect(authRouter.createCaller({ app: s.app }).exportData({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("trust.requestDeletion (web)", () => {
  test("stores the request and limits repeats per contact", async () => {
    const s = await scene();
    for (let i = 0; i < 3; i++) await s.anonSafety.requestDeletion({ contact: "Me@Example.com", handle: "@ann" });
    expect(s.store.deletionRequests).toHaveLength(3);
    expect(s.store.deletionRequests[0]).toMatchObject({ contact: "me@example.com", handle: "ann" });
    await expect(s.anonSafety.requestDeletion({ contact: "me@example.com" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("inbox with only pending calls (regression)", () => {
  test("a record cell with nothing resolved yet does not fail the inbox or the record", async () => {
    const s = await scene();
    const annCall = await s.calls("u-ann").calls.create({ marketId: OPEN, side: "YES" });
    await s.calls("u-bob").calls.respond({ targetCallId: annCall.call.id, kind: "back" });
    // Before the fix, buildCounts refused the cell's lastResolvedAt: null and
    // every derive-on-read inbox request answered 500.
    expect((await s.inbox("u-ann").notifications.list({})).items).toHaveLength(1);
    expect((await s.inbox("u-ann").record.mine({})).free.total.pending).toBe(1);
  });
});
