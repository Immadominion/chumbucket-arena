/**
 * Persistence: the pivot tables, for real.
 *
 * Every test here runs against `tests/pgrestFake.ts`, which transcribes the
 * CHECK constraints, unique indexes, foreign keys and BEFORE triggers the six
 * applied migrations actually install — and raises the same SQLSTATEs. So a
 * green test means "the write this store sends is one the live schema accepts",
 * not "the mock was called".
 *
 * NO NETWORK AND NO REAL POSTGRES IS TOUCHED BY ANYTHING IN THIS FILE. `fetch`
 * is injected; the production database, which holds real users, is never
 * addressed.
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { CallsService } from "../src/calls/CallsService.ts";
import { predictionStoreReader } from "../src/calls/markets.ts";
import { RESOLUTION_CURSOR, ResolutionSync } from "../src/calls/ResolutionSync.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import { SupabaseCallsStore } from "../src/calls/supabaseStore.ts";
import { buildCallsRuntime, resetCallsRuntimes } from "../src/calls/runtime.ts";
import type { CallFeedPage, Person } from "../src/calls/types.ts";
import { DEFAULT_CACHE_TTLS } from "../src/prediction/cache.ts";
import { ManualClock } from "../src/prediction/clock.ts";
import { FIXTURE_EPOCH, FixtureVenue } from "../src/prediction/FixtureVenue.ts";
import { MARKET_SYNC_CURSOR, MarketSync } from "../src/prediction/marketSync.ts";
import { PgrestError, snapshotUuid, WriteQueue, type WriteFailure } from "../src/prediction/pgrest.ts";
import { buildPredictionRuntime, resetPredictionRuntimes } from "../src/prediction/runtime.ts";
import type { PredictionConfig } from "../src/prediction/config.ts";
import {
  isPersistableVenue,
  supabasePersistenceDecision,
  SupabasePredictionStore,
} from "../src/prediction/supabaseStore.ts";
import { marketUuid } from "../src/prediction/types.ts";
import { PgrestFake, seedUser, UUIDS } from "./pgrestFake.ts";

const OPEN_MARKET = marketUuid("fixture", "fx-open-btc-120k");
const RESOLVED_YES_MARKET = marketUuid("fixture", "fx-resolved-yes-sol-300");

interface Rig {
  clock: ManualClock;
  fake: PgrestFake;
  queue: WriteQueue;
  failures: WriteFailure[];
  venue: FixtureVenue;
  prediction: SupabasePredictionStore;
  calls: SupabaseCallsStore;
  sync: MarketSync;
  service: CallsService;
}

/**
 * Two durable stores sharing ONE write queue — exactly how the runtime wires
 * them, and the reason a call can reference a market that was written moments
 * earlier in the same pass.
 */
async function rig(): Promise<Rig> {
  const clock = new ManualClock(FIXTURE_EPOCH);
  const fake = new PgrestFake({ now: () => clock.now() });
  seedUser(fake, UUIDS.alice, { handle: "alice", fullName: "ALICE" });
  seedUser(fake, UUIDS.bob, { handle: "bob", fullName: "BOB" });

  const failures: WriteFailure[] = [];
  const queue = new WriteQueue({ clock, onFailure: (f) => failures.push(f) });
  const venue = new FixtureVenue({ clock });
  const prediction = new SupabasePredictionStore({
    config: fake.config,
    fetchImpl: fake.fetchImpl,
    clock,
    queue,
  });
  const calls = new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl, clock, queue });
  const sync = new MarketSync({ venue, store: prediction, clock });

  await prediction.hydrate();
  await calls.hydrate();

  const service = new CallsService({
    store: calls,
    markets: predictionStoreReader(prediction),
    clock,
    newId: () => crypto.randomUUID(),
  });

  return { clock, fake, queue, failures, venue, prediction, calls, sync, service };
}

/** A second pair of stores over the SAME database — i.e. a redeploy. */
async function redeploy(
  fake: PgrestFake,
  clock: ManualClock,
): Promise<{ prediction: SupabasePredictionStore; calls: SupabaseCallsStore; service: CallsService }> {
  const queue = new WriteQueue({ clock, onFailure: () => {} });
  const prediction = new SupabasePredictionStore({
    config: fake.config,
    fetchImpl: fake.fetchImpl,
    clock,
    queue,
  });
  const calls = new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl, clock, queue });
  await prediction.hydrate();
  await calls.hydrate();
  const service = new CallsService({
    store: calls,
    markets: predictionStoreReader(prediction),
    clock,
    newId: () => crypto.randomUUID(),
  });
  return { prediction, calls, service };
}

