/**
 * Money only where our trade path works: Panta's primary buy answers
 * MARKET_NOT_IN_PRIMARY outside phase "primary" (docs; live on 2026-10-08 for
 * all 9 open secondary markets, and INVALID_MARKET_PARAMS for Arsenal). Such a
 * market is served untradable, so the app hides the amount, and a buy is
 * refused on the fresh read before any reservation or quote. Plus the quote's
 * bounded retries for a bare INVALID_MARKET_PARAMS seen live the same day.
 */
import { describe, expect, test } from "bun:test";
import { servedMarket, pantaTradable } from "../src/prediction/marketQuote.ts";
import { pantaPost } from "../src/prediction/PantaHttp.ts";
import { PANTA_PROGRAM_ID } from "../src/prediction/PantaProgram.ts";
import { PRIMARY_SALE_ONLY_COPY, PantaTradingService } from "../src/prediction/PantaTradingService.ts";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { marketUuid, type VenueMarket } from "../src/prediction/types.ts";
import * as REAL from "./fixtures/pantaChainAccounts.ts";
import { TestClock, jsonResponse, stubFetch } from "./predictionFixtures.ts";

const NOW = 1_791_075_600_000;
const KEY = "pk_live_synthetic_tests_only";
const TRAM = REAL.USDC_OPEN_TRAM.address;
/** Detail as documented, with the program-derived block the adapter now merges. */
const detail = (over: Record<string, unknown> = {}) => ({
  marketId: TRAM, category: "pop-culture", title: "Will Tram finish in the Top 3 of BBNaija Season 11?", description: "",
  phase: "primary", status: "open", resolved: false, startTime: 1790866800, endTime: 1791151200, resolutionTime: 1791151200,
  yesPrice: "0.52", noPrice: "0.48", programId: PANTA_PROGRAM_ID,
  onChain: { resolutionRule: "Synthetic rules.", isActive: true }, ...over,
});
const venueFor = (row: Record<string, unknown>) =>
  new PantaVenue({ apiKey: KEY, clock: new TestClock(NOW), fetchImpl: stubFetch(() => jsonResponse(row)).fetch });

describe("money only in the primary sale (live 2026-10-08: MARKET_NOT_IN_PRIMARY on every secondary market)", () => {
  const usdcMarket = (rawStatus: string): VenueMarket => ({ id: marketUuid("panta", TRAM), venue: "panta", venueEventId: TRAM,
    venueMarketId: TRAM, question: "q", rulesText: "r", category: "c", outcomes: [{ side: "YES", label: "Yes" }, { side: "NO", label: "No" }],
    status: "OPEN", rawStatus, opensAt: null, closesAt: null, resolvesAt: null, resolutionSource: null, lastSyncedAt: NOW, payloadVersion: 1 });

  test("a graduated USDC market is served untradable, so the app hides the amount", () => {
    expect(servedMarket(usdcMarket("primary"))).toMatchObject({ quoteCurrency: "USDC", tradable: true });
    expect(servedMarket(usdcMarket("open"))).toMatchObject({ quoteCurrency: "USDC", tradable: true });
    expect(servedMarket(usdcMarket("secondary"))).toMatchObject({ quoteCurrency: "USDC", tradable: false });
    expect(servedMarket(usdcMarket("secondary_active"))).toMatchObject({ quoteCurrency: "USDC", tradable: false });
    expect(pantaTradable({ ...usdcMarket("primary"), payloadVersion: 2 })).toBe(false); // SOL-quoted
  });

  const trading = (venue: PantaVenue) => {
    let reserved = 0, built = 0;
    const service = new PantaTradingService({
      store: {
        callIntent: async () => ({ callId: "c1", marketId: marketUuid("panta", TRAM), venueMarketId: TRAM, side: "YES", tradable: true }),
        find: async () => null, byOrder: async () => null, activeForCall: async () => null,
        reserve: async () => { reserved++; return null; }, update: async () => null,
      },
      execution: { buildBuy: async () => { built++; throw new Error("unreachable"); } } as never,
      chain: { broadcast: async () => {} }, venue, maxAmountBaseUnits: "100000000",
      wallets: { status: async () => "active" as const }, now: () => NOW,
    });
    const prepare = () => service.prepare("alice", { callId: "c1", wallet: REAL.SOL_OPEN_HYPE.address, amountBaseUnits: "2000000",
      idempotencyKey: "k1", maxSlippageBps: 100 });
    return { prepare, counts: () => [reserved, built] };
  };

  test("a buy on a secondary market is refused on the fresh read, before any reservation or quote", async () => {
    // Arsenal, live: phase "secondary", status "secondary_active".
    for (const row of [{ phase: "secondary", status: "secondary_active" }, { phase: "secondary", status: "open" }]) {
      const t = trading(venueFor(detail(row)));
      await expect(t.prepare()).rejects.toThrow(PRIMARY_SALE_ONLY_COPY);
      expect(t.counts()).toEqual([0, 0]);
    }
  });

  test("a primary-sale market goes on to reserve the intent", async () => {
    const t = trading(venueFor(detail()));
    await expect(t.prepare()).rejects.toThrow("Could not reserve the trade intent");
    expect(t.counts()).toEqual([1, 0]);
  });
});

