/**
 * Cursor-backed, idempotent reconciliation (contracts §4).
 *
 * The problem it exists for: a callback is dropped, or the process restarts
 * between "client signed and sent" and "venue confirmed the fill". The local
 * order is then stuck on SUBMITTED forever while the user's money is actually
 * in a filled position. Polling the venue's own history repairs that — and
 * because it is the ONLY writer of FILLED, it is also the only thing that can
 * ever make the word "funded" true.
 *
 * Three properties it must have, and is tested for:
 *   - IDEMPOTENT: running it twice over the same history changes nothing the
 *     second time (no duplicate positions, no double fills).
 *   - CURSOR-BACKED: the position cursor is persisted after every page, so a
 *     crash mid-pass resumes where it stopped instead of re-walking from zero.
 *   - RESTART-SAFE: a brand-new reconciler over the same store picks the cursor
 *     back up.
 *
 * It never invents a fill. A venue order that does not carry a venue order id,
 * a non-zero filled size and a transaction signature is not a confirmed fill,
 * and the store rejects it.
 */

import { systemClock, type Clock } from "./clock.ts";
import { isVenueError } from "./errors.ts";
import type { PredictionVenue, VenueOrder } from "./PredictionVenue.ts";
import type { FundingState } from "./types.ts";
import type { FillEvidence, PredictionStore } from "./store.ts";

/** Orders worth asking the venue about. Terminal states are left alone. */
const REPAIRABLE: ReadonlySet<FundingState> = new Set<FundingState>(["QUOTED", "SUBMITTED", "PARTIAL"]);

export interface ReconcileReport {
  ordersChecked: number;
  ordersFilled: number;
  ordersPartial: number;
  ordersFailed: number;
  ordersUnchanged: number;
  ordersMissingAtVenue: number;
  positionsUpserted: number;
  pages: number;
  cursor: string | null;
}

export interface OrderReconcilerDeps {
  venue: PredictionVenue;
  store: PredictionStore;
  clock?: Clock;
  /** Safety valve against an endless cursor loop from a misbehaving venue. */
  maxPagesPerPass?: number;
}

export class OrderReconciler {
  private readonly venue: PredictionVenue;
  private readonly store: PredictionStore;
  private readonly clock: Clock;
  private readonly maxPages: number;

  constructor(deps: OrderReconcilerDeps) {
    this.venue = deps.venue;
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
    this.maxPages = deps.maxPagesPerPass ?? 50;
  }

  static cursorKey(ownerKey: string): string {
    return `positions:${ownerKey}`;
  }

  async runOnce(opts: { ownerKey: string; owner: string }): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      ordersChecked: 0,
      ordersFilled: 0,
      ordersPartial: 0,
      ordersFailed: 0,
      ordersUnchanged: 0,
      ordersMissingAtVenue: 0,
      positionsUpserted: 0,
      pages: 0,
      cursor: null,
    };

    // ── 1. repair every non-terminal order from the venue's own record ──────
    for (const local of this.store.listOrders(opts.ownerKey)) {
      if (!REPAIRABLE.has(local.fundingState)) continue;
      report.ordersChecked++;
      let remote: VenueOrder;
      try {
        remote = await this.venue.getOrder(local.orderId);
      } catch (err) {
        if (isVenueError(err) && err.code === "VENUE_NOT_FOUND") {
          report.ordersMissingAtVenue++;
          continue;
        }
        throw err;
      }
      const at = this.clock.now();

      // A dropped callback shows up exactly here: the venue has moved on and we
      // never heard. Walk the local row forward through the states it skipped.
      if (remote.fundingState === "FILLED" || remote.fundingState === "PARTIAL") {
        if (local.fundingState === "QUOTED") this.store.setOrderState(local.orderId, "SUBMITTED", at);
        const evidence = this.evidenceFrom(remote, at);
        if (!evidence) {
          // The venue says filled but cannot prove it. Never mark FILLED.
          report.ordersUnchanged++;
          continue;
        }
        const updated = this.store.applyFill(local.orderId, evidence, at);
        if (updated.fundingState === "FILLED") report.ordersFilled++;
        else report.ordersPartial++;
        continue;
      }

      if (remote.fundingState === "FAILED") {
        this.store.setOrderState(local.orderId, "FAILED", at);
        report.ordersFailed++;
        continue;
      }

      if (remote.fundingState === "SUBMITTED" && local.fundingState === "QUOTED") {
        this.store.setOrderState(local.orderId, "SUBMITTED", at);
        report.ordersUnchanged++;
        continue;
      }

      report.ordersUnchanged++;
    }

    // ── 2. walk venue positions from the persisted cursor ──────────────────
    const cursorKey = OrderReconciler.cursorKey(opts.ownerKey);
    let cursor = this.store.getCursor(cursorKey);
    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.venue.listPositions(opts.owner, cursor ?? undefined);
      report.pages++;
      for (const p of res.positions) {
        this.store.upsertPosition({ ...p, ownerKey: opts.ownerKey });
        report.positionsUpserted++;
      }
      // Persist after EVERY page: a crash here resumes from the next page, not
      // from the beginning.
      this.store.setCursor(cursorKey, res.nextCursor);
      cursor = res.nextCursor;
      if (!res.nextCursor) break;
    }
    report.cursor = this.store.getCursor(cursorKey);
    return report;
  }

  /**
   * Turn a venue order into confirmed fill evidence, or null. "The venue said
   * filled" is NOT sufficient on its own — a fill needs a venue order id, a
   * non-zero filled size and a transaction signature.
   */
  private evidenceFrom(remote: VenueOrder, at: number): FillEvidence | null {
    if (!remote.venueOrderId || !remote.fillTxSignature) return null;
    let filled: bigint;
    try {
      filled = BigInt(remote.filledBaseUnits);
    } catch {
      return null;
    }
    if (filled <= 0n) return null;
    return {
      venue: remote.venue,
      venueOrderId: remote.venueOrderId,
      filledBaseUnits: remote.filledBaseUnits,
      fillTxSignature: remote.fillTxSignature,
      confirmedAt: remote.updatedAt || at,
      raw: remote,
    };
  }
}
