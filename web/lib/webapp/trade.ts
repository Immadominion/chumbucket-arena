/**
 * A Panta buy from the browser, on the BFF's own prepare → sign → submit
 * path (`pantaTrading.*`), exactly as the Android app runs it:
 *
 *   prepare   the BFF quotes and builds the transaction for this account's
 *             own wallet (it refuses a wallet the account has not proven)
 *   sign      the wallet signs those exact bytes — nothing else, no send
 *   submit    the BFF checks the signature against the reviewed message and
 *             broadcasts it; the order is SUBMITTED, never "done"
 *
 * Only the BFF ever says FILLED, after Panta confirms and the chain shows
 * the USDC debit. Nothing here marks a trade funded.
 *
 * Pure: no DOM, so the BFF repo's bun tests can import it.
 */

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

export type TradeFailure = "expired" | "mismatch" | "declined";
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

/**
 * One buy, start to SUBMITTED. Reuse the same `idempotencyKey` to retry the
 * same intent after a dropped reply: the BFF answers with the same quote and
 * never builds a second buy.
 */
export async function placeTrade(args: {
  api: TradeApi;
  callId: string;
  amountBaseUnits: string;
  idempotencyKey: string;
  signer: TradeSigner;
  now?: () => number;
}): Promise<TradeOrder> {
  const now = args.now ?? Date.now;
  const prepared = await args.api.prepareTrade({
    callId: args.callId,
    wallet: args.signer.address,
    amountBaseUnits: args.amountBaseUnits,
    idempotencyKey: args.idempotencyKey,
    maxSlippageBps: 100,
  });
  const { order } = prepared;
  if (order.owner !== args.signer.address || order.amountBaseUnits !== args.amountBaseUnits || order.transaction.encoding !== "solana-tx-base64") {
    throw new TradeError("mismatch");
  }
  if (order.transaction.expiresAt <= now()) throw new TradeError("expired");
  const unsigned = base64ToBytes(order.transaction.payload);
  let signed: Uint8Array;
  try {
    signed = await args.signer.sign(unsigned);
  } catch {
    throw new TradeError("declined");
  }
  if (!signedOnlyInSlot(unsigned, signed, 0)) throw new TradeError("mismatch");
  if (order.transaction.expiresAt <= now()) throw new TradeError("expired");
  return args.api.submitTrade(order.orderId, bytesToBase64(signed));
}