describe("market sync -> venue_markets / market_snapshots / market_resolutions", () => {
  test("one pass persists the catalog, its price and only its PUBLISHED resolutions", async () => {
    const r = await rig();
    const report = await r.sync.runOnce();
    await r.prediction.flush();

    // The fixture catalog is six markets: one OPEN, one PAUSED, one
    // CLOSED_PENDING_RESOLUTION, two RESOLVED and one CANCELLED.
    expect(report.marketsSeen).toBe(6);
    expect(r.fake.rows("venue_markets")).toHaveLength(6);

    // A price is only read for a market that can still move.
    expect(report.snapshotsRecorded).toBe(1);
    expect(r.fake.rows("market_snapshots")).toHaveLength(1);

    // Three of the six carry a venue-published resolution (YES, NO, VOID). The
    // CLOSED_PENDING_RESOLUTION one does NOT, and no row is invented for it.
    expect(report.resolutionsRecorded).toBe(3);
    const resolutions = r.fake.rows("market_resolutions").map((row) => row.resolution).sort();
    expect(resolutions).toEqual(["NO", "VOID", "YES"]);
    expect(r.fake.rows("market_resolutions").every((row) => row.raw_evidence !== null)).toBe(true);
  });

  test("running it twice writes nothing the second time", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();
    const after1 = {
      markets: r.fake.rows("venue_markets").length,
      snapshots: r.fake.rows("market_snapshots").length,
      resolutions: r.fake.rows("market_resolutions").length,
    };

    await r.sync.runOnce();
    await r.prediction.flush();

    expect(r.fake.rows("venue_markets")).toHaveLength(after1.markets);
    // The clock has not moved, so the re-observation is the same instant from
    // the same source: UNIQUE (market_id, observed_at, source) makes it one row.
    expect(r.fake.rows("market_snapshots")).toHaveLength(after1.snapshots);
    expect(r.fake.rows("market_resolutions")).toHaveLength(after1.resolutions);
    expect(r.failures).toEqual([]);
  });

  test("a new observation is a NEW snapshot row; the same instant is not", async () => {
    const r = await rig();
    await r.sync.runOnce();
    // Past snapshotMaxAgeMs, which is a ten-minute floor: the pass refuses to
    // re-price a market it priced recently, because re-writing the same number
    // every minute was ~216,000 rows a day of noise.
    r.clock.advance(11 * 60_000);
    await r.sync.runOnce();
    await r.prediction.flush();

    expect(r.fake.rows("market_snapshots")).toHaveLength(2);
    expect(r.fake.rows("venue_markets")).toHaveLength(6);
  });

  test("a lost cursor repairs from last_synced_at rather than re-importing", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();
    const watermark = r.sync.watermark();
    expect(watermark).toBe(FIXTURE_EPOCH);

    // Wipe the page cursor — a crashed process, a cleared cache.
    r.sync.resetCursor();
    await r.prediction.flush();
    expect(r.prediction.getCursor(MARKET_SYNC_CURSOR)).toBeNull();

    // The watermark survives because it is derived from the ROWS, and the
    // repair walk upserts onto the same deterministic ids.
    expect(r.sync.watermark()).toBe(watermark);
    await r.sync.runOnce();
    await r.prediction.flush();
    expect(r.fake.rows("venue_markets")).toHaveLength(6);
  });

  test("the cursor is persisted after every page, so a restart resumes mid-walk", async () => {
    const r = await rig();
    const paged = new MarketSync({
      venue: r.venue,
      store: r.prediction,
      clock: r.clock,
      pageSize: 2,
      maxPagesPerPass: 1,
      snapshotBudget: 0,
    });
    await paged.runOnce();
    await r.prediction.flush();
    expect(r.fake.rows("venue_markets")).toHaveLength(2);
    expect(r.prediction.getCursor(MARKET_SYNC_CURSOR)).not.toBeNull();

    // A fresh process reads the cursor back out of indexer_cursors and carries on.
    const after = await redeploy(r.fake, r.clock);
    const resumed = new MarketSync({
      venue: r.venue,
      store: after.prediction,
      clock: r.clock,
      pageSize: 2,
      maxPagesPerPass: 1,
      snapshotBudget: 0,
    });
    const report = await resumed.runOnce();
    await after.prediction.flush();
    expect(report.marketsSeen).toBe(2);
    expect(r.fake.rows("venue_markets")).toHaveLength(4); // 2 + 2, no re-import
  });
});

