import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CallsService } from "../src/calls/CallsService.ts";
import { buildCallsRuntime, setCallsRuntime } from "../src/calls/runtime.ts";
import { resolveCallsConfig } from "../src/calls/config.ts";
import { walletDirectoryViewerResolver } from "../src/calls/viewer.ts";
import { appRouter } from "../src/api/router.ts";
import { asWallet } from "../src/domain/ids.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { SupabaseCallsStore } from "../src/calls/supabaseStore.ts";
import { CallReceiptsProjection } from "../src/calls/receipts.ts";
import { ResolutionSync } from "../src/calls/ResolutionSync.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import { SupabasePredictionStore } from "../src/prediction/supabaseStore.ts";
import { parseSharePrice, sharePriceFromIndicative, sharePriceUuid } from "../src/prediction/sharePrices.ts";
import { WriteQueue } from "../src/prediction/pgrest.ts";
import type { RawPayload } from "../src/prediction/PredictionVenue.ts";
import { market, person, TestClock, T0, testApp } from "./socialCallsFixtures.ts";
import { PgrestFake, seedUser, UUIDS } from "./pgrestFake.ts";

const id = '11111111-1111-5111-8111-111111111111';
const m = market(id, { venue: "panta", venueMarketId: "11111111111111111111111111111111" });
export const observation = (at = T0, yesPrice: string | null = '1.250000000000000001', noPrice: string | null = '0.35') =>
  sharePriceFromIndicative({ marketId: id, venueMarketId: m.venueMarketId, venue: 'panta',
    currency: 'USDC', unit: 'per_share', yesPrice, noPrice, observedAt: at,
    attribution: 'Powered by Panta', executable: false, demo: false });
const evidence = (s = observation()): RawPayload => ({ venue: 'panta', venueMarketId: m.venueMarketId,
  payloadVersion: 1, fetchedAt: s.observedAt, body: { yesPrice: s.yesPrice, noPrice: s.noPrice } });
function rig() {
  const clock = new TestClock(); const prices = new InMemoryPredictionStore();
  prices.upsertMarket(m, evidence()); prices.appendSharePrice(observation(), evidence());
  const calls = new InMemoryCallsStore();
  for (const id of ['alice','bob','carol']) calls.upsertPerson(person(id));
  const receipts = new CallReceiptsProjection();
  const service = new CallsService({ store: calls, markets: predictionStoreReader(prices), clock, receipts, allowPantaCalls: true });
  return {clock, prices, calls, receipts, service};
}

test('independent decimal prices >1 survive calls and receipts without probability', () => {
  const h = rig();
  const made = h.service.createCall({ marketId: id, side: 'NO' }, 'alice');
  expect(made.call.entryPrice).toEqual(observation());
  expect(made.call.entryProbability).toBeNull(); expect(made.call.snapshotId).toBeNull();
  expect(made.call.fundingState).toBe('NONE');
  expect(h.service.marketDetail({ marketId: id }, null).sharePrice).toEqual(observation());
  expect(h.service.openMarkets().map(m => m.id)).toEqual([id]);
  const receipt = h.receipts.recordMade(made.call, m);
  expect(receipt.entryPrice?.noPrice).toBe('0.35');
  expect(JSON.stringify(receipt)).not.toMatch(/stake|payout|transaction|balance/);
});

test('later prices never change an old call; Fade pins its own current snapshot', () => {
  const h = rig(); const first = h.service.createCall({ marketId: id, side: 'YES' }, 'alice');
  h.clock.advance(1000); const second = observation(h.clock.now(), '0.9', '0.8');
  h.prices.appendSharePrice(second, evidence(second));
  const fade = h.service.respond({targetCallId: first.call.id, kind: 'fade'}, 'bob');
  expect(fade.resultingCall?.call.side).toBe('NO');
  expect(fade.resultingCall?.call.entryPrice).toEqual(second);
  expect(h.calls.getCall(first.call.id)?.entryPrice).toEqual(observation());
  expect(() => h.calls.attemptCallUpdate(first.call.id, { entryPrice: second })).toThrow('mutable');
  expect(() => { first.call.entryPrice!.yesPrice = '0.1'; }).toThrow();
});

test('settlement preserves the locked price and still requires venue evidence', () => {
  const h=rig(); const made=h.service.createCall({marketId:id,side:'YES'},'alice');
  const sync=new ResolutionSync({store:h.calls,markets:predictionStoreReader(h.prices),clock:h.clock,receipts:h.receipts});
  h.prices.upsertMarket({...m,status:'RESOLVED'},evidence());
  expect(sync.runOnce().resultsSettled).toBe(0);
  expect(h.calls.getResult(made.call.id)?.outcome).toBe('PENDING');
  h.prices.recordResolution({marketId:id,venue:'panta',venueMarketId:m.venueMarketId,resolution:'YES',resolvedAt:T0,
    evidenceSource:'synthetic-venue-fixture',rawEvidence:{synthetic:true,resolution:'YES'},demo:false},T0);
  expect(sync.runOnce().resultsSettled).toBe(1);
  expect(h.receipts.receiptForCall(made.call.id)).toMatchObject({outcome:'CORRECT',entryPrice:observation(),entryProbability:null,shareable:true});
  expect(sync.runOnce().resultsSettled).toBe(0);
});

