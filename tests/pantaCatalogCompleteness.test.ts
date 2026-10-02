/**
 * The Markets tab must offer the whole open Panta catalog, honestly.
 *
 * Measured against production on 2026-10-02: Panta's public USDC catalog held
 * ~89 rows across two 50-row pages, six of them open. The fixes covered here:
 *  - pricing is no longer limited to the pages one pass happened to visit;
 *  - rows Panta stops listing once they end are re-read until the venue
 *    settles them, instead of reading OPEN in the mirror forever;
 *  - `predictions.catalog` can serve just the open slice, closing-soonest or
 *    most-active first, with category facets taken from the rows themselves,
 *    and never serves OPEN past a market's own close time.
 * All rows are synthetic, with the documented/observed Panta field names.
 */
import { expect, test } from "bun:test";
import { PantaVenue, pantaReportedVolume } from "../src/prediction/PantaVenue.ts";
import { MarketSync, UNLISTED_SWEEP_SUFFIX } from "../src/prediction/marketSync.ts";
import { InMemoryPredictionStore } from "../src/prediction/store.ts";
import { buildPredictionRuntime, setPredictionRuntime } from "../src/prediction/runtime.ts";
import { resolvePredictionConfig, withPredictionConfig } from "../src/prediction/config.ts";
import { catalogPage, effectiveStatus } from "../src/prediction/catalog.ts";
import { predictionsRouter } from "../src/api/predictions.ts";
import { marketUuid } from "../src/prediction/types.ts";
import { T0, TestClock, jsonResponse, stubFetch } from "./predictionFixtures.ts";
import { market, testApp } from "./socialCallsFixtures.ts";

const key = "pk_live_synthetic_tests_only";
// Real 32-byte base58 addresses (well-known program ids), used only as ids.
const A = "11111111111111111111111111111111";
const B = "So11111111111111111111111111111111111111112";
const C = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const D = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW_S = Math.floor(T0 / 1000);

const row = (marketId: string, over: Record<string, unknown> = {}) => ({
  marketId, category: "crypto", title: `Synthetic question ${marketId.slice(0, 4)}?`,
  description: "Synthetic fixture, not a real market.", phase: "secondary",
  status: "secondary_active", resolved: false, startTime: NOW_S - 86_400,
  endTime: NOW_S + 86_400, resolutionTime: NOW_S + 90_000,
  yesPrice: "0.5", noPrice: "0.5", volumeUsdc: "0.00",
  onChain: { resolutionRule: "Exact synthetic settlement rule.", isActive: true },
  ...over,
});
const settled = (marketId: string) => row(marketId, {
  phase: "resolved", status: "resolved", resolved: true, endTime: NOW_S - 7_200,
  onChain: { resolutionRule: "Exact synthetic settlement rule.", isResolved: true, isCancelled: false,
    yesWins: false, pendingReview: "none", resolvedAt: NOW_S - 3_600, claimableAt: NOW_S - 3_600,
    reviewExpiresAt: NOW_S - 3_000 },
});

/** A synthetic Panta: `pages` is the listing, `details` the per-market detail. */
function venueRig(pages: Record<string, unknown>[][], details: Record<string, unknown> = {}) {
  const clock = new TestClock();
  const detail = new Map<string, unknown>(Object.entries(details));
  const http = stubFetch(url => {
    if (url.pathname.endsWith("/markets/")) {
      const page = Number(url.searchParams.get("cursor")?.slice("page-".length) ?? 0);
      const items = pages[page] ?? [];
      return jsonResponse({ items, nextCursor: page + 1 < pages.length ? `page-${page + 1}` : null });
    }
    const id = url.pathname.split("/").filter(Boolean).at(-1)!;
    const body = detail.get(id) ?? pages.flat().find(r => r.marketId === id);
    return body ? jsonResponse(body) : jsonResponse({ code: "MARKET_NOT_FOUND" }, { status: 404 });
  });
  const venue = new PantaVenue({ apiKey: key, fetchImpl: http.fetch, clock, retry: { attempts: 1 } });
  const store = new InMemoryPredictionStore();
  return { clock, http, venue, store, detail, detailReads: (id: string) =>
    http.calls.filter(c => new URL(c.url).pathname.endsWith(`/markets/${id}/`)).length };
}

