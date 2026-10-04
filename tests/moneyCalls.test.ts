/**
 * Calls with an amount (docs/money-api.md §a, §b): every state transition,
 * the visibility rules, and that nothing is funded before FILLED.
 */
import { describe, expect, test } from "bun:test";
import { CallsService } from "../src/calls/CallsService.ts";
import { buildCallsRuntime } from "../src/calls/runtime.ts";
import { MoneyCallIndex } from "../src/money/visibility.ts";
import { callsStoreReader } from "../src/notifications/sources.ts";
import { PENDING_MAX_MS, PENDING_TTL_MS, dollars } from "../src/money/MoneyCallsService.ts";
import { PantaFundingIndex } from "../src/prediction/PantaFunding.ts";
import { HOUR, MIN, W, depositPerson, moneyRig, own, respond, settle } from "./moneyCallsFixtures.ts";
import { harness, market, person, T0 } from "./socialCallsFixtures.ts";

const ann = depositPerson("ann");
const bob = depositPerson("bob");

async function ready(r: ReturnType<typeof moneyRig>, input = own()) {
  const out = await r.money.prepareCall(ann, input);
  if (out.status !== "READY") throw new Error(`expected READY, got ${out.status}`);
  return out;
}

describe("prepare: gas, then funds, before anything exists", () => {
  test("not enough balance answers NEEDS_FUNDS and writes nothing", async () => {
    const r = moneyRig();
    r.balances.set(W.ann, "3000000");
    const out = await r.money.prepareCall(ann, own("m", "YES", "5000000"));
    expect(out).toEqual({ status: "NEEDS_FUNDS", wallet: { address: W.ann, walletType: "chumbucket" },
      balanceBaseUnits: "3000000", neededBaseUnits: "5000000", shortfallBaseUnits: "2000000" });
    expect(r.h.calls.listCalls()).toHaveLength(0);
    expect(r.store.rows.size).toBe(0);
    expect(r.panta.prepares).toHaveLength(0);
  });

  test("no SOL answers NEEDS_GAS with the top-up to run, and funds include the top-up's USDC", async () => {
    const r = moneyRig();
    r.gas.answer = { needsSol: true, topUp: { amountBaseUnits: "1000000" } };
    r.balances.set(W.ann, "5500000");
    expect(await r.money.prepareCall(ann, own("m", "YES", "5000000"))).toMatchObject({ status: "NEEDS_FUNDS", shortfallBaseUnits: "500000" });
    r.balances.set(W.ann, "6000000");
    expect(await r.money.prepareCall(ann, own("m", "YES", "5000000")))
      .toEqual({ status: "NEEDS_GAS", wallet: { address: W.ann, walletType: "chumbucket" }, topUp: { amountBaseUnits: "1000000" } });
    expect(r.h.calls.listCalls()).toHaveLength(0);
    expect(r.store.rows.size).toBe(0);
  });

  test("when funds land, the same tap continues by itself", async () => {
    const r = moneyRig();
    r.balances.set(W.ann, "0");
    const input = own();
    expect((await r.money.prepareCall(ann, input)).status).toBe("NEEDS_FUNDS");
    r.balances.set(W.ann, "9000000");
    const out = await r.money.prepareCall(ann, input);
    expect(out.status).toBe("READY");
  });

  test("amounts are whole cents from $1 to the server limit; wallets are the account's own", async () => {
    const r = moneyRig();
    for (const amount of ["999999", "5000001", "100010000"]) {
      await expect(r.money.prepareCall(ann, own("m", "YES", amount))).rejects.toMatchObject({ code: "AMOUNT" });
    }
    await expect(r.money.prepareCall(ann, { ...own(), wallet: W.bob })).rejects.toMatchObject({ code: "WALLET_NOT_LINKED" });
    await expect(r.money.prepareCall({ ...ann, wallets: [] }, own())).rejects.toMatchObject({ code: "NO_WALLET" });
    expect(r.store.rows.size).toBe(0);
  });

  test("a market our trade path cannot buy on (SOL-quoted) takes free calls only; nothing is written", async () => {
    const r = moneyRig();
    (r.money as unknown as { deps: { tradable: (id: string) => boolean } }).deps.tradable = id => id !== "m";
    await expect(r.money.prepareCall(ann, own("m"))).rejects.toMatchObject({ code: "NOT_TRADABLE", message: "This market takes free calls only." });
    expect(r.h.calls.listCalls()).toHaveLength(0);
    expect(r.store.rows.size).toBe(0);
    expect((await r.money.prepareCall(ann, own("n"))).status).toBe("READY");
  });

  test("a chosen linked wallet (pay with Phantom) pays instead of the trading wallet", async () => {
    const r = moneyRig();
    r.balances.set(W.annPhantom, "8000000");
    const out = await r.money.prepareCall(depositPerson("ann", [W.annPhantom]), { ...own(), wallet: W.annPhantom });
    expect(out.status === "READY" && out.trade.order.owner).toBe(W.annPhantom);
  });
});

