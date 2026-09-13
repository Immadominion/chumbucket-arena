/**
 * Receipts — the generalisation of the arena's `CallMade` / `CallSettled` event
 * shapes and of `SettledCallsProjection` into venue-backed FREE-call receipts.
 *
 * What is proved here:
 *   - a receipt carries when / which side / at what probability / what the
 *     venue published / which market, and NO MONEY — even when it was
 *     generalised from an arena event that DID carry a stake and a payout;
 *   - `WON | LOST` generalises to the §3 `CallOutcome`, which has a fourth
 *     value the arena pair could not express: VOID;
 *   - the read side tails `EventStore.subscribe()` independently. It is never
 *     registered in `ReadModel` (§6: that array is friction, not a seam) and
 *     the existing projections keep working untouched;
 *   - a receipt is only shareable once the VENUE has settled it.
 */

import { describe, expect, test } from "bun:test";
import { CallReceiptsProjection } from "../src/calls/receipts.ts";
import { asBucket, asCallId, asMarketId, asMatchId, asWallet, playerStream, wal } from "../src/domain/ids.ts";
import { InMemoryEventStore } from "../src/core/eventstore/InMemoryEventStore.ts";
import { harness, market, person } from "./socialCallsFixtures.ts";

const WALLET = "WalletOfAnn";

describe("venue-backed free-call receipts", () => {
  test("a locked call produces a PENDING, un-shareable receipt with full venue provenance", () => {
    const h = harness({ people: [person("u-ann")], markets: [market("m")] });
    h.venue.appendSnapshot({ marketId: "m", yesProbability: 0.37, observedAt: h.clock.now(), source: "fixture" });
    const entry = h.rt.service.createCall({ marketId: "m", side: "YES", thesis: "it will" }, "u-ann");

    const receipt = h.rt.receipts.receiptForCall(entry.call.id)!;
    expect(receipt.origin).toBe("venue");
    expect(receipt.userId).toBe("u-ann");
    expect(receipt.side).toBe("YES");
    expect(receipt.entryProbability).toBe(0.37);
    expect(receipt.lockedAt).toBe(h.clock.now());
    expect(receipt.outcome).toBe("PENDING");
    expect(receipt.shareable).toBe(false);
    expect(receipt.market.venue).toBe("fixture");
    expect(receipt.market.demo).toBe(true); // a demo receipt can never read as live
    expect(receipt.market.question).toContain("[DEMO]");
    expect(receipt.market.resolutionSource).toBe("fixture:oracle");
  });

  test("the venue settling it makes the receipt shareable and cites the evidence", () => {
    const h = harness({ people: [person("u-ann")], markets: [market("m")] });
    const entry = h.rt.service.createCall({ marketId: "m", side: "NO" }, "u-ann");
    const evidenceId = h.resolve("m", "NO");
    h.rt.sync.runOnce();

    const receipt = h.rt.receipts.receiptForCall(entry.call.id)!;
    expect(receipt.outcome).toBe("CORRECT");
    expect(receipt.resolution).toBe("NO");
    expect(receipt.marketResolutionId).toBe(evidenceId);
    expect(receipt.shareable).toBe(true);
  });

  test("a VOID receipt is settled, shareable, and neither a win nor a loss", () => {
    const h = harness({ people: [person("u-ann")], markets: [market("m")] });
    const entry = h.rt.service.createCall({ marketId: "m", side: "YES" }, "u-ann");
    h.resolve("m", "VOID");
    h.rt.sync.runOnce();

    const receipt = h.rt.receipts.receiptForCall(entry.call.id)!;
    expect(receipt.outcome).toBe("VOID");
    expect(receipt.shareable).toBe(true);
    const p = h.rt.service.getPerson({ personRef: "u-ann" }, null).person;
    expect(p.settledCalls).toBe(0);
    expect(p.correctCalls).toBe(0);
  });

  test("no receipt carries a money field — the guard runs on every one", () => {
    const h = harness({ people: [person("u-ann")], markets: [market("m")] });
    const entry = h.rt.service.createCall({ marketId: "m", side: "YES" }, "u-ann");
    h.resolve("m", "YES");
    h.rt.sync.runOnce();

    const receipt = h.rt.receipts.receiptForCall(entry.call.id)!;
    expect(JSON.stringify(receipt)).not.toMatch(
      /amount|stake|escrow|wager|payout|lamport|baseUnits|signature|collateral/i,
    );
    expect(Object.keys(receipt)).not.toContain("stake");
    expect(Object.keys(receipt)).not.toContain("payout");
  });

  test("receiptsFor lists a person's receipts newest first", () => {
    const h = harness({ people: [person("u-ann")], markets: [market("m1"), market("m2")] });
    const first = h.rt.service.createCall({ marketId: "m1", side: "YES" }, "u-ann");
    h.clock.advance(1000);
    const second = h.rt.service.createCall({ marketId: "m2", side: "NO" }, "u-ann");
    expect(h.rt.receipts.receiptsFor("u-ann").map((r) => r.callId)).toEqual([second.call.id, first.call.id]);
  });
});