// ── sync ────────────────────────────────────────────────────────────────────

test("open markets on pages this pass did not visit are still priced", async () => {
  // Three one-row pages, one page per pass: the old pass priced only its page.
  const h = venueRig([[row(A)], [row(B)], [row(C)]]);
  const sync = new MarketSync({ venue: h.venue, store: h.store, clock: h.clock, venueId: "panta",
    pageSize: 1, maxPagesPerPass: 1 });
  for (let i = 0; i < 3; i++) await sync.runOnce();
  // Prices lapse at 10 minutes and refresh at 5; the walk is on page 1 again.
  h.clock.advance(6 * 60_000);
  const passStart = h.clock.now();
  const report = await sync.runOnce();
  expect(report.pages).toBe(1);
  expect(report.snapshotsRecorded).toBe(3);
  for (const id of [A, B, C]) {
    expect(h.store.latestSharePrice(marketUuid("panta", id))!.observedAt).toBeGreaterThanOrEqual(passStart);
  }
});

test("a market the venue stopped confirming is not kept callable by its price", async () => {
  const h = venueRig([[row(A)]]);
  const sync = new MarketSync({ venue: h.venue, store: h.store, clock: h.clock, venueId: "panta",
    listedWithinMs: 3_600_000, unlistedBudget: 0 });
  await sync.runOnce();
  // Panta drops it from the listing (e.g. the market was deleted).
  h.detail.clear();
  const quiet = venueRig([[]]);
  const later = new MarketSync({ venue: quiet.venue, store: h.store, clock: h.clock, venueId: "panta",
    listedWithinMs: 3_600_000, unlistedBudget: 0 });
  h.clock.advance(3_600_001);
  quiet.clock.advance(3_600_001);
  expect((await later.runOnce()).snapshotsRecorded).toBe(0);
  expect(quiet.detailReads(A)).toBe(0);
});

test("ended markets the venue stops listing are re-read until the venue settles them", async () => {
  // Listed while open, then Panta lists it with a blank title after it ends —
  // which the adapter skips — and finally publishes the final evidence.
  const listing = [[row(A)]];
  const h = venueRig(listing);
  const sync = new MarketSync({ venue: h.venue, store: h.store, clock: h.clock, venueId: "panta",
    cursorKey: "test:panta" });
  await sync.runOnce();
  const id = marketUuid("panta", A);
  expect(h.store.getMarket(id)?.market.status).toBe("OPEN");

  listing[0] = [row(A, { title: "", endTime: NOW_S - 60 })];
  h.detail.set(A, row(A, { endTime: NOW_S + 60, phase: "secondary", status: "secondary" }));
  h.clock.advance(120_000); // past its close; awaiting the venue's result
  let report = await sync.runOnce();
  expect(report.marketsSeen).toBe(0);
  expect(report.unlistedRefreshed).toBe(0); // refreshed by the walk 2 minutes ago
  h.clock.advance(600_000);
  report = await sync.runOnce();
  expect(report.unlistedRefreshed).toBe(1);
  expect(h.store.getMarket(id)?.market.status).toBe("CLOSED_PENDING_RESOLUTION");
  expect(h.store.getResolution(id)).toBeUndefined();

  h.detail.set(A, settled(A));
  h.clock.advance(600_000);
  report = await sync.runOnce();
  expect(report.resolutionsRecorded).toBe(1);
  expect(h.store.getResolution(id)?.resolution).toBe("NO");
  expect(h.store.getMarket(id)?.market.status).toBe("RESOLVED");

  // Settled with evidence: never re-read again.
  const reads = h.detailReads(A);
  h.clock.advance(3_600_000);
  expect((await sync.runOnce()).unlistedRefreshed).toBe(0);
  expect(h.detailReads(A)).toBe(reads);
});

