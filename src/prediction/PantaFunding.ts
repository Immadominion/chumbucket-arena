/**
 * Which calls carry a CONFIRMED Panta fill — the social "put money on it"
 * marker shown on feeds, call detail and receipts.
 *
 * Only a FILLED ledger row counts, and FILLED is unreachable without the
 * provider's confirmed attribution plus independent RPC proof of the exact USDC
 * debit (see PantaTradingService.reconcile and the SQL CHECKs). SUBMITTED,
 * QUOTED or a wallet tap never mark a call.
 *
 * The marker is deliberately an overlay on the feed entry, not a rewrite of
 * `calls.funding_state`: that column is the call's immutable free/funded
 * provenance (§3), and free-call accuracy stays computed from free calls.
 * No wallet or order identifier is exposed. The filled amount and side are
 * held for "$5 on YES" receipts and cards, and the calls layer shows them
 * only with MONEY_CALLS_ENABLED (docs/money-api.md); off, a funded entry
 * keeps its exact earlier shape.
 */
import type { AppConfig } from "../config.ts";
import { SupabasePantaTradingStore, type PantaTradingLedger } from "./PantaTradingStore.ts";

export interface CallFunding {
  state: "FILLED";
  venue: "panta";
  /** When the fill was confirmed (unix ms). */
  fundedAt: number;
  /** The confirmed fills on this call, summed: USDC base units. MONEY_CALLS_ENABLED only. */
  amountBaseUnits?: string;
  /** The side those fills bought. MONEY_CALLS_ENABLED only. */
  side?: "YES" | "NO";
}
/** One confirmed fill, as the ledger reports it. */
export interface FilledRow {
  id?: string;
  call_id: string;
  updated_at: string;
  amount_base_units?: string;
  side?: "YES" | "NO";
}
interface Funded { at: number; amount: bigint; side: "YES" | "NO" | null; known: boolean }
export interface CallFundingReader {
  fundingOf(callId: string): CallFunding | null;
}

export class PantaFundingIndex implements CallFundingReader {
  private readonly funded = new Map<string, Funded>();
  /** Fill rows already summed, so a re-read page never counts one twice. */
  private readonly seen = new Set<string>();
  private cursor: string | null = null;
  private loaded = false;

  constructor(private readonly source: { filledSince(since: string | null, limit: number): Promise<FilledRow[]> } | null) {}

  /** True once the ledger has been read at least once. */
  get hydrated(): boolean { return this.loaded; }

  fundingOf(callId: string): CallFunding | null {
    const f = this.funded.get(callId);
    if (!f) return null;
    return { state: "FILLED", venue: "panta", fundedAt: f.at,
      ...(f.known && f.amount > 0n ? { amountBaseUnits: f.amount.toString() } : {}), ...(f.side ? { side: f.side } : {}) };
  }

  /** A confirmed fill this process just made durable. */
  markFilled(callId: string, at: number, fill?: { id: string; amountBaseUnits: string; side: "YES" | "NO" }): void {
    this.add({ call_id: callId, updated_at: new Date(at).toISOString(),
      ...(fill ? { id: fill.id, amount_base_units: fill.amountBaseUnits, side: fill.side } : {}) }, at);
  }

  private add(row: FilledRow, at: number): boolean {
    if (row.id !== undefined) {
      if (this.seen.has(row.id)) return false;
      this.seen.add(row.id);
    }
    const amount = row.amount_base_units !== undefined && /^[0-9]+$/.test(String(row.amount_base_units)) ? BigInt(row.amount_base_units) : null;
    const held = this.funded.get(row.call_id);
    if (!held) {
      this.funded.set(row.call_id, { at, amount: amount ?? 0n, side: row.side ?? null, known: amount !== null && row.id !== undefined });
      return true;
    }
    // A second confirmed fill on the same call (another of the person's wallets).
    if (amount !== null && row.id !== undefined && held.known) held.amount += amount;
    else held.known = false;
    return false;
  }

  /** Pull confirmed fills changed since the last pull. Idempotent; returns how many calls were new. */
  async refresh(pageSize = 500): Promise<number> {
    if (!this.source) { this.loaded = true; return 0; }
    let added = 0;
    for (let page = 0; page < 20; page++) {
      const rows = await this.source.filledSince(this.cursor, pageSize);
      for (const row of rows) {
        const at = Date.parse(row.updated_at);
        if (this.add(row, Number.isFinite(at) ? at : Date.now())) added++;
        this.cursor = row.updated_at;
      }
      if (rows.length < pageSize) break;
    }
    this.loaded = true;
    return added;
  }
}

const indexes = new WeakMap<AppConfig, PantaFundingIndex>();
/**
 * One index per AppConfig. Backed by the durable ledger only when the Panta
 * schema is live and the service database is configured; otherwise it is
 * empty, which reads as "no call is funded" — the truth for such a server.
 * Construction never touches the network; `refresh()` does.
 */
export function pantaFundingIndexFor(config: AppConfig): PantaFundingIndex {
  let index = indexes.get(config);
  if (!index) {
    const source = config.social && config.predictions?.pantaSchemaReady === true
      ? new SupabasePantaTradingStore(config.social) : null;
    index = new PantaFundingIndex(source);
    indexes.set(config, index);
  }
  return index;
}
/** Test seam, scoped to the exact AppConfig object. */
export function setPantaFundingIndex(config: AppConfig, index: PantaFundingIndex): void { indexes.set(config, index); }
