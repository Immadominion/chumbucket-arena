import { expect, test } from "bun:test";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { TestClock, jsonResponse, stubFetch, hangingFetch } from "./predictionFixtures.ts";
import { CircuitBreaker } from "../src/prediction/circuit.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import { MarketSync } from "../src/prediction/marketSync.ts";
import { loadConfig } from "../src/config.ts";
import { resolvePredictionConfig, describePredictionConfig } from "../src/prediction/config.ts";
import { buildPredictionRuntime, setPredictionRuntime } from "../src/prediction/runtime.ts";
import { predictionsRouter } from "../src/api/predictions.ts";
import { createApp } from "../src/app.ts";
import { marketUuid } from "../src/prediction/types.ts";
import { asWallet } from "../src/domain/ids.ts";
import { harness, market, person } from "./socialCallsFixtures.ts";
import { CallsService } from "../src/calls/CallsService.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { SHARE_PRICE_MAX_AGE_MS, usableSharePrice } from "../src/prediction/sharePrices.ts";

// Synthetic rows with the documented/observed field names, NOT live evidence.
const id = "11111111111111111111111111111111";
const row = (over: Record<string, unknown> = {}) => ({
  marketId: id, category: "crypto", title: "Synthetic crypto question?",
  description: "Synthetic fixture rules, not a real market.", phase: "primary",
  status: "primary", resolved: false, startTime: 1_750_000_000,
  endTime: 1_780_000_000, resolutionTime: 1_780_003_600,
  yesPrice: "0.52", noPrice: "0.48", primaryYesPrice: "0.52",
  primaryNoPrice: "0.48", secondaryYesPrice: null, secondaryNoPrice: null,
  onChain: { resolutionRule: "Exact synthetic settlement rule.", isActive: true },
  ...over,
});
const key = "pk_live_synthetic_tests_only";
const rig = (body: unknown = row()) => {
  const clock = new TestClock();
  const http = stubFetch(() => jsonResponse(body));
  return { venue: new PantaVenue({ apiKey: key, fetchImpl: http.fetch, clock }), http, clock };
};

test("Panta keeps independent share prices and never invents a probability snapshot", async () => {
  const { venue } = rig(row({ phase: "secondary", status: "secondary", yesPrice: "1.25", noPrice: "0.35" }));
  expect(await venue.getIndicativePrices(id)).toMatchObject({
    venue: "panta", currency: "USDC", unit: "per_share", yesPrice: "1.25", noPrice: "0.35", executable: false,
  });
  const book = await venue.getOrderbook(id);
  expect(book.snapshot).toBeNull();
  expect(book.bids).toEqual([]); expect(book.asks).toEqual([]);
});

test("market identity, seconds, exact chain rules and provider attribution survive normalization", async () => {
  const { venue } = rig(); const m = await venue.getMarket(id);
  expect(m.id).toBe(marketUuid('panta', id));
  expect(m.id).not.toBe(marketUuid('polymarket', id));
  expect(m.venueMarketId).toBe(id); expect(m.venue).toBe('panta');
  expect(m.closesAt).toBe(1_780_000_000_000);
  expect(m.opensAt).toBeNull(); // native startTime is the event start, not trading availability
  expect(m.rulesText).toBe('Exact synthetic settlement rule.');
  expect(m.resolutionSource).toBe(`https://live-api.panta.market/api/v1/markets/${id}/`);
  expect(m.status).toBe('OPEN'); expect(venue.rawPayload(id)?.body).toEqual(row());
});

test("catalog cursor/category/limit are encoded; only complete detail rows become events", async () => {
  const clock = new TestClock();
  const missingTitle = row({ title: '' });
  const http = stubFetch(url => url.pathname.endsWith('/markets/')
    ? jsonResponse({ items: [missingTitle, row()], nextCursor: id }) : jsonResponse(row()));
  const venue = new PantaVenue({ apiKey: key, fetchImpl: http.fetch, clock });
  const page = await venue.listEvents({ category: 'crypto', status: ['OPEN'], limit: 100 }, id);
  expect(page.events).toHaveLength(1); expect(page.nextCursor).toBe(id);
  expect(http.calls).toHaveLength(2);
  const url = new URL(http.calls[0]!.url);
  expect(url.searchParams.get('limit')).toBe('50'); expect(url.searchParams.get('cursor')).toBe(id);
  expect(url.searchParams.get('category')).toBe('crypto'); expect(url.searchParams.has('status')).toBe(false);
  expect(clock.slept).toContain(600);
  expect(JSON.stringify(page)).not.toContain(key);
});