describe("READY: a pending call is its owner's alone", () => {
  test("the intent is recorded before the call, the call is locked, and Panta quotes the buy", async () => {
    const r = moneyRig();
    const out = await ready(r);
    expect(out.moneyCall).toMatchObject({ state: "PENDING", trade: "QUOTED", kind: "own", side: "YES", amountBaseUnits: "5000000",
      wallet: W.ann, canRetry: true, canKeepFree: true, canDiscard: true });
    expect(out.call.money).toEqual({ state: "PENDING", amountBaseUnits: "5000000", side: "YES", expiresAt: out.moneyCall.expiresAt });
    expect(out.call.funding).toBeUndefined();
    expect(out.trade.order).toMatchObject({ owner: W.ann, amountBaseUnits: "5000000", fundingState: "QUOTED" });
    expect(r.panta.prepares[0]).toMatchObject({ callId: out.call.call.id, wallet: W.ann, amountBaseUnits: "5000000" });
    expect(r.panta.prepares[0]!.idempotencyKey.endsWith(".t1")).toBe(true);
    expect(r.flushes).toBeGreaterThan(0);
  });

  test("nobody else sees it anywhere, and it counts toward nothing", async () => {
    const r = moneyRig();
    const bobsCall = r.calls.createCall({ marketId: "m", side: "NO" }, "bob");
    const out = await ready(r);
    const id = out.call.call.id;
    // feed, call, profile
    expect(r.calls.feed({ mode: "global" }, "bob").entries.map(e => e.call.id)).not.toContain(id);
    expect(r.calls.feed({ mode: "global" }, null).entries.map(e => e.call.id)).not.toContain(id);
    expect(() => r.calls.getCall({ callId: id }, "bob")).toThrow("We couldn't find that call.");
    expect(r.calls.getPerson({ personRef: "ann" }, "bob").calls).toHaveLength(0);
    // the owner does see it, marked pending
    expect(r.calls.getCall({ callId: id }, "ann").entry.money?.state).toBe("PENDING");
    expect(r.calls.feed({ mode: "global" }, "ann").entries.map(e => e.call.id)).toContain(id);
    // crowd split: not counted, and it unlocks nothing for its owner
    expect(r.calls.marketDetail({ marketId: "m" }, "bob").crowdSplit).toEqual({ marketId: "m", yesCalls: 0, noCalls: 1 });
    expect(r.calls.marketDetail({ marketId: "m" }, "ann").crowdSplit).toBeNull();
    // top calls, records, notifications
    expect(r.calls.topCalls({}, "cy").entries.map(e => e.call.id)).toEqual([bobsCall.call.id]);
    expect(r.calls.people.publicRecord("ann").counts.pending).toBe(0);
    const graph = callsStoreReader(r.h.calls, id2 => r.calls.isPrivate(id2));
    expect(graph.listCalls().map(c => c.id)).toEqual([bobsCall.call.id]);
    expect(graph.getCall(id)).toBeUndefined();
    expect(graph.callsByAuthor("ann")).toEqual([]);
  });

  test("Tail takes the same side, Fade the other, and neither counts on the target until public", async () => {
    const r = moneyRig();
    const target = r.calls.createCall({ marketId: "m", side: "YES" }, "bob");
    const tail = await r.money.prepareCall(ann, respond("back", target.call.id));
    expect(tail.status === "READY" && tail.call.call.side).toBe("YES");
    expect(tail.status === "READY" && tail.call.call.parentCallId).toBe(target.call.id);
    expect(r.calls.getCall({ callId: target.call.id }, "bob").entry.backCount).toBe(0);
    const fade = await r.money.prepareCall(depositPerson("cy"), respond("fade", target.call.id));
    expect(fade.status === "READY" && fade.call.call.side).toBe("NO");
    expect(r.h.calls.listResponses()).toHaveLength(0);
  });

  test("Tail/Fade refusals match calls.respond: your own call, a call you cannot see, twice", async () => {
    const r = moneyRig();
    const mine = r.calls.createCall({ marketId: "m", side: "YES" }, "ann");
    await expect(r.money.prepareCall(ann, respond("back", mine.call.id))).rejects.toMatchObject({ code: "RESPONSE_SELF" });
    const bobsPending = await r.money.prepareCall(bob, own("n"));
    const pendingId = bobsPending.status === "READY" ? bobsPending.call.call.id : "";
    await expect(r.money.prepareCall(ann, respond("fade", pendingId))).rejects.toMatchObject({ code: "CALL_NOT_VISIBLE" });
    expect(r.store.rows.size).toBe(1);
  });

  test("one live call per market: a pending call blocks a second until it ends", async () => {
    const r = moneyRig();
    await ready(r);
    await expect(r.money.prepareCall(ann, own())).rejects.toMatchObject({ code: "CALL_ALREADY_MADE" });
    expect(() => r.calls.createCall({ marketId: "m", side: "NO" }, "ann")).toThrow("you already have a live call on this market");
  });
});

