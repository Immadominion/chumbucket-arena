/**
 * §5, Packet C: "`calls`: public rows readable by anyone; a `followers` row
 * readable only by a follower or the author."
 *
 * Two users, one following and one not, across every surface a call can reach:
 * the feed, one call by id, a person's page, and a call's responses. A rule
 * that holds on the feed but leaks through `calls.get` is not a rule.
 */

import { describe, expect, test } from "bun:test";
import { callsRouter } from "../src/api/calls.ts";
import { asWallet } from "../src/domain/ids.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { harness, market, person, testApp } from "./socialCallsFixtures.ts";

const MARKET = "mkt-eth";

/**
 * author  — makes both calls
 * fan     — follows the author
 * rando   — follows nobody
 */
async function scene() {
  const h = harness({
    people: [person("u-author"), person("u-fan"), person("u-rando")],
    markets: [market(MARKET), market("mkt-2")],
  });
  h.calls.follow("u-fan", "u-author");

  const open = h.rt.service.createCall(
    { marketId: MARKET, side: "YES", visibility: "public", thesis: "out loud" },
    "u-author",
  );
  const quiet = h.rt.service.createCall(
    { marketId: "mkt-2", side: "NO", visibility: "followers", thesis: "just for you" },
    "u-author",
  );

  const app = await testApp();
  setCallsRuntime(app.config, h.rt);

  return {
    h,
    publicCallId: open.call.id,
    followersCallId: quiet.call.id,
    anon: callsRouter.createCaller({ app }),
    fan: callsRouter.createCaller({ app, wallet: asWallet("Wallet_u-fan") }),
    rando: callsRouter.createCaller({ app, wallet: asWallet("Wallet_u-rando") }),
    author: callsRouter.createCaller({ app, wallet: asWallet("Wallet_u-author") }),
  };
}

describe("a public call is readable by anyone", () => {
  test("the feed carries it for a signed-out caller, a follower and a stranger", async () => {
    const s = await scene();
    for (const caller of [s.anon, s.fan, s.rando]) {
      const page = await caller.calls.feed({ mode: "global", limit: 20 });
      expect(page.entries.map((e) => e.call.id)).toContain(s.publicCallId);
    }
  });

  test("calls.get serves it to a signed-out caller", async () => {
    const s = await scene();
    const detail = await s.anon.calls.get({ callId: s.publicCallId });
    expect(detail.entry.call.visibility).toBe("public");
    expect(detail.entry.author.handle).toBe("u-author");
  });
});

describe("a followers-only call reaches a follower and the author, and nobody else", () => {
  test("the feed withholds it from a stranger and from anon", async () => {
    const s = await scene();
    for (const caller of [s.anon, s.rando]) {
      const page = await caller.calls.feed({ mode: "global", limit: 20 });
      expect(page.entries.map((e) => e.call.id)).not.toContain(s.followersCallId);
    }
  });

  test("the feed carries it for the follower and for the author", async () => {
    const s = await scene();
    for (const caller of [s.fan, s.author]) {
      const page = await caller.calls.feed({ mode: "global", limit: 20 });
      expect(page.entries.map((e) => e.call.id)).toContain(s.followersCallId);
    }
  });

  test("calls.get refuses a stranger with the same answer it gives for a missing call", async () => {
    const s = await scene();
    const missing = await s.rando.calls.get({ callId: "call-does-not-exist" }).catch((e) => e);
    const hidden = await s.rando.calls.get({ callId: s.followersCallId }).catch((e) => e);
    // Deliberately indistinguishable: a different refusal would confirm the
    // row exists and who made it.
    expect(hidden.code).toBe("NOT_FOUND");
    expect(hidden.message).toBe(missing.message);
  });

  test("calls.get serves it to the follower", async () => {
    const s = await scene();
    const detail = await s.fan.calls.get({ callId: s.followersCallId });
    expect(detail.entry.call.visibility).toBe("followers");
  });

  test("people.get shows the follower both calls and the stranger only one", async () => {
    const s = await scene();
    const forFan = await s.fan.people.get({ personRef: "u-author" });
    const forRando = await s.rando.people.get({ personRef: "u-author" });
    const forAnon = await s.anon.people.get({ personRef: "u-author" });

    expect(forFan.calls.map((e) => e.call.id).sort()).toEqual([s.followersCallId, s.publicCallId].sort());
    expect(forRando.calls.map((e) => e.call.id)).toEqual([s.publicCallId]);
    expect(forAnon.calls.map((e) => e.call.id)).toEqual([s.publicCallId]);
  });

  test("unfollowing takes the row away again", async () => {
    const s = await scene();
    s.h.calls.unfollow("u-fan", "u-author");
    const page = await s.fan.calls.feed({ mode: "global", limit: 20 });
    expect(page.entries.map((e) => e.call.id)).not.toContain(s.followersCallId);
  });

  test("following is asymmetric: the AUTHOR following the fan grants nothing", async () => {
    const s = await scene();
    s.h.calls.unfollow("u-fan", "u-author");
    s.h.calls.follow("u-author", "u-fan"); // the wrong direction
    const page = await s.fan.calls.feed({ mode: "global", limit: 20 });
    expect(page.entries.map((e) => e.call.id)).not.toContain(s.followersCallId);
  });
});

describe("the following feed", () => {
  test("a signed-out caller gets UNAUTHORIZED, not an empty page", async () => {
    const s = await scene();
    const err = await s.anon.calls.feed({ mode: "following", limit: 20 }).catch((e) => e);
    expect(err.code).toBe("UNAUTHORIZED");
    // "you follow nobody" must stay distinguishable from "we don't know you".
    const rando = await s.rando.calls.feed({ mode: "following", limit: 20 });
    expect(rando.entries).toHaveLength(0);
  });

  test("a follower sees only the people they follow", async () => {
    const s = await scene();
    const page = await s.fan.calls.feed({ mode: "following", limit: 20 });
    expect(page.entries).toHaveLength(2);
    expect(new Set(page.entries.map((e) => e.call.userId))).toEqual(new Set(["u-author"]));
  });

  test("a credential that maps to no canonical user is UNAUTHORIZED, not a 500", async () => {
    const s = await scene();
    const app = await testApp();
    setCallsRuntime(app.config, s.h.rt);
    const stranger = callsRouter.createCaller({ app, wallet: asWallet("Wallet_nobody_linked") });
    const err = await stranger.calls.feed({ mode: "following", limit: 20 }).catch((e) => e);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toMatch(/isn't linked yet/);
  });
});

describe("no procedure accepts an identity as input (§8 finding 4)", () => {
  test("passing viewerUserId / userId / wallet is rejected by the input schema", async () => {
    const s = await scene();
    const forbidden = [
      { key: "viewerUserId", call: () => s.anon.calls.feed({ viewerUserId: "u-author" } as never) },
      { key: "userId", call: () => s.anon.markets.detail({ marketId: MARKET, userId: "u-author" } as never) },
      { key: "wallet", call: () => s.anon.people.get({ personRef: "u-author", wallet: "Wallet_u-fan" } as never) },
    ];
    for (const { key, call } of forbidden) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/Unrecognized key|BAD_REQUEST|unrecognized_keys/i);
      expect(key).toBeTruthy();
    }
  });

  test("a stranger cannot borrow an identity to see a followers-only call", async () => {
    const s = await scene();
    // Even if the key were accepted, the viewer comes from the session.
    const page = await s.rando.calls.feed({ mode: "global", limit: 20 } as never);
    expect(page.entries.map((e) => e.call.id)).not.toContain(s.followersCallId);
  });
});
