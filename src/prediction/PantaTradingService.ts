/** A call and a funded position are separate artifacts, joined by explicit intent. */
import { createHash } from "node:crypto";
import type { PantaExecution, PantaPreparedOrder } from "./PantaExecution.ts";
import type { PantaSettlementChain } from "./PantaSettlementChain.ts";
import { signedMessageHash, validateSignedPantaTransaction, type PantaChain } from "./PantaChain.ts";
import type { PantaCallIntent, PantaTradingLedger, PantaTradingStore, PantaTradeSession } from "./PantaTradingStore.ts";
import { capturesRaw, type PredictionVenue, type VenueOrder } from "./PredictionVenue.ts";
import { pantaInPrimarySale } from "./marketQuote.ts";
import type { AccountWallets } from "../wallet/accountWallets.ts";
import { VenueError } from "./errors.ts";

export interface PantaPrepareInput { callId: string; wallet: string; amountBaseUnits: string; idempotencyKey: string; maxSlippageBps: number; }
/** What the verified session itself proves: the address of a Sign-in-with-Solana session (Supabase Auth checked its signature). */
export interface PantaPrepareSession { signInWallet?: string | null; }
/** Short on purpose: the apps lead with a link icon and open the account's wallets. */
export const WALLET_NOT_LINKED_COPY = "Link this wallet to your account first";
/** A call made with an amount is funded only through money.* (docs/money-api.md). */
export const MONEY_CALL_ROUTE_COPY = "This call was made with an amount. Fund it from the call itself.";
const MONEY_WINDOW_CLOSED_COPY = "This call's money window has closed. Make a new call.";
/** Panta's primary buy answers MARKET_NOT_IN_PRIMARY outside the primary sale. */
export const PRIMARY_SALE_ONLY_COPY = "Funding opens only while a Panta market is in its first sale. Your call still counts free.";
/**
 * A money call may be traded only by money.*, only while PENDING, only with
 * its current attempt's key, and only inside its window. The SQL trigger on
 * panta_trade_sessions applies the same rule (money_call_trade_guard_v1).
 */
