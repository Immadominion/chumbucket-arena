/**
 * A Panta buy from the browser, on the BFF's own prepare → sign → submit
 * path (`pantaTrading.*`), exactly as the Android app runs it:
 *
 *   review    the BFF quotes and builds the transaction for this account's
 *             own wallet (it refuses a wallet the account has not proven);
 *             the browser checks it is exactly this buy (`pantaBuyCheck.ts`)
 *             and shows what it costs and pays, before any wallet sees it
 *   confirm   the wallet signs those exact bytes — nothing else, no send —
 *             and the BFF checks the signature and broadcasts; the order is
 *             SUBMITTED, never "done"
 *
 * Only the BFF ever says FILLED, after Panta confirms and the chain shows
 * the USDC debit. Nothing here marks a trade funded.
 *
 * Pure: no DOM, so the BFF repo's bun tests can import it.
 */

import { checkPantaBuy, UnsafeTransaction } from "./pantaBuyCheck";
import type { FundingState, Side } from "./types";
import { base64ToBytes, bytesToBase64, signedOnlyInSlot } from "./solanaTx";

export interface PreparedTrade {
  order: {
    orderId: string;
    owner: string;
    side: Side;
    amountBaseUnits: string;
    fundingState: "QUOTED";
    transaction: { encoding: "solana-tx-base64"; payload: string; expiresAt: number };
    expiresAt: number;
  };
  review: { amountUsdc: string; amountBaseUnits: string; avgPrice: string; feeUsdc: string; expectedShares: string };
}

export interface TradeOrder {
  orderId: string;
  owner: string;
  side: Side;
  amountBaseUnits: string;
  fundingState: FundingState;
  fillTxSignature: string | null;
  updatedAt: number;
}

/** Who signs: an address and a function that returns the full signed bytes. */
export interface TradeSigner {
  address: string;
  sign(unsigned: Uint8Array): Promise<Uint8Array>;
}

export interface TradeApi {
  prepareTrade(input: {
    callId: string;
    wallet: string;
    amountBaseUnits: string;
    idempotencyKey: string;
    maxSlippageBps: number;
  }): Promise<PreparedTrade>;
  submitTrade(orderId: string, signedTransaction: string): Promise<TradeOrder>;
}

export type TradeFailure = "expired" | "mismatch" | "declined" | "unsafe";
export class TradeError extends Error {
  constructor(readonly kind: TradeFailure) {
    super(kind);
  }
}

/** Whole dollars to USDC base units (6 decimals). "$5" → "5000000". */
export function usdToBaseUnits(usd: number): string {
  if (!Number.isInteger(usd) || usd <= 0 || usd > 1_000_000) throw new RangeError("whole dollars only");
  return `${usd}000000`;
}

/** The BFF's answer is final: a confirmed fill, or a failure the chain proved. */
export const isFinal = (order: Pick<TradeOrder, "fundingState">): boolean =>
  order.fundingState === "FILLED" || order.fundingState === "FAILED";

/** "12.5" → "$12.50". Money only ever reads as dollars. */
export function dollars(decimal: string): string {
  const n = Number(decimal);
  return Number.isFinite(n) && n >= 0 ? `$${n.toFixed(2)}` : "—";
}

/** A buy the BFF built and the browser checked, ready for the person to confirm. */
export interface ReviewedTrade {
  prepared: PreparedTrade;
  unsigned: Uint8Array;
  signer: TradeSigner;
  call: { venueMarketId: string; side: Side };
  /** "$5.00" */
  pay: string;
  /** "~$9.20": each share pays about $1 if the call is right. */
  win: string;
  /** "$0.01" */
  fee: string;
}

/**
 * Step one: the BFF's quote for this wallet, checked to be exactly this buy.
 * Reuse the same `idempotencyKey` after a dropped reply: the BFF answers with
 * the same quote and never builds a second buy.
 */
export async function reviewTrade(args: {
  api: TradeApi;
  callId: string;
  venueMarketId: string;
  side: Side;
  amountBaseUnits: string;
  idempotencyKey: string;
  signer: TradeSigner;
  now?: () => number;
}): Promise<ReviewedTrade> {
  const now = args.now ?? Date.now;
  const prepared = await args.api.prepareTrade({
    callId: args.callId,
    wallet: args.signer.address,
    amountBaseUnits: args.amountBaseUnits,
    idempotencyKey: args.idempotencyKey,
    maxSlippageBps: 100,
  });
  const { order, review } = prepared;
  if (
    order.owner !== args.signer.address ||
    order.amountBaseUnits !== args.amountBaseUnits ||
    order.side !== args.side ||
    order.transaction.encoding !== "solana-tx-base64"
  ) {
    throw new TradeError("mismatch");
  }
  if (order.transaction.expiresAt <= now()) throw new TradeError("expired");
  const unsigned = base64ToBytes(order.transaction.payload);
  const call = { venueMarketId: args.venueMarketId, side: args.side };
  await checked(unsigned, args.signer.address, call, args.amountBaseUnits);
  return {
    prepared,
    unsigned,
    signer: args.signer,
    call,
    pay: dollars(review.amountUsdc),
    win: `~${dollars(review.expectedShares)}`,
    fee: dollars(review.feeUsdc),
  };
}

async function checked(unsigned: Uint8Array, owner: string, call: ReviewedTrade["call"], amountBaseUnits: string) {
  try {
    await checkPantaBuy(unsigned, { owner, venueMarketId: call.venueMarketId, side: call.side, amountBaseUnits });
  } catch (e) {
    if (e instanceof UnsafeTransaction) throw new TradeError("unsafe");
    throw e;
  }
}

/** Step two, after the person confirmed: sign exactly the reviewed bytes, submit. */
export async function confirmTrade(args: { api: TradeApi; reviewed: ReviewedTrade; now?: () => number }): Promise<TradeOrder> {
  const now = args.now ?? Date.now;
  const { prepared, unsigned, signer, call } = args.reviewed;
  if (prepared.order.transaction.expiresAt <= now()) throw new TradeError("expired");
  // Checked again right before any wallet sees it.
  await checked(unsigned, signer.address, call, prepared.order.amountBaseUnits);
  let signed: Uint8Array;
  try {
    signed = await signer.sign(unsigned);
  } catch {
    throw new TradeError("declined");
  }
  if (!signedOnlyInSlot(unsigned, signed, 0)) throw new TradeError("mismatch");
  if (prepared.order.transaction.expiresAt <= now()) throw new TradeError("expired");
  return args.api.submitTrade(prepared.order.orderId, bytesToBase64(signed));
}

/** Review then confirm in one go (no person in between). */
export async function placeTrade(args: Parameters<typeof reviewTrade>[0]): Promise<TradeOrder> {
  const reviewed = await reviewTrade(args);
  return confirmTrade({ api: args.api, reviewed, ...(args.now ? { now: args.now } : {}) });
}