describe("a redeploy is a no-op, not an amnesia event", () => {
  test("venue markets, prices and resolutions come back byte-for-byte", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();

    const before = r.prediction.listMarkets().map((x) => x.market);
    const after = await redeploy(r.fake, r.clock);

    const rehydrated = after.prediction.listMarkets().map((x) => x.market);
    expect(sortById(rehydrated)).toEqual(sortById(before));
    expect(after.prediction.latestSnapshot(OPEN_MARKET)).toEqual(r.prediction.latestSnapshot(OPEN_MARKET));
    expect(after.prediction.getResolution(RESOLVED_YES_MARKET)).toEqual(
      r.prediction.getResolution(RESOLVED_YES_MARKET),
    );
    // And the raw payload survives, which is what makes a disputed
    // normalisation re-derivable (§4).
    expect(after.prediction.getMarket(OPEN_MARKET)?.raw?.body).toBeDefined();
  });

  test("a call, its result and its author survive the restart", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();

    const entry = r.service.createCall({ marketId: OPEN_MARKET, side: "YES", thesis: "it prints" }, UUIDS.alice);
    await r.calls.flush();

    expect(r.fake.rows("calls")).toHaveLength(1);
    expect(r.fake.rows("call_results")).toHaveLength(1);
    expect(r.fake.rows("call_results")[0]!.outcome).toBe("PENDING");

    const after = await redeploy(r.fake, r.clock);
    const feed = after.service.feed({ mode: "global" }, UUIDS.alice);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.call.id).toBe(entry.call.id);
    expect(feed.entries[0]!.call.thesis).toBe("it prints");
    expect(feed.entries[0]!.author.handle).toBe("alice");
    expect(feed.entries[0]!.result?.outcome).toBe("PENDING");
    // entry_probability and the snapshot it came from are both restored.
    expect(feed.entries[0]!.call.entryProbability).toBe(0.62);
    expect(feed.entries[0]!.call.snapshotId).toBe(snapshotUuid(OPEN_MARKET, FIXTURE_EPOCH, "fixture"));
  });

  test("a hidden call is restored hidden, without being born hidden", async () => {
    const r = await rig();
    await r.sync.runOnce();
    const entry = r.service.createCall({ marketId: OPEN_MARKET, side: "NO" }, UUIDS.bob);
    r.service.hideCall(entry.call.id, UUIDS.bob);
    await r.calls.flush();

    expect(r.fake.rows("calls")[0]!.hidden_at).not.toBeNull();

    const after = await redeploy(r.fake, r.clock);
    expect(after.calls.getCall(entry.call.id)?.hiddenAt).toBe(FIXTURE_EPOCH);
    expect(after.calls.liveCalls()).toHaveLength(0);
    // Hidden means withdrawn from distribution, not deleted: the result and the
    // author's history survive.
    expect(after.calls.getResult(entry.call.id)).toBeDefined();
    expect(after.calls.callsByAuthor(UUIDS.bob)).toHaveLength(1);
    expect(after.calls.hydrationReport?.hiddenCalls).toBe(1);
  });
});

describe("CallsService cannot tell the two stores apart", () => {
  test("the same script produces the same observable output in memory and on Postgres", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();
    const markets = predictionStoreReader(r.prediction);

    // Deterministic, VALID UUIDs: both runs mint the same ids, and the durable
    // run's ids are ones `calls.id`/`call_responses.id` actually accept, so the
    // parity is proved against a store whose writes really landed.
    const script = (store: InMemoryCallsStore | SupabaseCallsStore) => {
      let seq = 0;
      const clock = new ManualClock(FIXTURE_EPOCH);
      const service = new CallsService({
        store,
        markets,
        clock,
        newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
      });
      const alice = service.createCall(
        { marketId: OPEN_MARKET, side: "YES", thesis: "yes it does", confidence: 0.8 },
        UUIDS.alice,
      );
      const fade = service.respond({ targetCallId: alice.call.id, kind: "fade" }, UUIDS.bob);
      return {
        feed: strip(service.feed({ mode: "global" }, UUIDS.alice)),
        crowdSplit: service.marketDetail({ marketId: OPEN_MARKET }, UUIDS.alice).crowdSplit,
        fadeSide: fade.resultingCall?.call.side,
        invitations: service.invitations(UUIDS.alice),
        alicePerson: service.getPerson({ personRef: "alice" }, null).person,
        immutable: refusalCode(() => store.attemptCallUpdate(alice.call.id, { side: "NO" })),
        deleted: refusalCode(() => store.deleteCall(alice.call.id)),
        secondCall: refusalCode(() => service.createCall({ marketId: OPEN_MARKET, side: "NO" }, UUIDS.alice)),
      };
    };

    const durable = script(r.calls);
    await r.calls.flush(); // every durable write in the script was accepted

    const memory = new InMemoryCallsStore();
    for (const p of r.calls.listPeople()) memory.upsertPerson(p);
    const inMemory = script(memory);

    expect(inMemory).toEqual(durable);
    expect(durable.immutable).toBe("CALL_IMMUTABLE");
    expect(durable.deleted).toBe("CALL_NOT_DELETABLE");
    expect(durable.secondCall).toBe("CALL_ALREADY_MADE");
    expect(r.fake.rows("calls")).toHaveLength(2);
    expect(r.fake.rows("call_responses")).toHaveLength(1);
  });

  test("a durable back/fade lands as a call plus a response, parent-first", async () => {
    const r = await rig();
    await r.sync.runOnce();
    const alice = r.service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.alice);
    const fade = r.service.respond({ targetCallId: alice.call.id, kind: "fade" }, UUIDS.bob);
    await r.calls.flush();

    expect(r.fake.rows("calls")).toHaveLength(2);
    expect(r.fake.rows("call_responses")).toHaveLength(1);
    const response = r.fake.rows("call_responses")[0]!;
    expect(response.kind).toBe("fade");
    expect(response.resulting_call_id).toBe(fade.resultingCall?.call.id);
    // The fake enforces `call_responses_guard`: a fade must be the actor's own
    // call, on the same market, on the OTHER side. It accepted this one.
    expect(fade.resultingCall?.call.side).toBe("NO");
    expect(r.failures).toEqual([]);
  });
});

