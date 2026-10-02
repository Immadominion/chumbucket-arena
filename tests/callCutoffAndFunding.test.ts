/**
 * M14 — calls close a configurable window before the market does — and the
 * funded-call marker (confirmed fills only, never a rewrite of the call).
 */
import { describe, expect, test } from "bun:test";
import { CallsService } from "../src/calls/CallsService.ts";
import { resolveCallsConfig, DEFAULT_CALL_CUTOFF_MINUTES } from "../src/calls/config.ts";
import { acceptsNewCalls, callsCloseAt } from "../src/calls/markets.ts";
import { PantaFundingIndex } from "../src/prediction/PantaFunding.ts";
import { harness, market, person, T0 } from "./socialCallsFixtures.ts";

const MIN = 60_000;
function service(h: ReturnType<typeof harness>, cutoffMinutes = 30, funding?: PantaFundingIndex) {
  return new CallsService({ store: h.calls, markets: h.rt.markets, clock: h.clock, callCutoffMs: cutoffMinutes * MIN,
    newId: (() => { let n = 0; return (kind: string) => `${kind}-${++n}`; })(), ...(funding ? { funding } : {}) });
}

describe("call cut-off before market close (M14)", () => {
  test("defaults to 30 minutes, reads CALLS_CLOSE_CUTOFF_MINUTES, and is bounded", () => {
    expect(DEFAULT_CALL_CUTOFF_MINUTES).toBe(30);
    expect(resolveCallsConfig(undefined, {}).callCutoffMs).toBe(30 * MIN);
    expect(resolveCallsConfig(undefined, { CALLS_CLOSE_CUTOFF_MINUTES: "45" }).callCutoffMs).toBe(45 * MIN);
    expect(resolveCallsConfig(undefined, { CALLS_CLOSE_CUTOFF_MINUTES: "0" }).callCutoffMs).toBe(0);
    expect(resolveCallsConfig(undefined, { CALLS_CLOSE_CUTOFF_MINUTES: "99999" }).callCutoffMs).toBe(1440 * MIN);
    expect(resolveCallsConfig(undefined, { CALLS_CLOSE_CUTOFF_MINUTES: "nonsense" }).callCutoffMs).toBe(30 * MIN);
  });

  test("a market inside the window is not offered and refuses a call with copy that names the window", () => {
    const soon = market("soon", { closesAt: T0 + 20 * MIN });
    const later = market("later", { closesAt: T0 + 2 * 60 * MIN });
    const h = harness({ people: [person("ann")], markets: [soon, later] });
    const calls = service(h);
    expect(calls.openMarkets().map(m => m.id)).toEqual(["later"]);
    expect(acceptsNewCalls(soon, T0, 30 * MIN)).toBe(false);
    expect(acceptsNewCalls(soon, T0)).toBe(true);
    expect(callsCloseAt(later, 30 * MIN)).toBe(T0 + 90 * MIN);
    expect(() => calls.createCall({ marketId: "soon", side: "YES" }, "ann"))
      .toThrow("Calls close 30 minutes before this market does, so you can't make a call now.");
    expect(calls.createCall({ marketId: "later", side: "YES" }, "ann").call.marketId).toBe("later");
  });

  test("the window closes on time, back/fade respect it, and market detail tells the app when", () => {
    const m = market("m", { closesAt: T0 + 60 * MIN });
    const h = harness({ people: [person("ann"), person("bob")], markets: [m] });
    const calls = service(h);
    const ann = calls.createCall({ marketId: "m", side: "YES" }, "ann");
    const detail = calls.marketDetail({ marketId: "m" }, null);
    expect(detail.callsCloseAt).toBe(T0 + 30 * MIN);
    expect(detail.callCutoffMs).toBe(30 * MIN);
    h.clock.advance(30 * MIN);
    expect(() => calls.respond({ targetCallId: ann.call.id, kind: "fade" }, "bob")).toThrow("so you can't fade this call now");
    // A challenge carries no call, so it is still allowed inside the window.
    expect(calls.respond({ targetCallId: ann.call.id, kind: "challenge" }, "bob").invitation).not.toBeNull();
    expect(calls.openMarkets()).toEqual([]);
  });

  test("zero disables the window; the market's own close still ends calls", () => {
    const m = market("m", { closesAt: T0 + 5 * MIN });
    const h = harness({ people: [person("ann")], markets: [m] });
    const calls = service(h, 0);
    expect(calls.createCall({ marketId: "m", side: "NO" }, "ann").call.side).toBe("NO");
    expect(calls.marketDetail({ marketId: "m" }, null).callsCloseAt).toBe(T0 + 5 * MIN);
  });
});

describe("funded-call marker", () => {
  test("appears only for a confirmed fill, carries no money, and never rewrites the free call", async () => {
    const h = harness({ people: [person("ann"), person("bob")], markets: [market("m", { closesAt: T0 + 5 * 60 * MIN })] });
    let rows: { call_id: string; updated_at: string }[] = [];
    const funding = new PantaFundingIndex({ filledSince: async () => rows });
    const calls = service(h, 30, funding);
    const funded = calls.createCall({ marketId: "m", side: "YES" }, "ann");
    const free = calls.createCall({ marketId: "m", side: "NO" }, "bob");
    expect(Object.keys(calls.getCall({ callId: funded.call.id }, null).entry)).not.toContain("funding");
    rows = [{ call_id: funded.call.id, updated_at: new Date(T0 + 1000).toISOString() }];
    expect(await funding.refresh()).toBe(1);
    expect(await funding.refresh()).toBe(0);
    const entry = calls.getCall({ callId: funded.call.id }, null).entry;
    expect(entry.funding).toEqual({ state: "FILLED", venue: "panta", fundedAt: T0 + 1000 });
    expect(entry.call.fundingState).toBe("NONE");
    expect(JSON.stringify(entry.funding)).not.toMatch(/amount|wallet|order|signature|baseUnits/i);
    const feed = calls.feed({ mode: "global" }, null).entries;
    expect(feed.find(e => e.call.id === funded.call.id)?.funding?.state).toBe("FILLED");
    expect(feed.find(e => e.call.id === free.call.id)?.funding).toBeUndefined();
    // The call's own free/funded provenance is unchanged, so free-call
    // accuracy keeps counting it.
    expect(calls.getPerson({ personRef: "ann" }, null).calls[0]!.call.fundingState).toBe("NONE");
  });

  test("markFilled from this process shows at once; an empty index answers no funding", () => {
    const index = new PantaFundingIndex(null);
    expect(index.fundingOf("c1")).toBeNull();
    index.markFilled("c1", 5);
    index.markFilled("c1", 9);
    expect(index.fundingOf("c1")).toEqual({ state: "FILLED", venue: "panta", fundedAt: 5 });
  });
});
