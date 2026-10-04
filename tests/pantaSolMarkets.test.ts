/**
 * Panta's SOL-quoted markets: callable, honestly priced, settled by the
 * program, never tradable.
 *
 * Measured 2026-10-04 (UTC): the Panta program held 201 Event accounts; 12
 * were open — 6 USDC-quoted (all six already in Chumbucket) and 6 SOL-quoted,
 * which Panta's partner API never lists. These tests pin the decoder to real
 * mainnet bytes, then exercise the whole path: discovery, pricing, calls,
 * settlement, catalog, and the trade refusal.
 */
import { describe, expect, test } from "bun:test";
import { CallsService } from "../src/calls/CallsService.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { CallReceiptsProjection } from "../src/calls/receipts.ts";
import { ResolutionSync } from "../src/calls/ResolutionSync.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { catalogPage } from "../src/prediction/catalog.ts";
import { MarketSync } from "../src/prediction/marketSync.ts";
import { pantaQuoteCurrency, servedMarket } from "../src/prediction/marketQuote.ts";
import { PantaCatalogVenue } from "../src/prediction/PantaCatalogVenue.ts";
import { PantaChainCatalog } from "../src/prediction/PantaChainCatalog.ts";
import { PANTA_CHAIN_PAYLOAD_VERSION, PANTA_PROGRAM_ID, decodePantaEvent, normalizePantaChainMarket,
  pantaChainRead, pantaChainReadFromRaw, pantaEventPrices, pantaEventResolution, pantaEventStatus,
  pantaQuoteAsset } from "../src/prediction/PantaProgram.ts";
import { PantaTradingService } from "../src/prediction/PantaTradingService.ts";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { assertSharePriceEvidence, sharePriceFromIndicative } from "../src/prediction/sharePrices.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import { marketUuid } from "../src/prediction/types.ts";
import * as REAL from "./fixtures/pantaChainAccounts.ts";
import { encodePantaEvent, eventAddress, fakeSolanaRpc, type FakeAccount } from "./pantaChainFixtures.ts";
import { TestClock, jsonResponse, stubFetch } from "./predictionFixtures.ts";
import { person } from "./socialCallsFixtures.ts";

/** 2026-10-04T01:00Z, an hour after the fixtures were captured. */
const NOW = 1_791_075_600_000;
const NOW_S = NOW / 1000;
const bytes = (a: REAL.CapturedAccount) => Buffer.from(a.data, "base64");
const readOf = (a: REAL.CapturedAccount, category: string | null = "crypto") =>
  pantaChainRead({ address: a.address, owner: a.owner, data: bytes(a), slot: REAL.CAPTURED_SLOT, fetchedAt: NOW, category });

