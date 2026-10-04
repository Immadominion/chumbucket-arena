/** Async, private intent ledger. No in-memory success ahead of durability. */
import { pantaTradable } from "./marketQuote.ts";
import { Pgrest, type PgrestConfig } from "./pgrest.ts";
import type { PantaPreparedOrder } from "./PantaExecution.ts";
import type { Side } from "./types.ts";
import type { VenueOrder } from "./PredictionVenue.ts";

export interface PantaTradeSession {
  id: string; user_id: string; call_id: string; market_id: string; wallet_address: string;
  venue_market_id: string; side: Side; amount_base_units: string; max_slippage_bps: number;
  idempotency_key: string; request_fingerprint: string;
  state: "PREPARING" | "QUOTED" | "SUBMITTED" | "FILLED" | "FAILED";
  provider_order_id: string | null; prepared: PantaPreparedOrder | null;
  signed_transaction: string | null; signature: string | null; fill_evidence: VenueOrder | null;
  created_at: string; updated_at: string;
}
export interface PantaCallIntent {
  callId: string; marketId: string; venueMarketId: string; side: Side;
  /** False for a market Chumbucket's trade path cannot trade (a SOL-quoted
   *  Panta market read from its program account). Absent means tradable. */
  tradable?: boolean;
}
export interface PantaTradingStore {
  callIntent(userId: string, callId: string): Promise<PantaCallIntent | null>;
  find(userId: string, idempotencyKey: string): Promise<PantaTradeSession | null>;
  byOrder(userId: string, orderId: string): Promise<PantaTradeSession | null>;
  activeForCall(userId: string, callId: string, wallet: string): Promise<PantaTradeSession | null>;
  reserve(intent: Omit<PantaTradeSession, "state" | "provider_order_id" | "prepared" | "signed_transaction" | "signature" | "fill_evidence" | "created_at" | "updated_at">): Promise<PantaTradeSession | null>;
  update(id: string, previousState: PantaTradeSession["state"], patch: Partial<PantaTradeSession>): Promise<PantaTradeSession | null>;
}
/**
 * Lifecycle reads over the same private ledger, for the server reconciler,
 * the owner's positions and the funded-call marker. Every per-person read is
 * keyed by the canonical person id taken from the verified session.
 */
