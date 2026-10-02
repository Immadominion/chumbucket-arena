/**
 * The people layer — leaderboard, search, top calls, the public record on a
 * profile, and the thesis thread — end to end through the service and the
 * tRPC procedures.
 *
 * What these tests hold the code to, in the order src/calls/people.ts states it:
 *
 *   1. one record everywhere: public free calls, hidden INCLUDED, followers-only
 *      EXCLUDED, funded never blended;
 *   2. no percentage and no rank below MIN_DECIDED_FOR_ACCURACY decided calls;
 *   3. ranking by the evidence-weighted (Wilson) bound, not the raw ratio;
 *   4. no crowd direction on a top call until the viewer has their own call;
 *   5. no money anywhere.
 *
 * And for the thread: author-only, append-only, after the lock, never editing
 * the original thesis, exactly as visible as the call.
 */

import { describe, expect, test } from "bun:test";
import { callsRouter } from "../src/api/calls.ts";
import { LEADERBOARD_RULE, wilsonLowerBound } from "../src/calls/people.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { MAX_THESIS_UPDATES_PER_CALL, assertMoneyFree } from "../src/calls/types.ts";
import { MIN_DECIDED_FOR_ACCURACY } from "../src/notifications/record.ts";
import type { Resolution, Side } from "../src/prediction/types.ts";
import { asWallet } from "../src/domain/ids.ts";
import { harness, market, person, testApp, type Harness } from "./socialCallsFixtures.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Lock `n` calls for `userId` on fresh markets and settle them: `correct` of
 *  them the way the caller called, the rest the other way. */