describe("decoder, pinned to real mainnet accounts", () => {
  test("a SOL market decodes to exactly what panta.market shows", () => {
    const read = readOf(REAL.SOL_OPEN_HYPE);
    expect(read.quoteAsset).toBe("SOL");
    expect(read.event.question).toBe("Will HYPE reach $100 by December 31, 2026?");
    expect(read.event.resolutionRule.startsWith("Resolve YES, if HYPE reaches or exceeds")).toBe(true);
    expect(read.event.sourceOfTruth).toEqual(["world-crypto-coinbase", "world-crypto-coinmarketcap", "world-crypto-coingecko"]);
    // panta.market: "Yes 67.2% No 32.8%".
    expect(pantaEventPrices(read.event)).toEqual({ yesPrice: "0.671739755", noPrice: "0.328260245" });
    const m = normalizePantaChainMarket(read, NOW);
    expect(m).toMatchObject({ id: marketUuid("panta", REAL.SOL_OPEN_HYPE.address), venue: "panta", status: "OPEN",
      rawStatus: "secondary", category: "crypto", closesAt: read.event.endTime * 1000, opensAt: null,
      payloadVersion: PANTA_CHAIN_PAYLOAD_VERSION, resolutionSource: `https://explorer.solana.com/address/${REAL.SOL_OPEN_HYPE.address}` });
    expect(pantaQuoteCurrency(m)).toBe("SOL");
    expect(servedMarket(m)).toMatchObject({ quoteCurrency: "SOL", tradable: false });
    expect(readOf(REAL.SOL_OPEN_OBI).event.question).toStartWith("Will Peter Obi be Elected President of Nigeria");
  });

  test("the address derivation proves the quote asset: USDC markets are classified, not guessed", () => {
    const usdc = readOf(REAL.USDC_OPEN_TRAM);
    expect(usdc.quoteAsset).toBe("USDC");
    for (const a of [REAL.SOL_OPEN_HYPE, REAL.SOL_OPEN_OBI, REAL.SOL_RESOLVED_YES, REAL.SOL_RESOLVED_NO, REAL.SOL_CANCELLED]) {
      expect(pantaQuoteAsset(a.address, decodePantaEvent(bytes(a)))).toBe("SOL");
    }
  });

  test("results come only from the program's own final flags", () => {
    expect(pantaEventResolution(readOf(REAL.SOL_RESOLVED_YES).event, NOW)?.resolution).toBe("YES");
    expect(pantaEventResolution(readOf(REAL.SOL_RESOLVED_NO).event, NOW)?.resolution).toBe("NO");
    expect(pantaEventResolution(readOf(REAL.SOL_CANCELLED).event, NOW)?.resolution).toBe("VOID");
    expect(pantaEventResolution(readOf(REAL.SOL_OPEN_HYPE).event, NOW)).toBeNull();
    expect(normalizePantaChainMarket(readOf(REAL.SOL_RESOLVED_YES), NOW).status).toBe("RESOLVED");
    expect(normalizePantaChainMarket(readOf(REAL.SOL_CANCELLED), NOW).status).toBe("CANCELLED");
  });

  test("tampered, truncated, foreign or relabelled accounts are refused", () => {
    const real = bytes(REAL.SOL_OPEN_HYPE);
    // Change one letter of the question: the address no longer derives from it.
    const at = real.indexOf(Buffer.from("HYPE reach"));
    const edited = Buffer.from(real); edited[at] = "X".charCodeAt(0);
    expect(() => pantaChainRead({ address: REAL.SOL_OPEN_HYPE.address, owner: PANTA_PROGRAM_ID, data: edited, slot: 1, fetchedAt: NOW, category: null }))
      .toThrow("does not derive");
    expect(() => decodePantaEvent(real.subarray(0, 300))).toThrow("truncated");
    const wrongDisc = Buffer.from(real); wrongDisc[0] = 0;
    expect(() => decodePantaEvent(wrongDisc)).toThrow("not a Panta event");
    expect(() => pantaChainRead({ address: REAL.SOL_OPEN_HYPE.address, owner: "11111111111111111111111111111111", data: real, slot: 1, fetchedAt: NOW, category: null }))
      .toThrow("owner");
    // A USDC account presented at a SOL market's address.
    expect(() => pantaChainRead({ address: REAL.SOL_OPEN_HYPE.address, owner: PANTA_PROGRAM_ID, data: bytes(REAL.USDC_OPEN_TRAM), slot: 1, fetchedAt: NOW, category: null }))
      .toThrow("does not derive");
  });

  test("captured evidence re-derives, and evidence that disagrees with its bytes is refused", () => {
    const read = readOf(REAL.SOL_OPEN_HYPE);
    expect(pantaChainReadFromRaw(read.raw, REAL.SOL_OPEN_HYPE.address).event.question).toBe(read.event.question);
    const lying = { ...read.raw, body: { ...(read.raw.body as object), yesPrice: "0.9" } };
    expect(() => pantaChainReadFromRaw(lying, REAL.SOL_OPEN_HYPE.address)).toThrow("does not match its bytes");
    expect(() => pantaChainReadFromRaw({ ...read.raw, payloadVersion: 1 }, REAL.SOL_OPEN_HYPE.address)).toThrow("envelope");
  });

  test("an unknown category is display-only: listed as other, never invented", () => {
    expect(normalizePantaChainMarket(readOf(REAL.SOL_OPEN_HYPE, null), NOW).category).toBe("other");
    expect(normalizePantaChainMarket(readOf(REAL.SOL_OPEN_HYPE, "Not A Slug!"), NOW).category).toBe("other");
  });
});

