/** One bounded, single-flight venue -> durable evidence -> call-result pass.
 *  Catalog sync alone can lose closed markets; called Panta markets are polled
 *  individually until the venue publishes an evidenced answer. */
import type { Clock } from "../prediction/clock.ts";
import { systemClock } from "../prediction/clock.ts";
import { isVenueError } from "../prediction/errors.ts";
import type { PredictionRuntime } from "../prediction/runtime.ts";
import type { MarketSyncReport } from "../prediction/marketSync.ts";
import type { CallsRuntime } from "./runtime.ts";
import type { ResolutionSyncReport } from "./ResolutionSync.ts";

export const PENDING_MARKET_CURSOR = "call_results:pending_panta_market";

type CallsPort = Pick<CallsRuntime, "store" | "markets" | "sync" | "durable">;
type PredictionPort = Pick<PredictionRuntime, "marketSync" | "durable">;

export interface CallResultWorkerReport {
  catalog: MarketSyncReport;
  calledMarketsRefreshed: number;
  calledMarketsUnavailable: number;
  calledResolutionsRecorded: number;
  calledResolutionsUnevidenced: number;
  results: ResolutionSyncReport;
}

export class CallResultWorker {
  private inFlight: Promise<CallResultWorkerReport> | null = null;
  private readonly clock: Clock;
  private readonly maxCalledMarketsPerPass: number;

  constructor(private readonly deps: {
    calls: CallsPort;
    prediction: PredictionPort;
    clock?: Clock;
    maxCalledMarketsPerPass?: number;
  }) {
    this.clock = deps.clock ?? systemClock;
    const requested = deps.maxCalledMarketsPerPass ?? 8;
    this.maxCalledMarketsPerPass = Number.isFinite(requested)
      ? Math.max(1, Math.min(16, Math.trunc(requested))) : 8;
  }

  /** Overlapping intervals join the same pass; they never race a cursor or a
   *  FIFO database writer. The cursor advances after a bounded target batch;
   *  schema/write failures stay loud and can be retried next tick. */
  runOnce(): Promise<CallResultWorkerReport> {
    if (this.inFlight) return this.inFlight;
    const pass = this.runPass();
    this.inFlight = pass.finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runPass(): Promise<CallResultWorkerReport> {
    const { calls, prediction } = this.deps;
    let catalog: MarketSyncReport | undefined;
    let failed = false;
    let failure: unknown;
    let calledMarketsRefreshed = 0;
    let calledMarketsUnavailable = 0;
    let calledResolutionsRecorded = 0;
    let calledResolutionsUnevidenced = 0;
    try {
      catalog = await prediction.marketSync.runOnce();
    } catch (error) {
      // A catalog-page failure must not starve known calls whose detail endpoint
      // can still publish final evidence. Preserve the failure for the caller.
      failed = true;
      failure = error;
    }
    try {
      await prediction.durable?.flush(); // catalog parent/evidence before target reads
      const targets = this.pendingTargets();
      for (const venueMarketId of targets) {
        try {
          const refreshed = await prediction.marketSync.refreshCalledMarket(venueMarketId);
          calledMarketsRefreshed++;
          if (refreshed.resolutionRecorded) calledResolutionsRecorded++;
          if (refreshed.resolutionUnevidenced) calledResolutionsUnevidenced++;
        } catch (error) {
          if (!isVenueError(error) || !(error.retryable || error.code === "CIRCUIT_OPEN" || error.code === "VENUE_NOT_FOUND")) {
            throw error; // especially a changed schema: never guess or swallow it
          }
          calledMarketsUnavailable++;
        }
      }
      // One durable cursor write per pass, not eight per minute while a venue
      // holds a result in review. The repair sweep makes re-polling crash-safe.
      const last = targets.at(-1);
      if (last && calls.store.getCursor(PENDING_MARKET_CURSOR) !== last) {
        calls.store.setCursor(PENDING_MARKET_CURSOR, last);
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }

    // A provider/catalog failure must stay loud, but cannot stop an already
    // recorded, valid venue resolution from settling a pending call. If the
    // durable venue write itself failed, this await refuses before derivation.
    await prediction.durable?.flush();
    const results = calls.sync.runOnce();
    await calls.durable?.flush(); // never report settlement before durable write
    if (failed) throw failure;
    if (!catalog) throw new Error("Call-result pass produced no catalog report");
    return { catalog, calledMarketsRefreshed, calledMarketsUnavailable,
      calledResolutionsRecorded, calledResolutionsUnevidenced, results };
  }

  private pendingTargets(): string[] {
    const { calls } = this.deps;
    const now = this.clock.now();
    const ids = new Set<string>();
    for (const call of calls.store.listCalls()) {
      const existing = calls.store.getResult(call.id);
      if (existing && existing.outcome !== "PENDING") continue;
      const market = calls.markets.getMarket(call.marketId);
      if (!market || market.venue !== "panta" || calls.markets.getResolution(market.id)) continue;
      if (market.status === "OPEN" && (market.closesAt === null || market.closesAt > now)) continue;
      ids.add(market.venueMarketId);
    }
    const ordered = [...ids].sort();
    if (ordered.length === 0) return [];
    const cursor = calls.store.getCursor(PENDING_MARKET_CURSOR);
    const next = cursor === null ? 0 : ordered.findIndex(id => id > cursor);
    const start = next < 0 ? 0 : next;
    return [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, this.maxCalledMarketsPerPass);
  }
}