test("the unlisted sweep rotates, so a vanished market cannot starve the rest", async () => {
  const h = venueRig([[row(A), row(B), row(C)]]);
  const sync = new MarketSync({ venue: h.venue, store: h.store, clock: h.clock, venueId: "panta",
    cursorKey: "test:panta", unlistedBudget: 1, snapshotBudget: 0 });
  await sync.runOnce();
  // All three leave the listing; A is gone from the venue entirely.
  const quiet = venueRig([[]], { [B]: row(B), [C]: row(C) });
  const later = new MarketSync({ venue: quiet.venue, store: h.store, clock: h.clock, venueId: "panta",
    cursorKey: "test:panta", unlistedBudget: 1, snapshotBudget: 0 });
  const ids = [A, B, C].sort();
  const visited: string[] = [];
  for (let i = 0; i < 3; i++) {
    h.clock.advance(600_000); quiet.clock.advance(600_000);
    const report = await later.runOnce();
    expect(report.unlistedRefreshed + report.unlistedUnavailable).toBe(1);
    visited.push(h.store.getCursor(`test:panta${UNLISTED_SWEEP_SUFFIX}`)!);
  }
  expect(visited).toEqual(ids);
  expect(quiet.detailReads(B)).toBe(1);
  expect(quiet.detailReads(C)).toBe(1);
});

test("mirror-wide sync work never reaches another venue's historical rows", async () => {
  const h = venueRig([[]]);
  h.store.upsertMarket(market("legacy", { venue: "polymarket", venueMarketId: "123456", lastSyncedAt: T0 - 7_200_000 }), null);
  const sync = new MarketSync({ venue: h.venue, store: h.store, clock: h.clock, venueId: "panta" });
  const report = await sync.runOnce();
  expect(report.unlistedRefreshed + report.unlistedUnavailable + report.snapshotsRecorded).toBe(0);
  expect(h.http.calls).toHaveLength(1); // the listing only
});

test("schema drift on an unlisted re-read fails the pass loudly", async () => {
  const h = venueRig([[row(A)]]);
  const sync = new MarketSync({ venue: h.venue, store: h.store, clock: h.clock, venueId: "panta" });
  await sync.runOnce();
  const drifted = venueRig([[]], { [A]: row(A, { endTime: "2026-10-02T00:00:00Z" }) });
  const later = new MarketSync({ venue: drifted.venue, store: h.store, clock: h.clock, venueId: "panta" });
  h.clock.advance(600_000); drifted.clock.advance(600_000);
  await expect(later.runOnce()).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
});

test("one bad unlisted row stays loud but cannot stop pricing or wedge the sweep", async () => {
  // A and C left the listing; A's detail no longer parses. B is open and
  // listed. The sweep used to throw ahead of pricing without advancing its
  // cursor, so every later pass died at A and every share price lapsed.
  const h = venueRig([[row(A), row(B), row(C)]]);
  const sync = new MarketSync({ venue: h.venue, store: h.store, clock: h.clock, venueId: "panta",
    cursorKey: "test:panta" });
  await sync.runOnce();
  const drifted = venueRig([[row(B)]], { [A]: row(A, { endTime: "2026-10-02T00:00:00Z" }), [C]: row(C) });
  const later = new MarketSync({ venue: drifted.venue, store: h.store, clock: h.clock, venueId: "panta",
    cursorKey: "test:panta" });
  h.clock.advance(600_000); drifted.clock.advance(600_000);
  const passStart = drifted.clock.now(); // prices carry the venue's read time
  await expect(later.runOnce()).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
  // The listed open market was still priced by the failing pass.
  expect(h.store.latestSharePrice(marketUuid("panta", B))!.observedAt).toBeGreaterThanOrEqual(passStart);
  // The healthy unlisted row was still re-read, and the rotation moved on.
  expect(drifted.detailReads(C)).toBe(1);
  expect(h.store.getCursor(`test:panta${UNLISTED_SWEEP_SUFFIX}`)).toBe([A, C].sort().at(-1)!);
  // A is revisited and stays loud; it is never silently skipped.
  h.clock.advance(60_000); drifted.clock.advance(60_000);
  await expect(later.runOnce()).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
});