describe("status and finality on synthetic transitions", () => {
  const base = { question: "Will the synthetic market resolve?", endTime: NOW_S + 86_400 };
  const ev = (over = {}) => decodePantaEvent(encodePantaEvent({ ...base, ...over }));
  test("open, closed past end, paused when inactive or under review", () => {
    expect(pantaEventStatus(ev(), NOW)).toBe("OPEN");
    expect(pantaEventStatus(ev({ endTime: NOW_S - 1 }), NOW)).toBe("CLOSED_PENDING_RESOLUTION");
    expect(pantaEventStatus(ev({ isActive: false }), NOW)).toBe("PAUSED");
    expect(pantaEventStatus(ev({ pendingReview: 1 }), NOW)).toBe("PAUSED");
  });
  test("a resolution under dispute, inside its review window, or not yet claimable is not final", () => {
    const resolved = { endTime: NOW_S - 7200, isResolved: true, yesWins: true, resolvedAt: NOW_S - 3600, claimableAt: NOW_S - 3600 };
    expect(pantaEventResolution(ev(resolved), NOW)).toEqual({ resolution: "YES", resolvedAt: (NOW_S - 3600) * 1000 });
    expect(pantaEventResolution(ev({ ...resolved, pendingReview: 2 }), NOW)).toBeNull();
    expect(pantaEventResolution(ev({ ...resolved, reviewExpiresAt: NOW_S + 60 }), NOW)).toBeNull();
    expect(pantaEventResolution(ev({ ...resolved, claimableAt: NOW_S + 60 }), NOW)).toBeNull();
    expect(pantaEventStatus(ev({ ...resolved, claimableAt: NOW_S + 60 }), NOW)).toBe("CLOSED_PENDING_RESOLUTION");
  });
  test("no usable price at the extremes", () => {
    expect(pantaEventPrices(ev({ lastYesPrice: 0n }))).toEqual({ yesPrice: null, noPrice: null });
    expect(pantaEventPrices(ev({ lastYesPrice: 1_000_000_000n }))).toEqual({ yesPrice: null, noPrice: null });
    expect(pantaEventPrices(ev({ lastYesPrice: 250_000_000n }))).toEqual({ yesPrice: "0.25", noPrice: "0.75" });
  });
});

// ── the whole path ───────────────────────────────────────────────────────────

const KEY = "pk_live_synthetic_tests_only";
const USDC_ID = "So11111111111111111111111111111111111111112";
const usdcRow = {
  marketId: USDC_ID, category: "sports", title: "Synthetic USDC question?", description: "Synthetic.",
  phase: "secondary", status: "secondary_active", resolved: false, startTime: NOW_S - 86_400,
  endTime: NOW_S + 86_400, resolutionTime: NOW_S + 90_000, yesPrice: "0.52", noPrice: "0.48", volumeUsdc: "12.00",
  onChain: { resolutionRule: "Exact synthetic settlement rule.", isActive: true },
};