for (const [label, at, yes, no] of [
  ['stale', T0-600001, '0.4','0.3'], ['future', T0+1,'0.4','0.3'],
  ['missing YES', T0,null,'0.3'], ['missing NO', T0,'0.4',null],
] as const) test(`${label} refuses discovery and locking`, () => {
  const clock = new TestClock(); const prices = new InMemoryPredictionStore();
  prices.upsertMarket(m, evidence()); const s = observation(at, yes, no); prices.appendSharePrice(s, evidence(s));
  const calls = new InMemoryCallsStore(); calls.upsertPerson(person('alice'));
  const service = new CallsService({store:calls, markets:predictionStoreReader(prices),clock,allowPantaCalls:true});
  expect(service.openMarkets()).toEqual([]);
  expect(() => service.createCall({marketId:id, side:'YES'}, 'alice')).toThrow("isn't available right now");
  expect(calls.listCalls()).toEqual([]);
});

test('missing evidence and mismatched capture identities fail closed', () => {
  const h = rig(); const s = observation(T0+1);
  for (const raw of [null, {...evidence(s),venue:'fixture' as const}, {...evidence(s),venueMarketId:'other'}, {...evidence(s),fetchedAt:T0},
    {...evidence(s),body:{yesPrice:'0.01',noPrice:s.noPrice}}, {...evidence(s),payloadVersion:2}]) {
    expect(() => h.prices.appendSharePrice(s,raw)).toThrow('matching captured');
  }
});

test('same observation is idempotent but contradictory price cannot overwrite it', () => {
  const h = rig(); h.prices.appendSharePrice(observation(),evidence());
  const forged=observation(T0,'0.01','0.99');
  expect(() => h.prices.appendSharePrice(forged,evidence(forged))).toThrow('immutable');
  expect(h.prices.latestSharePrice(id)).toEqual(observation());
});

for (const patch of [{yesPrice:1.2},{yesPrice:'1e3'},{noPrice:'-1'},{unit:'probability'},
  {executable:true},{stake:'123'},{id:randomUUID()}]) test(`strict contract rejects ${Object.keys(patch)[0]}`, () => {
  expect(() => parseSharePrice({...observation(),...patch})).toThrow('Invalid Panta');
});

test('closed and resolved markets cannot accept Panta calls', () => {
  for (const status of ['CLOSED_PENDING_RESOLUTION','RESOLVED','CANCELLED','PAUSED'] as const) {
    const h=rig(); h.prices.upsertMarket({...m,status},evidence());
    expect(() => h.service.createCall({marketId:id,side:'YES'},'alice')).toThrow('not taking new calls');
  }
});

test('call hydration and price hydration preserve separate observations after restart', async () => {
  const clock=new TestClock(); const fake=new PgrestFake({now:()=>clock.now()}); seedUser(fake,UUIDS.alice);
  const queue=new WriteQueue({clock});
  const prices=new SupabasePredictionStore({config:fake.config,fetchImpl:fake.fetchImpl,clock,queue});
  const calls=new SupabaseCallsStore({config:fake.config,fetchImpl:fake.fetchImpl,clock,queue});
  await calls.hydrate(); prices.upsertMarket(m,evidence()); prices.appendSharePrice(observation(),evidence());
  const service=new CallsService({store:calls,markets:predictionStoreReader(prices),clock,allowPantaCalls:true,newId:()=>randomUUID()});
  const made=service.createCall({marketId:id,side:'YES'},UUIDS.alice);
  clock.advance(1000); const newer=observation(clock.now(),'0.2','1.3'); prices.appendSharePrice(newer,evidence(newer));
  await calls.flush();
  const restoredPrices=new SupabasePredictionStore({config:fake.config,fetchImpl:fake.fetchImpl,clock});
  const restoredCalls=new SupabaseCallsStore({config:fake.config,fetchImpl:fake.fetchImpl,clock});
  await restoredPrices.hydrate(); await restoredCalls.hydrate();
  expect(restoredPrices.latestSharePrice(id)).toEqual(newer);
  expect(restoredCalls.getCall(made.call.id)?.entryPrice).toEqual(observation());
  expect(restoredCalls.getCall(made.call.id)?.entryProbability).toBeNull();
  expect(sharePriceUuid(id,T0)).not.toBe(sharePriceUuid(id,T0+1000));
});

test('mounted routes expose Panta details, lock and Fade with the exact price contract', async () => {
  const h=rig(); const app=await testApp();
  const rt=buildCallsRuntime(undefined,{config:{...resolveCallsConfig(undefined,{}),callCutoffMs:0},store:h.calls,markets:predictionStoreReader(h.prices),clock:h.clock,
    allowPantaCalls:true,viewer:walletDirectoryViewerResolver(h.calls)});
  setCallsRuntime(app.config,rt);
  const alice=appRouter.createCaller({app,wallet:asWallet('Wallet_alice')});
  const bob=appRouter.createCaller({app,wallet:asWallet('Wallet_bob')});
  const before=await alice.markets.detail({marketId:id});
  expect(before.sharePrice).toEqual(observation()); expect(before.snapshot).toBeNull(); expect(before.crowdSplit).toBeNull();
  const call=await alice.calls.create({marketId:id,side:'YES'});
  expect(call.call.entryPrice).toEqual(observation());
  const faded=await bob.calls.respond({targetCallId:call.call.id,kind:'fade'});
  expect(faded.resultingCall?.call.entryPrice).toEqual(observation());
  expect(faded.resultingCall?.call.side).toBe('NO');
  expect((await alice.calls.get({callId:call.call.id})).entry.call.entryPrice).toEqual(observation());
  expect((await alice.calls.feed({mode:'global'})).entries).toHaveLength(2);
});
