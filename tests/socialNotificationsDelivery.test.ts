/**
 * The four events that make the loop return, each firing exactly once for
 * exactly the right person — and never for the person who caused it.
 *
 *   BACKED    somebody backed your call
 *   FADED     somebody faded your call
 *   RESOLVED  the venue published a result for your call
 *   REMATCH   a challenge aimed at you, or the person you faded has called again
 *
 * Every notification in this file is DERIVED from rows Packet D wrote — a call
 * from `CallsService`, a response from `CallsService`, a `CallResult` from
 * `ResolutionSync` reading hand-built venue evidence. Nothing is hand-inserted,
 * because in production nothing can be.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryNotificationsStore, type NotificationDraft } from "../src/notifications/store.ts";
import { isNotificationsError } from "../src/notifications/errors.ts";
import { harness, market, ofKind, person, T0 } from "./socialNotificationsFixtures.ts";

const A = "mkt-a";
const B = "mkt-b";

/**
 * ann calls. bob backs her. cid fades her. bob challenges her. ann then calls
 * again on a second market — which is the rematch cid is owed. Finally the
 * venue settles the first market.
 */
function scene() {
  const h = harness({
    people: [person("u-ann"), person("u-bob"), person("u-cid")],
    markets: [market(A), market(B)],
  });
  h.calls.venue.appendSnapshot({ marketId: A, yesProbability: 0.6, observedAt: T0, source: "fixture" });

  const annCall = h.call("u-ann", A, "YES", "the thesis nobody should ever be pushed");
  h.tick();
  const backed = h.respond("u-bob", annCall.call.id, "back");
  h.tick();
  const faded = h.respond("u-cid", annCall.call.id, "fade");
  h.tick();
  const challenged = h.respond("u-bob", annCall.call.id, "challenge");
  h.tick();
  const annSecond = h.call("u-ann", B, "NO");
  h.tick();
  h.settle(A, "YES");

  const report = h.derive();
  return { h, annCall, annSecond, backed, faded, challenged, report };
}