function rig(opts: { registry?: Record<string, string> } = {}) {
  const clock = new TestClock(NOW);
  const live = new PantaVenue({ apiKey: KEY, clock, retry: { attempts: 1 }, fetchImpl: stubFetch(url => {
    if (url.pathname.endsWith("/markets/")) return jsonResponse({ items: [usdcRow], nextCursor: null });
    const id = url.pathname.split("/").filter(Boolean).at(-1)!;
    return id === USDC_ID ? jsonResponse(usdcRow) : jsonResponse({ code: "NOT_FOUND" }, { status: 404 });
  }).fetch });
  const accounts = new Map<string, FakeAccount>();
  for (const a of [REAL.SOL_OPEN_HYPE, REAL.SOL_OPEN_OBI, REAL.SOL_RESOLVED_YES, REAL.SOL_CANCELLED, REAL.USDC_OPEN_TRAM]) {
    accounts.set(a.address, { owner: a.owner, data: bytes(a) });
  }
  const rpc = fakeSolanaRpc(accounts);
  const registry = stubFetch(url => {
    const pda = url.pathname.split("/").at(-1)!;
    const category = opts.registry?.[pda];
    return category ? jsonResponse({ success: true, data: { eventPda: pda, Category: category } }) : jsonResponse({ success: false }, { status: 404 });
  });
  const unserved: string[] = [];
  const chain = new PantaChainCatalog({ rpcUrl: "https://rpc.synthetic.invalid/?api-key=synthetic-provider-key", clock,
    retry: { attempts: 1 }, onUnserved: a => unserved.push(a),
    fetchImpl: (input, init) => String(input).startsWith("https://rpc.synthetic.invalid") ? rpc.fetchImpl(input, init) : registry.fetch(input, init) });
  const failures: unknown[] = [];
  const venue = new PantaCatalogVenue({ live, chain, clock, onChainFailure: e => failures.push(e) });
  const store = new InMemoryPredictionStore();
  const sync = new MarketSync({ venue, store, clock, venueId: "panta", filters: {} });
  return { clock, accounts, rpc, registry, chain, venue, store, sync, failures, unserved };
}

const HYPE = marketUuid("panta", REAL.SOL_OPEN_HYPE.address);
const OBI = marketUuid("panta", REAL.SOL_OPEN_OBI.address);
const USDC = marketUuid("panta", USDC_ID);

