/**
 * Which calls are still private because their money has not landed.
 *
 * A call made with an amount is PENDING until its Panta order is FILLED, and
 * a PENDING call is its owner's alone: no feed, profile, top-calls strip,
 * suggestion, notification, crowd split or record ever sees it. An EXPIRED one
 * (never funded, never kept free) stays that way for good, and so does a FREE
 * one: "keep it free" withdraws it and makes a fresh free call at the current
 * price, which is the public one. A FUNDED call is an ordinary public call
 * and is not held here.
 *
 * The calls layer reads a synchronous mirror (it serves every read from
 * memory), so this is a mirror too: hydrated from money_calls with the calls
 * mirror, before any read is served, and updated in the same tick as every
 * transition the BFF makes. A row is put here BEFORE its call is locked, so a
 * pending call is never public for an instant.
 */
import type { AppConfig } from "../config.ts";
import { InMemoryMoneyCallStore, SupabaseMoneyCallStore, type MoneyCallRow, type MoneyCallStore } from "./store.ts";

export interface MoneyCallOwnerView {
  /** FREE: replaced by a fresh free call (that call is the one on record). */
  state: "PENDING" | "EXPIRED" | "FREE";
  amountBaseUnits: string;
  side: "YES" | "NO";
  expiresAt: number;
}

/** What the calls layer asks. */
export interface MoneyCallVisibility {
  /** PENDING, EXPIRED or FREE (replaced): owner-only, on no public surface or record. */
  isPrivate(callId: string): boolean;
  /** The owner's view of their own private money call, or null. */
  ownerView(callId: string): MoneyCallOwnerView | null;
}

export class MoneyCallIndex implements MoneyCallVisibility {
  private readonly rows = new Map<string, MoneyCallRow>();
  private loaded = false;

  constructor(private readonly source: Pick<MoneyCallStore, "privateRows"> | null) {}

  get hydrated(): boolean { return this.loaded; }

  isPrivate(callId: string): boolean { return this.rows.has(callId); }

  ownerView(callId: string): MoneyCallOwnerView | null {
    const row = this.rows.get(callId);
    if (!row || row.state === "FUNDED") return null;
    return { state: row.state, amountBaseUnits: row.amount_base_units, side: row.side, expiresAt: Date.parse(row.expires_at) };
  }

  get(callId: string): MoneyCallRow | undefined { return this.rows.get(callId); }

  /** Every PENDING row, for the sweeper. */
  pending(): MoneyCallRow[] { return [...this.rows.values()].filter(r => r.state === "PENDING"); }

  /** The newest state of a row. FUNDED leaves the index: the call is public. */
  put(row: MoneyCallRow): void {
    if (row.state === "FUNDED") this.rows.delete(row.call_id);
    else this.rows.set(row.call_id, row);
  }

  /** Read every private row. Throws when the ledger cannot be read: the caller fails closed. */
  async hydrate(): Promise<number> {
    if (!this.source) { this.loaded = true; return 0; }
    const rows = await this.source.privateRows();
    for (const row of rows) this.put(row);
    this.loaded = true;
    return rows.length;
  }
}

/** On only with MONEY_CALLS_ENABLED=true. */
export function moneyCallsEnabled(config: AppConfig | undefined): boolean {
  return config?.money?.callsEnabled === true;
}

const stores = new WeakMap<AppConfig, MoneyCallStore>();
const indexes = new WeakMap<AppConfig, MoneyCallIndex>();

/** The money_calls ledger for this app: durable with an account database, else memory. */
export function moneyCallStoreFor(config: AppConfig): MoneyCallStore {
  let store = stores.get(config);
  if (!store) {
    store = config.social ? new SupabaseMoneyCallStore(config.social) : new InMemoryMoneyCallStore();
    stores.set(config, store);
  }
  return store;
}

/** One index per AppConfig. Construction never touches the network; `hydrate()` does. */
export function moneyCallIndexFor(config: AppConfig): MoneyCallIndex {
  let index = indexes.get(config);
  if (!index) {
    index = new MoneyCallIndex(moneyCallStoreFor(config));
    indexes.set(config, index);
  }
  return index;
}

/** Test seams, scoped to the exact AppConfig object. */
export function setMoneyCallStore(config: AppConfig, store: MoneyCallStore): void { stores.set(config, store); indexes.delete(config); }
export function setMoneyCallIndex(config: AppConfig, index: MoneyCallIndex): void { indexes.set(config, index); }
