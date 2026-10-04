/**
 * The wallet sheet's recent money activity and collectable winnings
 * (docs/money-api.md §c, §d). Read models only: every item comes from a
 * ledger whose states are chain- or venue-proven, or from mainnet itself.
 *
 *   trade     panta_trade_sessions that reached a signature
 *   claim     panta_claim_sessions (payout proven on chain)
 *   cash_out  wallet_transfers out of the trading wallet
 *   deposit   wallet_transfers into it, and any other USDC that arrived in
 *             the trading wallet (card via Crossmint, "Send USDC"), read
 *             from the wallet's own USDC account on mainnet
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { MAINNET_GENESIS_HASH } from "../prediction/PantaChain.ts";
import type { PantaClaimSession } from "../prediction/PantaClaimStore.ts";
import { valueBaseUnits, type PantaPositionsPage } from "../prediction/PantaPositions.ts";
import type { PantaTradeSession } from "../prediction/PantaTradingStore.ts";
import type { Side, VenueMarket } from "../prediction/types.ts";
import type { WalletTransferRow } from "./store.ts";
import { usdcAccountOf, usdcDelta } from "./transfers.ts";

export interface ActivityItem {
  id: string;
  kind: "trade" | "claim" | "deposit" | "cash_out";
  direction: "in" | "out";
  amountBaseUnits: string;
  state: "pending" | "done" | "failed";
  at: number;
  signature: string | null;
  callId: string | null;
  marketId: string | null;
  side: Side | null;
  question: string | null;
  counterparty: string | null;
}

/** USDC that arrived in a wallet, from its own USDC account's history. */
export interface UsdcCredit {
  signature: string;
  amountBaseUnits: string;
  at: number;
  /** The wallet whose USDC went down by the same amount in that transaction, when there is exactly one. */
  from: string | null;
}

export interface UsdcCreditsReader {
  recentCredits(wallet: string, limit: number): Promise<UsdcCredit[]>;
}

/** Genesis-pinned mainnet reads of a wallet's USDC account history. */
export class RpcUsdcCredits implements UsdcCreditsReader {
  private readonly connection: Connection;
  private mainnet: Promise<void> | undefined;
  constructor(rpcUrl: string, fetchImpl: typeof fetch = fetch) {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Activity reads need a secure mainnet RPC");
    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed", disableRetryOnRateLimit: true,
      fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(8_000) }), { preconnect: fetchImpl.preconnect }),
    });
  }
  async recentCredits(wallet: string, limit: number): Promise<UsdcCredit[]> {
    this.mainnet ??= this.connection.getGenesisHash().then(g => { if (g !== MAINNET_GENESIS_HASH) throw new Error("not mainnet"); })
      .catch(error => { this.mainnet = undefined; throw error; });
    await this.mainnet;
    const signatures = await this.connection.getSignaturesForAddress(new PublicKey(usdcAccountOf(wallet)), { limit: Math.min(25, limit) }, "confirmed");
    const live = signatures.filter(s => s.err === null);
    if (live.length === 0) return [];
    const txs = await this.connection.getParsedTransactions(live.map(s => s.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const out: UsdcCredit[] = [];
    txs.forEach((tx, i) => {
      if (!tx?.meta || tx.meta.err !== null) return;
      const meta = tx.meta as unknown as Parameters<typeof usdcDelta>[0];
      const delta = usdcDelta(meta, wallet);
      if (delta === null || delta <= 0n) return;
      const owners = new Set([...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].map(b => b.owner).filter((o): o is string => !!o && o !== wallet));
      const senders = [...owners].filter(o => usdcDelta(meta, o) === -delta);
      out.push({ signature: live[i]!.signature, amountBaseUnits: delta.toString(),
        at: (tx.blockTime ?? live[i]!.blockTime ?? 0) * 1000, from: senders.length === 1 ? senders[0]! : null });
    });
    return out;
  }
}

/** Merge the ledgers and the chain into one newest-first list. Pure. */
export function buildActivity(args: {
  trades: readonly PantaTradeSession[];
  claims: readonly PantaClaimSession[];
  transfers: readonly WalletTransferRow[];
  credits: readonly UsdcCredit[];
  market: (marketId: string) => VenueMarket | undefined;
  limit: number;
}): ActivityItem[] {
  const items: ActivityItem[] = [];
  const known = new Set<string>();
  for (const t of args.trades) {
    if (!t.signature || !["SUBMITTED", "FILLED", "FAILED"].includes(t.state)) continue;
    known.add(t.signature);
    items.push({
      id: `trade:${t.id}`, kind: "trade", direction: "out", amountBaseUnits: String(t.amount_base_units),
      state: t.state === "FILLED" ? "done" : t.state === "FAILED" ? "failed" : "pending",
      at: Date.parse(t.updated_at), signature: t.signature, callId: t.call_id, marketId: t.market_id, side: t.side,
      question: args.market(t.market_id)?.question ?? null, counterparty: null,
    });
  }
  for (const c of args.claims) {
    if (!c.signature || !["SUBMITTED", "CONFIRMED", "FAILED"].includes(c.state)) continue;
    known.add(c.signature);
    // Done: the payout the chain proved. Pending or failed: the winning shares
    // at $1 that Panta's reviewed claim names.
    const reviewed = c.prepared ? valueBaseUnits(c.prepared.binding.review.winningShares, "1") : null;
    const amount = c.state === "CONFIRMED" ? c.confirm_evidence?.payoutBaseUnits ?? null : reviewed?.toString() ?? null;
    if (amount === null || !/^[1-9][0-9]*$/.test(amount)) continue;
    items.push({
      id: `claim:${c.id}`, kind: "claim", direction: "in",
      amountBaseUnits: amount,
      state: c.state === "CONFIRMED" ? "done" : c.state === "FAILED" ? "failed" : "pending",
      at: Date.parse(c.updated_at), signature: c.signature, callId: null, marketId: c.market_id, side: null,
      question: args.market(c.market_id)?.question ?? null, counterparty: null,
    });
  }
  for (const r of args.transfers) {
    if (!r.signature || r.state === "BUILT") continue;
    known.add(r.signature);
    items.push({
      id: `transfer:${r.id}`, kind: r.kind, direction: r.kind === "cash_out" ? "out" : "in", amountBaseUnits: r.amount_base_units,
      state: r.state === "CONFIRMED" ? "done" : r.state === "FAILED" ? "failed" : "pending",
      at: Date.parse(r.updated_at), signature: r.signature, callId: null, marketId: null, side: null, question: null,
      counterparty: r.kind === "cash_out" ? r.to_wallet : r.from_wallet,
    });
  }
  for (const credit of args.credits) {
    // A claim payout or one of our own transfers is already listed above.
    if (known.has(credit.signature)) continue;
    known.add(credit.signature);
    items.push({
      id: `deposit:${credit.signature}`, kind: "deposit", direction: "in", amountBaseUnits: credit.amountBaseUnits, state: "done",
      at: credit.at, signature: credit.signature, callId: null, marketId: null, side: null, question: null, counterparty: credit.from,
    });
  }
  return items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, args.limit);
}

