/**
 * people.suggested — who to follow during onboarding (onboarding spec §13.3).
 *
 * What these tests hold it to:
 *   - only real people with at least one public free call; an empty directory
 *     is an empty list, never fixtures;
 *   - the viewer and anyone they already follow are left out;
 *   - order: ranked → top-call authors → building → most recent caller,
 *     nobody twice, nobody ranked by money;
 *   - each person's latest LIVE call (an open market with no result), or null;
 *   - friends only for a session, from the viewer's own legacy rows, never
 *     repeated in `people`;
 *   - placeholder-handle people are still returned (the client hides only the
 *     handle);
 *   - no wallet, stake or P&L field anywhere on the wire;
 *   - people the viewer blocked or muted, people who blocked the viewer, and
 *     deleted accounts are never suggested (src/trust);
 *   - a "latest live call" honours the call cut-off (M14): it is a call the
 *     viewer could still answer.
 */

import { describe, expect, test } from "bun:test";
import { callsRouter } from "../src/api/calls.ts";
import { trustRouter } from "../src/api/trust.ts";
import { PeopleDirectory } from "../src/calls/people.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { resolveTrustConfig } from "../src/trust/config.ts";
import { buildTrustRuntime, setTrustRuntime } from "../src/trust/runtime.ts";
import { InMemoryTrustStore, RecordingAuthUserAdmin } from "../src/trust/store.ts";
import { MAX_FRIENDS_READ, SupabaseFriendsReader, type FriendsReader } from "../src/calls/friends.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { assertMoneyFree } from "../src/calls/types.ts";
import type { Resolution } from "../src/prediction/types.ts";
import { asWallet } from "../src/domain/ids.ts";
import { MIN_DECIDED_FOR_ACCURACY } from "../src/notifications/record.ts";
import { harness, market, person, testApp, type Harness } from "./socialCallsFixtures.ts";

function settledRun(h: Harness, userId: string, n: number, correct: number) {
  for (let i = 0; i < n; i++) {
    const id = `${userId}-m${i}`;
    h.venue.upsertMarket(market(id), null);
    h.venue.appendSnapshot({ marketId: id, yesProbability: 0.5, observedAt: h.clock.now(), source: "venue" });
    h.rt.service.createCall({ marketId: id, side: "YES" }, userId);
    h.resolve(id, (i < correct ? "YES" : "NO") as Resolution);
  }
  h.rt.sync.runOnce();
}

async function routes(h: Harness) {
  const app = await testApp();
  setCallsRuntime(app.config, h.rt);
  const as = (id: string) => callsRouter.createCaller({ app, wallet: asWallet(`Wallet_${id}`) });
  return { anon: callsRouter.createCaller({ app }), as };
}

const friendsOf = (map: Record<string, string[]>): FriendsReader => ({
  async friendsOf(userId) {
    return map[userId] ?? [];
  },
});

/**
 * u-ace: ranked (10 decided). u-hot: a top call with responses. u-new: an
 * open call, newer, no responses (also a top call). u-mid: building (3
 * decided). u-quiet: only a Back — which is a call of their own, on a market
 * the strip already shows. u-silent: no calls at all.
 */
function scene() {
  const h = harness({
    people: [
      person("u-ace"),
      person("u-hot"),
      person("u-mid"),
      person("u-new", { handle: "user-80d78065", displayName: "Kemi" }),
      person("u-quiet"),
      person("u-silent"),
      person("u-me"),
      person("u-pal"),
    ],
    markets: [market("m-hot"), market("m-new"), market("m-late")],
  });
  settledRun(h, "u-ace", MIN_DECIDED_FOR_ACCURACY, 8);
  settledRun(h, "u-mid", 3, 2);
  const svc = h.rt.service;
  const hot = svc.createCall({ marketId: "m-hot", side: "NO" }, "u-hot");
  svc.respond({ targetCallId: hot.call.id, kind: "back" }, "u-quiet");
  h.clock.advance(1000);
  svc.createCall({ marketId: "m-new", side: "YES" }, "u-new");
  return h;
}