describe("the arena's own call events generalise into the same receipt shape", () => {
  async function arenaScene() {
    const h = harness({ people: [person("u-ann", { walletAddress: WALLET })] });
    const store = new InMemoryEventStore();
    const detach = h.rt.attachReceipts(store);
    return { h, store, detach };
  }

  const callId = asCallId("arena-call-1");
  const matchId = asMatchId("match-9");
  const marketId = asMarketId("RESULT");

  test("attach() tails EventStore.subscribe() and hands back its unsubscribe thunk", async () => {
    const { h, store, detach } = await arenaScene();
    expect(typeof detach).toBe("function");

    await store.append(playerStream(asWallet(WALLET)), [
      {
        type: "CallMade",
        callId,
        matchId,
        marketId,
        bucket: asBucket("YES"),
        stake: wal(5),
        impliedProbAtCall: 0.4,
        bold: false,
        note: "arena-era take",
      },
    ]);

    const receipt = h.rt.receipts.receiptForCall(callId)!;
    expect(receipt.origin).toBe("arena"); // never presents as venue evidence
    expect(receipt.userId).toBe("u-ann");
    expect(receipt.side).toBe("YES");
    expect(receipt.entryProbability).toBe(0.4);
    expect(receipt.outcome).toBe("PENDING");

    // The STAKE on the source event is dropped. That is the generalisation.
    expect(JSON.stringify(receipt)).not.toMatch(/stake|payout|pnl/i);

    detach();
    await store.append(playerStream(asWallet(WALLET)), [
      { type: "CallMade", callId: asCallId("after-detach"), matchId, marketId, bucket: asBucket("NO"), stake: wal(1), impliedProbAtCall: 0.5, bold: false },
    ]);
    expect(h.rt.receipts.receiptForCall(asCallId("after-detach"))).toBeUndefined();
  });

  test("WON/LOST generalise to CORRECT/INCORRECT, and CallVoided to VOID", async () => {
    for (const [result, outcome] of [
      ["WON", "CORRECT"],
      ["LOST", "INCORRECT"],
    ] as const) {
      const { h, store } = await arenaScene();
      await store.append(playerStream(asWallet(WALLET)), [
        { type: "CallMade", callId, matchId, marketId, bucket: asBucket("YES"), stake: wal(5), impliedProbAtCall: 0.4, bold: false },
        {
          type: "CallSettled",
          callId,
          matchId,
          marketId,
          result,
          stake: wal(5),
          payout: result === "WON" ? wal(9) : 0n,
          pnlDelta: result === "WON" ? wal(4) : -wal(5),
          grDelta: 3,
          difficulty: 0.6,
        },
      ]);
      const receipt = h.rt.receipts.receiptForCall(callId)!;
      expect(receipt.outcome).toBe(outcome);
      expect(receipt.shareable).toBe(true);
      // The money legs on CallSettled are dropped, every one of them.
      expect(JSON.stringify(receipt)).not.toMatch(/stake|payout|pnlDelta|grDelta/i);
    }

    const { h, store } = await arenaScene();
    await store.append(playerStream(asWallet(WALLET)), [
      { type: "CallMade", callId, matchId, marketId, bucket: asBucket("NO"), stake: wal(5), impliedProbAtCall: 0.4, bold: false },
      { type: "CallVoided", callId, matchId, marketId, refund: wal(5), reason: "match abandoned" },
    ]);
    // VOID is the value the arena WON|LOST pair could not express at all.
    expect(h.rt.receipts.receiptForCall(callId)!.outcome).toBe("VOID");
  });

  test("an arena receipt cites NO venue evidence — it can never launder as one", async () => {
    const { h, store } = await arenaScene();
    await store.append(playerStream(asWallet(WALLET)), [
      { type: "CallMade", callId, matchId, marketId, bucket: asBucket("YES"), stake: wal(5), impliedProbAtCall: 0.4, bold: false },
      { type: "CallSettled", callId, matchId, marketId, result: "WON", stake: wal(5), payout: wal(9), pnlDelta: wal(4), grDelta: 3, difficulty: 0.6 },
    ]);
    const receipt = h.rt.receipts.receiptForCall(callId)!;
    expect(receipt.origin).toBe("arena");
    expect(receipt.marketResolutionId).toBeNull();
    expect(receipt.resolution).toBeNull();
    expect(receipt.market.venue).toBeNull();
  });

  test("an unmapped wallet produces NO receipt — an identity is never invented", async () => {
    const h = harness({ people: [] }); // nobody is linked to WALLET
    const store = new InMemoryEventStore();
    h.rt.attachReceipts(store);
    await store.append(playerStream(asWallet(WALLET)), [
      { type: "CallMade", callId, matchId, marketId, bucket: asBucket("YES"), stake: wal(5), impliedProbAtCall: 0.4, bold: false },
    ]);
    expect(h.rt.receipts.size).toBe(0);
  });

  test("an arena bucket outside YES/NO is not a call receipt", async () => {
    const { h, store } = await arenaScene();
    await store.append(playerStream(asWallet(WALLET)), [
      { type: "CallMade", callId, matchId, marketId, bucket: asBucket("HOME"), stake: wal(5), impliedProbAtCall: 0.4, bold: false },
    ]);
    expect(h.rt.receipts.receiptForCall(callId)).toBeUndefined();
  });

  test("unknown events are ignored, exactly like every existing projection", () => {
    const p = new CallReceiptsProjection();
    expect(() =>
      p.apply({
        meta: { id: "e1" as never, streamId: "gaffer:match:1", version: 0, at: 1 },
        payload: {
          type: "MatchResolved",
          matchId,
          score: { home: 1, away: 0 },
          outcomes: {},
          source: "demo",
        },
      }),
    ).not.toThrow();
    expect(p.size).toBe(0);
  });

  test("tailing the log does not disturb ReadModel's own projections (§6)", async () => {
    const { h, store } = await arenaScene();
    let alsoSaw = 0;
    // A second, independent subscriber — proving subscribe() is not exclusive.
    const off = store.subscribe(() => {
      alsoSaw++;
    });
    await store.append(playerStream(asWallet(WALLET)), [
      { type: "CallMade", callId, matchId, marketId, bucket: asBucket("YES"), stake: wal(5), impliedProbAtCall: 0.4, bold: false },
    ]);
    expect(alsoSaw).toBe(1);
    expect(h.rt.receipts.size).toBe(1);
    off();
  });
});
