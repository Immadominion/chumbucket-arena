/**
 * Orders, the FILLED invariant, and reconciliation.
 *
 * The single most expensive mistake this packet could make is calling something
 * "funded" that is not. contracts §3 says FILLED is the only state the word may
 * appear for, and §4 says reconciliation is what establishes it. So:
 *
 *   - createOrder produces a QUOTE. A quote is not money.
 *   - the same idempotency key never produces a second order, even concurrently.
 *   - NOTHING can write FILLED except applyFill(), and only with a venue order
 *     id, a non-zero filled size and a transaction signature.
 *   - reconciliation repairs a dropped callback, is idempotent, and resumes from
 *     its persisted cursor after a restart.
 */

import { describe, expect, test } from "bun:test";
import {
  FixtureVenue,
  InMemoryPredictionStore,
  OrderReconciler,
  PredictionService,
  isVenueError,
  orderFingerprint,
  type FillEvidence,
  type OrderRecord,
} from "../src/prediction/index.ts";
import { T0, TestClock } from "./predictionFixtures.ts";

const OWNER_KEY = "wallet:OwnerAddress111";
const OWNER = "OwnerAddress111";
const MARKET = "fx-open-btc-120k";

function harness(fundedPositions = true) {
  const clock = new TestClock();
  const venue = new FixtureVenue({ clock });
  const store = new InMemoryPredictionStore();
  const service = new PredictionService({ venue, store, clock, flags: { fundedPositions } });
  return { clock, venue, store, service };
}

const orderReq = (idempotencyKey: string, overrides: Partial<Parameters<PredictionService["createOrder"]>[0]> = {}) => ({
  ownerKey: OWNER_KEY,
  ownerAddress: OWNER,
  venueMarketId: MARKET,
  side: "YES" as const,
  amountBaseUnits: "5000000",
  idempotencyKey,
  ...overrides,
});

describe("order creation", () => {
  test("a created order is a QUOTE, never money", async () => {
    const { service } = harness();
    const { order, record } = await service.createOrder(orderReq("idem-key-0001"));
    expect(order.fundingState).toBe("QUOTED");
    expect(record.fundingState).toBe("QUOTED");
    expect(record.filledBaseUnits).toBe("0");
    expect(record.fillTxSignature).toBeNull();
    expect(record.reconciledAt).toBeNull();
  });

  test("money must be integer base units as a string", async () => {
    const { service } = harness();
    await expect(service.createOrder(orderReq("idem-key-0002", { amountBaseUnits: "1.5" }))).rejects.toThrow(
      /integer base units/,
    );
    await expect(service.createOrder(orderReq("idem-key-0003", { amountBaseUnits: "0" }))).rejects.toThrow(
      /greater than zero/,
    );
  });

  test("an order against a non-OPEN market is refused by the venue", async () => {
    const { service } = harness();
    await expect(
      service.createOrder(orderReq("idem-key-0004", { venueMarketId: "fx-closed-eth-5k" })),
    ).rejects.toThrow(/CLOSED_PENDING_RESOLUTION/);
  });
});