function settledRun(h: Harness, userId: string, n: number, correct: number, opts: { resolvedAt?: number } = {}) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${userId}-m${i}`;
    h.venue.upsertMarket(market(id), null);
    h.venue.appendSnapshot({ marketId: id, yesProbability: 0.5, observedAt: h.clock.now(), source: "venue" });
    const entry = h.rt.service.createCall({ marketId: id, side: "YES" }, userId);
    ids.push(entry.call.id);
    h.resolve(id, (i < correct ? "YES" : "NO") as Resolution, opts.resolvedAt);
  }
  h.rt.sync.runOnce();
  return ids;
}

async function routes(h: Harness) {
  const app = await testApp();
  setCallsRuntime(app.config, h.rt);
  const as = (id: string) => callsRouter.createCaller({ app, wallet: asWallet(`Wallet_${id}`) });
  return { anon: callsRouter.createCaller({ app }), as };
}

// ── 1. the public record ─────────────────────────────────────────────────────

describe("the public record has one scope everywhere", () => {
  test("hidden calls still count, followers-only calls never do, pending decides nothing", () => {
    const h = harness({
      people: [person("u-ann")],
      markets: [market("m-pub"), market("m-hid"), market("m-fol"), market("m-pend")],
    });
    const svc = h.rt.service;
    svc.createCall({ marketId: "m-pub", side: "YES" }, "u-ann");
    const hidden = svc.createCall({ marketId: "m-hid", side: "YES" }, "u-ann");
    svc.createCall({ marketId: "m-fol", side: "YES", visibility: "followers" }, "u-ann");
    svc.createCall({ marketId: "m-pend", side: "YES" }, "u-ann");
    h.resolve("m-pub", "YES");
    h.resolve("m-hid", "NO"); // a miss…
    h.resolve("m-fol", "YES"); // …and a followers-only win
    h.rt.sync.runOnce();
    svc.hideCall(hidden.call.id, "u-ann"); // …withdrawn after the fact

    const record = svc.getPerson({ personRef: "u-ann" }, null).record;
    // The withdrawn miss is still a miss. The followers-only win is not public.
    expect(record.counts).toMatchObject({ correct: 1, incorrect: 1, voided: 0, decided: 2, pending: 1 });
    // Two decided is below the sample: no accuracy field at all, not a null.
    expect(record.display.mode).toBe("counts");
    expect("accuracy" in record.display).toBe(false);
  });

  test("a percentage appears only at the minimum decided sample", () => {
    const h = harness({ people: [person("u-ann")] });
    settledRun(h, "u-ann", MIN_DECIDED_FOR_ACCURACY - 1, 9);
    expect(h.rt.service.getPerson({ personRef: "u-ann" }, null).record.display.mode).toBe("counts");

    const h2 = harness({ people: [person("u-ann")] });
    settledRun(h2, "u-ann", MIN_DECIDED_FOR_ACCURACY, 7);
    const display = h2.rt.service.getPerson({ personRef: "u-ann" }, null).record.display;
    expect(display).toMatchObject({ mode: "accuracy", accuracy: 0.7, incorrect: 3 });
  });

  test("people.get carries follower and following counts, never the lists", async () => {
    const h = harness({ people: [person("u-ann"), person("u-bob"), person("u-cid")] });
    h.rt.service.setFollowing({ personRef: "u-ann", following: true }, "u-bob");
    h.rt.service.setFollowing({ personRef: "u-ann", following: true }, "u-cid");
    h.rt.service.setFollowing({ personRef: "u-bob", following: true }, "u-ann");
    const { anon } = await routes(h);
    const detail = await anon.people.get({ personRef: "u-ann" });
    expect(detail.followerCount).toBe(2);
    expect(detail.followingCount).toBe(1);
    expect(JSON.stringify(detail)).not.toContain("u-cid");
  });
});

// ── 2/3. the leaderboard ─────────────────────────────────────────────────────

describe("people.leaderboard", () => {
  function board() {
    const h = harness({
      people: [person("u-ace"), person("u-lucky"), person("u-new"), person("u-quiet"), person("u-me")],
    });
    settledRun(h, "u-ace", 50, 47); // 94% over a long record
    settledRun(h, "u-lucky", 10, 10); // 100% over the minimum
    settledRun(h, "u-new", 4, 4); // perfect, but only four decided
    return h;
  }

  test("ranks only the minimum sample, by the evidence-weighted bound", async () => {
    const h = board();
    const { anon } = await routes(h);
    const lb = await anon.people.leaderboard({ window: "all" });

    expect(lb.minimumDecided).toBe(MIN_DECIDED_FOR_ACCURACY);
    expect(lb.rule).toBe(LEADERBOARD_RULE);
    // 47/50 outranks 10/10: a short streak is not a better record.
    expect(lb.ranked.map((r) => [r.rank, r.person.id])).toEqual([
      [1, "u-ace"],
      [2, "u-lucky"],
    ]);
    expect(wilsonLowerBound(47, 50)).toBeGreaterThan(wilsonLowerBound(10, 10));
    // Both inputs of the ordering are on the row.
    expect(lb.ranked[1]!.record.display).toMatchObject({ mode: "accuracy", accuracy: 1, decided: 10 });

    // Below the sample: listed, never numbered, never given a percentage.
    expect(lb.building.map((r) => r.person.id)).toEqual(["u-new"]);
    expect(lb.building[0]!.rank).toBeNull();
    expect(lb.building[0]!.record.display.mode).toBe("counts");
    // Nobody with nothing decided is listed.
    expect([...lb.ranked, ...lb.building].some((r) => r.person.id === "u-quiet")).toBe(false);
    // Signed out: no pinned row.
    expect(lb.viewer).toBeNull();
  });

  test("the pinned row is the session's, wherever it stands", async () => {
    const h = board();
    const { as } = await routes(h);
    const mine = await as("u-me").people.leaderboard({ window: "all" });
    expect(mine.viewer).toMatchObject({ rank: null, decidedToRank: MIN_DECIDED_FOR_ACCURACY });
    expect(mine.viewer!.person.id).toBe("u-me");
    expect(mine.viewer!.record.counts.decided).toBe(0);

    const lucky = await as("u-lucky").people.leaderboard({ window: "all", limit: 1 });
    // Ranked beyond the requested page, and still told their rank.
    expect(lucky.ranked).toHaveLength(1);
    expect(lucky.viewer).toMatchObject({ rank: 2, decidedToRank: 0 });

    const newcomer = await as("u-new").people.leaderboard({ window: "all" });
    expect(newcomer.viewer).toMatchObject({ rank: null, decidedToRank: MIN_DECIDED_FOR_ACCURACY - 4 });
  });

  test("a window counts results the venue published inside it, and nothing pending", async () => {
    const h = harness({ people: [person("u-old"), person("u-fresh")] });
    settledRun(h, "u-old", 12, 12, { resolvedAt: h.clock.now() - 20 * DAY });
    settledRun(h, "u-fresh", 11, 9);
    const { anon } = await routes(h);

    const week = await anon.people.leaderboard({ window: "7d" });
    expect(week.ranked.map((r) => r.person.id)).toEqual(["u-fresh"]);
    const month = await anon.people.leaderboard({ window: "30d" });
    expect(month.ranked.map((r) => r.person.id).sort()).toEqual(["u-fresh", "u-old"]);
    expect(week.ranked[0]!.record.counts.pending).toBe(0);
  });

  test("an empty network is an empty board, not an invented one", async () => {
    const h = harness({ people: [person("u-ann")] });
    const { anon } = await routes(h);
    const lb = await anon.people.leaderboard({});
    expect(lb.window).toBe("30d");
    expect(lb.ranked).toEqual([]);
    expect(lb.building).toEqual([]);
  });

  test("it carries no money and takes no identity as input", async () => {
    const h = board();
    const { anon } = await routes(h);
    const lb = await anon.people.leaderboard({ window: "all" });
    expect(() => assertMoneyFree(lb, "a leaderboard")).not.toThrow();
    expect(JSON.stringify(lb)).not.toContain("Wallet_");
    // .strict(): naming a viewer is a loud refusal, not a stripped key.
    const err = await anon.people
      .leaderboard({ window: "all", viewerUserId: "u-ace" } as never)
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("BAD_REQUEST");
  });
});

// ── search ───────────────────────────────────────────────────────────────────

describe("people.search", () => {
  test("matches handles and names, ignores @, never matches a wallet", async () => {
    const h = harness({
      people: [
        person("u-1", { handle: "satoshi", displayName: "Nakamoto Fan" }),
        person("u-2", { handle: "hal", displayName: "Hal Finney" }),
        person("u-3", { handle: "finn", displayName: "Finn the Human" }),
      ],
    });
    h.rt.service.setFollowing({ personRef: "u-3", following: true }, "u-2");
    const { anon, as } = await routes(h);

    expect((await anon.people.search({ query: "@sato" })).people.map((p) => p.id)).toEqual(["u-1"]);
    // Handle prefix first, then a name word.
    expect((await anon.people.search({ query: "fin" })).people.map((p) => p.id)).toEqual(["u-3", "u-2"]);
    expect((await anon.people.search({ query: "Wallet_u-1" })).people).toEqual([]);

    const mine = await as("u-2").people.search({ query: "finn" });
    expect(mine.people[0]).toMatchObject({ id: "u-3", viewerIsFollowing: true });
    expect(Object.keys(mine.people[0]!)).not.toContain("walletAddress");
  });

  test("an empty query is refused rather than returning the directory", async () => {
    const h = harness({ people: [person("u-1")] });
    const { anon } = await routes(h);
    const err = await anon.people.search({ query: "   " }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("BAD_REQUEST");
  });
});

describe("people.following", () => {
  test("is the session's own list and needs a session", async () => {
    const h = harness({ people: [person("u-ann"), person("u-bob"), person("u-cid")] });
    h.rt.service.setFollowing({ personRef: "u-bob", following: true }, "u-ann");
    const { anon, as } = await routes(h);
    expect((await as("u-ann").people.following({})).people.map((p) => p.id)).toEqual(["u-bob"]);
    expect((await as("u-cid").people.following({})).people).toEqual([]);
    const err = await anon.people.following({}).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("UNAUTHORIZED");
  });
});

// ── 4. top calls ─────────────────────────────────────────────────────────────

describe("calls.top", () => {
  function scene() {
    const h = harness({
      people: [person("u-ann"), person("u-bob"), person("u-cid"), person("u-dee")],
      markets: [market("m-hot"), market("m-warm"), market("m-closed"), market("m-priv")],
    });
    const svc = h.rt.service;
    const hot = svc.createCall({ marketId: "m-hot", side: "YES" }, "u-ann");
    const warm = svc.createCall({ marketId: "m-warm", side: "NO" }, "u-bob");
    svc.createCall({ marketId: "m-closed", side: "YES" }, "u-ann");
    svc.createCall({ marketId: "m-priv", side: "YES", visibility: "followers" }, "u-dee");
    svc.respond({ targetCallId: hot.call.id, kind: "back" }, "u-bob");
    svc.respond({ targetCallId: hot.call.id, kind: "fade" }, "u-cid");
    svc.respond({ targetCallId: hot.call.id, kind: "challenge" }, "u-dee");
    svc.respond({ targetCallId: warm.call.id, kind: "challenge" }, "u-cid");
    // A market that stops taking calls leaves the strip.
    h.venue.upsertMarket(market("m-closed", { status: "CLOSED_PENDING_RESOLUTION", rawStatus: "closed" }), null);
    return { h, hot, warm };
  }

  test("open public calls, one per market, by response volume", async () => {
    const { h, hot } = scene();
    const { anon } = await routes(h);
    const page = await anon.calls.top({});
    expect(page.entries.map((e) => e.market.id)).toEqual(["m-hot", "m-warm"]);
    // Volume counts all three kinds, and says nothing about direction.
    expect(page.entries[0]!.responses).toBe(3);
    expect(page.entries[0]!.call.id).toBe(hot.call.id);
    // Signed out: no split, ever.
    expect(page.entries.every((e) => e.split === null && e.viewerHasCalled === false)).toBe(true);
    // The followers-only call is not discovery material.
    expect(page.entries.some((e) => e.market.id === "m-priv")).toBe(false);
  });

  test("the split appears only once the viewer has a call on that market", async () => {
    const { h, hot } = scene();
    const { as } = await routes(h);

    const before = await as("u-dee").calls.top({});
    // u-dee only CHALLENGED: a challenge is not a call, so the gate stays shut.
    expect(before.entries.find((e) => e.call.id === hot.call.id)!.split).toBeNull();

    const bob = await as("u-bob").calls.top({});
    // u-bob backed, which minted their own call on m-hot: the gate opens there…
    expect(bob.entries.find((e) => e.call.id === hot.call.id)).toMatchObject({
      viewerHasCalled: true,
      split: { backs: 1, fades: 1 },
    });
    // …and their OWN call never appears on their strip.
    expect(bob.entries.some((e) => e.call.userId === "u-bob")).toBe(false);
  });

  test("an empty network is an empty strip", async () => {
    const h = harness({ people: [person("u-ann")], markets: [market("m")] });
    const { anon } = await routes(h);
    expect((await anon.calls.top({})).entries).toEqual([]);
  });
});

// ── the thesis thread ────────────────────────────────────────────────────────

describe("calls.addUpdate — the thesis as an append-only thread", () => {
  function scene(side: Side = "YES") {
    const h = harness({ people: [person("u-ann"), person("u-bob")], markets: [market("m")] });
    const made = h.rt.service.createCall({ marketId: "m", side, thesis: "the original reason" }, "u-ann");
    return { h, callId: made.call.id };
  }

  test("the author appends; the original thesis is untouched; readers see the thread in order", async () => {
    const { h, callId } = scene();
    const { anon, as } = await routes(h);
    const first = await as("u-ann").calls.addUpdate({ callId, body: "  flows still accelerating  " });
    h.clock.advance(60_000);
    await as("u-ann").calls.addUpdate({ callId, body: "funding flipped" });

    expect(first.body).toBe("flows still accelerating");
    const detail = await anon.calls.get({ callId });
    expect(detail.entry.call.thesis).toBe("the original reason");
    expect(detail.updates.map((u) => u.body)).toEqual(["flows still accelerating", "funding flipped"]);
    expect(detail.updates.every((u) => u.createdAt >= detail.entry.call.lockedAt)).toBe(true);
    expect(detail.updatesAvailable).toBe(true);
  });

  test("nobody else may write one", async () => {
    const { h, callId } = scene();
    const { anon, as } = await routes(h);
    const other = await as("u-bob").calls.addUpdate({ callId, body: "not mine" }).catch((e: unknown) => e);
    expect((other as { code?: string }).code).toBe("FORBIDDEN");
    const signedOut = await anon.calls.addUpdate({ callId, body: "who am i" }).catch((e: unknown) => e);
    expect((signedOut as { code?: string }).code).toBe("UNAUTHORIZED");
    expect(h.calls.thesisUpdatesFor(callId)).toEqual([]);
  });

  test("a followers-only call's thread is as private as the call", async () => {
    const h = harness({ people: [person("u-ann"), person("u-bob")], markets: [market("m")] });
    const made = h.rt.service.createCall({ marketId: "m", side: "YES", visibility: "followers" }, "u-ann");
    const { as } = await routes(h);
    await as("u-ann").calls.addUpdate({ callId: made.call.id, body: "for my followers" });
    const stranger = await as("u-bob").calls.get({ callId: made.call.id }).catch((e: unknown) => e);
    expect((stranger as { code?: string }).code).toBe("NOT_FOUND");
    h.rt.service.setFollowing({ personRef: "u-ann", following: true }, "u-bob");
    expect((await as("u-bob").calls.get({ callId: made.call.id })).updates).toHaveLength(1);
  });

  test("bounded: empty, over-long, withdrawn and over-cap updates are refused", async () => {
    const { h, callId } = scene();
    const { as } = await routes(h);
    const ann = as("u-ann");
    const empty = await ann.calls.addUpdate({ callId, body: "   " }).catch((e: unknown) => e);
    expect((empty as { code?: string }).code).toBe("BAD_REQUEST");
    const long = await ann.calls.addUpdate({ callId, body: "x".repeat(281) }).catch((e: unknown) => e);
    expect((long as { code?: string }).code).toBe("BAD_REQUEST");

    for (let i = 0; i < MAX_THESIS_UPDATES_PER_CALL; i++) await ann.calls.addUpdate({ callId, body: `update ${i}` });
    const capped = await ann.calls.addUpdate({ callId, body: "one more" }).catch((e: unknown) => e);
    expect((capped as { code?: string }).code).toBe("CONFLICT");

    const { h: h2, callId: c2 } = scene();
    const r2 = await routes(h2);
    await r2.as("u-ann").calls.addUpdate({ callId: c2, body: "before withdrawing" });
    h2.clock.advance(1);
    h2.rt.service.hideCall(c2, "u-ann");
    h2.clock.advance(1);
    const withdrawn = await r2.as("u-ann").calls.addUpdate({ callId: c2, body: "after" }).catch((e: unknown) => e);
    expect((withdrawn as { message?: string }).message).toMatch(/withdrawn/);
    // The update written before the withdrawal is still the author's history,
    // and the author is not offered an "Add update" that would only fail.
    const own = await r2.as("u-ann").calls.get({ callId: c2 });
    expect(own.updates.map((u) => u.body)).toEqual(["before withdrawing"]);
    expect(own.updatesAvailable).toBe(false);
  });

  test("the store has no way to edit or delete an update", () => {
    const { h } = scene();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(h.calls));
    expect(methods.filter((m) => /thesis/i.test(m)).sort()).toEqual([
      "insertThesisUpdate",
      "thesisUpdatesAvailable",
      "thesisUpdatesFor",
    ]);
  });
});
