/**
 * The original eight call procedures, end to end through createCaller — and the two
 * behaviours the client CANNOT enforce (integration-requests/packet-c.md §5):
 *
 *   1. `crowdSplit` is null until the CALLER has a locked call on that market.
 *   2. `back` and `fade` create the actor's OWN call and return it; `challenge`
 *      creates NO call and carries no amount, no escrow and no transaction.
 */

import { describe, expect, test } from "bun:test";
import { callsRouter } from "../src/api/calls.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { asWallet } from "../src/domain/ids.ts";
import { harness, market, person, testApp } from "./socialCallsFixtures.ts";

const OPEN = "mkt-open";
const CLOSED = "mkt-closed";

async function scene() {
  const h = harness({
    people: [person("u-ann"), person("u-bob"), person("u-cid")],
    markets: [
      market(OPEN),
      market(CLOSED, { status: "CLOSED_PENDING_RESOLUTION", rawStatus: "closed" }),
      market("mkt-second"),
    ],
  });
  h.venue.appendSnapshot({ marketId: OPEN, yesProbability: 0.62, observedAt: h.clock.now(), source: "fixture" });

  const app = await testApp();
  setCallsRuntime(app.config, h.rt);

  return {
    h,
    app,
    anon: callsRouter.createCaller({ app }),
    ann: callsRouter.createCaller({ app, wallet: asWallet("Wallet_u-ann") }),
    bob: callsRouter.createCaller({ app, wallet: asWallet("Wallet_u-bob") }),
    cid: callsRouter.createCaller({ app, wallet: asWallet("Wallet_u-cid") }),
  };
}