export interface Winning {
  orderId: string;
  callId: string;
  marketId: string;
  question: string | null;
  side: Side;
  wallet: string;
  amountBaseUnits: string;
  costBaseUnits: string;
  state: "COLLECTABLE" | "COLLECTING";
  claimId: string | null;
}

/**
 * Won positions the venue says are claimable and nobody has collected, and
 * ones being collected now. The amount is the winning shares at $1, from the
 * same figure pantaTrading.positions shows. Pure.
 */
export function collectableWinnings(page: Pick<PantaPositionsPage, "positions">): { items: Winning[]; totalBaseUnits: string } {
  const items: Winning[] = [];
  let total = 0n;
  for (const p of page.positions) {
    if (p.status !== "won_claimable" && p.status !== "claiming") continue;
    if (p.valueBaseUnits === null || !/^[1-9][0-9]*$/.test(p.valueBaseUnits)) continue;
    const state = p.status === "won_claimable" ? "COLLECTABLE" : "COLLECTING";
    if (state === "COLLECTABLE") total += BigInt(p.valueBaseUnits);
    items.push({ orderId: p.orderId, callId: p.callId, marketId: p.marketId, question: p.question, side: p.side, wallet: p.owner,
      amountBaseUnits: p.valueBaseUnits, costBaseUnits: p.costBaseUnits, state, claimId: p.claim?.claimId ?? null });
  }
  return { items, totalBaseUnits: total.toString() };
}

/** "solana:<address>?spl-token=<mint>[&amount=<decimal>]": a Solana Pay transfer request. */
export function solanaPayUri(address: string, mint: string, amountBaseUnits?: string): string {
  const params = new URLSearchParams();
  if (amountBaseUnits && /^[1-9][0-9]*$/.test(amountBaseUnits)) {
    const v = BigInt(amountBaseUnits);
    const whole = v / 1_000_000n, frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    params.set("amount", frac ? `${whole}.${frac}` : whole.toString());
  }
  params.set("spl-token", mint);
  return `solana:${address}?${params.toString()}`;
}
