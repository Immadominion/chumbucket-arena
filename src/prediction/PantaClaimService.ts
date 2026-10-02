/**
 * Win claims for a person's own confirmed Panta position — the buy path's
 * discipline applied to the way money comes back:
 *
 *   prepare  durable intent -> Panta claim build -> doc-derived profile check
 *            -> reviewed approval saved BEFORE any wallet sees it
 *   submit   exact reviewed message + owner signature -> SUBMITTED with the
 *            signed bytes saved BEFORE broadcast -> broadcast on our RPC
 *   status   CONFIRMED only after independent chain proof that the owner was
 *            paid USDC; FAILED only after the chain says the transaction
 *            failed or can never land
 *
 * A claim is tied to one of the person's FILLED buys (their wallet + market),
 * never to a client-named wallet or market. There is no in-memory success.
 */
import { createHash } from "node:crypto";
import { validateSignedPantaTransaction, type PantaChain } from "./PantaChain.ts";
import type { PantaClaimExecution, PantaPreparedClaim } from "./PantaClaims.ts";
import type { PantaClaimSession, PantaClaimStore } from "./PantaClaimStore.ts";
import type { PantaSettlementChain } from "./PantaSettlementChain.ts";
import type { PantaTradingStore } from "./PantaTradingStore.ts";
import { VenueError } from "./errors.ts";

export interface PantaClaimView {
  claimId: string;
  orderId: string;
  venueMarketId: string;
  owner: string;
  state: "BUILT" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  /** The broadcast signature, once the person approved. Public chain data. */
  signature: string | null;
  /** USDC actually credited to the owner, proven on chain. Base units. */
  payoutBaseUnits: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  attribution: "Powered by Panta";
}
export interface PantaClaimPrepared {
  claim: PantaClaimView;
  /** Null when this position already has a claim in flight or settled. */
  transaction: PantaPreparedClaim["transaction"] | null;
  review: PantaPreparedClaim["binding"]["review"] | null;
}
type ClaimChain = Pick<PantaChain, "broadcast"> & Partial<Pick<PantaChain, "failed">> &
  Partial<Pick<PantaSettlementChain, "neverLanded">> & Pick<PantaSettlementChain, "verifyClaim">;

const refuse = (message: string): never => { throw new VenueError("VENUE_BAD_REQUEST", message, { venue: "panta" }); };

export class PantaClaimService {
  constructor(private readonly deps: {
    claims: PantaClaimStore;
    trades: Pick<PantaTradingStore, "byOrder">;
    execution: Pick<PantaClaimExecution, "build" | "validateTransaction">;
    chain: ClaimChain;
    /** Optional attribution report (`POST /trades/`, kind claim). Never gates settlement. */
    report?: (body: { signature: string; wallet: string; marketId: string }) => Promise<unknown>;
    now?: () => number;
  }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private fingerprint(orderId: string, wallet: string, market: string, key: string) {
    return createHash("sha256").update(JSON.stringify(["claim", orderId, wallet, market, key])).digest("hex");
  }

  view(row: PantaClaimSession): PantaClaimView {
    const state = row.state === "PREPARING" ? "FAILED" : row.state;
    return { claimId: row.id, orderId: row.order_id, venueMarketId: row.venue_market_id, owner: row.wallet_address, state,
      signature: row.state === "SUBMITTED" || row.state === "CONFIRMED" ? row.signature : null,
      payoutBaseUnits: row.state === "CONFIRMED" ? row.confirm_evidence?.payoutBaseUnits ?? null : null,
      createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at),
      expiresAt: row.prepared?.binding.expiresAt ?? null, attribution: "Powered by Panta" };
  }

  async prepare(userId: string, input: { orderId: string; idempotencyKey: string }): Promise<PantaClaimPrepared> {
    const trade = await this.deps.trades.byOrder(userId, input.orderId);
    if (!trade || trade.state !== "FILLED") return refuse("Only your own confirmed Panta position can be claimed");
    const wallet = trade.wallet_address, market = trade.venue_market_id;
    const active = await this.deps.claims.activeFor(userId, wallet, market);
    if (active) return { claim: this.view(active), transaction: null, review: null };
    const fingerprint = this.fingerprint(input.orderId, wallet, market, input.idempotencyKey);
    const existing = await this.deps.claims.find(userId, input.idempotencyKey);
    if (existing) return this.replay(existing, fingerprint);
    const reserved = await this.deps.claims.reserve({ id: crypto.randomUUID(), user_id: userId, trade_session_id: trade.id,
      market_id: trade.market_id, order_id: input.orderId, wallet_address: wallet, venue_market_id: market,
      idempotency_key: input.idempotencyKey, request_fingerprint: fingerprint });
    if (!reserved) {
      const raced = await this.deps.claims.find(userId, input.idempotencyKey);
      if (!raced) return refuse("Could not reserve the claim; no transaction was issued");
      return this.replay(raced, fingerprint);
    }
    try {
      const prepared = await this.deps.execution.build({ owner: wallet, venueMarketId: market });
      const stored = await this.deps.claims.update(reserved.id, "PREPARING", { state: "BUILT", prepared });
      if (!stored) return refuse("Could not save the reviewed claim; no wallet approval is available");
      return { claim: this.view(stored), transaction: prepared.transaction, review: prepared.binding.review };
    } catch (error) {
      await this.deps.claims.update(reserved.id, "PREPARING", { state: "FAILED" }).catch(() => null);
      throw error;
    }
  }