describe("people.suggested", () => {
  test("an empty directory suggests nobody — never fixtures", async () => {
    const h = harness({ people: [person("u-ann")], markets: [market("m")] });
    const { anon } = await routes(h);
    const page = await anon.people.suggested({});
    expect(page.people).toEqual([]);
    expect(page.friends).toEqual([]);
    expect(typeof page.servedAt).toBe("number");
  });

  test("real callers only, ordered ranked → top call → building → recent", async () => {
    const h = scene();
    const { anon } = await routes(h);
    const page = await anon.people.suggested({});
    expect(page.people.map((p) => [p.id, p.reason])).toEqual([
      ["u-ace", "ranked"],
      ["u-hot", "top_call"],
      ["u-new", "top_call"],
      ["u-mid", "building"],
      ["u-quiet", "recent"],
    ]);
    // Nobody without a public free call is suggested.
    expect(page.people.map((p) => p.id)).not.toContain("u-silent");
    expect(page.people.map((p) => p.id)).not.toContain("u-me");
    // Records come from the one public record.
    const ace = page.people[0]!;
    expect(ace.record.display.mode).toBe("accuracy");
    expect(page.friends).toEqual([]);
  });

  test("each person's latest live call, or null once nothing is open", async () => {
    const h = scene();
    const { anon } = await routes(h);
    const page = await anon.people.suggested({});
    const hot = page.people.find((p) => p.id === "u-hot")!;
    expect(hot.latestLiveCall).toMatchObject({ side: "NO", marketId: "m-hot", question: "[DEMO] Will m-hot happen?" });
    // u-ace's calls all settled: nothing live.
    expect(page.people.find((p) => p.id === "u-ace")!.latestLiveCall).toBeNull();

    h.venue.upsertMarket(market("m-hot", { status: "CLOSED_PENDING_RESOLUTION", rawStatus: "closed" }), null);
    const later = await anon.people.suggested({});
    expect(later.people.find((p) => p.id === "u-hot")!.latestLiveCall).toBeNull();
  });

  test("the viewer and people they follow are left out", async () => {
    const h = scene();
    h.rt.service.setFollowing({ personRef: "u-ace", following: true }, "u-mid");
    const { as } = await routes(h);
    const page = await as("u-mid").people.suggested({});
    const ids = page.people.map((p) => p.id);
    expect(ids).not.toContain("u-mid");
    expect(ids).not.toContain("u-ace");
    expect(page.people.every((p) => p.viewerIsFollowing === false)).toBe(true);
  });

  test("placeholder handles are still returned; the client hides the handle", async () => {
    const h = scene();
    const { anon } = await routes(h);
    const kemi = (await anon.people.suggested({})).people.find((p) => p.id === "u-new")!;
    expect(kemi.handle).toBe("user-80d78065");
    expect(kemi.displayName).toBe("Kemi");
  });

  test("friends: the session's own, call or not, never repeated in people", async () => {
    const h = scene();
    h.rt.friends = friendsOf({ "u-me": ["u-pal", "u-hot", "u-missing", "u-me"] });
    const { anon, as } = await routes(h);

    const mine = await as("u-me").people.suggested({});
    expect(mine.friends.map((f) => [f.id, f.reason])).toEqual([
      ["u-pal", "friend"],
      ["u-hot", "friend"],
    ]);
    expect(mine.people.map((p) => p.id)).not.toContain("u-hot");
    // A friend with no calls is still a friend — a row that says so.
    expect(mine.friends[0]!.record.counts.pending).toBe(0);

    // Signed out: no friends, whatever the reader holds.
    expect((await anon.people.suggested({})).friends).toEqual([]);
  });

  test("a friend already followed is not suggested again", async () => {
    const h = scene();
    h.rt.friends = friendsOf({ "u-me": ["u-pal"] });
    h.rt.service.setFollowing({ personRef: "u-pal", following: true }, "u-me");
    const { as } = await routes(h);
    expect((await as("u-me").people.suggested({})).friends).toEqual([]);
  });

  test("limit bounds the list; the input is strict", async () => {
    const h = scene();
    const { anon } = await routes(h);
    expect((await anon.people.suggested({ limit: 2 })).people).toHaveLength(2);
    await expect(anon.people.suggested({ limit: 0 })).rejects.toThrow();
    await expect(anon.people.suggested({ limit: 21 })).rejects.toThrow();
    // No way to name a viewer: identity comes from the session only.
    await expect(
      anon.people.suggested({ viewerUserId: "u-me" } as unknown as { limit: number }),
    ).rejects.toThrow();
  });

  test("each person carries the avatar they chose, so the row matches their calls", async () => {
    const h = scene();
    h.calls.upsertPerson(person("u-hot", { avatarId: 3 }));
    const { anon } = await routes(h);
    const page = await anon.people.suggested({});
    expect(page.people.find((p) => p.id === "u-hot")!.avatarId).toBe(3);
    expect(page.people.find((p) => p.id === "u-ace")!.avatarId).toBeNull();
  });

  test("no money and no wallet on the wire", async () => {
    const h = scene();
    h.rt.friends = friendsOf({ "u-me": ["u-pal"] });
    const { as } = await routes(h);
    const page = await as("u-me").people.suggested({});
    assertMoneyFree(page, "people.suggested");
    const wire = JSON.stringify(page);
    expect(wire).not.toContain("Wallet_");
    expect(wire).not.toContain("walletAddress");
  });
});

