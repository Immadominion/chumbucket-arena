import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CallResultWorker, PENDING_MARKET_CURSOR } from "../src/calls/CallResultWorker.ts";
import { durableWriterNeedsRestart } from "../src/calls/durableFailure.ts";
import { CallsService } from "../src/calls/CallsService.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { CallReceiptsProjection } from "../src/calls/receipts.ts";
import { ResolutionSync } from "../src/calls/ResolutionSync.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { SupabaseCallsStore } from "../src/calls/supabaseStore.ts";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { MarketSync } from "../src/prediction/marketSync.ts";
import { WriteQueue, type WriteFailure } from "../src/prediction/pgrest.ts";
import { sharePriceFromIndicative } from "../src/prediction/sharePrices.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import { SupabasePredictionStore } from "../src/prediction/supabaseStore.ts";
import { marketUuid } from "../src/prediction/types.ts";
import { TestClock, jsonResponse, stubFetch } from "./predictionFixtures.ts";
import { person, T0 } from "./socialCallsFixtures.ts";
import { PgrestFake, seedUser, UUIDS } from "./pgrestFake.ts";

const addresses = [
  "11111111111111111111111111111111",
  "11111111111111111111111111111112",
] as const;
const key = "pk_live_synthetic_result_worker_test";

function row(address: string, finished: boolean, finalEvidence: boolean) {
  const at = Math.floor(T0 / 1000);
  return {
    marketId: address, category: "crypto", title: "Synthetic crypto question?",
    description: "Synthetic test rule", phase: finished ? "resolved" : "primary",
    status: finished ? "resolved" : "primary", resolved: finished,
    startTime: at - 60, endTime: at + 10, resolutionTime: at + 20,
    yesPrice: "1.25", noPrice: "0.35",
    onChain: {
      resolutionRule: "Synthetic test rule", isActive: !finished,
      ...(finalEvidence ? {
        isResolved: true, isCancelled: false, yesWins: true,
        pendingReview: "none", resolvedAt: at + 20,
        claimableAt: at + 20, reviewExpiresAt: at + 20,
      } : {}),
    },
  };
}

async function rig(count = 1, maxCalledMarketsPerPass = 8) {
  const clock = new TestClock();
  const settled = new Map<string, { finished: boolean; finalEvidence: boolean }>();
  const unavailable = new Set<string>();
  const malformed = new Set<string>();
  const catalog = { malformed: false };
  const http = stubFetch(url => {
    if (url.pathname.endsWith("/markets/")) return jsonResponse(catalog.malformed ? { invalid: true } : { items: [], nextCursor: null });
    const address = url.pathname.split("/").filter(Boolean).at(-1)!;
    if (unavailable.has(address)) return new Response("synthetic refusal", { status: 503 });
    const state = settled.get(address) ?? { finished: false, finalEvidence: false };
    return jsonResponse(malformed.has(address)
      ? { ...row(address, state.finished, state.finalEvidence), phase: "unknown" }
      : row(address, state.finished, state.finalEvidence));
  });
  const venue = new PantaVenue({ apiKey: key, clock, fetchImpl: http.fetch, retry: { attempts: 1 } });
  const prices = new InMemoryPredictionStore();
  const calls = new InMemoryCallsStore();
  calls.upsertPerson(person("alice"));
  const markets = predictionStoreReader(prices);
  const receipts = new CallReceiptsProjection();
  const service = new CallsService({ store: calls, markets, clock, receipts, allowPantaCalls: true });
  const entries: string[] = [];
  for (const address of addresses.slice(0, count)) {
    const market = await venue.getMarket(address);
    prices.upsertMarket(market, venue.rawPayload(address)!);
    const price = sharePriceFromIndicative(await venue.getIndicativePrices(address));
    prices.appendSharePrice(price, venue.rawPayload(address)!);
    entries.push(service.createCall({ marketId: marketUuid("panta", address), side: "YES" }, "alice").call.id);
  }
  const marketSync = new MarketSync({ venue, store: prices, clock, maxPagesPerPass: 1, snapshotBudget: 0 });
  const sync = new ResolutionSync({ store: calls, markets, clock, receipts });
  const worker = new CallResultWorker({
    calls: { store: calls, markets, sync, durable: null },
    prediction: { marketSync, durable: null },
    clock, maxCalledMarketsPerPass,
  });
  return { clock, settled, unavailable, malformed, catalog, http, prices, calls, receipts, worker, marketSync, entries };
}

