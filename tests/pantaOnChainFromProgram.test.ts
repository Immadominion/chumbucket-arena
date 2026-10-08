/**
 * Panta removed the undocumented `onChain` block from market detail on
 * 2026-10-08: detail is now exactly the documented catalog row, with no rules
 * and no final flags. Every USDC market then read as "no published rules", so
 * every funded buy was refused and settlement of USDC calls stopped.
 *
 * These tests pin the repair: the same fields, read from the market's own
 * program account (proven USDC by its address derivation), merged under the
 * old names with a provenance marker the stored evidence can be re-checked
 * against.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { PantaChainCatalog } from "../src/prediction/PantaChainCatalog.ts";
import { PANTA_PROGRAM_ID } from "../src/prediction/PantaProgram.ts";
import { PantaTradingService } from "../src/prediction/PantaTradingService.ts";
import { PANTA_PAYLOAD_VERSION, PantaVenue } from "../src/prediction/PantaVenue.ts";
import type { RawPayload } from "../src/prediction/PredictionVenue.ts";
import { buildPredictionRuntime } from "../src/prediction/runtime.ts";
import { assertSharePriceEvidence, sharePriceFromIndicative } from "../src/prediction/sharePrices.ts";
import { marketUuid } from "../src/prediction/types.ts";
import * as REAL from "./fixtures/pantaChainAccounts.ts";
import { encodePantaEvent, eventAddress, fakeSolanaRpc, type FakeAccount, type SyntheticEvent } from "./pantaChainFixtures.ts";
import { TestClock, jsonResponse, stubFetch } from "./predictionFixtures.ts";

/** 2026-10-04T01:00Z: the TRAM fixture (captured an hour earlier) is still open. */
const NOW = 1_791_075_600_000;
const NOW_S = NOW / 1000;
const KEY = "pk_live_synthetic_tests_only";
const RPC = "https://rpc.synthetic.invalid/?api-key=synthetic-provider-key";
const TRAM = REAL.USDC_OPEN_TRAM.address;

/** Detail exactly as documented since 2026-10-08: no `onChain`, no rules. */
const apiRow = (marketId: string, over: Record<string, unknown> = {}) => ({
  marketId, category: "pop-culture", title: "Will Tram finish in the Top 3 of BBNaija Season 11?", description: "",
  images: [], phase: "primary", marketType: "breaking", startTime: 1790866800, endTime: 1791151200,
  resolutionTime: 1791151200, region: "Global", resolved: false, status: "open", volumeUsdc: "12.00", campaignId: null,
  createdByPartner: false, yesPrice: null, noPrice: null, primaryYesPrice: null, primaryNoPrice: null,
  secondaryYesPrice: null, secondaryNoPrice: null, programId: PANTA_PROGRAM_ID, ...over,
});

function rig(opts: { rows?: Record<string, unknown>; reader?: boolean } = {}) {
  const clock = new TestClock(NOW);
  const rows: Record<string, unknown> = { [TRAM]: apiRow(TRAM), ...opts.rows };
  const api = stubFetch(url => {
    const id = url.pathname.split("/").filter(Boolean).at(-1)!;
    return rows[id] ? jsonResponse(rows[id]) : jsonResponse({ code: "MARKET_NOT_FOUND" }, { status: 404 });
  });
  const accounts = new Map<string, FakeAccount>();
  for (const a of [REAL.USDC_OPEN_TRAM, REAL.SOL_OPEN_HYPE]) accounts.set(a.address, { owner: a.owner, data: Buffer.from(a.data, "base64") });
  const rpc = fakeSolanaRpc(accounts, { slot: 455_000_000 });
  const chain = new PantaChainCatalog({ rpcUrl: RPC, clock, retry: { attempts: 1 }, registryUrl: null, fetchImpl: rpc.fetchImpl });
  const failures: { id: string; error: unknown }[] = [];
  const venue = new PantaVenue({ apiKey: KEY, clock, retry: { attempts: 1 }, fetchImpl: api.fetch,
    ...(opts.reader === false ? {} : { program: chain, onProgramFailure: (id: string, error: unknown) => failures.push({ id, error }) }) });
  /** A synthetic USDC market: account at its real USDC derivation, plus its API row. */
  const usdc = (e: Omit<SyntheticEvent, "endTime"> & { endTime?: number }, row: Record<string, unknown> = {}) => {
    const address = eventAddress(e.question, "USDC");
    accounts.set(address, { owner: PANTA_PROGRAM_ID, data: encodePantaEvent({ endTime: NOW_S + 86_400, ...e }) });
    rows[address] = apiRow(address, { title: e.question, ...row });
    return address;
  };
  return { clock, rows, api, accounts, rpc, chain, venue, failures, usdc };
}
const body = (raw: RawPayload | undefined) => raw!.body as Record<string, any>;