export interface PantaTradingLedger extends PantaTradingStore {
  /** SUBMITTED approvals across all people, oldest change first. Server worker only. */
  submitted(limit: number): Promise<PantaTradeSession[]>;
  /** The person's approvals that reached a wallet signature (SUBMITTED, FILLED, FAILED). */
  listForUser(userId: string, limit?: number): Promise<PantaTradeSession[]>;
  /** Every one of them, oldest first, paged; throws past a hard cap rather than truncate. */
  listAllForUser?(userId: string): Promise<PantaTradeSession[]>;
  /** The person's newest signed approval for one of their calls, any wallet. */
  latestForCall(userId: string, callId: string): Promise<PantaTradeSession | null>;
  /** Confirmed fills changed at or after `since` (ISO), oldest first: call id and time only. */
  filledSince(since: string | null, limit: number): Promise<{ call_id: string; updated_at: string }[]>;
}
/** listAllForUser's ceiling: 50 pages of 200. */
const ALL_ROWS_CAP = 10_000;
const columns = "id,user_id,call_id,market_id,wallet_address,venue_market_id,side,amount_base_units::text,max_slippage_bps,idempotency_key,request_fingerprint,state,provider_order_id,prepared,signed_transaction,signature,fill_evidence,created_at,updated_at";
export class SupabasePantaTradingStore implements PantaTradingLedger {
  private readonly pg: Pgrest;
  constructor(config: PgrestConfig, fetchImpl: typeof fetch = fetch) { this.pg = new Pgrest(config, fetchImpl); }
  async callIntent(userId: string, callId: string): Promise<PantaCallIntent | null> {
    const calls = await this.pg.select<{ id: string; market_id: string; side: Side }>("calls", new URLSearchParams({ id: `eq.${callId}`, user_id: `eq.${userId}`, select: "id,market_id,side", limit: "1" }));
    const call = calls[0]; if (!call) return null;
    const markets = await this.pg.select<{ venue_market_id: string; payload_version: number }>("venue_markets", new URLSearchParams({ id: `eq.${call.market_id}`, venue: "eq.panta", is_public: "eq.true", select: "venue_market_id,payload_version", limit: "1" }));
    const market = markets[0];
    return market ? { callId, marketId: call.market_id, venueMarketId: market.venue_market_id, side: call.side,
      tradable: pantaTradable({ venue: "panta", payloadVersion: market.payload_version }) } : null;
  }
  async find(userId: string, idempotencyKey: string) {
    return (await this.pg.select<PantaTradeSession>("panta_trade_sessions", new URLSearchParams({ user_id: `eq.${userId}`, idempotency_key: `eq.${idempotencyKey}`, select: columns, limit: "1" })))[0] ?? null;
  }
  async byOrder(userId: string, orderId: string) {
    return (await this.pg.select<PantaTradeSession>("panta_trade_sessions", new URLSearchParams({ user_id: `eq.${userId}`, provider_order_id: `eq.${orderId}`, select: columns, limit: "1" })))[0] ?? null;
  }
  async activeForCall(userId: string, callId: string, wallet: string) {
    return (await this.pg.select<PantaTradeSession>("panta_trade_sessions", new URLSearchParams({
      user_id: `eq.${userId}`, call_id: `eq.${callId}`, wallet_address: `eq.${wallet}`,
      state: "in.(SUBMITTED,FILLED)", select: columns, order: "created_at.desc", limit: "1",
    })))[0] ?? null;
  }
  async reserve(intent: Parameters<PantaTradingStore["reserve"]>[0]) {
    const rows = await this.pg.insert<PantaTradeSession>("panta_trade_sessions", [intent], { onConflict: "user_id,idempotency_key", ignoreDuplicates: true, returning: true });
    return rows[0] ?? null;
  }
  async update(id: string, previousState: PantaTradeSession["state"], patch: Partial<PantaTradeSession>) {
    const rows = await this.pg.patch<PantaTradeSession>("panta_trade_sessions", new URLSearchParams({ id: `eq.${id}`, state: `eq.${previousState}`, select: columns }), { ...patch, updated_at: new Date().toISOString() }, { returning: true });
    return rows[0] ?? null;
  }
  async submitted(limit: number) {
    return this.pg.select<PantaTradeSession>("panta_trade_sessions", new URLSearchParams({
      state: "eq.SUBMITTED", select: columns, order: "updated_at.asc", limit: String(Math.max(1, Math.min(100, limit))),
    }));
  }
  async listForUser(userId: string, limit = 200) {
    return this.pg.select<PantaTradeSession>("panta_trade_sessions", new URLSearchParams({
      user_id: `eq.${userId}`, state: "in.(SUBMITTED,FILLED,FAILED)", signature: "not.is.null",
      select: columns, order: "created_at.desc", limit: String(Math.max(1, Math.min(200, limit))),
    }));
  }
  async listAllForUser(userId: string) {
    const page = 200;
    const rows: PantaTradeSession[] = [];
    for (let offset = 0; offset < ALL_ROWS_CAP; offset += page) {
      const batch = await this.pg.select<PantaTradeSession>("panta_trade_sessions", new URLSearchParams({
        user_id: `eq.${userId}`, state: "in.(SUBMITTED,FILLED,FAILED)", signature: "not.is.null",
        select: columns, order: "created_at.asc,id.asc", limit: String(page), offset: String(offset),
      }));
      rows.push(...batch);
      if (batch.length < page) return rows;
    }
    // Never a silent truncation: a reader that must see everything refuses.
    throw new Error("panta_trade_sessions: more rows than one read may hold");
  }
  async latestForCall(userId: string, callId: string) {
    return (await this.pg.select<PantaTradeSession>("panta_trade_sessions", new URLSearchParams({
      user_id: `eq.${userId}`, call_id: `eq.${callId}`, state: "in.(SUBMITTED,FILLED,FAILED)", signature: "not.is.null",
      select: columns, order: "created_at.desc", limit: "1",
    })))[0] ?? null;
  }
  async filledSince(since: string | null, limit: number) {
    const params = new URLSearchParams({ state: "eq.FILLED", select: "call_id,updated_at", order: "updated_at.asc",
      limit: String(Math.max(1, Math.min(1000, limit))) });
    if (since) params.set("updated_at", `gte.${since}`);
    return this.pg.select<{ call_id: string; updated_at: string }>("panta_trade_sessions", params);
  }
}