test("a broken off-page price candidate cannot stop the markets after it being priced", async () => {
  // A closes soonest, so it is priced first. It left the listing minutes ago
  // (still a mirror-wide candidate) and its detail no longer parses.
  const h = venueRig([[row(A, { endTime: NOW_S + 3_600 }), row(B)]]);
  const sync = new MarketSync({ venue: h.venue, store: h.store, clock: h.clock, venueId: "panta" });
  await sync.runOnce();
  const drifted = venueRig([[row(B)]], { [A]: row(A, { endTime: "2026-10-02T00:00:00Z" }) });
  const later = new MarketSync({ venue: drifted.venue, store: h.store, clock: h.clock, venueId: "panta",
    unlistedBudget: 0 });
  h.clock.advance(360_000); drifted.clock.advance(360_000);
  const passStart = drifted.clock.now();
  await expect(later.runOnce()).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
  expect(drifted.detailReads(A)).toBe(1);
  expect(h.store.latestSharePrice(marketUuid("panta", B))!.observedAt).toBeGreaterThanOrEqual(passStart);
});

// ── serving ─────────────────────────────────────────────────────────────────

test("Panta's reported volume is read verbatim or not at all", () => {
  expect(pantaReportedVolume({ volumeUsdc: "1200.50" })).toBe("1200.50");
  for (const body of [{}, { volumeUsdc: 1200 }, { volumeUsdc: "1e3" }, { volumeUsdc: "-4" }, null, "x"]) {
    expect(pantaReportedVolume(body)).toBeNull();
  }
});

test("OPEN never outlives its own close time on the wire, and is never promoted to RESOLVED", () => {
  const m = market("m", { closesAt: T0 });
  expect(effectiveStatus(m, T0 - 1)).toBe("OPEN");
  expect(effectiveStatus(m, T0)).toBe("CLOSED_PENDING_RESOLUTION");
  expect(effectiveStatus({ ...m, status: "PAUSED" }, T0 + 1)).toBe("PAUSED");
});

async function catalogRig() {
  const app = await testApp();
  const clock = new TestClock();
  const store = new InMemoryPredictionStore();
  const rt = buildPredictionRuntime(app.config, {
    store, clock, config: resolvePredictionConfig(withPredictionConfig(app.config, { venue: "fixture" }), {}),
  });
  setPredictionRuntime(app.config, rt);
  const put = (id: string, over: Parameters<typeof market>[1] = {}) => store.upsertMarket(market(id, over), null);
  put("btc", { category: "crypto", question: "[DEMO] Will Bitcoin close above 100k?", closesAt: T0 + 3_600_000 });
  put("bbn", { category: "pop-culture", question: "[DEMO] Will a female housemate win?", closesAt: T0 + 7_200_000 });
  put("gta", { category: "gaming", question: "[DEMO] Will GTA 6 release on time?", closesAt: T0 + 86_400_000 });
  put("tram", { category: "pop-culture", question: "[DEMO] Will Tram finish top 3?", closesAt: T0 + 5_400_000 });
  put("ended", { category: "sports", closesAt: T0 - 1 }); // OPEN in the mirror, past close
  put("paused", { category: "sports", status: "PAUSED", closesAt: null });
  put("done", { category: "crypto", status: "RESOLVED", closesAt: T0 - 86_400_000 });
  put("foreign", { venue: "jupiter", category: "crypto" });
  return { anon: predictionsRouter.createCaller({ app }), store, clock };
}

test("legacy catalog input keeps its id order and id cursor, with honest statuses", async () => {
  const { anon } = await catalogRig();
  const first = await anon.catalog({ limit: 3 });
  expect(first.markets.map(m => m.id)).toEqual(["bbn", "btc", "done"]);
  expect(first.nextCursor).toBe("done");
  const rest = await anon.catalog({ limit: 100, cursor: first.nextCursor! });
  expect(rest.markets.map(m => m.id)).toEqual(["ended", "gta", "paused", "tram"]);
  expect(rest.markets.find(m => m.id === "ended")?.status).toBe("CLOSED_PENDING_RESOLUTION");
  expect(rest.nextCursor).toBeNull();
});

test("the open scope is every discoverable market, closing soonest, with real category facets", async () => {
  const { anon } = await catalogRig();
  const page = await anon.catalog({ scope: "open" });
  expect(page.markets.map(m => m.id)).toEqual(["btc", "tram", "bbn", "gta"]);
  expect(page.total).toBe(4);
  expect(page.categories).toEqual([
    { category: "pop-culture", count: 2 }, { category: "crypto", count: 1 }, { category: "gaming", count: 1 },
  ]);
  expect(page.markets.every(m => m.status === "OPEN" && m.volumeUsdc === null)).toBe(true);
});