describe("detail without onChain, completed from the program account", () => {
  test("a documented row plus a verified USDC account read gives a market with the program's rules", async () => {
    const h = rig();
    const m = await h.venue.getMarket(TRAM);
    expect(m).toMatchObject({ id: marketUuid("panta", TRAM), venue: "panta", status: "OPEN", rawStatus: "open",
      question: "Will Tram finish in the Top 3 of BBNaija Season 11?", payloadVersion: PANTA_PAYLOAD_VERSION,
      resolutionSource: `https://live-api.panta.market/api/v1/markets/${TRAM}/` });
    expect(m.rulesText).toStartWith("Resolve YES, if Resolves to YES if Tram finishes 1st, 2nd, or 3rd place");
    const raw = h.venue.rawPayload(TRAM)!;
    expect(raw.payloadVersion).toBe(1);
    // The old block's names and semantics: lowercase review, unix seconds, 0 when unset.
    expect(body(raw).onChain).toEqual({ resolutionRule: m.rulesText, sources: ["ng-pop-africamagic"], isResolved: false,
      isCancelled: false, isActive: true, yesWins: false, pendingReview: "none", resolvedAt: 0, cancelledAt: 0,
      claimableAt: 0, reviewExpiresAt: 0 });
    expect(body(raw).onChainSource).toEqual({ source: "solana-account", cluster: "mainnet-beta", programId: PANTA_PROGRAM_ID,
      account: TRAM, owner: PANTA_PROGRAM_ID, slot: 455_000_000, dataEncoding: "base64", data: REAL.USDC_OPEN_TRAM.data,
      fields: ["onChain"] });
    // Everything else is the API's, untouched: title, prices, phase.
    const { onChain: _c, onChainSource: _s, ...rest } = body(raw);
    expect(rest).toEqual(apiRow(TRAM));
    expect(h.failures).toEqual([]);
  });

  test("prices still come only from the API, and its evidence still satisfies the USDC share-price check", async () => {
    const h = rig({ rows: { [TRAM]: apiRow(TRAM, { yesPrice: "0.61", noPrice: "0.44" }) } });
    const prices = await h.venue.getIndicativePrices(TRAM);
    expect(prices).toMatchObject({ currency: "USDC", yesPrice: "0.61", noPrice: "0.44" }); // chain says 0.5
    expect(() => assertSharePriceEvidence(sharePriceFromIndicative(prices), h.venue.rawPayload(TRAM)!, TRAM)).not.toThrow();
    const nulls = rig();
    expect(await nulls.venue.getIndicativePrices(TRAM)).toMatchObject({ yesPrice: null, noPrice: null });
  });

  test("an inactive account pauses the market; an active one is open", async () => {
    const h = rig();
    const paused = h.usdc({ question: "Will the synthetic paused market resolve?", isActive: false });
    const open = h.usdc({ question: "Will the synthetic open market resolve?" });
    expect((await h.venue.getMarket(paused)).status).toBe("PAUSED");
    expect((await h.venue.getMarket(open)).status).toBe("OPEN");
  });

  test("a blank API title becomes the proven question; a present one is kept", async () => {
    const h = rig({ rows: { [TRAM]: apiRow(TRAM, { title: " " }) } });
    const m = await h.venue.getMarket(TRAM);
    expect(m.question).toBe("Will Tram finish in the Top 3 of BBNaija Season 11?⁠"); // the account's exact bytes
    expect(body(h.venue.rawPayload(TRAM)).onChainSource.fields).toEqual(["onChain", "title"]);
    const kept = rig({ rows: { [TRAM]: apiRow(TRAM, { title: "Tram top 3?" }) } });
    expect((await kept.venue.getMarket(TRAM)).question).toBe("Tram top 3?");
  });

  test("the list hydrates rows through the same merge, so USDC markets are listed again", async () => {
    const h = rig();
    const list = stubFetch(url => url.pathname.endsWith("/markets/")
      ? jsonResponse({ items: [apiRow(TRAM)], nextCursor: null }) : jsonResponse(apiRow(TRAM)));
    const venue = new PantaVenue({ apiKey: KEY, clock: h.clock, fetchImpl: list.fetch, program: h.chain });
    const page = await venue.listEvents({});
    expect(page.events.map(e => e.venueEventId)).toEqual([TRAM]);
    expect(page.events[0]!.markets[0]!.rulesText).toStartWith("Resolve YES");
  });

  test("an account read is reused for 15 s, then read again", async () => {
    const h = rig();
    await h.chain.readUsdcEvent(TRAM);
    await h.chain.readUsdcEvent(TRAM);
    const reads = () => h.rpc.asked.filter(a => a.method === "getAccountInfo").length;
    expect(reads()).toBe(1);
    h.clock.advance(15_000);
    await h.chain.readUsdcEvent(TRAM);
    expect(reads()).toBe(2);
    // A USDC read is never served as a SOL market.
    await expect(h.chain.readSolMarket(TRAM)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
  });
});

describe("the funded path", () => {
  test("a buy on a documented row gets past the market read again and reserves its intent", async () => {
    // On-device 2026-10-08 two funded calls were refused right here.
    const h = rig();
    let reserved = 0;
    const service = new PantaTradingService({
      store: {
        callIntent: async () => ({ callId: "c1", marketId: marketUuid("panta", TRAM), venueMarketId: TRAM, side: "YES", tradable: true }),
        find: async () => null, byOrder: async () => null, activeForCall: async () => null,
        reserve: async () => { reserved++; return null; }, update: async () => null,
      },
      execution: { buildBuy: async () => { throw new Error("unreachable"); } } as never,
      chain: { broadcast: async () => {} }, venue: h.venue, maxAmountBaseUnits: "100000000",
      wallets: { status: async () => "active" as const }, now: () => NOW,
    });
    await expect(service.prepare("alice", { callId: "c1", wallet: REAL.SOL_OPEN_HYPE.address, amountBaseUnits: "2000000",
      idempotencyKey: "k1", maxSlippageBps: 100 })).rejects.toThrow("Could not reserve the trade intent");
    expect(reserved).toBe(1);
    const unread = rig({ reader: false });
    const refused = new PantaTradingService({ ...(service as unknown as { deps: ConstructorParameters<typeof PantaTradingService>[0] }).deps, venue: unread.venue });
    await expect(refused.prepare("alice", { callId: "c1", wallet: REAL.SOL_OPEN_HYPE.address, amountBaseUnits: "2000000",
      idempotencyKey: "k2", maxSlippageBps: 100 })).rejects.toThrow("no published question or resolution rules");
    expect(reserved).toBe(1);
  });
});

describe("refusals: never invented, never another market's account", () => {
  test("no reader configured: a row without onChain is refused, as before", async () => {
    const h = rig({ reader: false });
    await expect(h.venue.getMarket(TRAM)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND",
      message: expect.stringContaining("no published question or resolution rules") });
    expect(h.rpc.asked).toEqual([]);
  });

  test("an address whose account derives as SOL is refused, and so is one the program does not list", async () => {
    const hype = REAL.SOL_OPEN_HYPE.address;
    const stranger = "Vote111111111111111111111111111111111111111";
    const h = rig({ rows: { [hype]: apiRow(hype), [stranger]: apiRow(stranger) } });
    h.accounts.set(stranger, { owner: "Stake11111111111111111111111111111111111111", data: Buffer.alloc(4_096, 1) });
    await expect(h.venue.getMarket(hype)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
    await expect(h.venue.getMarket(stranger)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
    await expect(h.chain.readUsdcEvent(hype)).rejects.toThrow("Not a USDC-quoted Panta market");
    const fullReads = h.rpc.asked.filter(a => a.method === "getAccountInfo" || a.method === "getMultipleAccounts");
    expect(fullReads.flatMap(a => a.addresses)).not.toContain(stranger);
    expect(h.failures.map(f => f.id)).toEqual([hype, stranger]);
  });

  test("a USDC account presented at another market's address is refused", async () => {
    const h = rig();
    const other = eventAddress("Some other synthetic question?", "USDC");
    h.rows[other] = apiRow(other);
    h.accounts.set(other, { owner: PANTA_PROGRAM_ID, data: Buffer.from(REAL.USDC_OPEN_TRAM.data, "base64") });
    await expect(h.venue.getMarket(other)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
  });

  test("an RPC outage falls through to the refusal and never leaks the RPC URL", async () => {
    const h = rig();
    h.rpc.failWith(() => new Response("down", { status: 503 }));
    await expect(h.venue.getMarket(TRAM)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
    expect(h.failures).toHaveLength(1);
    expect(String((h.failures[0]!.error as Error).message)).not.toContain("synthetic-provider-key");
    expect(body(h.venue.rawPayload(TRAM)).onChain).toBeUndefined();
  });

  test("a row that still carries onChain behaves exactly as before: no RPC, body untouched", async () => {
    const legacy = apiRow(TRAM, { onChain: { resolutionRule: "Exact API rule.", isActive: false } });
    const h = rig({ rows: { [TRAM]: legacy } });
    const m = await h.venue.getMarket(TRAM);
    expect(m).toMatchObject({ rulesText: "Exact API rule.", status: "PAUSED" });
    expect(h.venue.rawPayload(TRAM)!.body).toEqual(legacy);
    expect(h.rpc.asked).toEqual([]);
  });
});

describe("settlement from the merged evidence", () => {
  const resolvedRow = { phase: "resolved", status: "resolved", resolved: true, endTime: NOW_S - 7_200 };
  const final = { endTime: NOW_S - 7_200, isResolved: true, resolvedAt: NOW_S - 3_600, claimableAt: NOW_S - 3_600 };
  const resolutionOf = async (h: ReturnType<typeof rig>, address: string) => {
    const m = await h.venue.getMarket(address);
    return { status: m.status, published: h.venue.publishedResolution(address) };
  };

  test("YES, NO and VOID are read from the program's own final flags", async () => {
    const h = rig();
    const yes = h.usdc({ question: "Will the synthetic USDC market resolve YES?", ...final, yesWins: true }, resolvedRow);
    const no = h.usdc({ question: "Will the synthetic USDC market resolve NO?", ...final, yesWins: false }, resolvedRow);
    const voided = h.usdc({ question: "Will the synthetic USDC market be cancelled?", endTime: NOW_S - 7_200,
      isCancelled: true, cancelledAt: NOW_S - 3_600 }, { phase: "cancelled", status: "cancelled", endTime: NOW_S - 7_200 });
    expect(await resolutionOf(h, yes)).toEqual({ status: "RESOLVED", published: { resolution: "YES", resolvedAt: (NOW_S - 3_600) * 1000 } });
    expect(await resolutionOf(h, no)).toEqual({ status: "RESOLVED", published: { resolution: "NO", resolvedAt: (NOW_S - 3_600) * 1000 } });
    expect(await resolutionOf(h, voided)).toEqual({ status: "CANCELLED", published: { resolution: "VOID", resolvedAt: (NOW_S - 3_600) * 1000 } });
  });

  test("nothing is published under review, inside the review window, before claimable, or on the API's word alone", async () => {
    const h = rig();
    const cases = [
      h.usdc({ question: "Synthetic primary-invalidity review?", ...final, yesWins: true, pendingReview: 1 }, resolvedRow),
      h.usdc({ question: "Synthetic resolution dispute?", ...final, yesWins: true, pendingReview: 2 }, resolvedRow),
      h.usdc({ question: "Synthetic review window open?", ...final, yesWins: true, reviewExpiresAt: NOW_S + 3_600 }, resolvedRow),
      h.usdc({ question: "Synthetic not yet claimable?", ...final, yesWins: true, claimableAt: NOW_S + 3_600 }, resolvedRow),
      // The API says resolved; the program does not.
      h.usdc({ question: "Synthetic API ahead of the program?", endTime: NOW_S - 7_200 }, resolvedRow),
    ];
    for (const address of cases) {
      expect(await resolutionOf(h, address)).toEqual({ status: "CLOSED_PENDING_RESOLUTION", published: null });
    }
    expect(body(h.venue.rawPayload(cases[0]!)).onChain.pendingReview).toBe("primary_invalidity");
    expect(body(h.venue.rawPayload(cases[1]!)).onChain.pendingReview).toBe("resolution_dispute");
  });

  test("stored evidence settles on its own after a restart, and evidence that disagrees with its bytes is refused", async () => {
    const h = rig();
    const yes = h.usdc({ question: "Will the stored synthetic market resolve YES?", ...final, yesWins: true }, resolvedRow);
    await h.venue.getMarket(yes);
    const stored = h.venue.rawPayload(yes)!;
    const fresh = new PantaVenue({ apiKey: KEY, clock: h.clock, fetchImpl: stubFetch(() => jsonResponse({})).fetch });
    expect(fresh.publishedResolution(yes, stored)).toEqual({ resolution: "YES", resolvedAt: (NOW_S - 3_600) * 1000 });
    const lie = (patch: (b: Record<string, any>) => void) => {
      const b = structuredClone(stored.body) as Record<string, any>; patch(b);
      return { ...stored, body: b };
    };
    expect(() => fresh.publishedResolution(yes, lie(b => { b.onChain.yesWins = false; }))).toThrow("does not match its bytes");
    expect(() => fresh.publishedResolution(yes, lie(b => { b.onChain.extra = 1; }))).toThrow("does not match its bytes");
    expect(() => fresh.publishedResolution(yes, lie(b => { b.onChainSource.fields = ["onChain", "title"]; b.title = "Edited?"; })))
      .toThrow("does not match its bytes");
    expect(() => fresh.publishedResolution(yes, lie(b => { b.onChainSource.data = REAL.USDC_OPEN_TRAM.data; }))).toThrow("not this market's account");
    expect(() => fresh.publishedResolution(yes, lie(b => { b.onChainSource.owner = "11111111111111111111111111111111"; }))).toThrow("envelope");
  });
});

describe("wiring", () => {
  test("a live Panta runtime gives its program reader to every PantaVenue, SOL markets or not", () => {
    for (const env of [{}, { PANTA_SOL_MARKETS: "true" }]) {
      const app = loadConfig({ PANTA_API_KEY: KEY, PANTA_CATALOG_RPC_URL: RPC, ...env });
      const rt = buildPredictionRuntime(app);
      expect(rt.pantaProgram?.program).toBeInstanceOf(PantaChainCatalog);
      expect(typeof rt.pantaProgram?.onProgramFailure).toBe("function");
    }
  });

  test("an insecure catalog RPC disables program reads without SOL markets, and still fails boot with them", () => {
    const off = loadConfig({ PANTA_API_KEY: KEY, PANTA_CATALOG_RPC_URL: "http://insecure.invalid" });
    expect(buildPredictionRuntime(off).pantaProgram).toBeUndefined();
    const on = loadConfig({ PANTA_API_KEY: KEY, PANTA_CATALOG_RPC_URL: "http://insecure.invalid", PANTA_SOL_MARKETS: "true" });
    expect(() => buildPredictionRuntime(on)).toThrow("secure mainnet RPC");
  });
});
