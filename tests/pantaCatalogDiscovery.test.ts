import { expect, test } from "bun:test";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { TestClock, jsonResponse, stubFetch } from "./predictionFixtures.ts";
import { market, testApp } from "./socialCallsFixtures.ts";
import { buildPredictionRuntime, setPredictionRuntime } from "../src/prediction/runtime.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import { predictionsRouter } from "../src/api/predictions.ts";
import { withPredictionConfig, resolvePredictionConfig } from '../src/prediction/config.ts';

test("opaque Panta cursor survives and is URL-encoded, not interpreted as a public key", async () => {
  const token = 'opaque:next-page_=' + 'a'.repeat(115) + '&other=1';
  const http = stubFetch(() => jsonResponse({items: [], nextCursor: token}));
  const venue = new PantaVenue({apiKey:'pk_live_synthetic_tests_only',clock:new TestClock(),fetchImpl:http.fetch});
  expect((await venue.listEvents({})).nextCursor).toBe(token);
  await venue.listEvents({}, token);
  const url = new URL(http.calls[1]!.url);
  expect(url.searchParams.get('cursor')).toBe(token);
  expect(url.searchParams.has('other')).toBe(false);
});

for (const cursor of ['', 123, 'x'.repeat(513), 'line\nbreak', 'two words']) {
  test(`invalid cursor shape fails closed (${typeof cursor}, length ${String(cursor).length})`, async () => {
    const http = stubFetch(() => jsonResponse({items:[],nextCursor:cursor}));
    const venue = new PantaVenue({apiKey:'pk_live_synthetic_tests_only',clock:new TestClock(),fetchImpl:http.fetch});
    await expect(venue.listEvents({})).rejects.toMatchObject({code:'VENUE_SCHEMA'});
  });
}

test("public catalog paginates all categories without a price or caller identity", async () => {
  const app = await testApp();
  const store = new InMemoryPredictionStore();
  const rt = buildPredictionRuntime(app.config, {store, config:resolvePredictionConfig(withPredictionConfig(app.config, {venue:'fixture'}), {})});
  setPredictionRuntime(app.config, rt);
  for (const [id, category] of [['a','sports'],['b','crypto'],['c','politics']]) {
    store.upsertMarket(market(id!, {category:category!}), null);
  }
  store.upsertMarket(market('foreign', {venue:'jupiter'}), null);
  const anon = predictionsRouter.createCaller({app});
  const page = await anon.catalog({limit:2});
  expect(page.markets.map(m=>m.category)).toEqual(['sports','crypto']);
  expect(page.nextCursor).toBe('b');
  const second = await anon.catalog({limit:2,cursor:page.nextCursor!});
  expect(second.markets.map(m=>m.id)).toEqual(['c']);
  expect(second.nextCursor).toBeNull();
  expect(store.latestSnapshot('a')).toBeUndefined();
});

test("Panta worker requests every category using an independent cursor", async () => {
  const app = await testApp();
  // Configuration seam used by production runtime, but a synthetic transport.
  const configured = withPredictionConfig(app.config, {venue:'panta',panta:{apiKey:'pk_live_synthetic_tests_only',timeoutMs:8000}});
  const http = stubFetch(() => jsonResponse({items:[],nextCursor:null}));
  const clock = new TestClock();
  const venue = new PantaVenue({apiKey:'pk_live_synthetic_tests_only',fetchImpl:http.fetch,clock});
  const rt = buildPredictionRuntime(configured, {venue, clock});
  await rt.marketSync.runOnce();
  expect(new URL(http.calls[0]!.url).searchParams.has('category')).toBe(false);
});