test("missing question/rules is unavailable, never replaced with invented metadata", async () => {
  for (const bad of [row({ title: ' ' }), row({ onChain: null }), row({ onChain: { resolutionRule: '' } })]) {
    const { venue } = rig(bad);
    await expect(venue.getMarket(id)).rejects.toMatchObject({ code: 'VENUE_NOT_FOUND' });
  }
});

test("empty filtered pages retain the upstream cursor rather than stopping a sync", async () => {
  const { venue, http } = rig({ items: [row({ title: '', endTime: 1_750_000_001 })], nextCursor: id });
  expect(await venue.listEvents({})).toMatchObject({ events: [], nextCursor: id });
  expect(http.calls).toHaveLength(1);
});

test("blank live list titles are hydrated from detail, not silently removed from discovery", async () => {
  const clock = new TestClock();
  const http = stubFetch(url => url.pathname.endsWith('/markets/')
    ? jsonResponse({items:[row({title:''})],nextCursor:null}) : jsonResponse(row()));
  const venue = new PantaVenue({apiKey:key,clock,fetchImpl:http.fetch});
  const page = await venue.listEvents({status:['OPEN'],query:'synthetic'});
  expect(page.events).toHaveLength(1);
  expect(page.events[0]!.title).toBe('Synthetic crypto question?');
  expect(http.calls).toHaveLength(2);
});

for (const [label, patch] of [
  ['unknown phase', { phase: 'surprise' }], ['unknown status', { status: 'settled-ish' }],
  ['sandbox ISO time', { startTime: '2026-01-01T00:00:00Z' }],
  ['milliseconds instead of seconds', { endTime: 1_780_000_000_000 }],
  ['numeric price', { yesPrice: 0.52 }], ['negative price', { noPrice: '-0.4' }],
  ['NaN price', { noPrice: 'NaN' }], ['exponent price', { noPrice: '1e3' }],
  ['bad chain boolean', { onChain: { isResolved: 'true' } }],
] as const) test(`schema drift fails closed: ${label}`, async () => {
  const { venue, http } = rig(row(patch));
  await expect(venue.getMarket(id)).rejects.toMatchObject({ code: 'VENUE_SCHEMA' });
  expect(http.calls).toHaveLength(1); expect(venue.rawPayload(id)).toBeUndefined();
});

test("null and precise non-complementary prices are preserved without fallback", async () => {
  const { venue } = rig(row({ yesPrice: null, noPrice: '123456789.123456789123456789' }));
  expect(await venue.getIndicativePrices(id)).toMatchObject({ yesPrice: null, noPrice: '123456789.123456789123456789' });
});

test("detail/price reads coalesce and expire without refreshing observedAt on cache hits", async () => {
  const { venue, http, clock } = rig();
  const [a, b] = await Promise.all([venue.getIndicativePrices(id), venue.getIndicativePrices(id)]);
  expect(a).toEqual(b); expect(http.calls).toHaveLength(1);
  clock.advance(10_000); expect((await venue.getIndicativePrices(id)).observedAt).toBe(a.observedAt);
  clock.advance(6000); expect((await venue.getIndicativePrices(id)).observedAt).toBeGreaterThan(a.observedAt);
  expect(http.calls).toHaveLength(2);
});

const finalRow = (over: Record<string, unknown> = {}) => row({ phase: 'resolved', status: 'resolved', resolved: true,
  onChain: { resolutionRule: 'Exact final fixture rules.', isResolved: true, isCancelled: false,
    yesWins: true, pendingReview: 'none', resolvedAt: 1_750_000_000,
    claimableAt: 1_750_000_000, reviewExpiresAt: 1_750_000_001, ...over } });