test("a called market omitted by catalog gets venue evidence; status alone remains PENDING", async () => {
  const h = await rig();
  const address = addresses[0];
  h.clock.advance(16_000); // after close, before any published result
  const pending = await h.worker.runOnce();
  expect(pending.calledMarketsRefreshed).toBe(1);
  expect(pending.results.resultsSettled).toBe(0);
  expect(h.calls.getResult(h.entries[0]!)?.outcome).toBe("PENDING");
  expect(h.prices.getResolution(marketUuid("panta", address))).toBeUndefined();

  h.settled.set(address, { finished: true, finalEvidence: false });
  h.clock.advance(16_000); // cache expires; status now says resolved, evidence does not
  const premature = await h.worker.runOnce();
  expect(premature.results.resultsSettled).toBe(0);
  expect(h.calls.getResult(h.entries[0]!)?.outcome).toBe("PENDING");

  h.settled.set(address, { finished: true, finalEvidence: true });
  h.clock.advance(16_000);
  const final = await h.worker.runOnce();
  expect(final.calledResolutionsRecorded).toBe(1);
  expect(final.results.resultsSettled).toBe(1);
  expect(h.calls.getResult(h.entries[0]!)).toMatchObject({ outcome: "CORRECT", resolution: "YES" });
  expect(h.receipts.receiptForCall(h.entries[0]!)?.outcome).toBe("CORRECT");
  const evidence = h.prices.getResolution(marketUuid("panta", address));
  expect(evidence?.rawEvidence).toMatchObject({ onChain: { yesWins: true, pendingReview: "none" } });

  const again = await h.worker.runOnce();
  expect(again.calledMarketsRefreshed).toBe(0);
  expect(again.results.resultsSettled).toBe(0);
  expect(h.prices.getResolution(marketUuid("panta", address))).toEqual(evidence);
});

test("bounded outstanding-market refresh rotates its durable cursor without starving later calls", async () => {
  const h = await rig(2, 1);
  h.clock.advance(40_000);
  for (const address of addresses) h.settled.set(address, { finished: true, finalEvidence: true });
  const first = await h.worker.runOnce();
  expect(first.calledMarketsRefreshed).toBe(1);
  expect(first.results.resultsSettled).toBe(1);
  expect(h.calls.getCursor(PENDING_MARKET_CURSOR)).toBe(addresses[0]);
  const second = await h.worker.runOnce();
  expect(second.calledMarketsRefreshed).toBe(1);
  expect(second.results.resultsSettled).toBe(1);
  expect(h.calls.getCursor(PENDING_MARKET_CURSOR)).toBe(addresses[1]);
  expect(h.entries.map(id => h.calls.getResult(id)?.outcome)).toEqual(["CORRECT", "CORRECT"]);
});

test("overlapping ticks share one pass and never create parallel catalog or result writes", async () => {
  const h = await rig();
  const original = h.worker.runOnce.bind(h.worker);
  const first = original();
  const second = original();
  expect(first).toBe(second);
  await Promise.all([first, second]);
  expect(h.http.calls.filter(c => new URL(c.url).pathname.endsWith("/markets/"))).toHaveLength(1);
});

test("transient detail refusal leaves the call pending and retries without a false result", async () => {
  const h = await rig();
  h.clock.advance(16_000);
  h.unavailable.add(addresses[0]);
  const pending = await h.worker.runOnce();
  expect(pending.calledMarketsUnavailable).toBe(1);
  expect(h.calls.getResult(h.entries[0]!)?.outcome).toBe("PENDING");
  expect(h.prices.getResolution(marketUuid("panta", addresses[0]))).toBeUndefined();

  h.unavailable.delete(addresses[0]);
  h.settled.set(addresses[0], { finished: true, finalEvidence: true });
  h.clock.advance(25_000);
  expect((await h.worker.runOnce()).results.resultsSettled).toBe(1);
});

test("detail schema drift fails loudly without cursor advancement or a guessed result", async () => {
  const h = await rig();
  h.clock.advance(16_000);
  h.malformed.add(addresses[0]);
  await expect(h.worker.runOnce()).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
  expect(h.calls.getCursor(PENDING_MARKET_CURSOR)).toBeNull();
  expect(h.calls.getResult(h.entries[0]!)?.outcome).toBe("PENDING");

  h.malformed.delete(addresses[0]);
  h.settled.set(addresses[0], { finished: true, finalEvidence: true });
  h.clock.advance(25_000);
  expect((await h.worker.runOnce()).results.resultsSettled).toBe(1);
});

test("valid recorded evidence still settles a call when a later catalog pass changes schema", async () => {
  const h = await rig();
  h.clock.advance(40_000);
  h.settled.set(addresses[0], { finished: true, finalEvidence: true });
  expect((await h.marketSync.refreshCalledMarket(addresses[0])).resolutionRecorded).toBe(true);
  expect(h.calls.getResult(h.entries[0]!)?.outcome).toBe("PENDING");
  h.catalog.malformed = true;
  await expect(h.worker.runOnce()).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
  expect(h.calls.getResult(h.entries[0]!)?.outcome).toBe("CORRECT");
});