describe("the four kinds fire exactly once, for exactly the right person", () => {
  test("BACKED reaches the author of the backed call, once", () => {
    const s = scene();
    const rows = ofKind(s.h.inboxOf("u-ann"), "BACKED");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe("u-bob");
    expect(rows[0]!.subjectCallId).toBe(s.annCall.call.id);
    expect(rows[0]!.responseId).toBe(s.backed.response.id);
    // The person who did the backing is told nothing about having done it.
    expect(ofKind(s.h.inboxOf("u-bob"), "BACKED")).toHaveLength(0);
  });

  test("FADED reaches the author of the faded call, once", () => {
    const s = scene();
    const rows = ofKind(s.h.inboxOf("u-ann"), "FADED");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe("u-cid");
    expect(rows[0]!.responseId).toBe(s.faded.response.id);
    expect(ofKind(s.h.inboxOf("u-cid"), "FADED")).toHaveLength(0);
  });

  test("RESOLVED reaches every author whose call the venue actually settled, once each", () => {
    const s = scene();
    // Three calls sat on market A: ann's YES, bob's YES (from the back) and
    // cid's NO (from the fade). The venue published YES.
    for (const who of ["u-ann", "u-bob", "u-cid"]) {
      expect(ofKind(s.h.inboxOf(who), "RESOLVED")).toHaveLength(1);
    }
    const ann = ofKind(s.h.inboxOf("u-ann"), "RESOLVED")[0]!;
    expect(ann.outcome).toBe("CORRECT");
    // §0.2: the venue published it, and the venue is not a person.
    expect(ann.actorUserId).toBeNull();
    expect(ofKind(s.h.inboxOf("u-cid"), "RESOLVED")[0]!.outcome).toBe("INCORRECT");
  });

  test("REMATCH reaches the challenged person, once, and carries no wager", () => {
    const s = scene();
    const rows = ofKind(s.h.inboxOf("u-ann"), "REMATCH").filter(
      (r) => r.rematchReason === "challenge",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe("u-bob");
    expect(rows[0]!.responseId).toBe(s.challenged.response.id);
    // §3: a challenge creates no call and carries no amount. Nor does the
    // notification about it — there is no field that could.
    expect(rows[0]!.rivalCallId).toBeNull();
    expect(JSON.stringify(rows[0]!)).not.toMatch(/amount|stake|escrow|payout|wager/i);
  });

  test("REMATCH reaches the person who faded, once, when their rival calls again", () => {
    const s = scene();
    const rows = ofKind(s.h.inboxOf("u-cid"), "REMATCH").filter(
      (r) => r.rematchReason === "rival_called_again",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe("u-ann"); // the person cid faded
    expect(rows[0]!.rivalCallId).toBe(s.annSecond.call.id); // her NEW call
    // Every kind is about the recipient's OWN call — here, the call cid's fade
    // minted (§3: a fade ALWAYS creates the actor's own call).
    expect(rows[0]!.subjectCallId).toBe(s.faded.resultingCall!.call.id);
  });

  test("the pass reports exactly what it created, kind by kind", () => {
    const s = scene();
    expect(s.report.createdByKind).toEqual({
      BACKED: 1,
      FADED: 1,
      RESOLVED: 3, // ann, bob and cid all had a call on the settled market
      REMATCH: 2, // one challenge aimed at ann, one rival-called-again for cid
    });
    expect(s.report.duplicates).toBe(0);
  });

  test("somebody who only backs, and is never acted upon, gets nothing but their own result", () => {
    const s = scene();
    const bob = s.h.inboxOf("u-bob");
    expect(bob.map((n) => n.kind)).toEqual(["RESOLVED"]);
  });
});

describe("nobody is ever notified about their own action", () => {
  test("no delivered notification names its recipient as the actor", () => {
    const s = scene();
    const all = s.h.rt.store.listAll();
    expect(all.length).toBeGreaterThan(0);
    for (const n of all) {
      expect(n.actorUserId).not.toBe(n.recipientUserId);
    }
  });

  test("Packet D refuses a self-response, so the case cannot even arise upstream", () => {
    const h = harness({ people: [person("u-ann")], markets: [market(A)] });
    const own = h.call("u-ann", A, "YES");
    expect(() => h.respond("u-ann", own.call.id, "back")).toThrow(/your own call/i);
  });

  test("and the store refuses one anyway, because upstream is not a guarantee", () => {
    const store = new InMemoryNotificationsStore();
    const draft: NotificationDraft = {
      recipientUserId: "u-ann",
      kind: "BACKED",
      actorUserId: "u-ann", // the same person
      subjectCallId: "call-1",
      subjectCallAuthorId: "u-ann",
      responseId: "resp-1",
      rivalCallId: null,
      outcome: null,
      rematchReason: null,
      createdAt: T0,
    };
    const err = (() => {
      try {
        store.insertIfAbsent(draft, "n1", { actor: "service" });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(isNotificationsError(err)).toBe(true);
    expect((err as Error).message).toMatch(/own action/i);
  });

  test("a notification about someone else's call is refused outright", () => {
    const store = new InMemoryNotificationsStore();
    expect(() =>
      store.insertIfAbsent(
        {
          recipientUserId: "u-ann",
          kind: "BACKED",
          actorUserId: "u-bob",
          subjectCallId: "call-1",
          subjectCallAuthorId: "u-cid", // not the recipient
          responseId: "resp-1",
          rivalCallId: null,
          outcome: null,
          rematchReason: null,
          createdAt: T0,
        },
        "n1",
        { actor: "service" },
      ),
    ).toThrow(/recipient's OWN calls/i);
  });

  test("a client cannot write into an inbox at all", () => {
    const store = new InMemoryNotificationsStore();
    expect(() =>
      store.insertIfAbsent(
        {
          recipientUserId: "u-ann",
          kind: "RESOLVED",
          actorUserId: null,
          subjectCallId: "call-1",
          subjectCallAuthorId: "u-ann",
          responseId: null,
          rivalCallId: null,
          outcome: "CORRECT",
          rematchReason: null,
          createdAt: T0,
        },
        "n1",
        { actor: "client" },
      ),
    ).toThrow(/derived, never posted/i);
  });
});

describe("PENDING is never announced, and a withdrawn call goes quiet", () => {
  test("a call with no venue evidence produces no RESOLVED, however long it waits", () => {
    const h = harness({ people: [person("u-ann")], markets: [market(A)] });
    h.call("u-ann", A, "YES");
    // The market's status is irrelevant: only a published resolution settles a
    // call (§0.2). Nothing is published here, so nothing is announced.
    h.calls.rt.sync.runOnce();
    h.tick(10_000_000);
    h.derive();
    expect(ofKind(h.inboxOf("u-ann"), "RESOLVED")).toHaveLength(0);
  });

  test("a market that is CANCELLED but has published nothing still announces nothing", () => {
    const h = harness({
      people: [person("u-ann")],
      markets: [market(A)],
    });
    h.call("u-ann", A, "YES");
    h.calls.venue.upsertMarket({ ...market(A), status: "CANCELLED", rawStatus: "cancelled" }, null);
    h.calls.rt.sync.runOnce();
    h.derive();
    expect(h.inboxOf("u-ann")).toHaveLength(0);
  });

  test("hiding a call stops NEW notifications about it", () => {
    const h = harness({
      people: [person("u-ann"), person("u-bob")],
      markets: [market(A)],
    });
    const ann = h.call("u-ann", A, "YES");
    h.tick();
    h.respond("u-bob", ann.call.id, "back");
    // Withdrawn from distribution (§3) BEFORE the pass runs.
    h.calls.rt.service.hideCall(ann.call.id, "u-ann");
    h.derive();
    expect(h.inboxOf("u-ann")).toHaveLength(0);
  });

  test("but a notification already delivered survives the call being hidden", () => {
    const h = harness({
      people: [person("u-ann"), person("u-bob")],
      markets: [market(A)],
    });
    const ann = h.call("u-ann", A, "YES");
    h.tick();
    h.respond("u-bob", ann.call.id, "back");
    h.derive();
    expect(ofKind(h.inboxOf("u-ann"), "BACKED")).toHaveLength(1);

    h.calls.rt.service.hideCall(ann.call.id, "u-ann");
    h.derive();
    // §3: hiding hides; it rewrites nothing that already happened.
    expect(ofKind(h.inboxOf("u-ann"), "BACKED")).toHaveLength(1);
  });
});

describe("a rematch never reveals a call the recipient may not read", () => {
  test("a followers-only call by the rival is withheld from a non-follower", () => {
    const h = harness({
      people: [person("u-ann"), person("u-cid")],
      markets: [market(A), market(B)],
    });
    const ann = h.call("u-ann", A, "YES");
    h.tick();
    h.respond("u-cid", ann.call.id, "fade");
    h.tick();
    // ann's new call is for followers only, and cid does not follow her.
    h.calls.rt.service.createCall({ marketId: B, side: "NO", visibility: "followers" }, "u-ann");

    const report = h.derive();
    expect(
      ofKind(h.inboxOf("u-cid"), "REMATCH").filter((r) => r.rematchReason === "rival_called_again"),
    ).toHaveLength(0);
    expect(report.withheld).toBeGreaterThan(0);
  });

  test("and is delivered once the recipient actually follows them", () => {
    const h = harness({
      people: [person("u-ann"), person("u-cid")],
      markets: [market(A), market(B)],
    });
    const ann = h.call("u-ann", A, "YES");
    h.tick();
    h.respond("u-cid", ann.call.id, "fade");
    h.tick();
    h.calls.rt.service.createCall({ marketId: B, side: "NO", visibility: "followers" }, "u-ann");
    h.calls.calls.follow("u-cid", "u-ann");

    h.derive();
    expect(
      ofKind(h.inboxOf("u-cid"), "REMATCH").filter((r) => r.rematchReason === "rival_called_again"),
    ).toHaveLength(1);
  });

  test("a call the rival had ALREADY made is not news and is not sent", () => {
    const h = harness({
      people: [person("u-ann"), person("u-cid")],
      markets: [market(A), market(B)],
    });
    // ann calls on BOTH markets first…
    const ann = h.call("u-ann", A, "YES");
    h.call("u-ann", B, "NO");
    h.tick();
    // …and only then does cid fade one of them.
    h.respond("u-cid", ann.call.id, "fade");

    h.derive();
    expect(
      ofKind(h.inboxOf("u-cid"), "REMATCH").filter((r) => r.rematchReason === "rival_called_again"),
    ).toHaveLength(0);
  });
});
