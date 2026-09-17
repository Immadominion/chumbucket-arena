/**
 * `SupabasePredictionStore` — Packet B's five tables, for real.
 *
 * ── THE SHAPE OF THE PROBLEM ─────────────────────────────────────────────────
 *
 * `PredictionStore` (./store.ts) is a SYNCHRONOUS interface, and so is
 * `CallsStore`. `PredictionService.persist()`, `CallsService.createCall()` and
 * `ResolutionSync.runOnce()` all call it without `await`, and their signatures
 * are consumed by route modules and by tests this packet may not change. Postgres
 * is not synchronous and `fetch` is not synchronous, so a durable implementation
 * of a synchronous interface has exactly one honest shape:
 *
 *   1. AN IN-PROCESS MIRROR serves every read and enforces every invariant. It
 *      is a real `InMemoryPredictionStore`, delegated to rather than
 *      re-implemented, so "same observable behaviour" is true by construction
 *      and cannot drift.
 *   2. EVERY MUTATION IS ALSO WRITTEN TO POSTGRES, through a strictly FIFO queue
 *      shared with `SupabaseCallsStore` (the pivot schema has real foreign keys
 *      across the two, so parent rows must be written first).
 *   3. THE MIRROR IS BUILT FROM POSTGRES AT BOOT (`hydrate()`), which is what
 *      makes a redeploy a no-op instead of an amnesia event — the whole point.
 *   4. A REJECTED WRITE IS NEVER SWALLOWED. It is recorded, counted, reported
 *      through `onFailure`, surfaced by `failures`, and re-raised by `flush()`.
 *      Re-hydrating (a restart, or `resync()`) is the repair, exactly as
 *      `ResolutionSync`'s own doc comment describes: the cursor is an
 *      optimisation, re-derivation from durable evidence is the guarantee.
 *
 * What this design honestly does NOT give you is a write whose rejection the
 * HTTP caller learns about in the same request. That needs an async
 * `PredictionStore`/`CallsStore`, which changes `CallsService`, `ResolutionSync`
 * and the route modules — integration-owned files. The exact patch is filed at
 * docs/contracts/integration-requests/packet-persist.md. Nothing below pretends
 * otherwise.
 *
 * ── WHAT THE DATABASE REFUSES, AND WHY THAT IS RIGHT ────────────────────────
 *
 *   venue_markets_venue_check          venue IN ('jupiter','fixture')
 *   venue_markets_live_rows_keep_raw   a jupiter row must carry raw_payload
 *   market_resolutions_requires_evidence  raw_evidence <> '{}'
 *   trg_market_resolutions_append_only    no UPDATE, no DELETE, service_role too
 *   venue_orders_filled_requires_evidence + trg_venue_orders_guard_funding_state
 *
 * Every one of those is mirrored by a rule `InMemoryPredictionStore` already
 * enforces, EXCEPT the venue allowlist and the raw-payload requirements, which
 * are enforced here — by refusing the write and saying so, never by writing a
 * weaker row.
 */

import { systemClock, type Clock } from "./clock.ts";
import {
  fromTimestamptz,
  isUuid,
  parseBaseUnits,
  parseNumeric,
  parseTimestamptz,
  Pgrest,
  PgrestError,
  snapshotUuid,
  toTimestamptz,
  toTimestamptzOrNull,
  uuidV5,
  WriteQueue,
  writeFailureError,
  type FetchImpl,
  type PgrestConfig,
  type WriteFailure,
} from "./pgrest.ts";
import type { RawPayload, VenuePosition } from "./PredictionVenue.ts";
import {
  InMemoryPredictionStore,
  type FillEvidence,
  type OrderRecord,
  type PositionRecord,
  type PredictionStore,
  type VenueMarketRecord,
} from "./store.ts";
import type {
  BaseUnits,
  FundingState,
  MarketResolutionRecord,
  MarketSnapshot,
  MarketStatus,
  Resolution,
  Side,
  VenueId,
  VenueMarket,
} from "./types.ts";

/**
 * The venues the LIVE schema will accept a row for. This is not a policy choice
 * here — it is a transcription of four CHECK constraints that are already
 * applied to production:
 *
 *   venue_markets_venue_check      CHECK (venue IN ('jupiter', 'fixture'))
 *   market_resolutions_venue_check CHECK (venue IN ('jupiter', 'fixture'))
 *   venue_orders_venue_check       CHECK (venue IN ('jupiter', 'fixture'))
 *   venue_positions_venue_check    CHECK (venue IN ('jupiter', 'fixture'))
 *
 * `VenueId` in ./types.ts already carries `'polymarket'`, and PolymarketVenue is
 * live and keyless — but a `venue = 'polymarket'` row is refused by all four
 * constraints, and loosening a constraint is not on the table. The one-line
 * migration that adds the member is filed at
 * docs/contracts/integration-requests/packet-persist.md §1; until it is applied,
 * `supabasePersistenceDecision()` below reports polymarket as NOT persistable
 * and the runtime degrades loudly to in-memory rather than accepting writes it
 * knows Postgres will throw away.
 */
// 20260917120000_venue_market_allow_polymarket.sql has been applied to
// production, so all four *_venue_check constraints and the venue_markets
// read policy now admit 'polymarket'. Verified on a replica first: the
// row writes, anon can see it through the policy, and an unknown venue is
// still refused.
export const PERSISTABLE_VENUES: ReadonlySet<VenueId> = new Set<VenueId>([
  "jupiter",
  "polymarket",
  "fixture",
]);