for (const yesWins of [true, false]) test(`final chain evidence derives ${yesWins ? 'YES' : 'NO'} without using price`, async () => {
  const { venue } = rig({ ...finalRow({ yesWins }), yesPrice: '0.5', noPrice: '0.5' });
  expect((await venue.getMarket(id)).status).toBe('RESOLVED');
  expect(venue.publishedResolution(id)).toEqual({ resolution: yesWins ? 'YES' : 'NO', resolvedAt: 1_750_000_000_000 });
});

for (const patch of [
  { pendingReview: 'disputed' }, { pendingReview: undefined },
  { reviewExpiresAt: 1_780_000_000 }, { reviewExpiresAt: undefined },
  { claimableAt: 1_780_000_000 }, { claimableAt: undefined },
  { resolvedAt: 1_780_000_000 }, { yesWins: undefined }, { isResolved: false }, { isCancelled: true },
]) test(`incomplete/review-pending evidence stays pending: ${Object.keys(patch)[0]}=${String(Object.values(patch)[0])}`, async () => {
  const { venue } = rig(finalRow(patch));
  expect((await venue.getMarket(id)).status).toBe('CLOSED_PENDING_RESOLUTION');
  expect(venue.publishedResolution(id)).toBeNull();
});

test("status and boundary prices alone never settle a call", async () => {
  const { venue } = rig(row({ phase: 'resolved', status: 'resolved', resolved: true, yesPrice: '1', noPrice: '0' }));
  expect((await venue.getMarket(id)).status).toBe('CLOSED_PENDING_RESOLUTION');
  expect(venue.publishedResolution(id)).toBeNull();
});

test("resolution evidence cannot be borrowed from another venue, market or payload version", async () => {
  const { venue } = rig(finalRow()); await venue.getMarket(id);
  const raw = venue.rawPayload(id)!;
  expect(venue.publishedResolution(id, { ...raw, venue: 'polymarket' })).toBeNull();
  expect(venue.publishedResolution(id, { ...raw, venueMarketId: 'different' })).toBeNull();
  expect(venue.publishedResolution(id, { ...raw, payloadVersion: 99 })).toBeNull();
  expect(() => venue.publishedResolution(id, { ...raw, body: { ...finalRow(), marketId: 'So11111111111111111111111111111111111111112' } }))
    .toThrow('resolution market mismatch');
});

test("closed, inactive and undated markets cannot be marked open", async () => {
  expect((await rig(row({ endTime: 1_750_000_001 })).venue.getMarket(id)).status).toBe('CLOSED_PENDING_RESOLUTION');
  expect((await rig(row({ endTime: null })).venue.getMarket(id)).status).toBe('PAUSED');
  expect((await rig(row({ onChain: { resolutionRule: 'Fixture', isActive: false } })).venue.getMarket(id)).status).toBe('PAUSED');
});

test("cancelled phase alone is not evidence; final chain cancellation is VOID", async () => {
  const { venue } = rig(row({ phase: 'cancelled', status: 'cancelled', onChain: {
    resolutionRule: 'Fixture cancellation.', isCancelled: true, cancelledAt: 1_750_000_000,
    reviewExpiresAt: 1_750_000_001, pendingReview: 'none' } }));
  expect((await venue.getMarket(id)).status).toBe('CANCELLED');
  expect(venue.publishedResolution(id)?.resolution).toBe('VOID');
  const unproven = rig(row({ phase: 'cancelled', status: 'cancelled' })).venue;
  await unproven.getMarket(id); expect(unproven.publishedResolution(id)).toBeNull();
});

test("unsupported keys and path injection are rejected before any request", async () => {
  for (const apiKey of ['', 'pk_test_synthetic_only', 'not-a-key']) {
    expect(() => new PantaVenue({ apiKey })).toThrow('LIVE API key');
  }
  const { venue, http } = rig();
  await expect(venue.getMarket('../account/keys')).rejects.toMatchObject({ code: 'VENUE_BAD_REQUEST' });
  await expect(venue.listEvents({}, 'cursor&key=bad')).rejects.toMatchObject({ code: 'VENUE_BAD_REQUEST' });
  expect(http.calls).toHaveLength(0);
});