describe("the resolution loop settles a persisted call, and only from evidence", () => {
  test("venue evidence -> CORRECT, and the SQL derivation agrees with ours", async () => {
    const r = await rig();
    await r.sync.runOnce();
    const entry = r.service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.alice);
    await r.calls.flush();
    expect(r.fake.rows("call_results")[0]!.outcome).toBe("PENDING");

    // The venue publishes. This is the ONLY way a result is ever settled.
    r.clock.advance(1000);
    const evidence = r.prediction.recordResolution(
      {
        marketId: OPEN_MARKET,
        venue: "fixture",
        venueMarketId: "fx-open-btc-120k",
        resolution: "YES",
        resolvedAt: r.clock.now(),
        evidenceSource: "fixture:oracle",
        rawEvidence: { settled: "YES" },
        demo: true,
      },
      r.clock.now(),
    );
    await r.prediction.flush();

    const written = r.calls.writeResult({ callId: entry.call.id, evidence }, r.clock.now(), { actor: "service" });
    await r.calls.flush();

    expect(written.result.outcome).toBe("CORRECT");
    const row = r.fake.rows("call_results")[0]!;
    expect(row.outcome).toBe("CORRECT");
    expect(row.market_resolution_id).toBe(evidence.id);
    expect(r.failures).toEqual([]);

    // Re-stating the same derivation is a no-op — no write, no churned
    // derived_at. That is what makes the synchroniser idempotent.
    const writesBefore = r.queue.acceptedWrites;
    const again = r.calls.writeResult({ callId: entry.call.id, evidence }, r.clock.now() + 5_000, {
      actor: "service",
    });
    expect(again.changed).toBe(false);
    expect(r.queue.acceptedWrites).toBe(writesBefore);
  });

  test("a client may not write a result, and nothing is enqueued when it tries", async () => {
    const r = await rig();
    await r.sync.runOnce();
    const entry = r.service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.alice);
    await r.calls.flush();
    const writesBefore = r.queue.acceptedWrites;

    expect(() => r.calls.writeResult({ callId: entry.call.id, evidence: null }, 1, { actor: "client" })).toThrow(
      /service-write only/,
    );
    expect(r.queue.acceptedWrites).toBe(writesBefore);
  });
});

describe("ResolutionSync over durable stores", () => {
  test("a pass settles a persisted call, persists its cursor, and is a no-op on the second run", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();

    const alice = r.service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.alice);
    const bob = r.service.createCall({ marketId: OPEN_MARKET, side: "NO" }, UUIDS.bob);
    await r.calls.flush();

    const resolutionSync = new ResolutionSync({
      store: r.calls,
      markets: predictionStoreReader(r.prediction),
      clock: r.clock,
    });

    // Nothing to settle yet: absence of evidence is PENDING, never a timeout.
    const first = resolutionSync.runOnce();
    await r.calls.flush();
    expect(first.resultsSettled).toBe(0);
    expect(first.stillPending).toBe(2);

    // The venue publishes.
    r.clock.advance(5_000);
    r.prediction.recordResolution(
      {
        marketId: OPEN_MARKET,
        venue: "fixture",
        venueMarketId: "fx-open-btc-120k",
        resolution: "YES",
        resolvedAt: r.clock.now(),
        evidenceSource: "fixture:oracle",
        rawEvidence: { settled: "YES" },
        demo: true,
      },
      r.clock.now(),
    );
    await r.prediction.flush();

    const second = resolutionSync.runOnce();
    await r.calls.flush();
    expect(second.resultsSettled).toBe(2);
    expect(second.stillPending).toBe(0);

    const outcomes = Object.fromEntries(
      r.fake.rows("call_results").map((row) => [String(row.call_id), String(row.outcome)]),
    );
    expect(outcomes[alice.call.id]).toBe("CORRECT");
    expect(outcomes[bob.call.id]).toBe("INCORRECT");

    // The watermark is in indexer_cursors, so a restart resumes rather than
    // re-walking the venue's whole history.
    const cursorRow = r.fake
      .rows("indexer_cursors")
      .find((row) => row.source === "bff_calls" && row.cursor_key === RESOLUTION_CURSOR);
    expect(cursorRow?.last_signature).toBe(String(r.clock.now()));

    // A third pass changes no result row — not an outcome, not a derived_at.
    // (The inclusive watermark is deliberately re-written with the same value:
    // re-reading one resolution costs nothing because applying it twice is a
    // no-op, and skipping a resolution recorded in the same millisecond would
    // not be.)
    const resultsBefore = r.fake.rows("call_results");
    const third = resolutionSync.runOnce();
    await r.calls.flush();
    expect(third.resultsSettled).toBe(0);
    expect(r.fake.rows("call_results")).toEqual(resultsBefore);
  });

  test("a settled result comes back settled after a restart, re-derived not imported", async () => {
    const r = await rig();
    await r.sync.runOnce();
    r.service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.alice);
    r.clock.advance(1_000);
    r.prediction.recordResolution(
      {
        marketId: OPEN_MARKET,
        venue: "fixture",
        venueMarketId: "fx-open-btc-120k",
        resolution: "NO",
        resolvedAt: r.clock.now(),
        evidenceSource: "fixture:oracle",
        rawEvidence: { settled: "NO" },
        demo: true,
      },
      r.clock.now(),
    );
    new ResolutionSync({
      store: r.calls,
      markets: predictionStoreReader(r.prediction),
      clock: r.clock,
    }).runOnce();
    await r.calls.flush();

    const after = await redeploy(r.fake, r.clock);
    const result = after.calls.listResults()[0]!;
    expect(result.outcome).toBe("INCORRECT");
    expect(result.resolution).toBe("NO");
    expect(after.calls.hydrationReport?.skipped).toEqual({ calls: 0, responses: 0, results: 0 });

    // And the settled row is permanent: a contradicting re-statement is refused
    // by the mirror before Postgres is even asked.
    expect(() =>
      after.calls.writeResult(
        { callId: result.callId, evidence: null },
        r.clock.now(),
        { actor: "service" },
      ),
    ).toThrow(/already settled/);
  });
});