  private replay(row: PantaClaimSession, fingerprint: string): PantaClaimPrepared {
    if (row.request_fingerprint !== fingerprint) throw new VenueError("IDEMPOTENCY_CONFLICT", "This approval key belongs to a different claim", { venue: "panta" });
    if (row.state === "PREPARING") throw new VenueError("IDEMPOTENCY_CONFLICT", "This claim is being prepared; retry this same intent", { venue: "panta" });
    if (row.state !== "BUILT" || !row.prepared) return { claim: this.view(row), transaction: null, review: null };
    if (row.prepared.binding.expiresAt <= this.now()) return refuse("This claim approval expired. Prepare a new claim");
    return { claim: this.view(row), transaction: row.prepared.transaction, review: row.prepared.binding.review };
  }

  private async own(userId: string, claimId: string): Promise<PantaClaimSession> {
    const row = await this.deps.claims.byId(userId, claimId);
    if (!row?.prepared) throw new VenueError("VENUE_NOT_FOUND", "No such Panta claim on your account", { venue: "panta" });
    return row;
  }

  async submit(userId: string, claimId: string, signedPayload: string): Promise<PantaClaimView> {
    let row = await this.own(userId, claimId);
    if (row.state === "FAILED") return refuse("This claim failed; prepare a new one");
    const binding = row.prepared!.binding;
    const tx = validateSignedPantaTransaction(signedPayload, row.wallet_address, binding.messageHash);
    if (row.signature !== null && (row.signature !== tx.signature || row.signed_transaction !== signedPayload)) {
      return refuse("This claim already approved a different transaction");
    }
    if (row.state === "CONFIRMED") return this.view(row);
    if (row.state === "BUILT") {
      if (binding.expiresAt <= this.now()) return refuse("Wallet approval arrived after the claim expired; do not broadcast");
      this.deps.execution.validateTransaction(row.prepared!.transaction.payload, binding);
      const saved = await this.deps.claims.update(row.id, "BUILT", { state: "SUBMITTED", signature: tx.signature, signed_transaction: signedPayload });
      row = saved ?? await this.own(userId, claimId);
      if (row.signature !== tx.signature || row.signed_transaction !== signedPayload) return refuse("This claim already approved a different transaction");
    }
    // Durable approval BEFORE RPC. A retry re-sends the identical bytes only.
    await this.deps.chain.broadcast(tx);
    return this.view(row);
  }

  async status(userId: string, claimId: string): Promise<PantaClaimView> {
    return this.view(await this.reconcile(await this.own(userId, claimId)));
  }

  /** Server worker and person-triggered checks share this one transition. */
  async reconcile(row: PantaClaimSession): Promise<PantaClaimSession> {
    if (row.state !== "SUBMITTED" || !row.signature || !row.prepared) return row;
    const b = row.prepared.binding;
    const proof = await this.deps.chain.verifyClaim({ signature: row.signature, owner: row.wallet_address,
      market: row.venue_market_id, programId: b.programId, messageHash: b.messageHash });
    if (proof) {
      let providerTrade: NonNullable<PantaClaimSession["confirm_evidence"]>["providerTrade"] = null;
      try {
        const report = await this.deps.report?.({ signature: row.signature, wallet: row.wallet_address, marketId: row.venue_market_id }) as
          { signature?: unknown; status?: unknown; kind?: unknown } | undefined;
        if (report?.signature === row.signature && report.status === "processed" && report.kind === "claim") {
          providerTrade = { signature: row.signature, status: "processed", kind: "claim" };
        }
      } catch { /* Attribution is optional and never gates a proven payout. */ }
      const saved = await this.deps.claims.update(row.id, "SUBMITTED", { state: "CONFIRMED", confirm_evidence: {
        payoutBaseUnits: proof.payoutBaseUnits, slot: proof.slot, messageHash: b.messageHash, independentlyVerified: true, providerTrade } });
      return saved ?? row;
    }
    if (await this.deps.chain.failed?.(row.signature) || await this.deps.chain.neverLanded?.(row.signature, b.lastValidBlockHeight)) {
      const saved = await this.deps.claims.update(row.id, "SUBMITTED", { state: "FAILED" });
      return saved ?? row;
    }
    return row;
  }
}