test("key is header-only, origin is pinned and credential redirects are forbidden", async () => {
  let calls = 0;
  const venue = new PantaVenue({ apiKey: key, fetchImpl: async (url, init) => {
    calls++; expect(new URL(url).origin).toBe('https://live-api.panta.market');
    expect(url).not.toContain(key); expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error'); expect(init?.headers).toEqual({ 'X-Api-Key': key });
    return jsonResponse(row());
  } });
  await venue.getMarket(id); expect(calls).toBe(1);
});

test("sandbox response cannot pass for live even when supplied with a live-prefixed key", async () => {
  const { venue } = rig({ items: [row()], disclaimer: 'Test mode: sandbox fixtures, not mainnet.' });
  await expect(venue.listEvents({})).rejects.toMatchObject({ code: 'VENUE_SCHEMA' });
});

test("response and transport errors cannot leak credentials or upstream bodies", async () => {
  for (const mode of ['http', 'transport', 'echo']) {
    const venue = new PantaVenue({ apiKey: key, retry: { attempts: 1 }, fetchImpl: async () => {
      if (mode === 'transport') throw new Error(`request included ${key}`);
      if (mode === 'http') return new Response(`private response ${key}`, { status: 500 });
      return jsonResponse({ ...row(), echoedKey: key });
    } });
    try { await venue.getMarket(id); throw new Error('expected refusal'); }
    catch (e) { expect(String(e)).not.toContain(key); expect(JSON.stringify(e)).not.toContain(key);
      expect((e as Error & { cause?: unknown }).cause).toBeUndefined(); }
  }
});

test("rate limits respect Retry-After, schema errors are not retried, timeout aborts", async () => {
  const clock = new TestClock(); let attempt = 0;
  const venue = new PantaVenue({ apiKey: key, clock, fetchImpl: async () => ++attempt === 1
    ? new Response('private error', { status: 429, headers: { 'Retry-After': '2' } }) : jsonResponse(row()) });
  await venue.getMarket(id); expect(attempt).toBe(2); expect(clock.slept).toContain(2000);
  const timeout = new PantaVenue({ apiKey: key, timeoutMs: 5, retry: { attempts: 1 }, fetchImpl: hangingFetch().fetch });
  await expect(timeout.getMarket(id)).rejects.toMatchObject({ code: 'VENUE_TIMEOUT' });
});

test("circuit recovers through a half-open catalog read without nested probes", async () => {
  const clock = new TestClock(); let healthy = false; let calls = 0;
  const circuit = new CircuitBreaker({ clock, venue: 'panta', failureThreshold: 1, resetAfterMs: 1000 });
  const venue = new PantaVenue({ apiKey: key, clock, circuit, retry: { attempts: 1 }, fetchImpl: async url => {
    calls++; if (!healthy) return new Response('', { status: 503 });
    return jsonResponse(new URL(url).pathname.endsWith('/markets/') ? { items: [row()], nextCursor: null } : row());
  } });
  await expect(venue.listEvents({})).rejects.toMatchObject({ code: 'VENUE_UNAVAILABLE' });
  await expect(venue.listEvents({})).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  expect(calls).toBe(1); healthy = true; clock.advance(1001);
  expect((await venue.listEvents({})).events).toHaveLength(1); expect(circuit.state).toBe('CLOSED');
});

test("all execution/portfolio methods refuse without network even if a caller flips its flag", async () => {
  const { venue, http } = rig();
  const actions = [() => venue.createBuyOrder({ owner: id, venueMarketId: id, side: 'YES', amountBaseUnits: '1000000', idempotencyKey: 'test-only' }),
    () => venue.getOrder('order'), () => venue.listPositions(id), () => venue.closePosition(id, 'pos'), () => venue.createClaim(id, 'pos')];
  for (const action of actions) await expect(action()).rejects.toMatchObject({ code: 'FUNDED_POSITIONS_DISABLED' });
  expect(venue.capabilities().trade).toBe(false);
  expect((await venue.getTradingStatus()).tradingEnabled).toBe(false); expect(http.calls).toHaveLength(0);
});