describe("idempotency", () => {
  test("the same key never creates two orders", async () => {
    const { service, store } = harness();
    const a = await service.createOrder(orderReq("idem-key-0010"));
    const b = await service.createOrder(orderReq("idem-key-0010"));
    expect(b.reused).toBe(true);
    expect(b.record.orderId).toBe(a.record.orderId);
    expect(store.listOrders(OWNER_KEY).length).toBe(1);
  });

  test("the venue is not even asked for a second quote on a replay", async () => {
    const { service, venue } = harness();
    let quotes = 0;
    const original = venue.createBuyOrder.bind(venue);
    venue.createBuyOrder = async (o) => {
      quotes++;
      return original(o);
    };
    await service.createOrder(orderReq("idem-key-0011"));
    await service.createOrder(orderReq("idem-key-0011"));
    await service.createOrder(orderReq("idem-key-0011"));
    expect(quotes).toBe(1);
  });

  test("concurrent requests with one key still produce exactly one order", async () => {
    const { service, store } = harness();
    const results = await Promise.all([
      service.createOrder(orderReq("idem-key-0012")),
      service.createOrder(orderReq("idem-key-0012")),
      service.createOrder(orderReq("idem-key-0012")),
    ]);
    const ids = new Set(results.map((r) => r.record.orderId));
    expect(ids.size).toBe(1);
    expect(store.listOrders(OWNER_KEY).length).toBe(1);
  });

  test("replaying a key with a DIFFERENT body is a conflict, not a silent reuse", async () => {
    const { service } = harness();
    await service.createOrder(orderReq("idem-key-0013"));
    let err: unknown;
    try {
      await service.createOrder(orderReq("idem-key-0013", { amountBaseUnits: "9000000" }));
    } catch (e) {
      err = e;
    }
    expect(isVenueError(err) && err.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("the same key from a different owner is a different order", async () => {
    const { service, store } = harness();
    await service.createOrder(orderReq("idem-key-0014"));
    await service.createOrder(
      orderReq("idem-key-0014", { ownerKey: "wallet:Other", ownerAddress: "Other" }),
    );
    expect(store.listOrders(OWNER_KEY).length).toBe(1);
    expect(store.listOrders("wallet:Other").length).toBe(1);
  });

  test("the fingerprint is what makes a replay comparable", () => {
    const a = orderFingerprint({ owner: "o", venueMarketId: "m", side: "YES", amountBaseUnits: "1" });
    const b = orderFingerprint({ owner: "o", venueMarketId: "m", side: "NO", amountBaseUnits: "1" });
    expect(a).not.toBe(b);
  });
});

describe("FILLED is reachable only from a reconciliation write", () => {
  const evidence = (over: Partial<FillEvidence> = {}): FillEvidence => ({
    venue: "fixture",
    venueOrderId: "fx-venue-1",
    filledBaseUnits: "5000000",
    fillTxSignature: "fx-sig-1",
    confirmedAt: T0,
    raw: {},
    ...over,
  });

  const seeded = async () => {
    const h = harness();
    const { record } = await h.service.createOrder(orderReq("idem-key-0020"));
    return { ...h, record };
  };

  test("an order cannot be created FILLED", async () => {
    const { store, record } = await seeded();
    const forged: OrderRecord = { ...record, orderId: "forged", idempotencyKey: "k-forged", fundingState: "FILLED" };
    expect(() => store.createOrder(forged)).toThrow(/may not be created FILLED/);
  });

  test("setOrderState refuses FILLED outright", async () => {
    const { store, record } = await seeded();
    store.setOrderState(record.orderId, "SUBMITTED", T0);
    expect(() => store.setOrderState(record.orderId, "FILLED", T0)).toThrow(/applyFill/);
  });

  test("applyFill refuses without a venue order id, a signature, or a non-zero size", async () => {
    const { store, record } = await seeded();
    store.setOrderState(record.orderId, "SUBMITTED", T0);
    expect(() => store.applyFill(record.orderId, evidence({ venueOrderId: "" }), T0)).toThrow(/venue order id/);
    expect(() => store.applyFill(record.orderId, evidence({ fillTxSignature: "" }), T0)).toThrow(/tx signature/);
    expect(() => store.applyFill(record.orderId, evidence({ filledBaseUnits: "0" }), T0)).toThrow(/non-zero/);
    expect(store.getOrder(record.orderId)!.fundingState).toBe("SUBMITTED");
  });

  test("FILLED may only follow SUBMITTED or PARTIAL", async () => {
    const { store, record } = await seeded();
    expect(() => store.applyFill(record.orderId, evidence(), T0)).toThrow(/may only follow SUBMITTED or PARTIAL/);
  });

  test("evidence from another venue is refused", async () => {
    const { store, record } = await seeded();
    store.setOrderState(record.orderId, "SUBMITTED", T0);
    expect(() => store.applyFill(record.orderId, evidence({ venue: "jupiter" }), T0)).toThrow(/different venue/);
  });

  test("a partial fill lands on PARTIAL, not FILLED", async () => {
    const { store, record } = await seeded();
    store.setOrderState(record.orderId, "SUBMITTED", T0);
    const out = store.applyFill(record.orderId, evidence({ filledBaseUnits: "2000000" }), T0);
    expect(out.fundingState).toBe("PARTIAL");
    expect(out.filledBaseUnits).toBe("2000000");
  });

  test("replaying the same evidence is a no-op; contradicting it is a conflict", async () => {
    const { store, record } = await seeded();
    store.setOrderState(record.orderId, "SUBMITTED", T0);
    const first = store.applyFill(record.orderId, evidence(), T0);
    const second = store.applyFill(record.orderId, evidence(), T0 + 5_000);
    expect(second).toEqual(first);
    expect(() => store.applyFill(record.orderId, evidence({ fillTxSignature: "other-sig" }), T0)).toThrow(
      /already FILLED with different evidence/,
    );
  });

  test("a FILLED order cannot regress", async () => {
    const { store, record } = await seeded();
    store.setOrderState(record.orderId, "SUBMITTED", T0);
    store.applyFill(record.orderId, evidence(), T0);
    expect(() => store.setOrderState(record.orderId, "SUBMITTED", T0)).toThrow(/may not regress/);
    expect(store.setOrderState(record.orderId, "CLAIMABLE", T0).fundingState).toBe("CLAIMABLE");
  });
});

describe("reconciliation repairs a dropped callback", () => {
  test("an order stuck on SUBMITTED is repaired to FILLED from venue history", async () => {
    const { service, venue, store, clock } = harness();
    const { record } = await service.createOrder(orderReq("idem-key-0030"));
    service.markSubmitted(OWNER_KEY, record.orderId);

    // The venue fills it — and the callback never arrives.
    venue.markSubmitted(record.orderId);
    venue.confirmFill(record.orderId);
    expect(store.getOrder(record.orderId)!.fundingState).toBe("SUBMITTED");

    clock.advance(60_000);
    const report = await service.reconcile(OWNER_KEY, OWNER);
    expect(report.ordersFilled).toBe(1);

    const repaired = store.getOrder(record.orderId)!;
    expect(repaired.fundingState).toBe("FILLED");
    expect(repaired.fillTxSignature).toBe(`fx-sig-${record.orderId}`);
    expect(repaired.venueOrderId).toBe(`fx-venue-${record.orderId}`);
    expect(repaired.reconciledAt).not.toBeNull();
  });

  test("an order still on QUOTED is walked forward through SUBMITTED", async () => {
    const { service, venue, store } = harness();
    const { record } = await service.createOrder(orderReq("idem-key-0031"));
    venue.markSubmitted(record.orderId);
    venue.confirmFill(record.orderId);

    await service.reconcile(OWNER_KEY, OWNER);
    expect(store.getOrder(record.orderId)!.fundingState).toBe("FILLED");
  });

  test("reconciling twice changes nothing the second time", async () => {
    const { service, venue, store } = harness();
    const { record } = await service.createOrder(orderReq("idem-key-0032"));
    service.markSubmitted(OWNER_KEY, record.orderId);
    venue.confirmFill(record.orderId);

    const first = await service.reconcile(OWNER_KEY, OWNER);
    const after = { ...store.getOrder(record.orderId)! };
    const second = await service.reconcile(OWNER_KEY, OWNER);

    expect(first.ordersFilled).toBe(1);
    expect(second.ordersFilled).toBe(0);
    expect(second.ordersChecked).toBe(0); // FILLED is terminal; not re-asked
    expect(store.getOrder(record.orderId)).toEqual(after);
    expect(store.listPositions(OWNER_KEY).length).toBe(1); // not duplicated
  });

  test("a venue that says 'filled' without evidence never becomes FILLED", async () => {
    const { service, venue, store } = harness();
    const { record } = await service.createOrder(orderReq("idem-key-0033"));
    service.markSubmitted(OWNER_KEY, record.orderId);
    // A venue whose confirmation carries no signature is not a confirmation.
    const original = venue.getOrder.bind(venue);
    venue.getOrder = async (id) => ({ ...(await original(id)), fundingState: "FILLED" as const, filledBaseUnits: "5000000", fillTxSignature: null });

    const report = await service.reconcile(OWNER_KEY, OWNER);
    expect(report.ordersFilled).toBe(0);
    expect(store.getOrder(record.orderId)!.fundingState).toBe("SUBMITTED");
  });

  test("a failed order is recorded as FAILED", async () => {
    const { service, venue, store } = harness();
    const { record } = await service.createOrder(orderReq("idem-key-0034"));
    service.markSubmitted(OWNER_KEY, record.orderId);
    venue.failOrder(record.orderId);
    const report = await service.reconcile(OWNER_KEY, OWNER);
    expect(report.ordersFailed).toBe(1);
    expect(store.getOrder(record.orderId)!.fundingState).toBe("FAILED");
  });

  test("an order the venue has never heard of is counted, not crashed on", async () => {
    const { service, venue, store } = harness();
    const { record } = await service.createOrder(orderReq("idem-key-0035"));
    service.markSubmitted(OWNER_KEY, record.orderId);
    venue.getOrder = async () => {
      const { VenueError } = await import("../src/prediction/errors.ts");
      throw new VenueError("VENUE_NOT_FOUND", "gone");
    };
    const report = await service.reconcile(OWNER_KEY, OWNER);
    expect(report.ordersMissingAtVenue).toBe(1);
    expect(store.getOrder(record.orderId)!.fundingState).toBe("SUBMITTED");
  });
});

describe("reconciliation is cursor-backed and restart-safe", () => {
  test("the position cursor is persisted after every page and resumes after a restart", async () => {
    const clock = new TestClock();
    const store = new InMemoryPredictionStore();

    // A venue whose position history spans three pages.
    const pages = [
      { positions: [pos("p1")], nextCursor: "c2", fetchedAt: T0 },
      { positions: [pos("p2")], nextCursor: "c3", fetchedAt: T0 },
      { positions: [pos("p3")], nextCursor: null, fetchedAt: T0 },
    ];
    const asked: (string | undefined)[] = [];
    const venue = new FixtureVenue({ clock });
    venue.listPositions = async (_owner, cursor) => {
      asked.push(cursor);
      if (cursor === undefined) return pages[0]!;
      if (cursor === "c2") throw new Error("process died mid-pass");
      if (cursor === "c3") return pages[2]!;
      return { positions: [], nextCursor: null, fetchedAt: T0 };
    };

    const first = new OrderReconciler({ venue, store, clock });
    await expect(first.runOnce({ ownerKey: OWNER_KEY, owner: OWNER })).rejects.toThrow("process died mid-pass");
    expect(store.getCursor(OrderReconciler.cursorKey(OWNER_KEY))).toBe("c2"); // page 1 was banked

    // Restart: a brand-new reconciler over the same store picks the cursor up.
    venue.listPositions = async (_owner, cursor) => {
      asked.push(cursor);
      if (cursor === "c2") return pages[1]!;
      if (cursor === "c3") return pages[2]!;
      return { positions: [], nextCursor: null, fetchedAt: T0 };
    };
    const second = new OrderReconciler({ venue, store, clock });
    const report = await second.runOnce({ ownerKey: OWNER_KEY, owner: OWNER });

    expect(asked).toEqual([undefined, "c2", "c2", "c3"]); // never re-walked from zero
    expect(report.pages).toBe(2);
    expect(store.listPositions(OWNER_KEY).map((p) => p.positionId).sort()).toEqual(["p1", "p2", "p3"]);
    expect(store.getCursor(OrderReconciler.cursorKey(OWNER_KEY))).toBeNull();
  });

  test("an older restatement never clobbers a newer position", () => {
    const store = new InMemoryPredictionStore();
    store.upsertPosition({ ...pos("p1"), ownerKey: OWNER_KEY, updatedAt: T0 + 10_000, sizeBaseUnits: "9" });
    store.upsertPosition({ ...pos("p1"), ownerKey: OWNER_KEY, updatedAt: T0, sizeBaseUnits: "1" });
    expect(store.listPositions(OWNER_KEY)[0]!.sizeBaseUnits).toBe("9");
  });
});

function pos(id: string) {
  return {
    positionId: id,
    venue: "fixture" as const,
    venueMarketId: MARKET,
    marketId: "m",
    owner: OWNER,
    side: "YES" as const,
    sizeBaseUnits: "5000000",
    averageProbability: 0.62,
    fundingState: "FILLED" as const,
    claimableBaseUnits: "0",
    resolution: null,
    updatedAt: T0,
    demo: true,
  };
}