describe("the database fights back, and the write is fixed rather than the constraint", () => {
  test("a call on a market that already published its answer is refused", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();

    const onTime = r.service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.alice);
    await r.calls.flush();

    // The venue resolves BEFORE the second call is made.
    r.prediction.recordResolution(
      {
        marketId: OPEN_MARKET,
        venue: "fixture",
        venueMarketId: "fx-open-btc-120k",
        resolution: "YES",
        resolvedAt: r.clock.now(),
        evidenceSource: "fixture:oracle",
        rawEvidence: { settled: "YES" },
        demo: true,
      },
      r.clock.now(),
    );
    await r.prediction.flush();

    // Refuse before acknowledging anything. Then deliberately bypass the
    // service to prove the database guard still catches another writer.
    expect(() => r.service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.bob)).toThrow();
    r.calls.insertCall({
      ...onTime.call, id: crypto.randomUUID(), userId: UUIDS.bob,
      hiddenAt: null, hiddenReason: null,
    });
    await r.queue.drain();

    expect(r.fake.rows("calls")).toHaveLength(1);
    const refusal = r.failures.find((f) => f.label.startsWith("insert calls/"));
    expect(refusal?.sqlState).toBe("P0001");
    expect(refusal?.refused).toBe(true);
    expect(refusal?.message).toContain("after the answer is public");
    // The failure is raised, not swallowed.
    await expect(r.calls.flush()).rejects.toThrow(/durable write\(s\) failed/);
  });

  test("a market row for an unpersistable venue is refused, never rewritten", async () => {
    const r = await rig();
    const poly = {
      id: marketUuid("polymarket", "0x1234"),
      venue: "polymarket" as const,
      venueEventId: "ev",
      venueMarketId: "0x1234",
      question: "Will it?",
      rulesText: "rules",
      category: "crypto",
      outcomes: [
        { side: "YES" as const, label: "Yes" },
        { side: "NO" as const, label: "No" },
      ],
      status: "OPEN" as const,
      rawStatus: "open",
      opensAt: null,
      closesAt: null,
      resolvesAt: null,
      resolutionSource: null,
      lastSyncedAt: r.clock.now(),
      payloadVersion: 1,
    };
    // Passing NO provider payload for a live (non-demo) venue. That trips
    // venue_markets_live_rows_keep_raw, which exists so a real market can
    // always be traced back to what the venue actually said.
    //
    // This test used to trip the venue CHECK instead, by writing a polymarket
    // row when the schema admitted only jupiter and fixture. The polymarket
    // migration has since landed, so that is no longer a refusal — but the
    // property under test never was about polymarket. It is that a refused
    // write stays refused and gets reported, rather than being quietly
    // reshaped into something the schema will accept.
    r.prediction.upsertMarket({ ...poly, venue: "jupiter" as const }, null);
    await r.queue.drain();

    expect(r.fake.rows("venue_markets")).toHaveLength(0);
    const refusal = r.failures[0];
    expect(refusal?.sqlState).toBe("23514");
    expect(refusal?.message).toContain("venue_markets_live_rows_keep_raw");
    // Nothing was invented to satisfy the constraint: no fabricated payload,
    // and no downgrade to `fixture` to dodge it.
    expect(r.fake.rows("venue_markets")).toHaveLength(0);
  });

  test("a live market with no raw payload is refused, not stored without its evidence", async () => {
    const r = await rig();
    const jup = {
      id: marketUuid("jupiter", "jup-1"),
      venue: "jupiter" as const,
      venueEventId: "ev",
      venueMarketId: "jup-1",
      question: "Will it?",
      rulesText: "rules",
      category: "crypto",
      outcomes: [
        { side: "YES" as const, label: "Yes" },
        { side: "NO" as const, label: "No" },
      ],
      status: "OPEN" as const,
      rawStatus: "open",
      opensAt: null,
      closesAt: null,
      resolvesAt: null,
      resolutionSource: null,
      lastSyncedAt: r.clock.now(),
      payloadVersion: 1,
    };
    r.prediction.upsertMarket(jup, null);
    await r.queue.drain();

    expect(r.fake.rows("venue_markets")).toHaveLength(0);
    expect(r.failures[0]?.sqlState).toBe("23514");
    expect(r.failures[0]?.message).toContain("venue_markets_live_rows_keep_raw");
  });

  test("a resolution with no evidence is refused before Postgres is even asked", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();
    r.prediction.recordResolution(
      {
        marketId: OPEN_MARKET,
        venue: "fixture",
        venueMarketId: "fx-open-btc-120k",
        resolution: "YES",
        resolvedAt: r.clock.now(),
        evidenceSource: "fixture:oracle",
        rawEvidence: {},
        demo: true,
      },
      r.clock.now(),
    );
    await r.queue.drain();
    const refusal = r.failures.find((f) => f.label.includes("market_resolutions"));
    expect(refusal?.message).toContain("market_resolutions_requires_evidence");
  });

  test("an order may not be created FILLED, and reaching FILLED needs the full reconciliation write", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();

    const base = {
      orderId: "ord-1",
      venue: "fixture" as const,
      venueMarketId: "fx-open-btc-120k",
      marketId: OPEN_MARKET,
      ownerKey: `wallet:Wallet_${UUIDS.alice.slice(0, 8)}`,
      ownerAddress: `Wallet_${UUIDS.alice.slice(0, 8)}`,
      side: "YES" as const,
      amountBaseUnits: "5000000",
      filledBaseUnits: "0",
      fundingState: "QUOTED" as const,
      venueOrderId: null,
      fillTxSignature: null,
      fillEvidence: null,
      idempotencyKey: "idem-1",
      requestFingerprint: "fp-1",
      createdAt: r.clock.now(),
      updatedAt: r.clock.now(),
      reconciledAt: null,
      demo: true,
    };

    // The mirror refuses a FILLED insert before Postgres is asked — same rule
    // as trg_venue_orders_guard_funding_state.
    expect(() => r.prediction.createOrder({ ...base, fundingState: "FILLED" })).toThrow(/may not be created FILLED/);

    r.prediction.createOrder(base);
    r.prediction.setOrderState("ord-1", "SUBMITTED", r.clock.now());
    r.prediction.applyFill(
      "ord-1",
      {
        venue: "fixture",
        venueOrderId: "venue-ord-1",
        filledBaseUnits: "5000000",
        fillTxSignature: "sig-1",
        confirmedAt: r.clock.now(),
        raw: { ok: true },
      },
      r.clock.now(),
    );
    await r.prediction.flush();

    const row = r.fake.rows("venue_orders")[0]!;
    expect(row.funding_state).toBe("FILLED");
    // The CHECK the fake transcribes demands all five; the store supplied them.
    expect(row.reconciliation_source).toBe("reconciliation");
    expect(row.reconciled_at).not.toBeNull();
    expect(row.venue_order_id).toBe("venue-ord-1");
    expect(row.fill_tx_signature).toBe("sig-1");
    expect(row.fill_evidence).not.toBeNull();

    const after = await redeploy(r.fake, r.clock);
    const restored = after.prediction.getOrder("ord-1");
    expect(restored?.fundingState).toBe("FILLED");
    expect(restored?.fillTxSignature).toBe("sig-1");
  });

  test("an order for an unknown wallet is refused rather than minting a user", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();
    r.prediction.createOrder({
      orderId: "ord-x",
      venue: "fixture",
      venueMarketId: "fx-open-btc-120k",
      marketId: OPEN_MARKET,
      ownerKey: "wallet:NobodyHasThisWallet",
      ownerAddress: "NobodyHasThisWallet",
      side: "YES",
      amountBaseUnits: "1000000",
      filledBaseUnits: "0",
      fundingState: "QUOTED",
      venueOrderId: null,
      fillTxSignature: null,
      fillEvidence: null,
      idempotencyKey: "idem-x",
      requestFingerprint: "fp-x",
      createdAt: r.clock.now(),
      updatedAt: r.clock.now(),
      reconciledAt: null,
      demo: true,
    });
    await r.queue.drain();

    expect(r.fake.rows("venue_orders")).toHaveLength(0);
    expect(r.fake.rows("users")).toHaveLength(2); // nothing was minted
    expect(r.failures[0]?.message).toContain("no canonical public.users row");
  });

  test("a non-UUID id is refused at the boundary, with the fix named", async () => {
    const r = await rig();
    await r.sync.runOnce();
    await r.prediction.flush();
    const service = new CallsService({
      store: r.calls,
      markets: predictionStoreReader(r.prediction),
      clock: r.clock,
      // The default generator, which is what an un-overridden runtime would use.
      newId: (kind) => `${kind}_1_abcdef`,
    });
    service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.alice);
    await r.queue.drain();

    expect(r.fake.rows("calls")).toHaveLength(0);
    expect(r.failures[0]?.sqlState).toBe("22P02");
    expect(r.failures[0]?.message).toContain("newId override in src/calls/runtime.ts");
  });

  test("a follow for a wallet-less account is refused instead of inventing a credential", async () => {
    const r = await rig();
    seedUser(r.fake, UUIDS.carol, { handle: "carol", wallet: null });
    await r.calls.resync();

    r.calls.follow(UUIDS.alice, UUIDS.carol);
    await r.queue.drain();
    expect(r.fake.rows("follows")).toHaveLength(0);
    expect(r.failures[0]?.sqlState).toBe("23502");

    r.failures.length = 0;
    r.calls.follow(UUIDS.alice, UUIDS.bob);
    await r.queue.drain();
    expect(r.fake.rows("follows")).toHaveLength(1);
    expect(r.failures).toEqual([]);

    const after = await redeploy(r.fake, r.clock);
    expect(after.calls.isFollowing(UUIDS.alice, UUIDS.bob)).toBe(true);
    r.calls.unfollow(UUIDS.alice, UUIDS.bob);
    await r.queue.drain();
    expect(r.fake.rows("follows")).toHaveLength(0);
  });
});