test("config selects Panta, honors the native emergency switch and refuses missing/test key", () => {
  const app = loadConfig({ PREDICTION_VENUE: 'panta', PANTA_API_KEY: key, FUNDED_POSITIONS: 'true' });
  const cfg = resolvePredictionConfig(app, {});
  expect(cfg.venue).toBe('panta'); expect(cfg.flags.fundedPositions).toBe(true);
  expect(buildPredictionRuntime(app).venue).toBeInstanceOf(PantaVenue);
  const described = describePredictionConfig(cfg);
  expect(described.pantaConfigured).toBe(true); expect(JSON.stringify(described)).not.toContain(key);
  for (const apiKey of [undefined, 'pk_test_synthetic_only']) {
    expect(() => resolvePredictionConfig(loadConfig({ PREDICTION_VENUE: 'panta', PANTA_API_KEY: apiKey }), {})).toThrow('live server key');
  }
});

test("provider migration cannot be overridden by ambient config for another venue", () => {
  const app = loadConfig({ PREDICTION_VENUE: 'panta', PANTA_API_KEY: key });
  expect(resolvePredictionConfig(app, { PREDICTION_VENUE: 'polymarket' }).venue).toBe('panta');
});

test("selecting Panta cannot silently replace durable production storage with memory", () => {
  const config = loadConfig({ PREDICTION_VENUE: 'panta', PANTA_API_KEY: key });
  expect(() => buildPredictionRuntime(config, { social: {
    supabaseUrl: 'https://test.invalid', serviceRoleKey: 'synthetic-only', network: 'devnet',
  } })).toThrow('Panta durable app traffic is not enabled');
});

test("free-call writes do not pretend the unfinished share-price receipt contract exists", () => {
  const h = harness({ people: [person('alice')], markets: [market('panta-market', { venue: 'panta' })] });
  expect(() => h.rt.service.createCall({ marketId: 'panta-market', side: 'YES' }, 'alice')).toThrow('Panta calls');
  expect(h.calls.listCalls()).toHaveLength(0);
});

test("sync uses final detail evidence and never synthesizes probability snapshots", async () => {
  const clock = new TestClock();
  const http = stubFetch(url => jsonResponse(url.pathname.endsWith('/markets/')
    ? { items: [row()], nextCursor: null } : finalRow()));
  const venue = new PantaVenue({ apiKey: key, fetchImpl: http.fetch, clock });
  const store = new InMemoryPredictionStore();
  const sync = new MarketSync({ venue, store, clock });
  const report = await sync.runOnce();
  expect(report.resolutionsRecorded).toBe(1); expect(report.snapshotsRecorded).toBe(0);
  expect(store.getResolution(marketUuid('panta', id))?.resolution).toBe('YES');
  expect((await sync.runOnce()).resolutionsRecorded).toBe(0);
});

function priceSyncRig(initial: Record<string, unknown>) {
  let current = row(initial);
  const clock = new TestClock();
  const http = stubFetch(url => jsonResponse(url.pathname.endsWith('/markets/')
    ? { items: [current], nextCursor: null } : current));
  const venue = new PantaVenue({ apiKey: key, fetchImpl: http.fetch, clock });
  const store = new InMemoryPredictionStore();
  const sync = new MarketSync({ venue, store, clock, snapshotBudget: 1 });
  const calls = new InMemoryCallsStore();
  calls.upsertPerson(person('alice'));
  const service = new CallsService({ store: calls, markets: predictionStoreReader(store), clock, allowPantaCalls: true });
  return { clock, store, sync, service, calls, change: (patch: Record<string, unknown>) => { current = row(patch); } };
}

