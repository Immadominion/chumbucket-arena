/**
 * The server-side half of "approval is not a fill": re-verifies every
 * SUBMITTED Panta buy and win claim on a cadence until it is proven FILLED /
 * CONFIRMED or proven FAILED, so nobody has to tap "Check order status".
 *
 * It never decides anything itself. Each row goes through the exact
 * transition the person's own check uses (PantaTradingService.reconcile,
 * PantaClaimService.reconcile), so a fill still needs provider attribution
 * plus independent RPC proof, and a failure still needs the chain to say so.
 * A definitively FAILED buy stops blocking a fresh funding of that call.
 *
 * Budget: Panta allows ~40 verify/report calls a minute per key, shared with
 * people's own checks, so each pass is bounded and each row backs off
 * (15 s, 30 s, 1 min, … capped at 10 min) while it stays pending. Backoff is
 * in memory: a restart simply checks every pending row once more.
 */
import { systemClock, type Clock } from "./clock.ts";
import { isVenueError } from "./errors.ts";
import type { PantaClaimService } from "./PantaClaimService.ts";
import type { PantaClaimSession, PantaClaimStore } from "./PantaClaimStore.ts";
import type { PantaFundingIndex } from "./PantaFunding.ts";
import type { PantaTradingService } from "./PantaTradingService.ts";
import type { PantaTradeSession, PantaTradingLedger } from "./PantaTradingStore.ts";
import type { MoneySweepReport } from "../money/hooks.ts";

export interface PantaReconcileReport {
  checked: number;
  filled: number;
  failed: number;
  pending: number;
  claimsChecked: number;
  claimsConfirmed: number;
  claimsFailed: number;
  fundedCallsLoaded: number;
  /** MONEY_CALLS_ENABLED: pending money calls funded / expired, wallet transfers settled this pass. */
  moneyFunded: number;
  moneyExpired: number;
  transfersSettled: number;
  errors: string[];
}

const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 600_000;

export class PantaReconciler {
  private readonly clock: Clock;
  private readonly backoff = new Map<string, { attempts: number; nextAt: number }>();
  private running = false;

  constructor(private readonly deps: {
    ledger: Pick<PantaTradingLedger, "submitted">;
    trading: Pick<PantaTradingService, "reconcile">;
    claimStore?: Pick<PantaClaimStore, "submitted"> | null;
    claims?: Pick<PantaClaimService, "reconcile"> | null;
    funding?: Pick<PantaFundingIndex, "refresh"> | null;
    /** MONEY_CALLS_ENABLED: the money sweeper (src/money), run after the fills are known. */
    money?: { sweep(): Promise<MoneySweepReport> } | null;
    clock?: Clock;
    /** Most rows verified per pass. Default 8. */
    maxPerPass?: number;
  }) {
    this.clock = deps.clock ?? systemClock;
  }

  private due(id: string, now: number): boolean {
    const b = this.backoff.get(id);
    return !b || b.nextAt <= now;
  }
  private defer(id: string, now: number): void {
    const attempts = (this.backoff.get(id)?.attempts ?? 0) + 1;
    this.backoff.set(id, { attempts, nextAt: now + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1)) });
  }

  /** One bounded pass. Overlapping calls are ignored, not queued. */
  async runOnce(): Promise<PantaReconcileReport> {
    const report: PantaReconcileReport = { checked: 0, filled: 0, failed: 0, pending: 0, claimsChecked: 0,
      claimsConfirmed: 0, claimsFailed: 0, fundedCallsLoaded: 0, moneyFunded: 0, moneyExpired: 0, transfersSettled: 0, errors: [] };
    if (this.running) return report;
    this.running = true;
    try {
      const budget = Math.max(1, this.deps.maxPerPass ?? 8);
      const now = this.clock.now();
      let rows: PantaTradeSession[] = [];
      try { rows = await this.deps.ledger.submitted(100); }
      catch (error) { report.errors.push(codeOf(error)); }
      const live = new Set(rows.map(r => r.id));
      for (const id of this.backoff.keys()) if (!live.has(id) && !id.startsWith("claim:")) this.backoff.delete(id);
      for (const row of rows.filter(r => this.due(r.id, now)).slice(0, budget)) {
        report.checked++;
        try {
          const next = await this.deps.trading.reconcile(row);
          if (next.state === "FILLED") { report.filled++; this.backoff.delete(row.id); }
          else if (next.state === "FAILED") { report.failed++; this.backoff.delete(row.id); }
          else { report.pending++; this.defer(row.id, now); }
        } catch (error) {
          report.errors.push(codeOf(error)); this.defer(row.id, now);
        }
      }
      if (this.deps.claimStore && this.deps.claims) {
        let claims: PantaClaimSession[] = [];
        try { claims = await this.deps.claimStore.submitted(100); }
        catch (error) { report.errors.push(codeOf(error)); }
        const liveClaims = new Set(claims.map(c => `claim:${c.id}`));
        for (const id of this.backoff.keys()) if (id.startsWith("claim:") && !liveClaims.has(id)) this.backoff.delete(id);
        for (const claim of claims.filter(c => this.due(`claim:${c.id}`, now)).slice(0, budget)) {
          report.claimsChecked++;
          try {
            const next = await this.deps.claims.reconcile(claim);
            if (next.state === "CONFIRMED") { report.claimsConfirmed++; this.backoff.delete(`claim:${claim.id}`); }
            else if (next.state === "FAILED") { report.claimsFailed++; this.backoff.delete(`claim:${claim.id}`); }
            else this.defer(`claim:${claim.id}`, now);
          } catch (error) {
            report.errors.push(codeOf(error)); this.defer(`claim:${claim.id}`, now);
          }
        }
      }
      if (this.deps.funding) {
        try { report.fundedCallsLoaded = await this.deps.funding.refresh(); }
        catch (error) { report.errors.push(codeOf(error)); }
      }
      if (this.deps.money) {
        try {
          const swept = await this.deps.money.sweep();
          report.moneyFunded = swept.funded;
          report.moneyExpired = swept.expired;
          report.transfersSettled = swept.transfersConfirmed + swept.transfersFailed;
          report.errors.push(...swept.errors);
        } catch { report.errors.push("MONEY_SWEEP_FAILED"); }
      }
      return report;
    } finally { this.running = false; }
  }
}

/** Log-safe: a venue error code or a fixed label. Never a body, cause or approval. */
function codeOf(error: unknown): string {
  return isVenueError(error) ? error.code : "LEDGER_OR_RPC_UNAVAILABLE";
}
