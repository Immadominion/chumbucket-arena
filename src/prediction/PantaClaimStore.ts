/** Private, durable win-claim ledger. The same discipline as panta_trade_sessions:
 * the reviewed transaction is saved before a wallet sees it, and the signed bytes
 * are saved before any broadcast, so a lost reply can never mint a second claim. */
import { Pgrest, type PgrestConfig } from "./pgrest.ts";
import type { PantaPreparedClaim } from "./PantaClaims.ts";

export type PantaClaimState = "PREPARING" | "BUILT" | "SUBMITTED" | "CONFIRMED" | "FAILED";
export interface PantaClaimEvidence {
  payoutBaseUnits: string;
  slot: number;
  messageHash: string;
  independentlyVerified: true;
  /** Panta's optional attribution report for this signature, when it answered. */
  providerTrade: { signature: string; status: "processed"; kind: "claim" } | null;
}
export interface PantaClaimSession {
  id: string; user_id: string; trade_session_id: string; market_id: string;
  /** The funded buy's provider order id: the person-facing handle of the position. */
  order_id: string;
  wallet_address: string; venue_market_id: string;
  idempotency_key: string; request_fingerprint: string;
  state: PantaClaimState;
  prepared: PantaPreparedClaim | null;
  signed_transaction: string | null; signature: string | null;
  confirm_evidence: PantaClaimEvidence | null;
  created_at: string; updated_at: string;
}
export type PantaClaimIntent = Pick<PantaClaimSession, "id" | "user_id" | "trade_session_id" | "market_id" | "order_id" |
  "wallet_address" | "venue_market_id" | "idempotency_key" | "request_fingerprint">;
export interface PantaClaimStore {
  find(userId: string, idempotencyKey: string): Promise<PantaClaimSession | null>;
  byId(userId: string, id: string): Promise<PantaClaimSession | null>;
  /** The person's in-flight or settled claim for one wallet on one market. */
  activeFor(userId: string, wallet: string, venueMarketId: string): Promise<PantaClaimSession | null>;
  listForUser(userId: string): Promise<PantaClaimSession[]>;
  /** SUBMITTED claims across all people, oldest change first. Server worker only. */
  submitted(limit: number): Promise<PantaClaimSession[]>;
  reserve(intent: PantaClaimIntent): Promise<PantaClaimSession | null>;
  update(id: string, previousState: PantaClaimState, patch: Partial<PantaClaimSession>): Promise<PantaClaimSession | null>;
}

const columns = "id,user_id,trade_session_id,market_id,order_id,wallet_address,venue_market_id,idempotency_key,request_fingerprint,state,prepared,signed_transaction,signature,confirm_evidence,created_at,updated_at";
export class SupabasePantaClaimStore implements PantaClaimStore {
  private readonly pg: Pgrest;
  constructor(config: PgrestConfig, fetchImpl: typeof fetch = fetch) { this.pg = new Pgrest(config, fetchImpl); }
  private async one(params: Record<string, string>) {
    return (await this.pg.select<PantaClaimSession>("panta_claim_sessions", new URLSearchParams({ ...params, select: columns, limit: "1" })))[0] ?? null;
  }
  find(userId: string, idempotencyKey: string) { return this.one({ user_id: `eq.${userId}`, idempotency_key: `eq.${idempotencyKey}` }); }
  byId(userId: string, id: string) { return this.one({ user_id: `eq.${userId}`, id: `eq.${id}` }); }
  activeFor(userId: string, wallet: string, venueMarketId: string) {
    return this.one({ user_id: `eq.${userId}`, wallet_address: `eq.${wallet}`, venue_market_id: `eq.${venueMarketId}`,
      state: "in.(SUBMITTED,CONFIRMED)", order: "created_at.desc" });
  }
  listForUser(userId: string) {
    return this.pg.select<PantaClaimSession>("panta_claim_sessions", new URLSearchParams({
      user_id: `eq.${userId}`, state: "in.(SUBMITTED,CONFIRMED,FAILED)", select: columns, order: "created_at.desc", limit: "200" }));
  }
  submitted(limit: number) {
    return this.pg.select<PantaClaimSession>("panta_claim_sessions", new URLSearchParams({
      state: "eq.SUBMITTED", select: columns, order: "updated_at.asc", limit: String(Math.max(1, Math.min(100, limit))) }));
  }
  async reserve(intent: PantaClaimIntent) {
    const rows = await this.pg.insert<PantaClaimSession>("panta_claim_sessions", [intent], { onConflict: "user_id,idempotency_key", ignoreDuplicates: true, returning: true });
    return rows[0] ?? null;
  }
  async update(id: string, previousState: PantaClaimState, patch: Partial<PantaClaimSession>) {
    const rows = await this.pg.patch<PantaClaimSession>("panta_claim_sessions", new URLSearchParams({ id: `eq.${id}`, state: `eq.${previousState}`, select: columns }),
      { ...patch, updated_at: new Date().toISOString() }, { returning: true });
    return rows[0] ?? null;
  }
}