describe("nothing is funded before FILLED", () => {
  test("a signed, submitted order is still PENDING, private and unfunded", async () => {
    const r = moneyRig();
    const out = await ready(r);
    r.panta.submit(out.trade.order.orderId);
    const status = await r.money.status("ann", out.call.call.id);
    expect(status.moneyCall).toMatchObject({ state: "PENDING", trade: "SUBMITTED", canRetry: false, canKeepFree: false, canDiscard: false });
    expect(status.order?.fundingState).toBe("SUBMITTED");
    expect(r.calls.isPrivate(out.call.call.id)).toBe(true);
    expect(r.calls.getCall({ callId: out.call.call.id }, "ann").entry.funding).toBeUndefined();
    await expect(r.money.keepFree("ann", out.call.call.id)).rejects.toMatchObject({ code: "IN_FLIGHT" });
    await expect(r.money.discard("ann", out.call.call.id)).rejects.toMatchObject({ code: "IN_FLIGHT" });
    await expect(r.money.retry(ann, out.call.call.id)).rejects.toMatchObject({ code: "IN_FLIGHT" });
    // The sweeper never expires a call with an order going through, even past its time.
    r.h.clock.advance(PENDING_MAX_MS + MIN);
    expect((await r.money.sweep()).expired).toBe(0);
    expect(r.store.rows.get(out.call.call.id)!.state).toBe("PENDING");
  });

  test("FILLED funds it: public, \"$5 on YES\", and a Tail now counts on its target", async () => {
    const r = moneyRig();
    const target = r.calls.createCall({ marketId: "m", side: "YES" }, "bob");
    const input = respond("back", target.call.id);
    const out = await r.money.prepareCall(ann, input);
    if (out.status !== "READY") throw new Error(out.status);
    r.panta.submit(out.trade.order.orderId);
    r.panta.fill(out.trade.order.orderId);
    await settle();
    const id = out.call.call.id;
    expect(r.store.rows.get(id)).toMatchObject({ state: "FUNDED", ended_reason: "filled" });
    expect(r.calls.isPrivate(id)).toBe(false);
    const seen = r.calls.getCall({ callId: id }, "cy").entry;
    expect(seen.funding).toMatchObject({ state: "FILLED", venue: "panta", amountBaseUnits: "5000000", side: "YES" });
    expect(seen.money).toBeUndefined();
    expect(r.calls.getCall({ callId: target.call.id }, "cy").entry.backCount).toBe(1);
    expect(r.h.calls.listResponses()[0]).toMatchObject({ kind: "back", actorUserId: "ann", resultingCallId: id });
    const status = await r.money.status("ann", id);
    expect(status.moneyCall).toMatchObject({ state: "FUNDED", trade: "FILLED", filledBaseUnits: "5000000", canRetry: false });
    // The tap replayed after funding is SETTLED, never a second buy.
    const prepares = r.panta.prepares.length;
    const replay = await r.money.prepareCall(ann, input);
    expect(replay.status).toBe("SETTLED");
    expect(r.panta.prepares.length).toBe(prepares);
  });

  test("a fill the hook missed is repaired by the sweeper from the ledger", async () => {
    const r = moneyRig();
    r.panta.onFilled = null;
    const out = await ready(r);
    r.panta.submit(out.trade.order.orderId);
    r.panta.fill(out.trade.order.orderId);
    expect(r.store.rows.get(out.call.call.id)!.state).toBe("PENDING");
    expect(await r.money.sweep()).toMatchObject({ funded: 1, expired: 0 });
    expect(r.store.rows.get(out.call.call.id)!.state).toBe("FUNDED");
  });

  test("the store refuses FUNDED without a FILLED trade and EXPIRED with one going through", async () => {
    const r = moneyRig();
    const out = await ready(r);
    const row = r.store.rows.get(out.call.call.id)!;
    await expect(r.store.update(row.call_id, { state: "PENDING", attempts: row.attempts }, { state: "FUNDED", ended_reason: "filled" }))
      .rejects.toThrow("funded only by a confirmed fill");
    r.panta.submit(out.trade.order.orderId);
    await expect(r.store.update(row.call_id, { state: "PENDING", attempts: row.attempts }, { state: "EXPIRED", ended_reason: "expired" }))
      .rejects.toThrow("cannot expire");
  });
});