function moneyCallRefusal(call: PantaCallIntent | null, key: string, now: number): string | null {
  if (!call?.moneyState) return null;
  if (call.moneyState !== "PENDING") return MONEY_WINDOW_CLOSED_COPY;
  if (call.moneyTradeKey && key !== call.moneyTradeKey) return "This isn't this call's current quote. Check the call again.";
  if (call.moneyExpiresAt != null && call.moneyExpiresAt <= now) return MONEY_WINDOW_CLOSED_COPY;
  return null;
}
const refuse = (message: string): never => { throw new VenueError("VENUE_BAD_REQUEST", message, { venue: "panta" }); };
export class PantaTradingService {
  constructor(private readonly deps: {
    store: PantaTradingStore; execution: PantaExecution;
    chain: Pick<PantaChain, "broadcast"> & Partial<Pick<PantaChain, "failed">> & Partial<Pick<PantaSettlementChain, "neverLanded">>;
    venue: PredictionVenue; maxAmountBaseUnits: string; now?: () => number;
    /** The account's own proven wallets: the only ones a buy may be quoted for. */
    wallets: AccountWallets;
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
  /**
   * The signing wallet must be the account's own: an active, SIWS-proven link,
   * or — with no link row at all — the wallet this very session signed in with.
   * A revoked link outranks the session: the person unlinked it. Checked on
   * every prepare (a replay included) before any reservation or provider read,
   * and again on submit before anything is broadcast. Unreadable links are
   * refused, never assumed.
   */
  private async assertOwnWallet(userId: string, wallet: string, session: PantaPrepareSession): Promise<void> {
    let status: Awaited<ReturnType<AccountWallets["status"]>>;
    try { status = await this.deps.wallets.status(userId, wallet); }
    catch { throw new VenueError("VENUE_UNAVAILABLE", "We couldn't confirm this wallet is yours. Try again in a moment", { venue: "panta" }); }
    if (status === "active") return;
    if (status === "none" && session.signInWallet === wallet) return;
    throw new VenueError("WALLET_NOT_LINKED", WALLET_NOT_LINKED_COPY, { venue: "panta" });
  }
  /**
   * `opts.moneyCall`: the caller is money.* quoting its own PENDING money call.
   * Every other caller (the pantaTrading route) is refused any money call.
   */
  async prepare(userId: string, input: PantaPrepareInput, session: PantaPrepareSession = {},
    opts: { moneyCall?: boolean } = {}): Promise<{ order: PantaPreparedOrder["order"]; review: PantaPreparedOrder["review"] }> {
    if (!/^[1-9][0-9]{0,15}$/.test(input.amountBaseUnits) || BigInt(input.amountBaseUnits) > BigInt(this.deps.maxAmountBaseUnits)) return refuse("Enter a positive USDC amount within the server trade limit");
    await this.assertOwnWallet(userId, input.wallet, session);
    const existing = await this.deps.store.find(userId, input.idempotencyKey);
    if (existing) { const prepared = this.replay(existing, input); return { order: prepared.order, review: prepared.review }; }
    if (await this.deps.store.activeForCall(userId, input.callId, input.wallet)) {
      return refuse("This call already has a submitted or filled Panta order. Check that order instead of buying again");
    }
    const call = await this.deps.store.callIntent(userId, input.callId);
    if (!call) return refuse("Only your own call on this exact Panta market can be funded");
    // A call made with an amount is funded only through money.*, only while
    // pending, with its current attempt's key, inside its window: never
    // around a price check, never past expiry, never brought back.
    if (call.moneyState && !opts.moneyCall) return refuse(MONEY_CALL_ROUTE_COPY);
    const moneyRefusal = moneyCallRefusal(call, input.idempotencyKey, this.now());
    if (moneyRefusal) return refuse(moneyRefusal);
    // SOL-quoted markets take calls, never trades: our trade path is Panta's
    // USDC primary buy. Refused before any provider read or reservation.
    if (call.tradable === false) return refuse("Trading isn't available on this market. Your call still counts");
    const market = await this.deps.venue.getMarket(call.venueMarketId);
    if (market.venue !== "panta" || market.status !== "OPEN" || (market.opensAt !== null && market.opensAt > this.now())) return refuse("This Panta market is not open for a primary buy");
    // A graduated market quotes MARKET_NOT_IN_PRIMARY: refused before any reservation.
    const venue = this.deps.venue;
    if (!pantaInPrimarySale(market, capturesRaw(venue) ? venue.rawPayload(call.venueMarketId) : null)) return refuse(PRIMARY_SALE_ONLY_COPY);
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
  async submit(userId: string, orderId: string, signedPayload: string, session: PantaPrepareSession = {}): Promise<VenueOrder> {
    let row = await this.own(userId, orderId);
    if (row.state === "FAILED") return refuse("This Panta order failed; review a new intent");
    // Still the account's own wallet: a link revoked since prepare stops the broadcast.
    if (row.state !== "FILLED") await this.assertOwnWallet(userId, row.wallet_address, session);
    // The reviewed bytes let a wallet app's own priority fee and Lighthouse checks through, nothing else.
    const tx = validateSignedPantaTransaction(signedPayload, row.wallet_address, row.prepared!.binding.messageHash,
      row.prepared!.binding.unsignedOrder.transaction.payload);
    if (row.signature !== null && (row.signature !== tx.signature || row.signed_transaction !== signedPayload)) return refuse("This intent already approved a different transaction");
    if (row.state === "FILLED") return this.view(row);
    if (row.state === "QUOTED") {
      if (row.prepared!.order.expiresAt <= this.now()) return refuse("Wallet approval arrived after quote expiry; do not broadcast");
      // A money call's quote is signed only while the call is pending, current and inside its window.
      const moneyRefusal = moneyCallRefusal(await this.deps.store.callIntent(userId, row.call_id), row.idempotency_key, this.now());
      if (moneyRefusal) return refuse(moneyRefusal);
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
    // The chain holds the message the wallet signed, which may be its amendment of the reviewed one.
    try {
      const signedHash = row.signed_transaction ? signedMessageHash(row.signed_transaction) : row.prepared.binding.messageHash;
      remote = await this.deps.execution.verify({ ...row.prepared.binding, signature: row.signature,
        ...(signedHash !== row.prepared.binding.messageHash ? { signedMessageHash: signedHash } : {}) });
    }
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