describe("discovery, pricing and calls", () => {
  test("one pass mirrors and prices every open market: the USDC catalog AND the SOL-quoted ones", async () => {
    const h = rig({ registry: { [REAL.SOL_OPEN_HYPE.address]: "crypto", [REAL.SOL_OPEN_OBI.address]: "politics" } });
    const report = await h.sync.runOnce();
    expect(h.failures).toEqual([]);
    // Settled SOL markets and the USDC account on-chain are not listed from the chain.
    expect(new Set(h.store.listMarkets().map(r => r.market.id))).toEqual(new Set([USDC, HYPE, OBI]));
    expect(report.snapshotsRecorded).toBe(3);
    const hype = h.store.latestSharePrice(HYPE)!;
    expect(hype).toMatchObject({ currency: "SOL", unit: "per_share", yesPrice: "0.671739755", noPrice: "0.328260245", attribution: "Powered by Panta" });
    expect(h.store.latestSharePrice(USDC)).toMatchObject({ currency: "USDC", yesPrice: "0.52", noPrice: "0.48" });
    expect(h.store.getMarket(OBI)!.market.category).toBe("politics");
    // Display categories are looked up only for markets discovery will show.
    expect(new Set(h.registry.calls.map(c => c.url.split("/").at(-1)))).toEqual(new Set([REAL.SOL_OPEN_HYPE.address, REAL.SOL_OPEN_OBI.address]));

    const calls = new InMemoryCallsStore();
    calls.upsertPerson(person("alice"));
    const service = new CallsService({ store: calls, markets: predictionStoreReader(h.store), clock: h.clock,
      receipts: new CallReceiptsProjection(), allowPantaCalls: true });
    const open = service.openMarkets();
    expect(open.map(m => m.id)).toEqual([USDC, HYPE, OBI]); // soonest close first
    expect(open.find(m => m.id === HYPE)).toMatchObject({ quoteCurrency: "SOL", tradable: false });
    expect(open.find(m => m.id === USDC)).toMatchObject({ quoteCurrency: "USDC", tradable: true });

    // A free call on a SOL market pins the SOL price it was made at.
    const made = service.createCall({ marketId: HYPE, side: "YES" }, "alice");
    expect(made.call.entryPrice).toEqual(hype);
    expect(made.call.entryProbability).toBeNull();
    expect(service.marketDetail({ marketId: HYPE }, "alice")).toMatchObject({
      market: { quoteCurrency: "SOL", tradable: false }, sharePrice: { currency: "SOL" } });
    expect(service.feed({ mode: "global" }, "alice").entries[0]!.market).toMatchObject({ id: HYPE, tradable: false });
  });

  test("the catalog lists SOL markets with their quote asset and no invented USDC volume", async () => {
    const h = rig();
    await h.sync.runOnce();
    const page = catalogPage(h.store.listMarkets(), { venue: "panta", now: NOW, scope: "open", limit: 50,
      isResolved: id => h.store.getResolution(id) !== undefined });
    expect(page.markets.map(m => [m.id, m.quoteCurrency, m.tradable, m.volumeUsdc])).toEqual([
      [USDC, "USDC", true, "12.00"], [HYPE, "SOL", false, null], [OBI, "SOL", false, null]]);
    // Without a registry answer the category is "other", never guessed.
    expect(page.categories.map(c => c.category).sort()).toEqual(["other", "sports"]);
  });

  test("a later pass reads only what can still change: USDC accounts are classified once", async () => {
    const h = rig();
    await h.sync.runOnce();
    const firstRead = h.rpc.asked.filter(a => a.method === "getMultipleAccounts").flatMap(a => a.addresses);
    expect(firstRead).toContain(REAL.USDC_OPEN_TRAM.address);
    h.rpc.asked.length = 0;
    h.clock.advance(60_000);
    await h.sync.runOnce();
    const later = h.rpc.asked.filter(a => a.method !== "getProgramAccounts").flatMap(a => a.addresses);
    expect(later).not.toContain(REAL.USDC_OPEN_TRAM.address);
    expect(later).not.toContain(REAL.SOL_RESOLVED_YES.address); // final: not re-listed
    expect(h.rpc.asked.filter(a => a.method === "getGenesisHash")).toHaveLength(0); // checked once
  });

  test("discovery is shared: concurrent and repeated listings within 30s cost one read", async () => {
    const h = rig();
    await Promise.all([h.chain.listSolMarkets(), h.chain.listSolMarkets(), h.chain.listSolMarkets()]);
    h.clock.advance(10_000);
    await h.chain.listSolMarkets();
    expect(h.rpc.asked.filter(a => a.method === "getProgramAccounts")).toHaveLength(1);
    h.clock.advance(30_000);
    await h.chain.listSolMarkets();
    expect(h.rpc.asked.filter(a => a.method === "getProgramAccounts")).toHaveLength(2);
  });

  test("an RPC outage never fails the USDC walk, and the RPC URL never reaches an error", async () => {
    const h = rig();
    h.rpc.failWith(() => new Response("down", { status: 503 }));
    const report = await h.sync.runOnce();
    expect(h.store.listMarkets().map(r => r.market.id)).toEqual([USDC]);
    expect(report.snapshotsRecorded).toBe(1);
    expect(h.failures).toHaveLength(1);
    expect(String((h.failures[0] as Error).message)).not.toContain("synthetic-provider-key");
    expect(String((h.failures[0] as Error).message)).not.toContain("rpc.synthetic.invalid");
  });

  test("a non-mainnet RPC is refused", async () => {
    const clock = new TestClock(NOW);
    const rpc = fakeSolanaRpc(new Map(), { genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" });
    const chain = new PantaChainCatalog({ rpcUrl: "https://devnet.synthetic.invalid", clock, fetchImpl: rpc.fetchImpl, registryUrl: null });
    await expect(chain.listSolMarkets()).rejects.toThrow("not Solana mainnet");
    expect(() => new PantaChainCatalog({ rpcUrl: "http://insecure.invalid" })).toThrow("secure mainnet RPC");
  });

  test("after a restart a SOL market is priced, read and evidenced before any listing classifies it", async () => {
    // A fresh process: the mirror holds the row, the chain catalog knows nothing
    // yet, and a lock's price re-read or a pricing pass reaches the venue first.
    const h = rig();
    const address = REAL.SOL_OPEN_HYPE.address;
    const prices = await h.venue.getIndicativePrices(address);
    expect(prices).toMatchObject({ marketId: HYPE, currency: "SOL", yesPrice: "0.671739755", noPrice: "0.328260245" });
    const raw = h.venue.rawPayload(address)!;
    expect(raw.payloadVersion).toBe(PANTA_CHAIN_PAYLOAD_VERSION);
    expect(() => assertSharePriceEvidence(sharePriceFromIndicative(prices), raw, address)).not.toThrow();
    expect(await h.venue.getOrderbook(address)).toMatchObject({ marketId: HYPE, bids: [], asks: [], snapshot: null });
    // A USDC market the partner API serves never touches the chain.
    h.rpc.asked.length = 0;
    expect(await h.venue.getIndicativePrices(USDC_ID)).toMatchObject({ currency: "USDC", yesPrice: "0.52" });
    expect(h.rpc.asked).toEqual([]);
  });

  test("a public read naming any address never downloads an account the program does not list", async () => {
    // predictions.getMarket / indicativePrices take any well-formed address.
    // The partner API answers 404 for it; the chain fallback must not then
    // fetch whatever account lives there (a provider-billed, possibly huge
    // read), report it, or remember it.
    const h = rig();
    const stranger = "Vote111111111111111111111111111111111111111";
    h.accounts.set(stranger, { owner: "Stake11111111111111111111111111111111111111", data: Buffer.alloc(1_000_000, 1) });
    for (let i = 0; i < 4; i++) {
      await expect(h.venue.getMarket(stranger)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
      await expect(h.venue.getIndicativePrices(stranger)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
    }
    const fullReads = h.rpc.asked.filter(a => a.method === "getAccountInfo" || a.method === "getMultipleAccounts");
    expect(fullReads.flatMap(a => a.addresses)).not.toContain(stranger);
    // One address-only listing answers every miss for 30s.
    expect(h.rpc.asked.filter(a => a.method === "getProgramAccounts")).toHaveLength(1);
    h.clock.advance(31_000);
    await expect(h.venue.getMarket(stranger)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
    expect(h.rpc.asked.filter(a => a.method === "getProgramAccounts")).toHaveLength(2);
    expect(h.unserved).toEqual([]);
  });

  test("one undecodable account is set aside and reported; every other market is still served", async () => {
    const h = rig();
    const broken = Buffer.from(bytes(REAL.SOL_OPEN_HYPE)); broken[broken.indexOf(Buffer.from("HYPE reach"))] = 0x58;
    h.accounts.set(REAL.SOL_OPEN_HYPE.address, { owner: PANTA_PROGRAM_ID, data: broken });
    await h.sync.runOnce();
    expect(h.unserved).toEqual([REAL.SOL_OPEN_HYPE.address]);
    expect(h.store.getMarket(HYPE)).toBeUndefined();
    expect(h.store.getMarket(OBI)).toBeDefined();
  });
});

describe("settlement", () => {
  test("a SOL market that resolves is settled from its account, and the call is decided", async () => {
    const question = "Will the synthetic SOL market resolve YES?";
    const address = eventAddress(question, "SOL");
    const h = rig();
    h.accounts.set(address, { owner: PANTA_PROGRAM_ID, data: encodePantaEvent({ question, endTime: NOW_S + 600, lastYesPrice: 400_000_000n }) });
    await h.sync.runOnce();
    const id = marketUuid("panta", address);
    const calls = new InMemoryCallsStore(); calls.upsertPerson(person("alice"));
    const receipts = new CallReceiptsProjection();
    const reader = predictionStoreReader(h.store);
    const service = new CallsService({ store: calls, markets: reader, clock: h.clock, receipts, allowPantaCalls: true });
    const made = service.createCall({ marketId: id, side: "YES" }, "alice");
    expect(made.call.entryPrice).toMatchObject({ currency: "SOL", yesPrice: "0.4", noPrice: "0.6" });

    // The market ends and the program publishes YES.
    h.clock.advance(3_600_000);
    const at = Math.floor(h.clock.now() / 1000) - 60;
    h.accounts.set(address, { owner: PANTA_PROGRAM_ID, data: encodePantaEvent({ question, endTime: NOW_S + 600,
      isResolved: true, yesWins: true, resolvedAt: at, claimableAt: at }) });
    // Not listed any more (it is final): the unlisted sweep re-reads it.
    await h.sync.runOnce();
    const resolution = h.store.getResolution(id);
    expect(resolution).toMatchObject({ resolution: "YES", venue: "panta", venueMarketId: address,
      evidenceSource: `https://explorer.solana.com/address/${address}` });
    expect((resolution!.rawEvidence as { source: string }).source).toBe("solana-account");
    const settled = new ResolutionSync({ store: calls, markets: reader, clock: h.clock, receipts }).runOnce();
    expect(settled.resultsSettled).toBe(1);
    expect(calls.getResult(made.call.id)?.outcome).toBe("CORRECT");
  });

  test("a persisted row settles after a restart from its stored bytes alone", () => {
    const h = rig();
    const read = readOf(REAL.SOL_RESOLVED_NO);
    const raw = read.raw;
    // A fresh venue that has never read this account (e.g. after hydrate).
    expect(h.venue.publishedResolution(REAL.SOL_RESOLVED_NO.address, raw)).toEqual(pantaEventResolution(read.event, NOW));
    expect(h.venue.publishedResolution(REAL.SOL_OPEN_HYPE.address, readOf(REAL.SOL_OPEN_HYPE).raw)).toBeNull();
  });
});

describe("prices are evidenced in their own currency", () => {
  const read = readOf(REAL.SOL_OPEN_HYPE);
  const sol = sharePriceFromIndicative({ marketId: HYPE, venueMarketId: REAL.SOL_OPEN_HYPE.address, venue: "panta",
    currency: "SOL", unit: "per_share", yesPrice: "0.671739755", noPrice: "0.328260245", observedAt: NOW,
    executable: false, attribution: "Powered by Panta", demo: false });
  test("a SOL price needs matching chain evidence; it cannot borrow USDC evidence or relabel itself", () => {
    expect(() => assertSharePriceEvidence(sol, read.raw, REAL.SOL_OPEN_HYPE.address)).not.toThrow();
    expect(() => assertSharePriceEvidence({ ...sol, currency: "USDC" }, read.raw, REAL.SOL_OPEN_HYPE.address)).toThrow("matching");
    expect(() => assertSharePriceEvidence({ ...sol, yesPrice: "0.7" }, read.raw, REAL.SOL_OPEN_HYPE.address)).toThrow("matching");
    const usdcEvidence = { ...read.raw, payloadVersion: 1, body: { yesPrice: sol.yesPrice, noPrice: sol.noPrice } };
    expect(() => assertSharePriceEvidence(sol, usdcEvidence, REAL.SOL_OPEN_HYPE.address)).toThrow("matching");
  });
});

describe("trading", () => {
  test("a call on a SOL market is refused a trade before any reservation or provider read", async () => {
    let reserved = 0, built = 0, read = 0;
    const service = new PantaTradingService({
      store: {
        callIntent: async () => ({ callId: "c1", marketId: HYPE, venueMarketId: REAL.SOL_OPEN_HYPE.address, side: "YES", tradable: false }),
        find: async () => null, byOrder: async () => null, activeForCall: async () => null,
        reserve: async () => { reserved++; return null; }, update: async () => null,
      },
      execution: { buildBuy: async () => { built++; throw new Error("unreachable"); } } as never,
      chain: { broadcast: async () => {} },
      venue: { getMarket: async () => { read++; throw new Error("unreachable"); } } as never,
      maxAmountBaseUnits: "100000000",
      wallets: { status: async () => "active" as const },
    });
    await expect(service.prepare("alice", { callId: "c1", wallet: REAL.SOL_OPEN_HYPE.address, amountBaseUnits: "1000000",
      idempotencyKey: "k1", maxSlippageBps: 100 })).rejects.toThrow("Trading isn't available on this market");
    expect([reserved, built, read]).toEqual([0, 0, 0]);
  });
});
