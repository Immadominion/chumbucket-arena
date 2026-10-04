/**
 * Security QA #1: a discarded or expired money call can't be resurrected
 * through the direct pantaTrading.prepare route. The trade path reads the
 * call's money state and trades a money call only while it is PENDING (the
 * SQL guard on panta_trade_sessions refuses it too: moneyLedgers.postgres).
 */
import { expect, test } from "bun:test";
import { MONEY_CALL_ROUTE_COPY, PantaTradingService } from "../src/prediction/PantaTradingService.ts";
import { SupabasePantaTradingStore, type PantaCallIntent, type PantaTradingStore } from "../src/prediction/PantaTradingStore.ts";

const user = "10000000-0000-4000-8000-000000000001";
const callId = "30000000-0000-4000-8000-000000000001";
const wallet = "AnnWa11et1111111111111111111111111111111111";

function service(intent: Partial<PantaCallIntent>, now = 1_760_000_000_000) {
  const reserved: unknown[] = [];
  const venueReads: string[] = [];
  const store = {
    callIntent: async () => ({ callId, marketId: "20000000-0000-4000-8000-000000000001", venueMarketId: "vm", side: "YES", ...intent }),
    find: async () => null, byOrder: async () => null, activeForCall: async () => null,
    reserve: async (row: unknown) => { reserved.push(row); return null; }, update: async () => null,
  } as unknown as PantaTradingStore;
  const trading = new PantaTradingService({
    store, execution: {} as never, chain: { broadcast: async () => {} }, maxAmountBaseUnits: "100000000", now: () => now,
    venue: { getMarket: async (id: string) => { venueReads.push(id); throw new Error("stop here"); } } as never,
    wallets: { status: async () => "active" },
  });
  const prepare = (key = "tap-key-0000000001-abcdef.t1", opts: { moneyCall?: boolean } = {}) =>
    trading.prepare(user, { callId, wallet, amountBaseUnits: "5000000", idempotencyKey: key, maxSlippageBps: 100 }, {}, opts);
  return { prepare, reserved, venueReads };
}
const pending = { moneyState: "PENDING" as const, moneyTradeKey: "tap-key-0000000001-abcdef.t1", moneyExpiresAt: 1_760_000_120_000 };

test("the pantaTrading route never funds a money call, pending or not: only money.* does", async () => {
  for (const intent of [pending, { ...pending, moneyState: "EXPIRED" as const }, { ...pending, moneyState: "FREE" as const }, { ...pending, moneyState: "FUNDED" as const }]) {
    const s = service(intent);
    await expect(s.prepare()).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST", message: MONEY_CALL_ROUTE_COPY });
    expect(s.reserved).toEqual([]);
    expect(s.venueReads).toEqual([]);
  }
});

test("money.* quotes a money call only while pending, with its current key, inside its window", async () => {
  const closed = "This call's money window has closed. Make a new call.";
  for (const [intent, key, now, message] of [
    [{ ...pending, moneyState: "EXPIRED" as const }, pending.moneyTradeKey, undefined, closed],
    [pending, "tap-key-0000000001-abcdef.t0", undefined, "This isn't this call's current quote. Check the call again."],
    [pending, pending.moneyTradeKey, pending.moneyExpiresAt, closed],
  ] as const) {
    const s = service(intent, now);
    await expect(s.prepare(key, { moneyCall: true })).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST", message });
    expect(s.reserved).toEqual([]);
  }
  const ok = service(pending);
  await expect(ok.prepare(pending.moneyTradeKey, { moneyCall: true })).rejects.toThrow("stop here");
  expect(ok.venueReads).toEqual(["vm"]);
});

test("a call made without an amount goes on as before", async () => {
  for (const intent of [{ moneyState: null }, {}]) {
    const s = service(intent);
    await expect(s.prepare()).rejects.toThrow("stop here");
    expect(s.venueReads).toEqual(["vm"]);
  }
});

test("the durable trade ledger reads the call's money state (fails closed), only when money calls exist", async () => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    asked.push(u.pathname.split("/").pop()!);
    const table = u.pathname.split("/").pop();
    const rows = table === "calls" ? [{ id: callId, market_id: "m1", side: "YES" }]
      : table === "venue_markets" ? [{ venue_market_id: "vm", payload_version: 1 }]
      : table === "money_calls" ? [{ state: "EXPIRED", idempotency_key: "tap-key-0000000001-abcdef", attempts: 2, expires_at: "2026-10-04T10:02:00.000Z" }] : [];
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
  const config = { supabaseUrl: "https://synthetic.invalid", serviceRoleKey: "synthetic-only" };
  expect(await new SupabasePantaTradingStore(config, fetchImpl, { moneyCalls: true }).callIntent(user, callId)).toMatchObject({
    moneyState: "EXPIRED", moneyTradeKey: "tap-key-0000000001-abcdef.t2", moneyExpiresAt: Date.parse("2026-10-04T10:02:00.000Z") });
  expect(asked).toEqual(["calls", "venue_markets", "money_calls"]);
  asked.length = 0;
  expect((await new SupabasePantaTradingStore(config, fetchImpl).callIntent(user, callId))?.moneyState).toBeNull();
  expect(asked).toEqual(["calls", "venue_markets"]);
  const down = (async (url: string) => new URL(url).pathname.endsWith("money_calls")
    ? new Response("{}", { status: 500 }) : fetchImpl(url)) as unknown as typeof fetch;
  await expect(new SupabasePantaTradingStore(config, down, { moneyCalls: true }).callIntent(user, callId)).rejects.toThrow();
});