export const isPersistableVenue = (venue: VenueId): boolean => PERSISTABLE_VENUES.has(venue);

/** Cursor namespace in `public.indexer_cursors` (see the note on `setCursor`). */
export const VENUE_CURSOR_SOURCE = "bff_venue";

const MARKETS_TABLE = "venue_markets";
const SNAPSHOTS_TABLE = "market_snapshots";
const RESOLUTIONS_TABLE = "market_resolutions";
const ORDERS_TABLE = "venue_orders";
const POSITIONS_TABLE = "venue_positions";
const CURSORS_TABLE = "indexer_cursors";
const USERS_TABLE = "users";
const LINKED_WALLETS_TABLE = "linked_wallets";

export interface SupabasePredictionStoreOptions {
  config: PgrestConfig & { network: "devnet" | "mainnet-beta" };
  fetchImpl?: FetchImpl;
  clock?: Clock;
  /** Shared with SupabaseCallsStore so cross-table FKs are written parent-first. */
  queue?: WriteQueue;
  mirror?: InMemoryPredictionStore;
  /** Pages of 1000 to walk when hydrating the latest snapshot per market. */
  maxSnapshotPages?: number;
  /** Safety bound; hydration throws rather than serving a truncated mirror. */
  maxRowsPerTable?: number;
}

export interface PredictionHydrationReport {
  markets: number;
  snapshots: number;
  resolutions: number;
  orders: number;
  positions: number;
  cursors: number;
  /** Markets for which no snapshot row surfaced inside the page budget. */
  marketsWithoutSnapshot: number;
  hydratedAt: number;
}

export class SupabasePredictionStore implements PredictionStore {
  readonly persistent = true;
  readonly mirror: InMemoryPredictionStore;
  readonly queue: WriteQueue;

  private readonly pg: Pgrest;
  private readonly clock: Clock;
  private readonly network: "devnet" | "mainnet-beta";
  private readonly maxSnapshotPages: number;
  private readonly maxRowsPerTable: number;
  /** marketId -> the real `market_resolutions.id` (DB-assigned or derived). */
  private readonly resolutionIds = new Map<string, string>();
  /** ownerKey -> canonical `public.users.id`, memoised after one lookup. */
  private readonly ownerUserIds = new Map<string, string>();
  private hydration: PredictionHydrationReport | null = null;