describe("degrading honestly", () => {
  test("no supabase config -> in-memory, and it says so", () => {
    const decision = supabasePersistenceDecision({ social: undefined, venue: "fixture" });
    expect(decision.persisting).toBe(false);
    expect(decision.reason).toContain("config.social is unset");
    expect(decision.reason).toContain("lost on restart");
  });

  test("polymarket persists, now that the venue migration has landed", () => {
    // This asserted the opposite until 20260917120000_venue_market_allow_polymarket
    // was applied: all four *_venue_check constraints and the venue_markets read
    // policy admitted only jupiter and fixture, so a real polymarket market was
    // refused and the runtime degraded to in-memory. Real data that evaporates on
    // redeploy is its own kind of fake, which is why the constraint moved.
    expect(isPersistableVenue("polymarket")).toBe(true);
    const decision = supabasePersistenceDecision({
      social: { supabaseUrl: "https://x.supabase.co", serviceRoleKey: "k" },
      venue: "polymarket",
    });
    expect(decision.persisting).toBe(true);
  });

  test("the runtimes pick the durable store only when both halves are durable", async () => {
    const fake = new PgrestFake();
    const social = fake.config;

    const pFixture = buildPredictionRuntime(undefined, {
      social,
      fetchImpl: fake.fetchImpl,
      config: predictionConfig("fixture"),
    });
    expect(pFixture.persistence.persisting).toBe(true);
    expect(pFixture.durable).toBeInstanceOf(SupabasePredictionStore);
    // Nothing was read: construction alone must not touch the database.
    expect(fake.log).toEqual([]);

    const pPoly = buildPredictionRuntime(undefined, {
      social,
      fetchImpl: fake.fetchImpl,
      config: predictionConfig("polymarket"),
    });
    expect(pPoly.persistence.persisting).toBe(true);
    expect(pPoly.durable).toBeInstanceOf(SupabasePredictionStore);

    // The honest fallback still exists — it is reached by an unconfigured
    // server, not by a venue the schema happens to dislike.
    const pNoSocial = buildPredictionRuntime(undefined, {
      fetchImpl: fake.fetchImpl,
      config: predictionConfig("polymarket"),
    });
    expect(pNoSocial.persistence.persisting).toBe(false);
    expect(pNoSocial.durable).toBeNull();
  });

  test("a calls runtime with no venue persistence refuses to pretend, and says why", () => {
    const rt = buildCallsRuntime(undefined, {});
    expect(rt.persistence.persisting).toBe(false);
    expect(rt.durable).toBeNull();
    expect(rt.persistence.reason).toContain("nothing to reference");
    expect(rt.store).toBeInstanceOf(InMemoryCallsStore);
  });
});

