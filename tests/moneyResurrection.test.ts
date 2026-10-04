/**
 * Security QA #1: a discarded or expired money call can't be resurrected
 * through the direct pantaTrading.prepare route. The trade path reads the
 * call's money state and trades a money call only while it is PENDING (the
 * SQL guard on panta_trade_sessions refuses it too: moneyLedgers.postgres).
 */
import { expect, test } from "bun:test";
import { PantaTradingService } from "../src/prediction/PantaTradingService.ts";
import { SupabasePantaTradingStore, type PantaCallIntent, type PantaTradingStore } from "../src/prediction/PantaTradingStore.ts";

const user = "10000000-0000-4000-8000-000000000001";
const callId = "30000000-0000-4000-8000-000000000001";
const wallet = "AnnWa11et1111111111111111111111111111111111";

function service(moneyState: PantaCallIntent["moneyState"]) {
  const reserved: unknown[] = [];
  const venueReads: string[] = [];
  const store = {
    callIntent: async () => ({ callId, marketId: "20000000-0000-4000-8000-000000000001", venueMarketId: "vm", side: "YES", moneyState }),
    find: async () => null, byOrder: async () => null, activeForCall: async () => null,
    reserve: async (row: unknown) => { reserved.push(row); return null; }, update: async () => null,
  } as unknown as PantaTradingStore;
  const trading = new PantaTradingService({
    store, execution: {} as never, chain: { broadcast: async () => {} }, maxAmountBaseUnits: "100000000",
    venue: { getMarket: async (id: string) => { venueReads.push(id); throw new Error("stop here"); } } as never,
    wallets: { status: async () => "active" },
  });
  const prepare = () => trading.prepare(user, { callId, wallet, amountBaseUnits: "5000000", idempotencyKey: "direct-route-key-01", maxSlippageBps: 100 });
  return { prepare, reserved, venueReads };
}

test("an ended money call (EXPIRED, discarded, FREE, FUNDED) is refused before any read or reservation", async () => {
  for (const state of ["EXPIRED", "FREE", "FUNDED"] as const) {
    const s = service(state);
    await expect(s.prepare()).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST", message: "This call's money window has closed. Make a new call." });
    expect(s.reserved).toEqual([]);
    expect(s.venueReads).toEqual([]);
  }
});

test("a PENDING money call, and a call made without an amount, go on to the market read as before", async () => {
  for (const state of ["PENDING", null, undefined] as const) {
    const s = service(state);
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
      : table === "money_calls" ? [{ state: "EXPIRED" }] : [];
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
  const config = { supabaseUrl: "https://synthetic.invalid", serviceRoleKey: "synthetic-only" };
  expect((await new SupabasePantaTradingStore(config, fetchImpl, { moneyCalls: true }).callIntent(user, callId))?.moneyState).toBe("EXPIRED");
  expect(asked).toEqual(["calls", "venue_markets", "money_calls"]);
  asked.length = 0;
  expect((await new SupabasePantaTradingStore(config, fetchImpl).callIntent(user, callId))?.moneyState).toBeNull();
  expect(asked).toEqual(["calls", "venue_markets"]);
  const down = (async (url: string) => new URL(url).pathname.endsWith("money_calls")
    ? new Response("{}", { status: 500 }) : fetchImpl(url)) as unknown as typeof fetch;
  await expect(new SupabasePantaTradingStore(config, down, { moneyCalls: true }).callIntent(user, callId)).rejects.toThrow();
});
