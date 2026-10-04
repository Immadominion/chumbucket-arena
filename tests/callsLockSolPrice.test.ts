/**
 * fleet/ux-calls × fleet/catalog-breadth: a Lock on a SOL-quoted Panta market
 * whose price lapsed.
 *
 * ux-calls re-reads Panta's price for the one market being locked
 * (freshenPantaPrice → PredictionService.getIndicativePrices) instead of
 * refusing it as stale. catalog-breadth serves SOL-quoted markets from the
 * Panta program account, which the partner API never lists. Together, the
 * re-read must reach the chain for a SOL market, store the SOL price with its
 * account evidence, and the new call must pin that SOL price — never a USDC
 * one, never a refusal.
 *
 * No network: the partner API is a stubbed fetch, the RPC a fake; the stores
 * are in memory.
 */
import { expect, test } from "bun:test";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../src/api/router.ts";
import { resolveCallsConfig } from "../src/calls/config.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { buildCallsRuntime, setCallsRuntime } from "../src/calls/runtime.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { MarketSync } from "../src/prediction/marketSync.ts";
import { PantaCatalogVenue } from "../src/prediction/PantaCatalogVenue.ts";
import { PantaChainCatalog } from "../src/prediction/PantaChainCatalog.ts";
import { PANTA_CHAIN_PAYLOAD_VERSION, PANTA_PROGRAM_ID } from "../src/prediction/PantaProgram.ts";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { resolvePredictionConfig } from "../src/prediction/config.ts";
import { buildPredictionRuntime } from "../src/prediction/runtime.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import { marketUuid } from "../src/prediction/types.ts";
import { encodePantaEvent, eventAddress, fakeSolanaRpc, type FakeAccount } from "./pantaChainFixtures.ts";
import { TestClock, jsonResponse, stubFetch } from "./predictionFixtures.ts";
import { person, testApp } from "./socialCallsFixtures.ts";

const NOW = 1_791_075_600_000;
const NOW_S = NOW / 1000;
const KEY = "pk_live_synthetic_sol_lock_test";
const QUESTION = "Will the synthetic SOL market close above its line?";
const ADDRESS = eventAddress(QUESTION, "SOL");
const MARKET = marketUuid("panta", ADDRESS);
const sessions: Record<string, string> = { "tok-new": "newbie" };

async function rig() {
  const clock = new TestClock(NOW);
  // The partner API lists no SOL market and answers 404 for its address.
  const live = new PantaVenue({ apiKey: KEY, clock, retry: { attempts: 1 }, fetchImpl: stubFetch(url =>
    url.pathname.endsWith("/markets/")
      ? jsonResponse({ items: [], nextCursor: null })
      : jsonResponse({ code: "NOT_FOUND" }, { status: 404 }),
  ).fetch });
  const accounts = new Map<string, FakeAccount>();
  const priceAt = (lastYesPrice: bigint) =>
    accounts.set(ADDRESS, { owner: PANTA_PROGRAM_ID, data: encodePantaEvent({ question: QUESTION, endTime: NOW_S + 30 * 86_400, lastYesPrice }) });
  priceAt(400_000_000n);
  const rpc = fakeSolanaRpc(accounts);
  const chain = new PantaChainCatalog({ rpcUrl: "https://rpc.synthetic.invalid", clock, retry: { attempts: 1 },
    registryUrl: null, fetchImpl: rpc.fetchImpl });
  const venue = new PantaCatalogVenue({ live, chain, clock });
  const store = new InMemoryPredictionStore();
  await new MarketSync({ venue, store, clock, venueId: "panta", filters: {} }).runOnce();

  const prediction = buildPredictionRuntime(undefined, {
    venue, store, clock,
    config: resolvePredictionConfig(undefined, { PREDICTION_VENUE: "panta", PANTA_API_KEY: KEY }),
  });
  const calls = new InMemoryCallsStore();
  calls.upsertPerson(person("newbie"));
  const app = await testApp();
  const rt = buildCallsRuntime(undefined, {
    config: { ...resolveCallsConfig(undefined, {}), callCutoffMs: 0 },
    store: calls, markets: predictionStoreReader(store), prediction, clock, allowPantaCalls: true,
    viewer: {
      async resolve(ctx: { supabaseAccessToken?: string }) {
        return (ctx.supabaseAccessToken && sessions[ctx.supabaseAccessToken]) ?? null;
      },
    },
  });
  setCallsRuntime(app.config, rt);

  async function post(path: string, json: unknown) {
    const res = await fetchRequestHandler({
      endpoint: "",
      router: appRouter,
      req: new Request(`https://synthetic.invalid/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok-new" },
        body: JSON.stringify({ json }),
      }),
      createContext: () => ({ app, supabaseAccessToken: "tok-new" }) as never,
    });
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  return { clock, store, rpc, priceAt, post };
}

test("a Lock on a SOL market whose price lapsed reads the program again and pins the SOL price", async () => {
  const h = await rig();
  expect(h.store.latestSharePrice(MARKET)).toMatchObject({ currency: "SOL", yesPrice: "0.4" });

  // Eleven minutes later the stored price has lapsed, and the market moved.
  h.clock.advance(11 * 60_000);
  h.priceAt(450_000_000n);
  const reads = h.rpc.asked.length;
  const res = await h.post("calls.create", { marketId: MARKET, side: "YES" });

  expect(res.status).toBe(200);
  const call = res.body.result.data.json.call;
  expect(call.entryPrice).toMatchObject({
    currency: "SOL", unit: "per_share", yesPrice: "0.45", noPrice: "0.55", observedAt: h.clock.now(),
  });
  expect(h.rpc.asked.length).toBeGreaterThan(reads);
  // Stored with its own account evidence, so the SOL price survives a restart.
  expect(h.store.latestSharePrice(MARKET)).toMatchObject({ currency: "SOL", yesPrice: "0.45" });
  expect(h.store.getMarket(MARKET)?.market.payloadVersion).toBe(PANTA_CHAIN_PAYLOAD_VERSION);
});