describe("the call procedures plus canonical follow actions", () => {
  test("the original eight paths remain stable; follow and the people layer are additive", () => {
    // The dotted paths are what a caller types, and they must match the §5
    // table character for character: no more procedures, no fewer, no renames.
    expect(Object.keys(callsRouter._def.procedures).sort()).toEqual([
      // People layer (src/calls/people.ts): additive paths only — none of
      // the original ten changed name or shape.
      "calls.addUpdate",
      "calls.create",
      "calls.feed",
      "calls.get",
      "calls.invitations",
      "calls.respond",
      "calls.top",
      "markets.detail",
      "markets.open",
      // Add a friend: "is this them?" before people.follow (personFinder.ts).
      "people.find",
      "people.follow",
      "people.following",
      "people.get",
      "people.leaderboard",
      "people.search",
      "people.suggested",
      "people.unfollow",
    ]);
  });

  test("markets.open lists only markets that accept new calls", async () => {
    const s = await scene();
    const open = await s.anon.markets.open({});
    expect(open.map((m) => m.id).sort()).toEqual([OPEN, "mkt-second"]);
    expect(open.every((m) => m.status === "OPEN")).toBe(true);
    // fixture data is structurally demo and says so.
    expect(open.every((m) => m.venue === "fixture")).toBe(true);
  });

  test("markets.open filters by category", async () => {
    const s = await scene();
    expect(await s.anon.markets.open({ category: "sport" })).toHaveLength(0);
    expect(await s.anon.markets.open({ category: "crypto" })).toHaveLength(2);
  });

  test("calls.create returns ONE feed entry with the frozen §3 Call shape", async () => {
    const s = await scene();
    const entry = await s.ann.calls.create({ marketId: OPEN, side: "YES", thesis: "yes it will" });
    expect(Object.keys(entry).sort()).toEqual([
      "author",
      "backCount",
      "call",
      "fadeCount",
      "market",
      "result",
      "viewerHasCalled",
    ]);
    expect(Object.keys(entry.call).sort()).toEqual([
      "confidence",
      "createdAt",
      "entryProbability",
      "fundingState",
      "id",
      "lockedAt",
      "marketId",
      "parentCallId",
      "side",
      "snapshotId",
      "thesis",
      "userId",
      "visibility",
    ]);
    // §3: 'NONE' for a free call, and the wire carries nothing money-shaped.
    expect(entry.call.fundingState).toBe("NONE");
    expect(JSON.stringify(entry.call)).not.toMatch(/amount|stake|escrow|payout|signature/i);
  });

  test("the server stamps entryProbability — a client cannot forge the price it saw", async () => {
    const s = await scene();
    const entry = await s.ann.calls.create({
      marketId: OPEN,
      side: "YES",
      snapshotId: "snap:forged-by-the-client",
    });
    expect(entry.call.entryProbability).toBe(0.62); // the server's own snapshot
    expect(entry.call.snapshotId).not.toBe("snap:forged-by-the-client");
    expect(entry.call.snapshotId).toContain(OPEN);
  });

  test("a call on a market that is not OPEN is refused with copy a person can read", async () => {
    const s = await scene();
    const err = await s.ann.calls.create({ marketId: CLOSED, side: "YES" }).catch((e) => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).toBe("This market is closed and awaiting its result, so it is not taking new calls.");
  });

  test("a second live call on the same market is a CONFLICT, not a silent edit", async () => {
    const s = await scene();
    await s.ann.calls.create({ marketId: OPEN, side: "YES" });
    const err = await s.ann.calls.create({ marketId: OPEN, side: "NO" }).catch((e) => e);
    expect(err.code).toBe("CONFLICT");
  });

  test("writes require a session; reads never do", async () => {
    const s = await scene();
    await s.ann.calls.create({ marketId: OPEN, side: "YES" });

    // reads: fine signed out
    expect((await s.anon.calls.feed({ mode: "global", limit: 5 })).entries).toHaveLength(1);
    expect(await s.anon.markets.open({})).toHaveLength(2);
    expect((await s.anon.markets.detail({ marketId: OPEN })).market.id).toBe(OPEN);
    expect((await s.anon.people.get({ personRef: "u-ann" })).calls).toHaveLength(1);

    // writes: UNAUTHORIZED signed out
    for (const fn of [
      () => s.anon.calls.create({ marketId: OPEN, side: "YES" }),
      () => s.anon.calls.respond({ targetCallId: "call-001", kind: "back" }),
      () => s.anon.calls.invitations({}),
    ]) {
      const err = await fn().catch((e) => e);
      expect(err.code).toBe("UNAUTHORIZED");
    }
  });

  test("people.get resolves a canonical id or a handle, and never a wallet", async () => {
    const s = await scene();
    await s.ann.calls.create({ marketId: OPEN, side: "YES" });
    expect((await s.anon.people.get({ personRef: "u-ann" })).person.id).toBe("u-ann");
    expect((await s.anon.people.get({ personRef: "@u-ann" })).person.id).toBe("u-ann");
    const err = await s.anon.people.get({ personRef: "Wallet_u-ann" }).catch((e) => e);
    expect(err.code).toBe("NOT_FOUND");
  });

  test("calls.feed pages with a cursor and never repeats a row", async () => {
    const s = await scene();
    const h = s.h;
    // three authors, three markets, so the one-live-call rule is respected
    h.venue.upsertMarket(market("mkt-3"), null);
    await s.ann.calls.create({ marketId: OPEN, side: "YES" });
    h.clock.advance(10);
    await s.bob.calls.create({ marketId: "mkt-second", side: "NO" });
    h.clock.advance(10);
    await s.cid.calls.create({ marketId: "mkt-3", side: "YES" });

    const first = await s.anon.calls.feed({ mode: "global", limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await s.anon.calls.feed({ mode: "global", limit: 2, cursor: first.nextCursor });
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.entries, ...second.entries].map((e) => e.call.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("crowdSplit is withheld until the CALLER has locked a call", () => {
  test("a signed-out caller is sent null, not a zeroed split", async () => {
    const s = await scene();
    await s.ann.calls.create({ marketId: OPEN, side: "YES" });
    const detail = await s.anon.markets.detail({ marketId: OPEN });
    expect(detail.crowdSplit).toBeNull();
    expect(detail.viewerCall).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("yesCalls");
  });

  test("a signed-in caller who has NOT called is sent null", async () => {
    const s = await scene();
    await s.ann.calls.create({ marketId: OPEN, side: "YES" });
    const detail = await s.bob.markets.detail({ marketId: OPEN });
    expect(detail.crowdSplit).toBeNull();
    expect(detail.viewerCall).toBeNull();
  });

  test("it appears the moment that caller locks their own call, and only for them", async () => {
    const s = await scene();
    await s.ann.calls.create({ marketId: OPEN, side: "YES" });
    await s.bob.calls.create({ marketId: OPEN, side: "NO" });

    const forBob = await s.bob.markets.detail({ marketId: OPEN });
    expect(forBob.crowdSplit).toEqual({ marketId: OPEN, yesCalls: 1, noCalls: 1 });
    expect(forBob.viewerCall?.call.userId).toBe("u-bob");

    // Cid still has nothing, on the very same market, at the very same instant.
    expect((await s.cid.markets.detail({ marketId: OPEN })).crowdSplit).toBeNull();
  });

  test("naming someone else does not unlock it — there is no field to name them in", async () => {
    const s = await scene();
    await s.ann.calls.create({ marketId: OPEN, side: "YES" });
    const err = await s.cid.markets
      .detail({ marketId: OPEN, viewerUserId: "u-ann" } as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/[Uu]nrecognized/);
  });

  test("hiding the caller's own call takes the split away again", async () => {
    const s = await scene();
    const mine = await s.bob.calls.create({ marketId: OPEN, side: "NO" });
    expect((await s.bob.markets.detail({ marketId: OPEN })).crowdSplit).not.toBeNull();
    s.h.rt.service.hideCall(mine.call.id, "u-bob");
    expect((await s.bob.markets.detail({ marketId: OPEN })).crowdSplit).toBeNull();
  });
});

describe("back and fade mint the actor's own call; challenge does not", () => {
  async function withTarget() {
    const s = await scene();
    const target = await s.ann.calls.create({ marketId: OPEN, side: "YES", thesis: "ann says yes" });
    return { ...s, targetId: target.call.id };
  }

  test("back creates the actor's OWN call on the SAME side and returns it", async () => {
    const s = await withTarget();
    const res = await s.bob.calls.respond({ targetCallId: s.targetId, kind: "back" });

    expect(res.resultingCall).not.toBeNull();
    expect(res.invitation).toBeNull();
    expect(res.resultingCall!.call.userId).toBe("u-bob"); // the ACTOR's own
    expect(res.resultingCall!.call.side).toBe("YES"); // same side
    expect(res.resultingCall!.call.parentCallId).toBe(s.targetId);
    expect(res.response.kind).toBe("back");
    expect(res.response.resultingCallId).toBe(res.resultingCall!.call.id);
    // It is a real, first-class call: it shows up in the feed on its own.
    const feed = await s.anon.calls.feed({ mode: "global", limit: 10 });
    expect(feed.entries.map((e) => e.call.id)).toContain(res.resultingCall!.call.id);
  });

  test("fade creates the actor's OWN call on the OPPOSITE side and returns it", async () => {
    const s = await withTarget();
    const res = await s.bob.calls.respond({ targetCallId: s.targetId, kind: "fade" });
    expect(res.resultingCall!.call.userId).toBe("u-bob");
    expect(res.resultingCall!.call.side).toBe("NO"); // the other side
    expect(res.invitation).toBeNull();
  });

  test("back and fade bump the counters on the call they responded to", async () => {
    const s = await withTarget();
    await s.bob.calls.respond({ targetCallId: s.targetId, kind: "back" });
    await s.cid.calls.respond({ targetCallId: s.targetId, kind: "fade" });
    const detail = await s.anon.calls.get({ callId: s.targetId });
    expect(detail.entry.backCount).toBe(1);
    expect(detail.entry.fadeCount).toBe(1);
    expect(detail.responses).toHaveLength(2);
  });

  test("challenge creates NO call at all", async () => {
    const s = await withTarget();
    const before = s.h.calls.listCalls().length;
    const res = await s.bob.calls.respond({ targetCallId: s.targetId, kind: "challenge", note: "prove it" });

    expect(res.resultingCall).toBeNull();
    expect(res.response.resultingCallId).toBeNull();
    expect(s.h.calls.listCalls()).toHaveLength(before); // nothing was minted
    expect(res.invitation).not.toBeNull();
    expect(res.invitation!.fromUserId).toBe("u-bob");
    expect(res.invitation!.toUserId).toBe("u-ann");
    expect(res.invitation!.sourceCallId).toBe(s.targetId);
  });

  test("a challenge carries no money field AT ALL — checked, not merely typed", async () => {
    const s = await withTarget();
    const res = await s.bob.calls.respond({ targetCallId: s.targetId, kind: "challenge", note: "prove it" });
    const invitation = res.invitation!;

    expect(Object.keys(invitation).sort()).toEqual([
      "createdAt",
      "fromUserId",
      "id",
      "marketId",
      "note",
      "responseId",
      "sourceCallId",
      "toUserId",
    ]);
    for (const key of Object.keys(invitation)) {
      expect(key).not.toMatch(/amount|stake|escrow|wager|payout|price|fee|currency|token|tx|signature|balance|collateral|deposit/i);
    }
    // And nothing money-shaped anywhere in the whole response payload.
    expect(JSON.stringify(res)).not.toMatch(/amount|stake|escrow|wager|payout|lamport|baseUnits|signature/i);
  });

  test("calls.invitations returns the challenges pointed at MY calls, and no escrow", async () => {
    const s = await withTarget();
    await s.bob.calls.respond({ targetCallId: s.targetId, kind: "challenge", note: "prove it" });
    await s.cid.calls.respond({ targetCallId: s.targetId, kind: "challenge" });

    const mine = await s.ann.calls.invitations({});
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((i) => i.fromUserId))).toEqual(new Set(["u-bob", "u-cid"]));
    expect(mine.every((i) => i.toUserId === "u-ann")).toBe(true);
    expect(JSON.stringify(mine)).not.toMatch(/amount|stake|escrow|payout/i);

    // Bob sent one; none are addressed to him.
    expect(await s.bob.calls.invitations({})).toHaveLength(0);
  });

  test("you cannot respond to your own call", async () => {
    const s = await withTarget();
    const err = await s.ann.calls.respond({ targetCallId: s.targetId, kind: "back" }).catch((e) => e);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toBe("You can't respond to your own call.");
  });

  test("the same response twice is a CONFLICT, not a duplicate call", async () => {
    const s = await withTarget();
    await s.bob.calls.respond({ targetCallId: s.targetId, kind: "back" });
    const err = await s.bob.calls.respond({ targetCallId: s.targetId, kind: "back" }).catch((e) => e);
    expect(err.code).toBe("CONFLICT");
  });

  test("you cannot back a call you are not allowed to see", async () => {
    const s = await scene();
    const quiet = await s.ann.calls.create({ marketId: OPEN, side: "YES", visibility: "followers" });
    const err = await s.bob.calls.respond({ targetCallId: quiet.call.id, kind: "back" }).catch((e) => e);
    expect(err.code).toBe("NOT_FOUND");
  });

  test("a challenge is still allowed on a market that has closed — backing is not", async () => {
    const s = await scene();
    const target = await s.ann.calls.create({ marketId: OPEN, side: "YES" });
    // the market closes after the call was locked
    s.h.venue.upsertMarket(market(OPEN, { status: "CLOSED_PENDING_RESOLUTION", rawStatus: "closed" }), null);

    const backErr = await s.bob.calls.respond({ targetCallId: target.call.id, kind: "back" }).catch((e) => e);
    expect(backErr.code).toBe("PRECONDITION_FAILED");

    const challenge = await s.bob.calls.respond({ targetCallId: target.call.id, kind: "challenge" });
    expect(challenge.invitation).not.toBeNull();
    expect(challenge.resultingCall).toBeNull();
  });
});
