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
 * No amount, wallet or order identifier is exposed — only that the author
 * backed this call with a confirmed Panta position.
 */
import type { AppConfig } from "../config.ts";
import { SupabasePantaTradingStore, type PantaTradingLedger } from "./PantaTradingStore.ts";

export interface CallFunding {
  state: "FILLED";
  venue: "panta";
  /** When the fill was confirmed (unix ms). */
  fundedAt: number;
}
export interface CallFundingReader {
  fundingOf(callId: string): CallFunding | null;
}

export class PantaFundingIndex implements CallFundingReader {
  private readonly funded = new Map<string, number>();
  private cursor: string | null = null;
  private loaded = false;

  constructor(private readonly source: Pick<PantaTradingLedger, "filledSince"> | null) {}

  /** True once the ledger has been read at least once. */
  get hydrated(): boolean { return this.loaded; }

  fundingOf(callId: string): CallFunding | null {
    const at = this.funded.get(callId);
    return at === undefined ? null : { state: "FILLED", venue: "panta", fundedAt: at };
  }

  /** A confirmed fill this process just made durable. */
  markFilled(callId: string, at: number): void {
    if (!this.funded.has(callId)) this.funded.set(callId, at);
  }

  /** Pull confirmed fills changed since the last pull. Idempotent; returns how many were new. */
  async refresh(pageSize = 500): Promise<number> {
    if (!this.source) { this.loaded = true; return 0; }
    let added = 0;
    for (let page = 0; page < 20; page++) {
      const rows = await this.source.filledSince(this.cursor, pageSize);
      for (const row of rows) {
        const at = Date.parse(row.updated_at);
        if (!this.funded.has(row.call_id)) { this.funded.set(row.call_id, Number.isFinite(at) ? at : Date.now()); added++; }
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