test("a broken catalog cannot starve an outstanding call with independently published venue evidence", async () => {
  const h = await rig();
  h.clock.advance(40_000);
  h.settled.set(addresses[0], { finished: true, finalEvidence: true });
  h.catalog.malformed = true;
  await expect(h.worker.runOnce()).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
  expect(h.prices.getResolution(marketUuid("panta", addresses[0]))?.resolution).toBe("YES");
  expect(h.calls.getResult(h.entries[0]!)?.outcome).toBe("CORRECT");
  expect(h.receipts.receiptForCall(h.entries[0]!)?.outcome).toBe("CORRECT");
});

test("the production entrypoint mounts and schedules the single-flight worker", () => {
  const entry = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  expect(entry).toContain("new CallResultWorker({ calls, prediction: calls.prediction })");
  expect(entry).toContain("await resultWorker.runOnce()");
  expect(entry).toContain("setInterval(marketSyncTick, marketSyncTickMs)");
  expect(entry).toContain("durableWriterNeedsRestart(queue)");
  expect(entry).toContain("process.exit(1)");
});

test("a poisoned durable queue drains then requires restart, never clears its failure", async () => {
  const failures: WriteFailure[] = [{ label: "synthetic cursor write", at: T0,
    message: "synthetic socket error", refused: false, sqlState: undefined }];
  let drains = 0;
  const queue = { failures, drain: async () => { drains++; } };
  expect(await durableWriterNeedsRestart(queue)).toBe(true);
  expect(drains).toBe(1);
  expect(failures).toHaveLength(1);
  failures.pop();
  expect(await durableWriterNeedsRestart(queue)).toBe(false);
  expect(drains).toBe(1);
  failures.push({ label: "synthetic stuck writer", at: T0,
    message: "synthetic error", refused: false, sqlState: undefined });
  expect(await durableWriterNeedsRestart({ failures,
    drain: async () => { throw new Error("synthetic non-draining queue"); },
  })).toBe(true);
});

test("the worker flushes Panta evidence and settled call before restart rehydration", async () => {
  const clock = new TestClock();
  const fake = new PgrestFake({ now: () => clock.now() });
  seedUser(fake, UUIDS.alice);
  const queue = new WriteQueue({ clock });
  const prices = new SupabasePredictionStore({ config: fake.config, fetchImpl: fake.fetchImpl, clock, queue });
  const calls = new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl, clock, queue });
  await prices.hydrate();
  await calls.hydrate();
  let finished = false;
  const address = addresses[0];
  const http = stubFetch(url => url.pathname.endsWith("/markets/")
    ? jsonResponse({ items: [], nextCursor: null })
    : jsonResponse(row(address, finished, finished)));
  const venue = new PantaVenue({ apiKey: key, clock, fetchImpl: http.fetch, retry: { attempts: 1 } });
  const market = await venue.getMarket(address);
  prices.upsertMarket(market, venue.rawPayload(address)!);
  prices.appendSharePrice(sharePriceFromIndicative(await venue.getIndicativePrices(address)), venue.rawPayload(address)!);
  await prices.flush();
  const markets = predictionStoreReader(prices);
  const service = new CallsService({ store: calls, markets, clock, allowPantaCalls: true, newId: () => randomUUID() });
  const call = service.createCall({ marketId: market.id, side: "NO" }, UUIDS.alice).call;
  await calls.flush();

  clock.advance(40_000);
  finished = true;
  const worker = new CallResultWorker({
    calls: { store: calls, markets, sync: new ResolutionSync({ store: calls, markets, clock }), durable: calls },
    prediction: { marketSync: new MarketSync({ venue, store: prices, clock, snapshotBudget: 0 }), durable: prices },
    clock,
  });
  const report = await worker.runOnce();
  expect(report.calledResolutionsRecorded).toBe(1);
  expect(report.results.resultsSettled).toBe(1);
  expect(fake.rows("market_resolutions")).toHaveLength(1);
  expect(fake.rows("call_results").find(r => r.call_id === call.id)?.outcome).toBe("INCORRECT");

  const restoredPrices = new SupabasePredictionStore({ config: fake.config, fetchImpl: fake.fetchImpl, clock });
  const restoredCalls = new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl, clock });
  await restoredPrices.hydrate();
  await restoredCalls.hydrate();
  expect(restoredPrices.getResolution(market.id)?.resolution).toBe("YES");
  expect(restoredCalls.getResult(call.id)?.outcome).toBe("INCORRECT");
  expect(restoredCalls.getCursor(PENDING_MARKET_CURSOR)).toBe(address);
});