test("a recorded venue resolution removes a market from the open scope", async () => {
  const { anon, store, clock } = await catalogRig();
  store.recordResolution({ marketId: "btc", venue: "fixture", venueMarketId: "vm-btc", resolution: "YES",
    resolvedAt: T0, evidenceSource: "fixture:oracle", rawEvidence: { demo: true }, demo: true }, clock.now());
  expect((await anon.catalog({ scope: "open" })).markets.map(m => m.id)).not.toContain("btc");
});

test("category and search cover the whole open catalog, not one page", async () => {
  const { anon } = await catalogRig();
  const pop = await anon.catalog({ scope: "open", category: "Pop-Culture", limit: 1 });
  expect(pop.markets.map(m => m.id)).toEqual(["tram"]);
  expect(pop.total).toBe(2);
  // Facets still describe the whole scope while a category is selected.
  expect(pop.categories.map(c => c.category)).toEqual(["pop-culture", "crypto", "gaming"]);
  const next = await anon.catalog({ scope: "open", category: "pop-culture", limit: 1, cursor: pop.nextCursor! });
  expect(next.markets.map(m => m.id)).toEqual(["bbn"]);
  expect(next.nextCursor).toBeNull();
  expect((await anon.catalog({ scope: "open", query: "pop culture" })).markets.map(m => m.id)).toEqual(["tram", "bbn"]);
  expect((await anon.catalog({ scope: "open", query: "  BITCOIN " })).markets.map(m => m.id)).toEqual(["btc"]);
  expect((await anon.catalog({ scope: "open", query: "no such market" })).total).toBe(0);
});

test("pages are keyset-stable when a market lands between two reads", async () => {
  const { anon, store } = await catalogRig();
  const first = await anon.catalog({ scope: "open", limit: 2 });
  expect(first.markets.map(m => m.id)).toEqual(["btc", "tram"]);
  store.upsertMarket(market("early", { closesAt: T0 + 60_000 }), null); // sorts before the boundary
  const second = await anon.catalog({ scope: "open", limit: 2, cursor: first.nextCursor! });
  expect(second.markets.map(m => m.id)).toEqual(["bbn", "gta"]);
});

test("a cursor from another sort, or a forged one, is refused", async () => {
  const { anon } = await catalogRig();
  const first = await anon.catalog({ scope: "open", limit: 1 });
  await expect(anon.catalog({ scope: "open", sort: "volume", cursor: first.nextCursor! }))
    .rejects.toMatchObject({ code: "BAD_REQUEST" });
  for (const cursor of ["btc", "k1.%%%", "k1." + Buffer.from('["x","y"]').toString("base64url")]) {
    await expect(anon.catalog({ scope: "open", cursor })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
});

test("most active sorts by Panta's own reported volume; unreported volume sorts last", () => {
  const now = T0;
  const raw = (id: string, volumeUsdc?: string) => ({
    venue: "panta" as const, venueMarketId: id, payloadVersion: 1, fetchedAt: now,
    body: volumeUsdc === undefined ? { marketId: id } : { marketId: id, volumeUsdc },
  });
  const panta = (id: string, closesAt: number) =>
    market(id, { venue: "panta", venueMarketId: id, closesAt });
  const records = [
    { market: panta("quiet", now + 1_000), raw: raw("quiet", "0.00") },
    { market: panta("busy", now + 9_000), raw: raw("busy", "1200.00") },
    { market: panta("unknown", now + 500), raw: raw("unknown") },
    { market: panta("mid", now + 5_000), raw: raw("mid", "75.5") },
  ];
  const page = catalogPage(records, { venue: "panta", now, scope: "open", sort: "volume", limit: 2,
    isResolved: () => false });
  expect(page.markets.map(m => [m.id, m.volumeUsdc])).toEqual([["busy", "1200.00"], ["mid", "75.5"]]);
  const rest = catalogPage(records, { venue: "panta", now, scope: "open", sort: "volume", limit: 2,
    cursor: page.nextCursor!, isResolved: () => false });
  expect(rest.markets.map(m => m.id)).toEqual(["quiet", "unknown"]);
  expect(rest.markets.at(-1)!.volumeUsdc).toBeNull();
});