describe("failed or abandoned: retry, keep free, discard, or expire", () => {
  test("retry after a failed trade quotes a new attempt for the same call", async () => {
    const r = moneyRig();
    const out = await ready(r);
    r.panta.submit(out.trade.order.orderId);
    r.panta.fail(out.trade.order.orderId);
    const status = await r.money.status("ann", out.call.call.id);
    expect(status.moneyCall).toMatchObject({ state: "PENDING", trade: "FAILED", canRetry: true, canKeepFree: true });
    const again = await r.money.retry(ann, out.call.call.id);
    expect(again.status).toBe("READY");
    expect(r.panta.prepares.at(-1)!.idempotencyKey.endsWith(".t2")).toBe(true);
    expect(r.store.rows.get(out.call.call.id)!.attempts).toBe(2);
    expect(again.status === "READY" && again.trade.order.orderId).not.toBe(out.trade.order.orderId);
  });

  test("a dropped reply never builds a second quote; an expired quote is re-quoted", async () => {
    const r = moneyRig();
    const input = own();
    const first = await r.money.prepareCall(ann, input);
    const replay = await r.money.prepareCall(ann, input);
    expect(replay.status === "READY" && first.status === "READY" && replay.trade.order.orderId).toBe(first.status === "READY" ? first.trade.order.orderId : "");
    expect(r.panta.prepares).toHaveLength(1);
    r.h.clock.advance(2 * MIN);
    const requoted = await r.money.prepareCall(ann, input);
    expect(requoted.status).toBe("READY");
    expect(r.panta.prepares).toHaveLength(2);
    await expect(r.money.prepareCall(ann, { ...input, amountBaseUnits: "6000000" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("retry re-checks funds and gas before quoting", async () => {
    const r = moneyRig();
    const out = await ready(r);
    r.panta.fail(out.trade.order.orderId);
    r.balances.set(W.ann, "1000000");
    expect((await r.money.retry(ann, out.call.call.id)).status).toBe("NEEDS_FUNDS");
    r.balances.set(W.ann, "9000000");
    r.gas.answer = { needsSol: true, topUp: { amountBaseUnits: "1000000" } };
    expect((await r.money.retry(ann, out.call.call.id)).status).toBe("NEEDS_GAS");
    expect(r.store.rows.get(out.call.call.id)!.attempts).toBe(1);
  });

  test("keep free: public with the Free marker, and a Fade now counts", async () => {
    const r = moneyRig();
    const target = r.calls.createCall({ marketId: "m", side: "YES" }, "bob");
    const out = await r.money.prepareCall(ann, respond("fade", target.call.id));
    if (out.status !== "READY") throw new Error(out.status);
    r.panta.fail(out.trade.order.orderId);
    const kept = await r.money.keepFree("ann", out.call.call.id);
    expect(kept.moneyCall).toMatchObject({ state: "FREE", canRetry: false, canKeepFree: false });
    expect(kept.call.funding).toBeUndefined();
    expect(kept.call.money).toBeUndefined();
    expect(r.calls.getCall({ callId: out.call.call.id }, "cy").entry.call.fundingState).toBe("NONE");
    expect(r.calls.getCall({ callId: target.call.id }, "cy").entry.fadeCount).toBe(1);
    expect(r.calls.people.publicRecord("ann").counts.pending).toBe(1);
    // Idempotent, and final unless a fill lands.
    expect((await r.money.keepFree("ann", out.call.call.id)).moneyCall.state).toBe("FREE");
    await expect(r.money.discard("ann", out.call.call.id)).rejects.toMatchObject({ code: "STATE" });
  });

  test("keep free is refused once the market stopped taking calls; the sweeper then expires it", async () => {
    const r = moneyRig({ markets: [market("m", { closesAt: T0 + 20 * MIN })] });
    const out = await ready(r);
    r.panta.fail(out.trade.order.orderId);
    r.h.clock.advance(21 * MIN);
    await expect(r.money.keepFree("ann", out.call.call.id)).rejects.toMatchObject({ code: "MARKET_CLOSED" });
    expect(await r.money.sweep()).toMatchObject({ expired: 1 });
    expect(r.store.rows.get(out.call.call.id)).toMatchObject({ state: "EXPIRED", ended_reason: "market_closed" });
  });

  test("discard withdraws it now; the owner sees EXPIRED and nobody else ever saw it", async () => {
    const r = moneyRig();
    const out = await ready(r);
    const gone = await r.money.discard("ann", out.call.call.id);
    expect(gone.moneyCall).toMatchObject({ state: "EXPIRED", canRetry: false });
    const call = r.h.calls.getCall(out.call.call.id)!;
    expect(call.hiddenReason).toBe("money_call_expired");
    expect(r.calls.getCall({ callId: call.id }, "ann").entry.money?.state).toBe("EXPIRED");
    expect(() => r.calls.getCall({ callId: call.id }, "bob")).toThrow();
    expect(r.calls.people.publicRecord("ann").counts.pending).toBe(0);
    // The market is free for a new call.
    expect(r.calls.createCall({ marketId: "m", side: "NO" }, "ann").call.side).toBe("NO");
  });

  test("no ghosts: an abandoned pending call expires after its time", async () => {
    const r = moneyRig();
    const out = await ready(r);
    expect(out.moneyCall.expiresAt).toBe(T0 + PENDING_TTL_MS);
    r.h.clock.advance(PENDING_TTL_MS - 1);
    expect((await r.money.sweep()).expired).toBe(0);
    r.h.clock.advance(1);
    expect((await r.money.sweep()).expired).toBe(1);
    expect(r.store.rows.get(out.call.call.id)).toMatchObject({ state: "EXPIRED", ended_reason: "expired" });
    expect(r.h.calls.getCall(out.call.call.id)!.hiddenAt).not.toBeNull();
    expect((await r.money.pending("ann")).calls).toHaveLength(0);
    await expect(r.money.retry(ann, out.call.call.id)).rejects.toMatchObject({ code: "STATE" });
  });

  test("no new quote that could outlive the call's thirty minutes", async () => {
    const r = moneyRig();
    const out = await ready(r);
    r.panta.fail(out.trade.order.orderId);
    r.h.clock.advance(PENDING_MAX_MS - 5 * MIN);
    await expect(r.money.retry(ann, out.call.call.id)).rejects.toMatchObject({ code: "EXPIRED" });
  });

  test("an expired call a late fill funds after all is shown again (the venue wins)", async () => {
    const r = moneyRig();
    const out = await ready(r);
    const row = r.store.rows.get(out.call.call.id)!;
    // Expired first (the race the SQL guard narrows), then the fill lands.
    await r.money.discard("ann", out.call.call.id);
    r.panta.rows[0]!.state = "SUBMITTED"; r.panta.rows[0]!.signature = "s".padEnd(64, "1");
    r.panta.fill(out.trade.order.orderId);
    await settle();
    expect(r.store.rows.get(row.call_id)!.state).toBe("FUNDED");
    expect(r.h.calls.getCall(row.call_id)!.hiddenAt).toBeNull();
    expect(r.calls.getCall({ callId: row.call_id }, "bob").entry.funding?.amountBaseUnits).toBe("5000000");
  });

  test("an intent whose call could not be locked leaves no ghost", async () => {
    const r = moneyRig();
    const plan = r.calls.planFundedCall({ kind: "own", marketId: "m", side: "YES" }, "ann");
    // Ann makes a free call on the market between plan and lock.
    r.calls.createCall({ marketId: "m", side: "NO" }, "ann");
    let planned = false;
    r.calls.planFundedCall = () => { planned = true; return { ...plan, callId: "call-ghost" }; };
    await expect(r.money.prepareCall(ann, own())).rejects.toMatchObject({ code: "CALL_ALREADY_MADE" });
    expect(planned).toBe(true);
    expect(r.store.rows.get("call-ghost")).toMatchObject({ state: "EXPIRED", ended_reason: "not_created" });
    expect(r.calls.isPrivate("call-ghost")).toBe(true);
    expect(r.h.calls.getCall("call-ghost")).toBeUndefined();
  });

  test("money.pending lists what the owner still has to finish", async () => {
    const r = moneyRig();
    const a = await ready(r, own("m"));
    const b = await ready(r, own("n"));
    expect((await r.money.pending("ann")).calls.map(c => c.moneyCall.callId).sort()).toEqual([a.call.call.id, b.call.call.id].sort());
    expect((await r.money.pending("bob")).calls).toEqual([]);
  });

  test("someone else's money call reads as not found", async () => {
    const r = moneyRig();
    const out = await ready(r);
    await expect(r.money.status("bob", out.call.call.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(r.money.keepFree("bob", out.call.call.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(r.money.retry(bob, out.call.call.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("the default amount is the last one used, else $5", async () => {
    const r = moneyRig();
    expect(await r.money.defaultAmount("ann")).toBe("5000000");
    await ready(r, own("m", "YES", "10000000"));
    expect(await r.money.defaultAmount("ann")).toBe("10000000");
    expect(dollars("5000000")).toBe("$5");
    expect(dollars("9200000")).toBe("$9.20");
  });
});

describe("after a restart", () => {
  test("which calls are private is rebuilt from the ledger, and a pending call stays its owner's", async () => {
    const r = moneyRig();
    const out = await ready(r);
    const fresh = new MoneyCallIndex(r.store);
    expect(fresh.isPrivate(out.call.call.id)).toBe(false);
    expect(await fresh.hydrate()).toBe(1);
    const calls = new CallsService({ store: r.h.calls, markets: r.h.rt.markets, clock: r.h.clock, moneyCalls: fresh });
    expect(() => calls.getCall({ callId: out.call.call.id }, "bob")).toThrow("We couldn't find that call.");
    expect(calls.getCall({ callId: out.call.call.id }, "ann").entry.money?.state).toBe("PENDING");
  });

  test("a money_calls ledger that cannot be read fails the feed closed, never open", async () => {
    const h = harness({ people: [person("ann")], markets: [market("m")] });
    const rt = buildCallsRuntime(undefined, { store: h.calls, markets: h.rt.markets, hydrate: true,
      moneyCalls: new MoneyCallIndex({ privateRows: async () => { throw new Error("relation money_calls does not exist"); } }) });
    await expect(rt.ready).rejects.toMatchObject({ code: "VENUE_UNAVAILABLE" });
  });
});

describe("funded-first ordering and filled amounts (§b)", () => {
  test("profiles and top calls list funded calls first; leaderboard rows count funded calls", async () => {
    const r = moneyRig({ markets: [market("m", { closesAt: T0 + 10 * HOUR }), market("n", { closesAt: T0 + 10 * HOUR }), market("o", { closesAt: T0 + 10 * HOUR })] });
    const funded = await ready(r, own("m"));
    r.h.clock.advance(MIN);
    const free = r.calls.createCall({ marketId: "n", side: "NO" }, "ann");
    r.panta.submit(funded.trade.order.orderId);
    r.panta.fill(funded.trade.order.orderId);
    await settle();
    expect(r.calls.getPerson({ personRef: "ann" }, "bob").calls.map(e => e.call.id)).toEqual([funded.call.call.id, free.call.id]);
    expect(r.calls.topCalls({}, "bob").entries.map(e => e.call.id)).toEqual([funded.call.call.id, free.call.id]);
    const board = r.calls.leaderboard({ window: "all" }, "ann");
    expect(board.viewer?.fundedCalls).toBe(1);
  });

  test("with money calls off, a funded entry keeps its exact earlier shape and nothing is private", () => {
    const h = harness({ people: [person("ann"), person("bob")], markets: [market("m")] });
    const funding = new PantaFundingIndex(null);
    const calls = new CallsService({ store: h.calls, markets: h.rt.markets, clock: h.clock, funding });
    const call = calls.createCall({ marketId: "m", side: "YES" }, "ann");
    funding.markFilled(call.call.id, 7, { id: "t1", amountBaseUnits: "5000000", side: "YES" });
    expect(calls.getCall({ callId: call.call.id }, "bob").entry.funding).toEqual({ state: "FILLED", venue: "panta", fundedAt: 7 });
    expect(calls.isPrivate(call.call.id)).toBe(false);
    expect(calls.leaderboard({ window: "all" }, "ann").viewer).not.toHaveProperty("fundedCalls");
  });

  test("the funding index sums fills per call once each, across pages that overlap", async () => {
    const rows = [
      { id: "t1", call_id: "c1", updated_at: "2026-10-04T10:00:00.000Z", amount_base_units: "5000000", side: "YES" as const },
      { id: "t2", call_id: "c1", updated_at: "2026-10-04T10:01:00.000Z", amount_base_units: "2500000", side: "YES" as const },
    ];
    const index = new PantaFundingIndex({ filledSince: async () => rows });
    await index.refresh();
    await index.refresh();
    expect(index.fundingOf("c1")).toMatchObject({ amountBaseUnits: "7500000", side: "YES" });
    index.markFilled("c1", 1, { id: "t2", amountBaseUnits: "2500000", side: "YES" });
    expect(index.fundingOf("c1")?.amountBaseUnits).toBe("7500000");
  });
});

