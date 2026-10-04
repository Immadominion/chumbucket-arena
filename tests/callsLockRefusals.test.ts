/**
 * calls.create / calls.respond over the real routers, for the refusals a
 * person can actually hit when they tap Lock:
 *
 *  - a Panta price that lapsed since the last sync pass is read again from
 *    Panta for that one market before the lock is decided, so nobody is told
 *    a price is "stale";
 *  - a lock that still cannot be priced is refused in plain words;
 *  - every refusal is logged by procedure and CODE only, so a proxy log's
 *    "POST /calls.respond 400" can be told apart afterwards;
 *  - the app's exact respond payload (nulls included) passes the strict
 *    schema.
 *
 * No network: Panta is a stubbed fetch; the stores are in memory.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../src/api/router.ts";
import { resolveCallsConfig } from "../src/calls/config.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { buildCallsRuntime, setCallsRuntime } from "../src/calls/runtime.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { buildPredictionRuntime } from "../src/prediction/runtime.ts";
import { resolvePredictionConfig } from "../src/prediction/config.ts";
import { sharePriceFromIndicative } from "../src/prediction/sharePrices.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import { jsonResponse, stubFetch } from "./predictionFixtures.ts";
import { person, T0, TestClock, testApp } from "./socialCallsFixtures.ts";

const ADDRESS = "11111111111111111111111111111111";
const key = "pk_live_synthetic_lock_refusals_test";

/** Panta's market detail row, with the side prices this test controls. */
function row(prices: { yes: string; no: string }) {
  const at = Math.floor(T0 / 1000);
  return {
    marketId: ADDRESS, category: "crypto", title: "Synthetic crypto question?",
    description: "Synthetic test rule", phase: "primary", status: "primary", resolved: false,
    startTime: at - 60, endTime: at + 30 * 86_400, resolutionTime: at + 31 * 86_400,
    yesPrice: prices.yes, noPrice: prices.no,
    onChain: { resolutionRule: "Synthetic test rule", isActive: true },
  };
}

const sessions: Record<string, string> = { "tok-dev": "dev", "tok-new": "newbie" };
let warnings: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.warn = realWarn;
});

async function rig(opts: { pantaDown?: boolean } = {}) {
  const clock = new TestClock();
  const prices = { yes: "0.5", no: "0.5" };
  const http = stubFetch(() =>
    opts.pantaDown ? new Response("synthetic outage", { status: 503 }) : jsonResponse(row(prices)),
  );
  const venue = new PantaVenue({ apiKey: key, clock, fetchImpl: http.fetch, retry: { attempts: 1 } });
  const store = new InMemoryPredictionStore();
  // Seed the mirror the way the sync does: the market, then its price.
  const seeded = new PantaVenue({
    apiKey: key, clock,
    fetchImpl: stubFetch(() => jsonResponse(row(prices))).fetch,
    retry: { attempts: 1 },
  });
  const market = await seeded.getMarket(ADDRESS);
  store.upsertMarket(market, seeded.rawPayload(ADDRESS)!);
  store.appendSharePrice(sharePriceFromIndicative(await seeded.getIndicativePrices(ADDRESS)), seeded.rawPayload(ADDRESS)!);

  const prediction = buildPredictionRuntime(undefined, {
    venue, store, clock, config: resolvePredictionConfig(undefined, { PREDICTION_VENUE: "panta", PANTA_API_KEY: key }),
  });
  const calls = new InMemoryCallsStore();
  calls.upsertPerson(person("dev"));
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
  const target = rt.service.createCall({ marketId: market.id, side: "NO" }, "dev");

  async function post(path: string, token: string, json: unknown) {
    const res = await fetchRequestHandler({
      endpoint: "",
      router: appRouter,
      req: new Request(`https://synthetic.invalid/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ json }),
      }),
      createContext: () => ({ app, supabaseAccessToken: token }) as never,
    });
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  return { clock, prices, http, market, target, post, store };
}

/** `RespondToCallInput.toJson()` in the app, field for field. */
const appRespond = (targetCallId: string, kind = "fade") => ({
  targetCallId, kind, confidence: null, thesis: null, visibility: "public",
});

test("the app's exact respond payload locks a Fade for a new account", async () => {
  const h = await rig();
  const res = await h.post("calls.respond", "tok-new", appRespond(h.target.call.id));
  expect(res.status).toBe(200);
  const own = res.body.result.data.json.resultingCall.call;
  expect(own.side).toBe("YES");
  expect(own.userId).toBe("newbie");
  expect(warnings).toEqual([]);
});

test("a Fade on a lapsed price reads Panta again instead of refusing", async () => {
  const h = await rig();
  // Eleven minutes after the sync's last price: past the ten-minute window.
  h.clock.advance(11 * 60_000);
  h.prices.yes = "0.62";
  h.prices.no = "0.4";
  const before = h.http.calls.length;
  const res = await h.post("calls.respond", "tok-new", appRespond(h.target.call.id));
  expect(res.status).toBe(200);
  const own = res.body.result.data.json.resultingCall.call;
  expect(own.side).toBe("YES");
  // The new call carries the price just read, observed now.
  expect(own.entryPrice.yesPrice).toBe("0.62");
  expect(own.entryPrice.observedAt).toBe(h.clock.now());
  expect(h.http.calls.length).toBeGreaterThan(before);
});

test("a fresh price is not read again", async () => {
  const h = await rig();
  const before = h.http.calls.length;
  const res = await h.post("calls.create", "tok-new", { marketId: h.market.id, side: "YES" });
  expect(res.status).toBe(200);
  expect(h.http.calls.length).toBe(before);
});

test("a call on a lapsed price reads Panta again too", async () => {
  const h = await rig();
  h.clock.advance(11 * 60_000);
  const res = await h.post("calls.create", "tok-new", { marketId: h.market.id, side: "YES" });
  expect(res.status).toBe(200);
  expect(res.body.result.data.json.call.entryPrice.observedAt).toBe(h.clock.now());
});

test("when Panta cannot price it either, the refusal is plain and logged by code", async () => {
  const h = await rig({ pantaDown: true });
  h.clock.advance(11 * 60_000);
  const res = await h.post("calls.respond", "tok-new", appRespond(h.target.call.id));
  expect(res.status).toBe(400);
  const message: string = res.body.error.json.message;
  expect(message).toBe("Panta's price for this market isn't available right now. Try again in a minute.");
  expect(message).not.toMatch(/stale|refresh/i);
  expect(warnings).toEqual(['[calls] refused {"procedure":"calls.respond","code":"CALL_INVALID"}']);
});

test("answering your own call is refused, logged by code, and never reads a price", async () => {
  const h = await rig();
  h.clock.advance(11 * 60_000);
  const before = h.http.calls.length;
  const res = await h.post("calls.respond", "tok-dev", appRespond(h.target.call.id, "back"));
  expect(res.status).toBe(400);
  expect(res.body.error.json.message).toBe("You can't respond to your own call.");
  expect(warnings).toEqual(['[calls] refused {"procedure":"calls.respond","code":"RESPONSE_SELF"}']);
  expect(h.http.calls.length).toBe(before);
});

test("a content refusal is logged by its trust code, never its text", async () => {
  const h = await rig();
  const res = await h.post("calls.respond", "tok-new", {
    ...appRespond(h.target.call.id),
    thesis: "see scam.com for proof",
  });
  expect(res.status).toBe(400);
  expect(warnings).toEqual(['[calls] refused {"procedure":"calls.respond","code":"TRUST_CONTENT_REFUSED"}']);
  expect(warnings.join(" ")).not.toContain("scam");
});