describe("wiring: the runtimes hand CallsService a durable store", () => {
  test("social + a persistable venue -> both stores durable, one shared queue, UUID ids", async () => {
    const clock = new ManualClock(FIXTURE_EPOCH);
    const fake = new PgrestFake({ now: () => clock.now() });
    seedUser(fake, UUIDS.alice, { handle: "alice" });

    const appConfig = loadConfig({
      SUPABASE_URL: fake.supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: fake.serviceRoleKey,
      SOLANA_NETWORK: "devnet",
    });

    // The prediction runtime is passed in so the test's fetch reaches BOTH
    // stores; in production `buildCallsRuntime` takes it from the module memo.
    const prediction = buildPredictionRuntime(appConfig, {
      social: fake.config,
      fetchImpl: fake.fetchImpl,
      clock,
      hydrate: true,
    });
    await prediction.ready;
    const rt = buildCallsRuntime(appConfig, {
      prediction,
      fetchImpl: fake.fetchImpl,
      clock,
      hydrate: true,
    });
    await rt.ready;

    expect(prediction.persistence.persisting).toBe(true);
    expect(rt.persistence.persisting).toBe(true);
    expect(rt.durable).toBeInstanceOf(SupabaseCallsStore);
    // ONE queue across both stores: `calls.market_id` is a FK onto
    // `venue_markets(id)`, so the market must be written first.
    expect(rt.durable?.queue).toBe(prediction.durable?.queue);
    expect(rt.store.getPerson(UUIDS.alice)?.handle).toBe("alice");

    await prediction.marketSync.runOnce();
    const entry = rt.service.createCall({ marketId: OPEN_MARKET, side: "YES" }, UUIDS.alice);
    await rt.durable!.flush();

    // The runtime supplied a UUID generator, so `calls.id` was accepted.
    expect(entry.call.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(fake.rows("calls")).toHaveLength(1);
    expect(fake.rows("calls")[0]!.id).toBe(entry.call.id);
    expect(fake.rows("venue_markets")).toHaveLength(6);

    resetPredictionRuntimes();
    resetCallsRuntimes();
  });
});

describe("the service-role key never escapes", () => {
  test("it is never in a URL, and a failure message cannot carry it", async () => {
    const r = await rig();
    await r.sync.runOnce();
    r.prediction.upsertMarket(
      {
        id: marketUuid("jupiter", "jup-leak"),
        venue: "jupiter",
        venueEventId: "ev",
        venueMarketId: "jup-leak",
        question: "Will it?",
        rulesText: "rules",
        category: "crypto",
        outcomes: [
          { side: "YES", label: "Yes" },
          { side: "NO", label: "No" },
        ],
        status: "OPEN",
        rawStatus: "open",
        opensAt: null,
        closesAt: null,
        resolvesAt: null,
        resolutionSource: null,
        lastSyncedAt: r.clock.now(),
        payloadVersion: 1,
      },
      null,
    );
    await r.queue.drain();

    expect(urlsCarryKey(r.fake)).toBe(false);
    expect(r.fake.urls.length).toBeGreaterThan(0);
    for (const f of r.failures) expect(f.message).not.toContain(r.fake.serviceRoleKey);
    // A PostgREST body that echoed the key back would still be scrubbed.
    const err = new PgrestError(`[pgrest] boom: ${r.fake.serviceRoleKey}`);
    expect(err.message).not.toContain(r.fake.serviceRoleKey);
    expect(err.message).toContain("[redacted]");
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** The typed refusal code, so "it refused, and for the same reason" is testable. */
function refusalCode(fn: () => unknown): string {
  try {
    fn();
    return "accepted";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const urlsCarryKey = (fake: PgrestFake): boolean =>
  fake.urls.some((u) => u.includes(fake.serviceRoleKey));

const sortById = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => a.id.localeCompare(b.id));

/** Drop the server-stamped timestamp so two runs are comparable. */
function strip(page: CallFeedPage): unknown {
  return {
    entries: page.entries.map((e) => ({
      call: e.call,
      author: withoutStats(e.author),
      market: e.market,
      result: e.result,
      backCount: e.backCount,
      fadeCount: e.fadeCount,
      viewerHasCalled: e.viewerHasCalled,
    })),
    nextCursor: page.nextCursor,
  };
}

const withoutStats = (p: Person): Omit<Person, "settledCalls" | "correctCalls"> => {
  const { settledCalls: _s, correctCalls: _c, ...rest } = p;
  return rest;
};

function predictionConfig(venue: "fixture" | "jupiter" | "polymarket"): PredictionConfig {
  return {
    venue,
    jupiter: null,
    polymarket: null,
    panta: null,
    flags: { fundedPositions: false },
    cache: DEFAULT_CACHE_TTLS,
    circuit: { failureThreshold: 3, resetAfterMs: 1000, halfOpenMaxCalls: 1 },
    retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  };
}