  constructor(opts: SupabasePredictionStoreOptions) {
    this.pg = new Pgrest(opts.config, opts.fetchImpl);
    this.clock = opts.clock ?? systemClock;
    this.network = opts.config.network;
    this.mirror = opts.mirror ?? new InMemoryPredictionStore();
    this.queue = opts.queue ?? new WriteQueue({ clock: this.clock });
    this.maxSnapshotPages = opts.maxSnapshotPages ?? 5;
    this.maxRowsPerTable = opts.maxRowsPerTable ?? 50_000;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  get hydrated(): boolean {
    return this.hydration !== null;
  }

  get hydrationReport(): PredictionHydrationReport | null {
    return this.hydration;
  }

  /** Every durable write queued so far; throws if any was rejected. */
  async flush(): Promise<void> {
    await this.queue.drain();
    if (this.queue.failures.length > 0) throw writeFailureError(this.queue.failures);
  }

  get failures(): readonly WriteFailure[] {
    return this.queue.failures;
  }

  /**
   * Build the mirror from Postgres. This is what makes a redeploy a no-op.
   * Safe to call again: the mirror is replaced wholesale by a fresh read.
   */
  async hydrate(): Promise<PredictionHydrationReport> {
    const report: PredictionHydrationReport = {
      markets: 0,
      snapshots: 0,
      resolutions: 0,
      orders: 0,
      positions: 0,
      cursors: 0,
      marketsWithoutSnapshot: 0,
      hydratedAt: this.clock.now(),
    };

    // ── markets ──
    for (const row of await this.page<MarketRow>(MARKETS_TABLE, () => {
      const p = new URLSearchParams({ select: MARKET_COLUMNS, order: "last_synced_at.desc" });
      return p;
    })) {
      const { market, raw } = marketFromRow(row);
      this.mirror.upsertMarket(market, raw);
      report.markets++;
    }

    // ── resolutions: keep the DB's own id, so call_results can reference it ──
    for (const row of await this.page<ResolutionRow>(RESOLUTIONS_TABLE, () => {
      return new URLSearchParams({
        select: RESOLUTION_COLUMNS,
        supersedes_id: "is.null",
        order: "recorded_at.asc",
      });
    })) {
      const rec = resolutionFromRow(row);
      // The mirror assigns its own sequential id; we keep the DB's.
      this.mirror.recordResolution(
        {
          marketId: rec.marketId,
          venue: rec.venue,
          venueMarketId: rec.venueMarketId,
          resolution: rec.resolution,
          resolvedAt: rec.resolvedAt,
          evidenceSource: rec.evidenceSource,
          rawEvidence: rec.rawEvidence,
          demo: rec.demo,
        },
        rec.recordedAt,
      );
      this.resolutionIds.set(rec.marketId, rec.id);
      report.resolutions++;
    }

    // ── the latest snapshot per market, newest-first and page-bounded ──
    const seen = new Set<string>();
    const wanted = new Set(this.mirror.listMarkets().map((r) => r.market.id));
    for (let page = 0; page < this.maxSnapshotPages && seen.size < wanted.size; page++) {
      const rows = await this.pg.select<SnapshotRow>(
        SNAPSHOTS_TABLE,
        new URLSearchParams({
          select: SNAPSHOT_COLUMNS,
          order: "observed_at.desc",
          limit: "1000",
          offset: String(page * 1000),
        }),
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const snap = snapshotFromRow(row);
        if (seen.has(snap.marketId)) continue; // a newer one already landed
        if (!wanted.has(snap.marketId)) continue; // an orphan; the FK forbids it anyway
        seen.add(snap.marketId);
        this.mirror.appendSnapshot(snap);
        report.snapshots++;
      }
      if (rows.length < 1000) break;
    }
    report.marketsWithoutSnapshot = wanted.size - seen.size;

    // ── orders + positions (funded_positions is OFF by default, §7) ──
    for (const row of await this.page<OrderRow>(ORDERS_TABLE, () => {
      return new URLSearchParams({ select: ORDER_COLUMNS, order: "created_at.asc" });
    })) {
      const rec = orderFromRow(row);
      this.ownerUserIds.set(rec.ownerKey, row.user_id);
      // createOrder refuses a FILLED insert (correctly — so does the SQL
      // trigger), so a persisted FILLED order is restored as the SUBMITTED row
      // it was, then advanced by its own fill evidence. The end state is
      // identical and no guard is bypassed.
      const filled = rec.fundingState === "FILLED" || rec.fundingState === "PARTIAL";
      this.mirror.createOrder(filled ? { ...rec, fundingState: "SUBMITTED", filledBaseUnits: "0" } : rec);
      if (filled && rec.fillEvidence) {
        this.mirror.applyFill(rec.orderId, rec.fillEvidence, rec.reconciledAt ?? rec.updatedAt);
      } else if (filled) {
        this.mirror.setOrderState(rec.orderId, "PARTIAL", rec.updatedAt);
      }
      report.orders++;
    }

    for (const row of await this.page<PositionRow>(POSITIONS_TABLE, () => {
      return new URLSearchParams({ select: POSITION_COLUMNS, order: "updated_at.asc" });
    })) {
      const rec = positionFromRow(row);
      this.ownerUserIds.set(rec.ownerKey, row.user_id);
      this.mirror.upsertPosition(rec);
      report.positions++;
    }

    // ── cursors ──
    for (const row of await this.pg.select<CursorRow>(
      CURSORS_TABLE,
      new URLSearchParams({
        select: "cursor_key,last_signature",
        network: `eq.${this.network}`,
        source: `eq.${VENUE_CURSOR_SOURCE}`,
      }),
    )) {
      this.mirror.setCursor(row.cursor_key, row.last_signature ?? null);
      report.cursors++;
    }

    this.hydration = report;
    return report;
  }

  /** Forget the mirror and rebuild it from Postgres. The repair path. */
  async resync(): Promise<PredictionHydrationReport> {
    this.hydration = null;
    this.resolutionIds.clear();
    // Re-reading Postgres IS the repair for a divergent mirror, so the recorded
    // failures stop being current the moment it succeeds — and not before.
    this.queue.clearFailures();
    // A fresh mirror, so a row deleted upstream does not survive the resync.
    (this as { mirror: InMemoryPredictionStore }).mirror = new InMemoryPredictionStore();
    return this.hydrate();
  }

  // ── markets ───────────────────────────────────────────────────────────────

  upsertMarket(market: VenueMarket, raw: RawPayload | null): VenueMarketRecord {
    // The mirror enforces "a market never changes venue" and is the read path.
    const rec = this.mirror.upsertMarket(market, raw);

    this.queue.push(`upsert ${MARKETS_TABLE}/${market.id}`, async () => {
      this.assertPersistableVenue(market.venue, MARKETS_TABLE);
      const rawBody = raw?.body ?? null;
      // venue_markets_live_rows_keep_raw: a LIVE row must carry the payload it
      // was parsed from, or a disputed normalisation cannot be re-derived from
      // anything. Refuse the write; do not invent a payload and do not weaken
      // the constraint.
      if (market.venue !== "fixture" && isEmptyJson(rawBody)) {
        throw new PgrestError(
          `[persist] ${MARKETS_TABLE}/${market.id}: venue '${market.venue}' is live, so venue_markets_live_rows_keep_raw requires a non-empty raw_payload. The adapter returned none — re-sync this market so the payload is captured.`,
          { sqlState: "23514", details: { marketId: market.id, venue: market.venue } },
        );
      }
      await this.pg.insert(
        MARKETS_TABLE,
        [
          {
            id: market.id,
            venue: market.venue,
            venue_event_id: market.venueEventId,
            venue_market_id: market.venueMarketId,
            question: market.question,
            rules_text: market.rulesText,
            category: market.category,
            outcomes: market.outcomes,
            status: market.status,
            raw_status: market.rawStatus,
            opens_at: toTimestamptzOrNull(market.opensAt),
            closes_at: toTimestamptzOrNull(market.closesAt),
            resolves_at: toTimestamptzOrNull(market.resolvesAt),
            resolution_source: market.resolutionSource,
            last_synced_at: toTimestamptz(market.lastSyncedAt),
            payload_version: market.payloadVersion,
            // `{}` only ever reaches here for the fixture catalog, which the
            // CHECK exempts. `is_demo` is GENERATED and must not be sent.
            raw_payload: rawBody ?? {},
            updated_at: toTimestamptz(this.clock.now()),
          },
        ],
        { onConflict: "id" },
      );
    });

    return rec;
  }

  getMarket(marketId: string): VenueMarketRecord | undefined {
    return this.mirror.getMarket(marketId);
  }

  getMarketByVenueId(venue: VenueId, venueMarketId: string): VenueMarketRecord | undefined {
    return this.mirror.getMarketByVenueId(venue, venueMarketId);
  }

  listMarkets(): VenueMarketRecord[] {
    return this.mirror.listMarkets();
  }

  // ── snapshots ─────────────────────────────────────────────────────────────

  appendSnapshot(s: MarketSnapshot): void {
    const before = this.mirror.latestSnapshot(s.marketId);
    this.mirror.appendSnapshot(s); // validates [0,1] and dedupes an identical re-poll
    if (before && before.observedAt === s.observedAt && before.yesProbability === s.yesProbability) {
      return; // the mirror treated it as a no-op; so does Postgres
    }

    this.queue.push(`insert ${SNAPSHOTS_TABLE}/${s.marketId}@${s.observedAt}`, async () => {
      await this.pg.insert(
        SNAPSHOTS_TABLE,
        [
          {
            // Deterministic, over exactly the columns of
            // UNIQUE (market_id, observed_at, source) — which is what lets a
            // call's `snapshotId` become a real FK with no extra round-trip.
            id: snapshotUuid(s.marketId, s.observedAt, s.source),
            market_id: s.marketId,
            yes_probability: s.yesProbability,
            observed_at: toTimestamptz(s.observedAt),
            source: s.source,
          },
        ],
        // Re-observing the same instant from the same source is the SAME row.
        { onConflict: "market_id,observed_at,source", ignoreDuplicates: true },
      );
    });
  }

  latestSnapshot(marketId: string): MarketSnapshot | undefined {
    return this.mirror.latestSnapshot(marketId);
  }

  snapshots(marketId: string): MarketSnapshot[] {
    return this.mirror.snapshots(marketId);
  }

  // ── resolutions: append-only venue evidence ───────────────────────────────

  /**
   * `market_resolutions.id` must be a real UUID, because `call_results
   * .market_resolution_id` is a FK onto it and the derivation trigger reads the
   * referenced row. The mirror hands out sequential `res_N` ids, so the id is
   * substituted here: derived deterministically from the market (the table's
   * `uq_market_resolutions_original` is UNIQUE(market_id) for original rows, so
   * one market is one original resolution), or taken from Postgres on hydrate.
   */
  recordResolution(
    r: Omit<MarketResolutionRecord, "id" | "recordedAt">,
    recordedAt: number,
  ): MarketResolutionRecord {
    // The mirror refuses to overwrite venue evidence with a contradiction and
    // returns the existing row for an identical restatement.
    const mirrored = this.mirror.recordResolution(r, recordedAt);
    const id = this.resolutionIdFor(mirrored.marketId);
    const rec: MarketResolutionRecord = { ...mirrored, id };

    this.queue.push(`insert ${RESOLUTIONS_TABLE}/${rec.marketId}`, async () => {
      this.assertPersistableVenue(rec.venue, RESOLUTIONS_TABLE);
      // market_resolutions_requires_evidence: a resolution with no evidence is
      // a guess, and §0.2 forbids guesses. The column is JSONB NOT NULL, so a
      // null payload is not even representable — refuse rather than fabricate.
      if (isEmptyJson(rec.rawEvidence)) {
        throw new PgrestError(
          `[persist] ${RESOLUTIONS_TABLE}/${rec.marketId}: market_resolutions_requires_evidence refuses an empty raw_evidence. A resolution is only ever read OUT of a venue payload (contracts §0.2).`,
          { sqlState: "23514", details: { marketId: rec.marketId } },
        );
      }
      await this.pg.insert(
        RESOLUTIONS_TABLE,
        [
          {
            id,
            market_id: rec.marketId,
            venue: rec.venue,
            venue_market_id: rec.venueMarketId,
            resolution: rec.resolution,
            resolved_at: toTimestamptz(rec.resolvedAt),
            evidence_source: rec.evidenceSource,
            raw_evidence: rec.rawEvidence,
            supersedes_id: null,
            recorded_at: toTimestamptz(rec.recordedAt),
          },
        ],
        // trg_market_resolutions_append_only refuses UPDATE for every role,
        // service_role included — so a replayed poll must be a no-op INSERT,
        // never a merge. ignore-duplicates is the only correct resolution here.
        { onConflict: "id", ignoreDuplicates: true },
      );
    });

    return rec;
  }

  getResolution(marketId: string): MarketResolutionRecord | undefined {
    const rec = this.mirror.getResolution(marketId);
    if (!rec) return undefined;
    return { ...rec, id: this.resolutionIdFor(marketId) };
  }

  private resolutionIdFor(marketId: string): string {
    const known = this.resolutionIds.get(marketId);
    if (known) return known;
    const derived = uuidV5(`market_resolution:original:${marketId}`);
    this.resolutionIds.set(marketId, derived);
    return derived;
  }

  // ── orders ────────────────────────────────────────────────────────────────

  findOrderByIdempotencyKey(ownerKey: string, idempotencyKey: string): OrderRecord | undefined {
    return this.mirror.findOrderByIdempotencyKey(ownerKey, idempotencyKey);
  }

  createOrder(rec: OrderRecord): OrderRecord {
    const stored = this.mirror.createOrder(rec); // refuses a FILLED insert, as the trigger does
    // The mirror returns the row it already had on an idempotent replay; that
    // row is already in Postgres, so there is nothing to write.
    if (stored !== rec) return stored;

    this.queue.push(`insert ${ORDERS_TABLE}/${rec.orderId}`, async () => {
      this.assertPersistableVenue(rec.venue, ORDERS_TABLE);
      const userId = await this.userIdForOwnerKey(rec.ownerKey);
      await this.pg.insert(
        ORDERS_TABLE,
        [
          {
            order_id: rec.orderId,
            user_id: userId,
            owner_address: rec.ownerAddress,
            venue: rec.venue,
            venue_market_id: rec.venueMarketId,
            market_id: rec.marketId || null,
            side: rec.side,
            amount_base_units: rec.amountBaseUnits,
            filled_base_units: rec.filledBaseUnits,
            funding_state: rec.fundingState,
            venue_order_id: rec.venueOrderId,
            fill_tx_signature: rec.fillTxSignature,
            fill_evidence: rec.fillEvidence ? fillEvidenceJson(rec.fillEvidence) : {},
            reconciliation_source: null,
            reconciled_at: toTimestamptzOrNull(rec.reconciledAt),
            idempotency_key: rec.idempotencyKey,
            request_fingerprint: rec.requestFingerprint,
            created_at: toTimestamptz(rec.createdAt),
            updated_at: toTimestamptz(rec.updatedAt),
          },
        ],
        { onConflict: "order_id", ignoreDuplicates: true },
      );
    });

    return stored;
  }

  getOrder(orderId: string): OrderRecord | undefined {
    return this.mirror.getOrder(orderId);
  }

  listOrders(ownerKey: string): OrderRecord[] {
    return this.mirror.listOrders(ownerKey);
  }

  setOrderState(orderId: string, next: FundingState, at: number): OrderRecord {
    const rec = this.mirror.setOrderState(orderId, next, at); // refuses FILLED, as the trigger does
    this.queue.push(`patch ${ORDERS_TABLE}/${orderId}:${next}`, async () => {
      await this.pg.patch(ORDERS_TABLE, new URLSearchParams({ order_id: `eq.${orderId}` }), {
        funding_state: next,
        updated_at: toTimestamptz(at),
      });
    });
    return rec;
  }

  /**
   * THE ONLY PATH TO FILLED, here as in the mirror and as in the SQL trigger.
   * `reconciliation_source` is stamped `'reconciliation'` here and nowhere else:
   * `venue_orders_filled_requires_evidence` and
   * `trg_venue_orders_guard_funding_state` both demand it, and this method is
   * by definition the reconciliation write. `OrderRecord` has no field for it
   * precisely so no other code path can set it.
   */
  applyFill(orderId: string, evidence: FillEvidence, at: number): OrderRecord {
    const rec = this.mirror.applyFill(orderId, evidence, at);
    this.queue.push(`patch ${ORDERS_TABLE}/${orderId}:fill`, async () => {
      await this.pg.patch(ORDERS_TABLE, new URLSearchParams({ order_id: `eq.${orderId}` }), {
        funding_state: rec.fundingState,
        filled_base_units: rec.filledBaseUnits,
        venue_order_id: rec.venueOrderId,
        fill_tx_signature: rec.fillTxSignature,
        fill_evidence: fillEvidenceJson(evidence),
        reconciliation_source: "reconciliation",
        reconciled_at: toTimestamptz(rec.reconciledAt ?? at),
        updated_at: toTimestamptz(at),
      });
    });
    return rec;
  }

  // ── positions ─────────────────────────────────────────────────────────────

  upsertPosition(p: PositionRecord): PositionRecord {
    const stored = this.mirror.upsertPosition(p);
    if (stored !== p) return stored; // an older restatement; nothing to write

    this.queue.push(`upsert ${POSITIONS_TABLE}/${p.positionId}`, async () => {
      this.assertPersistableVenue(p.venue, POSITIONS_TABLE);
      const userId = await this.userIdForOwnerKey(p.ownerKey);
      // venue_positions_filled_requires_reconciliation: FILLED needs
      // reconciled_at, a source order and a non-zero size. `VenuePosition`
      // carries no source order, so it is recovered from this owner's own
      // reconciled order on the same market and side. With no such order the
      // row is not representable as FILLED — and inventing one would be a lie
      // about where the money came from, so the write is refused instead.
      const sourceOrderId = this.sourceOrderFor(p);
      if (p.fundingState === "FILLED" && (!sourceOrderId || BigInt(p.sizeBaseUnits || "0") <= 0n)) {
        throw new PgrestError(
          `[persist] ${POSITIONS_TABLE}/${p.positionId}: venue_positions_filled_requires_reconciliation needs a source order and a non-zero size. No reconciled order for this owner on ${p.venueMarketId}/${p.side} is known, so "funded" cannot be evidenced (contracts §3/§5).`,
          { sqlState: "23514", details: { positionId: p.positionId } },
        );
      }
      await this.pg.insert(
        POSITIONS_TABLE,
        [
          {
            position_id: p.positionId,
            user_id: userId,
            owner_address: p.owner,
            venue: p.venue,
            venue_market_id: p.venueMarketId,
            market_id: p.marketId || null,
            source_order_id: sourceOrderId,
            side: p.side,
            size_base_units: p.sizeBaseUnits,
            average_probability: p.averageProbability,
            funding_state: p.fundingState,
            claimable_base_units: p.claimableBaseUnits,
            resolution: p.resolution,
            reconciled_at: toTimestamptz(p.updatedAt),
            updated_at: toTimestamptz(p.updatedAt),
          },
        ],
        { onConflict: "position_id" },
      );
    });

    return stored;
  }

  listPositions(ownerKey: string): PositionRecord[] {
    return this.mirror.listPositions(ownerKey);
  }

  private sourceOrderFor(p: PositionRecord): string | null {
    const match = this.mirror
      .listOrders(p.ownerKey)
      .filter(
        (o) =>
          o.venue === p.venue &&
          o.venueMarketId === p.venueMarketId &&
          o.side === p.side &&
          o.reconciledAt !== null,
      )
      .sort((a, b) => (b.reconciledAt ?? 0) - (a.reconciledAt ?? 0))[0];
    return match?.orderId ?? null;
  }

  // ── cursors ───────────────────────────────────────────────────────────────

  getCursor(name: string): string | null {
    return this.mirror.getCursor(name);
  }

  /**
   * Persisted in `public.indexer_cursors`, which is the repo's existing
   * restart-safe-polling watermark table (`advance_indexer_cursor`, used by the
   * arena reconciler). The pivot migrations added no cursor table of their own,
   * and inventing one would mean writing a migration this work is not allowed
   * to write — so an existing, purpose-built, service-role table is used with a
   * distinct `source` so nothing collides. A watermark is not a secret; nothing
   * sensitive is written here. packet-persist.md §4 asks for a purpose-built
   * `bff_cursors` table so this borrowing can end.
   */
  setCursor(name: string, cursor: string | null): void {
    this.mirror.setCursor(name, cursor);
    this.queue.push(`upsert ${CURSORS_TABLE}/${VENUE_CURSOR_SOURCE}:${name}`, async () => {
      await this.pg.insert(
        CURSORS_TABLE,
        [
          {
            network: this.network,
            source: VENUE_CURSOR_SOURCE,
            cursor_key: name,
            last_signature: cursor,
            last_seen_at: toTimestamptz(this.clock.now()),
            updated_at: toTimestamptz(this.clock.now()),
          },
        ],
        { onConflict: "network,source,cursor_key" },
      );
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private assertPersistableVenue(venue: VenueId, table: string): void {
    if (isPersistableVenue(venue)) return;
    throw new PgrestError(
      `[persist] ${table}: venue '${venue}' is refused by ${table}_venue_check, which is CHECK (venue IN ('jupiter','fixture')) in the live schema. Loosening it needs a migration — see docs/contracts/integration-requests/packet-persist.md §1.`,
      { sqlState: "23514", details: { venue, table } },
    );
  }

  /**
   * `ownerKey` is the BFF's "who is asking" handle (`wallet:<address>`, built in
   * src/api/predictions.ts). `venue_orders.user_id` and
   * `venue_positions.user_id` are FKs onto `public.users(id)` because §0.3 says
   * identity IS `public.users.id` and nothing authorises on a wallet string.
   * So the credential is LOOKED UP, never minted: an unknown wallet refuses the
   * write rather than creating an account, which is the exact hole §8.2
   * describes in `sync_user_by_wallet`.
   */
  private async userIdForOwnerKey(ownerKey: string): Promise<string> {
    const cached = this.ownerUserIds.get(ownerKey);
    if (cached) return cached;
    if (isUuid(ownerKey)) {
      this.ownerUserIds.set(ownerKey, ownerKey);
      return ownerKey;
    }
    const wallet = ownerKey.startsWith("wallet:") ? ownerKey.slice("wallet:".length) : ownerKey;
    const direct = await this.pg.select<{ id: string }>(
      USERS_TABLE,
      new URLSearchParams({ select: "id", wallet_address: `eq.${wallet}`, limit: "1" }),
    );
    let id = direct[0]?.id;
    if (!id) {
      const linked = await this.pg.select<{ user_id: string }>(
        LINKED_WALLETS_TABLE,
        new URLSearchParams({ select: "user_id", wallet_address: `eq.${wallet}`, limit: "1" }),
      );
      id = linked[0]?.user_id;
    }
    if (!id) {
      throw new PgrestError(
        `[persist] no canonical public.users row for owner '${ownerKey}'. venue_orders.user_id is a FK onto public.users(id) because identity IS public.users.id (contracts §0.3); this store looks a credential up and never mints one (§8.2).`,
        { sqlState: "23503", details: { ownerKey } },
      );
    }
    this.ownerUserIds.set(ownerKey, id);
    return id;
  }

  /** Walk every row of a table, refusing to serve a silently truncated mirror. */
  private async page<T>(table: string, params: () => URLSearchParams): Promise<T[]> {
    const out: T[] = [];
    const size = 1000;
    for (let offset = 0; offset <= this.maxRowsPerTable; offset += size) {
      const p = params();
      p.set("limit", String(size));
      p.set("offset", String(offset));
      const rows = await this.pg.select<T>(table, p);
      out.push(...rows);
      if (rows.length < size) return out;
    }
    throw new PgrestError(
      `[persist] ${table} has more than ${this.maxRowsPerTable} rows; refusing to hydrate a partial mirror (a partial mirror would mis-enforce the one-live-call-per-market uniqueness).`,
      { details: { table } },
    );
  }
}

// ── row shapes and mappers ───────────────────────────────────────────────────

const MARKET_COLUMNS =
  "id,venue,venue_event_id,venue_market_id,question,rules_text,category,outcomes,status,raw_status,opens_at,closes_at,resolves_at,resolution_source,last_synced_at,payload_version,raw_payload";

interface MarketRow {
  id: string;
  venue: string;
  venue_event_id: string;
  venue_market_id: string;
  question: string;
  rules_text: string;
  category: string;
  outcomes: { side: Side; label: string }[];
  status: string;
  raw_status: string;
  opens_at: string | null;
  closes_at: string | null;
  resolves_at: string | null;
  resolution_source: string | null;
  last_synced_at: string;
  payload_version: number;
  raw_payload: unknown;
}

export function marketFromRow(row: MarketRow): { market: VenueMarket; raw: RawPayload | null } {
  const market: VenueMarket = {
    id: row.id,
    venue: row.venue as VenueId,
    venueEventId: row.venue_event_id,
    venueMarketId: row.venue_market_id,
    question: row.question,
    rulesText: row.rules_text,
    category: row.category,
    outcomes: row.outcomes,
    status: row.status as MarketStatus,
    rawStatus: row.raw_status,
    opensAt: parseTimestamptz(row.opens_at),
    closesAt: parseTimestamptz(row.closes_at),
    resolvesAt: parseTimestamptz(row.resolves_at),
    resolutionSource: row.resolution_source,
    lastSyncedAt: fromTimestamptz(row.last_synced_at, `${MARKETS_TABLE}.last_synced_at`),
    payloadVersion: row.payload_version,
  };
  const raw: RawPayload | null = isEmptyJson(row.raw_payload)
    ? null
    : {
        venue: market.venue,
        venueMarketId: market.venueMarketId,
        payloadVersion: market.payloadVersion,
        fetchedAt: market.lastSyncedAt,
        body: row.raw_payload,
      };
  return { market, raw };
}

const SNAPSHOT_COLUMNS = "id,market_id,yes_probability,observed_at,source";

interface SnapshotRow {
  id: string;
  market_id: string;
  yes_probability: unknown;
  observed_at: string;
  source: string;
}

function snapshotFromRow(row: SnapshotRow): MarketSnapshot {
  return {
    marketId: row.market_id,
    yesProbability: parseNumeric(row.yes_probability) ?? 0,
    observedAt: fromTimestamptz(row.observed_at, `${SNAPSHOTS_TABLE}.observed_at`),
    source: row.source === "fixture" ? "fixture" : "venue",
  };
}

const RESOLUTION_COLUMNS =
  "id,market_id,venue,venue_market_id,resolution,resolved_at,evidence_source,raw_evidence,is_demo,recorded_at";

interface ResolutionRow {
  id: string;
  market_id: string;
  venue: string;
  venue_market_id: string;
  resolution: string;
  resolved_at: string;
  evidence_source: string;
  raw_evidence: unknown;
  is_demo: boolean;
  recorded_at: string;
}

function resolutionFromRow(row: ResolutionRow): MarketResolutionRecord {
  return {
    id: row.id,
    marketId: row.market_id,
    venue: row.venue as VenueId,
    venueMarketId: row.venue_market_id,
    resolution: row.resolution as Resolution,
    resolvedAt: fromTimestamptz(row.resolved_at, `${RESOLUTIONS_TABLE}.resolved_at`),
    evidenceSource: row.evidence_source,
    rawEvidence: row.raw_evidence,
    recordedAt: fromTimestamptz(row.recorded_at, `${RESOLUTIONS_TABLE}.recorded_at`),
    demo: row.is_demo,
  };
}

const ORDER_COLUMNS =
  "order_id,user_id,owner_address,venue,venue_market_id,market_id,side,amount_base_units::text,filled_base_units::text,funding_state,venue_order_id,fill_tx_signature,fill_evidence,reconciliation_source,reconciled_at,idempotency_key,request_fingerprint,is_demo,created_at,updated_at";

interface OrderRow {
  order_id: string;
  user_id: string;
  owner_address: string;
  venue: string;
  venue_market_id: string;
  market_id: string | null;
  side: string;
  amount_base_units: unknown;
  filled_base_units: unknown;
  funding_state: string;
  venue_order_id: string | null;
  fill_tx_signature: string | null;
  fill_evidence: unknown;
  reconciliation_source: string | null;
  reconciled_at: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

function orderFromRow(row: OrderRow): OrderRecord {
  const venue = row.venue as VenueId;
  const filled = parseBaseUnits(row.filled_base_units);
  // The COLUMNS are authoritative: venue_orders_filled_requires_evidence makes
  // venue_order_id / fill_tx_signature / filled_base_units > 0 mandatory for a
  // FILLED row, whatever the JSON blob happens to contain. `fill_evidence` is
  // the provider payload they were read from.
  const evidence = (row.fill_evidence ?? null) as Partial<FillEvidence> | null;
  const hasEvidence = row.venue_order_id !== null && row.fill_tx_signature !== null && filled !== "0";
  return {
    orderId: row.order_id,
    venue,
    venueMarketId: row.venue_market_id,
    marketId: row.market_id ?? "",
    ownerKey: `wallet:${row.owner_address}`,
    ownerAddress: row.owner_address,
    side: row.side as Side,
    amountBaseUnits: parseBaseUnits(row.amount_base_units) as BaseUnits,
    filledBaseUnits: filled as BaseUnits,
    fundingState: row.funding_state as FundingState,
    venueOrderId: row.venue_order_id,
    fillTxSignature: row.fill_tx_signature,
    fillEvidence: hasEvidence
      ? {
          venue,
          venueOrderId: row.venue_order_id as string,
          filledBaseUnits: filled as BaseUnits,
          fillTxSignature: row.fill_tx_signature as string,
          confirmedAt:
            parseTimestamptz(row.reconciled_at) ??
            (typeof evidence?.confirmedAt === "number" ? evidence.confirmedAt : 0),
          raw: evidence?.raw ?? row.fill_evidence ?? null,
        }
      : null,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdAt: fromTimestamptz(row.created_at, `${ORDERS_TABLE}.created_at`),
    updatedAt: fromTimestamptz(row.updated_at, `${ORDERS_TABLE}.updated_at`),
    reconciledAt: parseTimestamptz(row.reconciled_at),
    demo: row.is_demo,
  };
}

const POSITION_COLUMNS =
  "position_id,user_id,owner_address,venue,venue_market_id,market_id,source_order_id,side,size_base_units::text,average_probability,funding_state,claimable_base_units::text,resolution,is_demo,updated_at";

interface PositionRow {
  position_id: string;
  user_id: string;
  owner_address: string;
  venue: string;
  venue_market_id: string;
  market_id: string | null;
  source_order_id: string | null;
  side: string;
  size_base_units: unknown;
  average_probability: unknown;
  funding_state: string;
  claimable_base_units: unknown;
  resolution: string | null;
  is_demo: boolean;
  updated_at: string;
}

function positionFromRow(row: PositionRow): PositionRecord {
  const position: VenuePosition = {
    positionId: row.position_id,
    venue: row.venue as VenueId,
    venueMarketId: row.venue_market_id,
    marketId: row.market_id ?? "",
    owner: row.owner_address,
    side: row.side as Side,
    sizeBaseUnits: parseBaseUnits(row.size_base_units) as BaseUnits,
    averageProbability: parseNumeric(row.average_probability),
    fundingState: row.funding_state as FundingState,
    claimableBaseUnits: parseBaseUnits(row.claimable_base_units) as BaseUnits,
    resolution: (row.resolution as Resolution | null) ?? null,
    updatedAt: fromTimestamptz(row.updated_at, `${POSITIONS_TABLE}.updated_at`),
    demo: row.is_demo,
  };
  return { ...position, ownerKey: `wallet:${row.owner_address}` };
}

interface CursorRow {
  cursor_key: string;
  last_signature: string | null;
}

/** `fill_evidence` is JSONB NOT NULL DEFAULT '{}' and must be non-empty for a fill. */
function fillEvidenceJson(e: FillEvidence): Record<string, unknown> {
  return {
    venue: e.venue,
    venueOrderId: e.venueOrderId,
    filledBaseUnits: e.filledBaseUnits,
    fillTxSignature: e.fillTxSignature,
    confirmedAt: e.confirmedAt,
    raw: e.raw ?? null,
  };
}

/** The CHECK constraints compare against `'{}'::jsonb`. This is that test. */
export function isEmptyJson(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) return false; // `[]` <> `{}` in jsonb, so an array passes
  return Object.keys(v as Record<string, unknown>).length === 0;
}

/**
 * Why this store was or was not built, in a shape a boot log and a test can
 * both read. The `NoopSocialStore` precedent: an unconfigured — or
 * unpersistable — server says so out loud and never pretends to persist.
 */
export interface PersistenceDecision {
  persisting: boolean;
  reason: string;
}

export function supabasePersistenceDecision(args: {
  social: { supabaseUrl: string; serviceRoleKey: string } | undefined;
  venue: VenueId;
}): PersistenceDecision {
  if (!args.social?.supabaseUrl || !args.social?.serviceRoleKey) {
    return {
      persisting: false,
      reason:
        "supabase is not configured (config.social is unset), so venue markets, calls and results live in memory and are lost on restart",
    };
  }
  if (!isPersistableVenue(args.venue)) {
    return {
      persisting: false,
      reason:
        `venue '${args.venue}' is refused by venue_markets_venue_check / market_resolutions_venue_check / venue_orders_venue_check / venue_positions_venue_check, which are CHECK (venue IN ('jupiter','fixture')) in the live schema. ` +
        "Persisting would mean loosening a constraint, so this server stays in memory. Apply packet-persist.md §1 to persist polymarket",
    };
  }
  return { persisting: true, reason: `persisting ${args.venue} rows to supabase` };
}
