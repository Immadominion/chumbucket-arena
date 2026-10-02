/** A call and a funded position are separate artifacts, joined by explicit intent. */
import { createHash } from "node:crypto";
import type { PantaExecution, PantaPreparedOrder } from "./PantaExecution.ts";
import type { PantaSettlementChain } from "./PantaSettlementChain.ts";
import { validateSignedPantaTransaction, type PantaChain } from "./PantaChain.ts";
import type { PantaTradingLedger, PantaTradingStore, PantaTradeSession } from "./PantaTradingStore.ts";
import type { PredictionVenue, VenueOrder } from "./PredictionVenue.ts";
import { VenueError } from "./errors.ts";

export interface PantaPrepareInput { callId: string; wallet: string; amountBaseUnits: string; idempotencyKey: string; maxSlippageBps: number; }
const refuse = (message: string): never => { throw new VenueError("VENUE_BAD_REQUEST", message, { venue: "panta" }); };
export class PantaTradingService {
  constructor(private readonly deps: {
    store: PantaTradingStore; execution: PantaExecution;
    chain: Pick<PantaChain, "broadcast"> & Partial<Pick<PantaChain, "failed">> & Partial<Pick<PantaSettlementChain, "neverLanded">>;
    venue: PredictionVenue; maxAmountBaseUnits: string; now?: () => number;
    /** Told once per confirmed fill, after the FILLED row is durable. */
    onFilled?: (row: PantaTradeSession) => void;
  }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private fingerprint(input: PantaPrepareInput): string {
    return createHash("sha256").update(JSON.stringify([input.callId,input.wallet,input.amountBaseUnits,input.idempotencyKey,input.maxSlippageBps])).digest("hex");
  }
  private replay(row: PantaTradeSession, input: PantaPrepareInput): PantaPreparedOrder {
    if (row.request_fingerprint !== this.fingerprint(input)) throw new VenueError("IDEMPOTENCY_CONFLICT", "This approval key belongs to a different trade", { venue: "panta" });
    if (row.state === "PREPARING") throw new VenueError("IDEMPOTENCY_CONFLICT", "This quote is being prepared; retry this same intent", { venue: "panta" });
    if (row.state !== "QUOTED" || !row.prepared) return refuse("This intent is no longer an unsigned quote; check its order instead");
    if (row.prepared.order.expiresAt <= this.now()) return refuse("This quote expired. Request a new quote before wallet approval");
    return row.prepared;
  }
  async prepare(userId: string, input: PantaPrepareInput): Promise<{ order: PantaPreparedOrder["order"]; review: PantaPreparedOrder["review"] }> {
    if (!/^[1-9][0-9]{0,15}$/.test(input.amountBaseUnits) || BigInt(input.amountBaseUnits) > BigInt(this.deps.maxAmountBaseUnits)) return refuse("Enter a positive USDC amount within the server trade limit");
    const existing = await this.deps.store.find(userId, input.idempotencyKey);
    if (existing) { const prepared = this.replay(existing, input); return { order: prepared.order, review: prepared.review }; }
    if (await this.deps.store.activeForCall(userId, input.callId, input.wallet)) {
      return refuse("This call already has a submitted or filled Panta order. Check that order instead of buying again");
    }
    const call = await this.deps.store.callIntent(userId, input.callId);
    if (!call) return refuse("Only your own call on this exact Panta market can be funded");
    const market = await this.deps.venue.getMarket(call.venueMarketId);
    if (market.venue !== "panta" || market.status !== "OPEN" || (market.opensAt !== null && market.opensAt > this.now())) return refuse("This Panta market is not open for a primary buy");
    const reserved = await this.deps.store.reserve({
      id: crypto.randomUUID(), user_id: userId, call_id: call.callId, market_id: call.marketId,
      wallet_address: input.wallet, venue_market_id: call.venueMarketId, side: call.side,
      amount_base_units: input.amountBaseUnits, max_slippage_bps: input.maxSlippageBps,
      idempotency_key: input.idempotencyKey, request_fingerprint: this.fingerprint(input),
    });
    if (!reserved) {
      const raced = await this.deps.store.find(userId, input.idempotencyKey);
      if (!raced) return refuse("Could not reserve the trade intent; no transaction was issued");
      const prepared = this.replay(raced, input); return { order: prepared.order, review: prepared.review };
    }
    try {
      const prepared = await this.deps.execution.buildBuy({ owner: input.wallet, venueMarketId: call.venueMarketId, side: call.side,
        amountBaseUnits: input.amountBaseUnits, idempotencyKey: input.idempotencyKey, maxSlippageBps: input.maxSlippageBps, canonicalUserId: userId });
      const stored = await this.deps.store.update(reserved.id, "PREPARING", { state: "QUOTED", provider_order_id: prepared.order.orderId, prepared });
      if (!stored) return refuse("Could not save the reviewed quote; no wallet approval is available");
      return { order: prepared.order, review: prepared.review };
    } catch (error) {
      await this.deps.store.update(reserved.id, "PREPARING", { state: "FAILED" });
      throw error;
    }
  }
  private async own(userId: string, orderId: string): Promise<PantaTradeSession> {
    const row = await this.deps.store.byOrder(userId, orderId);
    if (!row?.prepared) throw new VenueError("VENUE_NOT_FOUND", "No such Panta order on your account", { venue: "panta" });
    return row;
  }
  view(row: PantaTradeSession): VenueOrder {
    if (row.state === "FILLED" && row.fill_evidence) {
      const e = row.fill_evidence;
      // The normalized private view is not a dump of server reconciliation evidence.
      return { orderId: e.orderId, venueOrderId: e.venueOrderId, venue: e.venue, venueMarketId: e.venueMarketId,
        owner: e.owner, side: e.side, amountBaseUnits: e.amountBaseUnits, filledBaseUnits: e.filledBaseUnits,
        fundingState: e.fundingState, fillTxSignature: e.fillTxSignature, createdAt: e.createdAt,
        updatedAt: e.updatedAt, idempotencyKey: e.idempotencyKey, demo: e.demo };
    }
    return { orderId: row.provider_order_id!, venueOrderId: row.provider_order_id, venue: "panta", venueMarketId: row.venue_market_id,
      owner: row.wallet_address, side: row.side, amountBaseUnits: String(row.amount_base_units), filledBaseUnits: "0",
      fundingState: row.state === "FAILED" ? "FAILED" : row.state === "SUBMITTED" ? "SUBMITTED" : "QUOTED",
      fillTxSignature: null, createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at), idempotencyKey: row.idempotency_key, demo: false };
  }
  async forCall(userId: string, callId: string, wallet: string): Promise<{ order: VenueOrder | null }> {
    const row = await this.deps.store.activeForCall(userId, callId, wallet);
    // No signed bytes, provider binding, or another person's position leaves the ledger.
    return { order: row ? this.view(row) : null };
  }
  async submit(userId: string, orderId: string, signedPayload: string): Promise<VenueOrder> {
    let row = await this.own(userId, orderId);
    if (row.state === "FAILED") return refuse("This Panta order failed; review a new intent");
    const tx = validateSignedPantaTransaction(signedPayload, row.wallet_address, row.prepared!.binding.messageHash);
    if (row.signature !== null && (row.signature !== tx.signature || row.signed_transaction !== signedPayload)) return refuse("This intent already approved a different transaction");
    if (row.state === "FILLED") return this.view(row);
    if (row.state === "QUOTED") {
      if (row.prepared!.order.expiresAt <= this.now()) return refuse("Wallet approval arrived after quote expiry; do not broadcast");
      const saved = await this.deps.store.update(row.id, "QUOTED", { state: "SUBMITTED", signature: tx.signature, signed_transaction: signedPayload });
      row = saved ?? await this.own(userId, orderId);
      if (row.signature !== tx.signature || row.signed_transaction !== signedPayload) return refuse("This intent already approved a different transaction");
    }
    // Durable approval BEFORE RPC. A lost reply can never mint a different buy.
    await this.deps.chain.broadcast(tx);
    await this.deps.execution.submit(row.prepared!.binding, tx.signature);
    return this.view(row); // still not funded
  }
  async order(userId: string, orderId: string): Promise<VenueOrder> {
    const row = await this.own(userId, orderId);
    return this.view(await this.reconcile(row));
  }
  /** The person's newest signed approval for their own call, read from the ledger only. */
  async callOrder(userId: string, callId: string): Promise<{ order: VenueOrder | null }> {
    const ledger = this.deps.store as Partial<PantaTradingLedger>;
    if (!ledger.latestForCall) return { order: null };
    const row = await ledger.latestForCall(userId, callId);
    return { order: row?.prepared ? this.view(row) : null };
  }
  /**
   * The one SUBMITTED -> FILLED/FAILED transition, shared by the person's
   * "check" and the server reconciler. FILLED needs the full fill proof;
   * FAILED needs the chain to say the transaction failed, or that it can
   * never land. Anything else leaves the duplicate-buy guard in place.
   */
  async reconcile(row: PantaTradeSession): Promise<PantaTradeSession> {
    if (row.state !== "SUBMITTED" || !row.signature || !row.prepared) return row;
    // Reassociate a dropped submit callback safely before verification. A
    // provider error does not skip the chain's own failure check below: a
    // confirmed on-chain error stays proof even while Panta is unreachable.
    let remote: Awaited<ReturnType<PantaExecution["verify"]>> | null = null;
    let unverified: unknown = null;
    try { remote = await this.deps.execution.verify({ ...row.prepared.binding, signature: row.signature }); }
    catch (error) { unverified = error; }
    if (remote?.fundingState === "FILLED") {
      const saved = await this.deps.store.update(row.id, "SUBMITTED", { state: "FILLED", fill_evidence: remote });
      if (saved) { this.deps.onFilled?.(saved); return saved; }
      return (await this.deps.store.byOrder(row.user_id, row.provider_order_id!)) ?? row;
    }
    // A provider session refusal is not proof a broadcast failed, and a
    // provider "still pending" is not proof it can land. Only RPC decides:
    // a confirmed on-chain error, or an approval whose blockhash expired
    // without the signature ever landing. "Never landed" is only trusted
    // when Panta answered and did not report the order confirmed: an RPC
    // that cannot see a signature Panta confirmed (pruned history, lag) is a
    // conflict to wait out, never a failure of a buy that may have debited USDC.
    const mayHaveLanded = remote === null || remote.providerStatus === "confirmed";
    if (await this.deps.chain.failed?.(row.signature) ||
        (!mayHaveLanded && await this.deps.chain.neverLanded?.(row.signature, row.prepared.binding.lastValidBlockHeight))) {
      const saved = await this.deps.store.update(row.id, "SUBMITTED", { state: "FAILED" });
      return saved ?? (await this.deps.store.byOrder(row.user_id, row.provider_order_id!)) ?? row;
    }
    if (unverified !== null) throw unverified;
    return row;
  }
}
