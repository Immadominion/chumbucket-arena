/**
 * Resolution sync — venue evidence in, `call_results` out.
 *
 * §0.2: "The venue is the only source of a result. No client, no admin, no
 * friend and no model may write a resolution. Only the BFF synchroniser, from
 * venue evidence." This is that synchroniser.
 *
 * It reads Packet B's `market_resolutions` (through `VenueMarketReader`, which
 * has no method capable of producing anything else) and derives `call_results`.
 * It NEVER invents, guesses or infers. In particular:
 *
 *   - a market whose `status` reads RESOLVED but which has published no
 *     resolution row yields PENDING;
 *   - a market long past `resolvesAt` with no resolution row yields PENDING;
 *   - a market that is CANCELLED yields PENDING until the venue publishes a
 *     VOID resolution. The status is not the evidence.
 *
 * PENDING is not a timeout and never decays into anything. A LATE resolution
 * stays PENDING right up until the venue actually publishes, and then settles
 * normally — which is exactly what "late resolution stays PENDING" means.
 *
 * THREE PROPERTIES, each tested:
 *
 *   IDEMPOTENT  — running it twice over the same history changes nothing the
 *                 second time. Not a row, not a `derivedAt`. `writeResult`
 *                 returns `changed: false` for an identical re-derivation and
 *                 does not touch the stored row.
 *   CURSOR-BACKED — the watermark over `market_resolutions.recordedAt` is
 *                 persisted after every page, so a crash mid-pass resumes
 *                 where it stopped instead of re-walking from zero.
 *   RESTART-SAFE — and yet correctness never DEPENDS on the cursor. Pass 2
 *                 below re-derives every still-pending call directly from
 *                 venue history, so a brand-new synchroniser with an empty
 *                 cursor (a fresh process, a lost cache) repairs the whole
 *                 store from the venue's own record. The cursor is an
 *                 optimisation; the repair sweep is the guarantee.
 */

import { systemClock, type Clock } from "../prediction/clock.ts";
import type { MarketResolutionRecord } from "../prediction/types.ts";
import type { VenueMarketReader } from "./markets.ts";
import type { CallReceiptsProjection } from "./receipts.ts";
import type { CallsStore } from "./store.ts";
import { toCall } from "./types.ts";

export const RESOLUTION_CURSOR = "call_results:venue_resolutions";

export interface ResolutionSyncReport {
  /** Venue resolutions newly consumed this pass. */
  resolutionsSeen: number;
  /** Calls whose result row actually changed. */
  resultsSettled: number;
  /** Calls checked and left exactly as they were. */
  resultsUnchanged: number;
  /** Calls still awaiting venue evidence after the pass. */
  stillPending: number;
  /** Calls that had no result row at all and were given a PENDING one. */
  resultsMaterialised: number;
  pages: number;
  cursor: string | null;
}

export interface ResolutionSyncDeps {
  store: CallsStore;
  markets: VenueMarketReader;
  clock?: Clock;
  receipts?: CallReceiptsProjection;
  /** Safety valve against an endless cursor loop. */
  maxPagesPerPass?: number;
  pageSize?: number;
}

export class ResolutionSync {
  private readonly store: CallsStore;
  private readonly markets: VenueMarketReader;
  private readonly clock: Clock;
  private readonly receipts: CallReceiptsProjection | undefined;
  private readonly maxPages: number;
  private readonly pageSize: number;

  constructor(deps: ResolutionSyncDeps) {
    this.store = deps.store;
    this.markets = deps.markets;
    this.clock = deps.clock ?? systemClock;
    this.receipts = deps.receipts;
    this.maxPages = deps.maxPagesPerPass ?? 50;
    this.pageSize = deps.pageSize ?? 100;
  }

  /** The persisted watermark, as a number. 0 = "walk the whole venue history". */
  cursorAt(): number {
    const raw = this.store.getCursor(RESOLUTION_CURSOR);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** Forget the watermark. The next pass repairs from the whole venue history. */
  resetCursor(): void {
    this.store.setCursor(RESOLUTION_CURSOR, null);
  }

  runOnce(): ResolutionSyncReport {
    const report: ResolutionSyncReport = {
      resolutionsSeen: 0,
      resultsSettled: 0,
      resultsUnchanged: 0,
      stillPending: 0,
      resultsMaterialised: 0,
      pages: 0,
      cursor: null,
    };

    // ── pass 1: walk NEW venue evidence from the persisted watermark ────────
    // Every call on a market the venue has just resolved is settled here.
    const settled = new Set<string>();
    // One read of the tail, oldest first, then paged. The watermark is
    // INCLUSIVE (`recordedAt >= since`) so a second resolution recorded in the
    // same millisecond is never skipped; re-reading one costs nothing because
    // applying it twice is a no-op.
    const tail = this.markets.resolutionsSince(this.cursorAt());

    for (let i = 0; i < tail.length && report.pages < this.maxPages; i += this.pageSize) {
      const batch = tail.slice(i, i + this.pageSize);
      report.pages++;

      for (const evidence of batch) {
        report.resolutionsSeen++;
        this.applyEvidence(evidence, report, settled);
      }

      // Persist after EVERY page: a crash here resumes from the next page,
      // not from the beginning of venue history.
      this.store.setCursor(RESOLUTION_CURSOR, String(batch[batch.length - 1]!.recordedAt));
    }

    // ── pass 2: the repair sweep. Correctness lives here, not in the cursor ──
    // Every call still without a settled result is re-derived from venue
    // history directly. This is what makes a restart with an empty cursor —
    // and a call made AFTER its market had already resolved — come out right.
    for (const call of this.store.listCalls()) {
      const existing = this.store.getResult(call.id);
      if (existing && existing.outcome !== "PENDING") continue;

      const evidence = this.markets.getResolution(call.marketId) ?? null;
      const at = this.clock.now();
      const { result, changed } = this.store.writeResult({ callId: call.id, evidence }, at, { actor: "service" });

      if (!existing) report.resultsMaterialised++;
      if (changed && result.outcome !== "PENDING") {
        if (!settled.has(call.id)) {
          report.resultsSettled++;
          settled.add(call.id);
        }
        this.emitReceipt(call.id, at);
      } else if (!changed) {
        report.resultsUnchanged++;
      }
      if (result.outcome === "PENDING") report.stillPending++;
    }

    report.cursor = this.store.getCursor(RESOLUTION_CURSOR);
    return report;
  }

  /** Derive every live call on the resolved market. Idempotent by construction. */
  private applyEvidence(
    evidence: MarketResolutionRecord,
    report: ResolutionSyncReport,
    settled: Set<string>,
  ): void {
    for (const call of this.store.listCalls()) {
      if (call.marketId !== evidence.marketId) continue;
      const at = this.clock.now();
      const { result, changed } = this.store.writeResult({ callId: call.id, evidence }, at, { actor: "service" });
      if (changed) {
        if (result.outcome !== "PENDING" && !settled.has(call.id)) {
          report.resultsSettled++;
          settled.add(call.id);
        }
        this.emitReceipt(call.id, at);
      } else {
        report.resultsUnchanged++;
      }
    }
  }

  /** A settled receipt is a projection of a derived result, never its own fact. */
  private emitReceipt(callId: string, at: number): void {
    if (!this.receipts) return;
    const call = this.store.getCall(callId);
    const result = this.store.getResult(callId);
    if (!call || !result || result.outcome === "PENDING") return;
    this.receipts.recordSettled(toCall(call), result, this.markets.getMarket(call.marketId), at);
  }
}