for (const missing of [{ yesPrice: null, noPrice: null }, { yesPrice: null }, { noPrice: null }]) {
  test(`sync retries missing Panta side prices within the next minute: ${Object.keys(missing)}`, async () => {
    const h = priceSyncRig(missing);
    expect((await h.sync.runOnce()).snapshotsRecorded).toBe(1);
    const before = h.store.latestSharePrice(marketUuid('panta', id))!;
    expect(h.service.openMarkets()).toEqual([]);
    expect(() => h.service.createCall({ marketId: before.marketId, side: 'YES' }, 'alice')).toThrow('missing or stale');
    h.change({ yesPrice: '0.41', noPrice: '0.62' });
    // A repeated tick must not create a request/write loop.
    expect((await h.sync.runOnce()).snapshotsRecorded).toBe(0);
    h.clock.advance(60_000);
    expect((await h.sync.runOnce()).snapshotsRecorded).toBe(1);
    const after = h.store.latestSharePrice(before.marketId)!;
    expect(after).toMatchObject({ yesPrice: '0.41', noPrice: '0.62' });
    expect(after.observedAt).toBeGreaterThan(before.observedAt);
    expect(h.service.openMarkets().map(m => m.id)).toEqual([before.marketId]);
    const call = h.service.createCall({ marketId: before.marketId, side: 'YES' }, 'alice');
    expect(call.call.entryPrice).toEqual(after);
    expect(call.call.entryProbability).toBeNull();
    expect(call.call.fundingState).toBe('NONE');
  });
}

test('sync keeps missing Panta prices uncallable across repeated retries', async () => {
  const h = priceSyncRig({ yesPrice: null, noPrice: null });
  await h.sync.runOnce();
  h.clock.advance(60_000);
  expect((await h.sync.runOnce()).snapshotsRecorded).toBe(1);
  expect(h.store.latestSharePrice(marketUuid('panta', id))).toMatchObject({ yesPrice: null, noPrice: null });
  expect(h.service.openMarkets()).toEqual([]);
  expect(h.calls.listCalls()).toEqual([]);
});

test('sync refreshes complete Panta prices before expiry and does not preserve them over a newer null', async () => {
  const h = priceSyncRig({});
  await h.sync.runOnce();
  const first = h.store.latestSharePrice(marketUuid('panta', id))!;
  h.clock.advance(SHARE_PRICE_MAX_AGE_MS / 2 - 5_000);
  expect((await h.sync.runOnce()).snapshotsRecorded).toBe(0);
  expect(h.store.latestSharePrice(first.marketId)).toEqual(first);
  h.clock.advance(6_000);
  expect((await h.sync.runOnce()).snapshotsRecorded).toBe(1);
  const refreshed = h.store.latestSharePrice(first.marketId)!;
  expect(refreshed.observedAt).toBeGreaterThan(first.observedAt);
  expect(usableSharePrice(refreshed, h.clock.now())).toBe(true);
  h.change({ yesPrice: null, noPrice: null });
  h.clock.advance(SHARE_PRICE_MAX_AGE_MS / 2);
  expect((await h.sync.runOnce()).snapshotsRecorded).toBe(1);
  expect(h.service.openMarkets()).toEqual([]);
  expect(usableSharePrice(h.store.latestSharePrice(first.marketId), h.clock.now())).toBe(false);
});

test("existing tRPC exposes native prices with attribution and rejects funded orders", async () => {
  const app = await createApp({ config: loadConfig({ PREDICTION_VENUE: 'panta', PANTA_API_KEY: key }) });
  const { venue, clock } = rig();
  setPredictionRuntime(app.config, buildPredictionRuntime(app.config, { venue, clock }));
  const caller = predictionsRouter.createCaller({ app, wallet: asWallet(id) });
  expect(await caller.indicativePrices({ venueMarketId: id })).toMatchObject({ venue: 'panta', unit: 'per_share', executable: false });
  const status = await caller.tradingStatus();
  expect(status.reason).toContain('Powered by Panta'); expect(status.ordersAccepted).toBe(false);
  await expect(caller.createOrder({ venueMarketId: id, side: 'YES', amountBaseUnits: '1000000', idempotencyKey: 'test-only' }))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
});