describe("people.suggested × trust and the call cut-off", () => {
  async function withTrust(h: Harness) {
    const app = await testApp();
    setCallsRuntime(app.config, h.rt);
    setTrustRuntime(
      app.config,
      buildTrustRuntime(app.config, {
        config: resolveTrustConfig(app.config, {}),
        store: new InMemoryTrustStore(),
        authAdmin: new RecordingAuthUserAdmin(),
        now: () => h.clock.now(),
      }),
    );
    const as = (id: string) => ({ app, wallet: asWallet(`Wallet_${id}`) });
    return {
      calls: (id: string) => callsRouter.createCaller(as(id)),
      safety: (id: string) => trustRouter.createCaller(as(id)),
    };
  }

  test("blocked, muted and blocked-by people are never suggested, as callers or friends", async () => {
    const h = scene();
    h.rt.friends = friendsOf({ "u-me": ["u-pal", "u-quiet"] });
    const s = await withTrust(h);
    const before = await s.calls("u-me").people.suggested({});
    expect(before.people.map((p) => p.id)).toEqual(expect.arrayContaining(["u-ace", "u-hot", "u-mid"]));
    expect(before.friends.map((f) => f.id)).toEqual(["u-pal", "u-quiet"]);

    await s.safety("u-me").mute({ personRef: "u-ace" });
    await s.safety("u-me").block({ personRef: "u-quiet" });
    await s.safety("u-hot").block({ personRef: "u-me" });

    const after = await s.calls("u-me").people.suggested({});
    const ids = after.people.map((p) => p.id);
    expect(ids).not.toContain("u-ace");
    expect(ids).not.toContain("u-hot");
    expect(after.friends.map((f) => f.id)).toEqual(["u-pal"]);
    // Somebody else's suggestions are untouched by u-me's choices.
    expect((await s.calls("u-mid").people.suggested({})).people.map((p) => p.id)).toContain("u-ace");
  });

  test("a deleted account is never suggested, even as a friend", async () => {
    const h = scene();
    h.calls.upsertPerson(person("u-hot", { handle: "deleted_0123456789ab", displayName: "Deleted account" }));
    h.calls.upsertPerson(person("u-pal", { handle: "", displayName: "Deleted account" }));
    h.rt.friends = friendsOf({ "u-me": ["u-pal"] });
    const { as } = await routes(h);
    const page = await as("u-me").people.suggested({});
    expect(page.people.map((p) => p.id)).not.toContain("u-hot");
    expect(page.friends).toEqual([]);
  });

  test("latest live call honours the cut-off: no call nobody can answer any more", () => {
    const h = scene();
    const people = (cutoffMs: number) =>
      new PeopleDirectory({
        store: h.calls,
        markets: predictionStoreReader(h.venue),
        clock: h.clock,
        callCutoffMs: cutoffMs,
      }).suggested({ limit: 10 }, null);
    expect(people(0).people.find((p) => p.id === "u-hot")!.latestLiveCall).not.toBeNull();
    // The fixtures' markets close ~16 minutes out: a 30-minute cut-off has
    // already closed them to new calls, so nothing is "live" to answer.
    expect(people(30 * 60_000).people.find((p) => p.id === "u-hot")!.latestLiveCall).toBeNull();
  });
});

describe("SupabaseFriendsReader", () => {
  const ME = "0d4e3c9b-7a21-4f55-9f10-2b6d8c1a4e77";
  const PAL = "9a1b2c3d-1111-4222-8333-444455556666";

  function reader(respond: (url: URL) => Response) {
    const seen: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      seen.push(url);
      return respond(url);
    }) as unknown as typeof fetch;
    return {
      seen,
      reader: new SupabaseFriendsReader({ supabaseUrl: "https://db.test.invalid", serviceRoleKey: "sk_test_role" }, fetchImpl),
    };
  }

  test("reads only the viewer's own accepted rows, bounded", async () => {
    const { seen, reader: r } = reader(
      () => new Response(JSON.stringify([{ friend_id: PAL }, { friend_id: PAL }, { friend_id: "not-a-uuid" }, { friend_id: ME }])),
    );
    expect(await r.friendsOf(ME)).toEqual([PAL]);
    const url = seen[0]!;
    expect(url.pathname).toBe("/rest/v1/friends");
    expect(url.searchParams.get("user_id")).toBe(`eq.${ME}`);
    expect(url.searchParams.get("status")).toBe("eq.accepted");
    expect(url.searchParams.get("select")).toBe("friend_id");
    expect(url.searchParams.get("limit")).toBe(String(MAX_FRIENDS_READ));
  });

  test("never queries for an id that is not a canonical UUID", async () => {
    const { seen, reader: r } = reader(() => new Response("[]"));
    expect(await r.friendsOf("u-me&user_id=neq.x")).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("a failed read is no friends, not an error", async () => {
    const { reader: r } = reader(() => new Response("{\"message\":\"boom\"}", { status: 500 }));
    expect(await r.friendsOf(ME)).toEqual([]);
  });
});