describe("the quote's bounded retries", () => {
  const quote = { quoteId: "qt_1", marketId: TRAM, side: "yes", amountUsdc: "2.00", shares: "3.9", avgPrice: "0.51",
    feeUsdc: "0.04", expiresAt: "2026-10-08T06:00:00Z", blockhashExpiryHintSec: 60 };
  const transport = (answers: Response[]) => {
    const paths: string[] = []; const slept: number[] = [];
    const request = pantaPost(KEY, 500, Object.assign(async (url: Parameters<typeof fetch>[0]) => {
      paths.push(new URL(String(url)).pathname); return answers.shift()!;
    }, { preconnect: fetch.preconnect }), async ms => { slept.push(ms); });
    return { request, paths, slept };
  };
  const bare = () => jsonResponse({ code: "INVALID_MARKET_PARAMS" }, { status: 400 });

  test("a bare INVALID_MARKET_PARAMS quote is asked again, a second apart, until it quotes", async () => {
    const t = transport([bare(), bare(), bare(), jsonResponse(quote)]);
    expect(await t.request("/primaryorderquote/", {})).toEqual(quote);
    expect(t.paths).toHaveLength(4);
    expect(t.slept).toEqual([1_000, 1_000, 1_000]);
  });

  test("at most six asks, only that exact answer, only the quote", async () => {
    const many = transport([bare(), bare(), bare(), bare(), bare(), bare(), jsonResponse(quote)]);
    await expect(many.request("/primaryorderquote/", {})).rejects.toThrow("HTTP 400");
    expect(many.paths).toHaveLength(6);
    expect(many.slept).toHaveLength(5);
    for (const answer of [
      jsonResponse({ code: "INVALID_MARKET_PARAMS", message: "amountUsdc: invalid", field: "amountUsdc" }, { status: 400 }),
      jsonResponse({ code: "MARKET_NOT_IN_PRIMARY" }, { status: 400 }),
      jsonResponse({ code: "INVALID_MARKET_PARAMS" }, { status: 500 }),
    ]) {
      const t = transport([answer, jsonResponse(quote)]);
      await expect(t.request("/primaryorderquote/", {})).rejects.toThrow("Panta operation refused");
      expect(t.paths).toHaveLength(1);
    }
    const build = transport([bare(), jsonResponse({})]);
    await expect(build.request("/primaryorderbuild/", {})).rejects.toThrow("HTTP 400");
    expect(build.paths).toHaveLength(1);
    expect(build.slept).toEqual([]);
  });
});
