/**
 * Crossmint's order object reduced to one honest state the app can render.
 *
 * Rules from the docs (docs/crossmint-deposits.md §2):
 *  - `phase === "completed"` is NOT success; the line item's delivery status is.
 *  - A failed delivery is refunded automatically.
 *  - A failed card payment can be retried inside the checkout, so it is not
 *    terminal while the person is still there.
 */

import type { CrossmintOrder } from "./crossmint.ts";

export type DepositState =
  | "awaiting_wallet_proof"
  | "awaiting_payment"
  | "verifying_identity"
  | "identity_review"
  | "identity_failed"
  | "payment_processing"
  | "payment_failed"
  | "delivering"
  | "delivered"
  | "delivery_failed"
  | "expired";

export const TERMINAL_DEPOSIT_STATES: ReadonlySet<DepositState> = new Set([
  "delivered",
  "delivery_failed",
  "identity_failed",
  "expired",
]);

export interface DepositOrderView {
  orderId: string;
  state: DepositState;
  terminal: boolean;
  /** Crossmint's raw sub-statuses, for support conversations. */
  phase: string | null;
  paymentStatus: string | null;
  deliveryStatus: string | null;
  /** The card charge, all fees included, when Crossmint has quoted one. */
  totalUsd: string | null;
  /** USDC Crossmint expects to deliver: one value once payment fixes it. */
  receiveUsdc: { min: string; max: string } | null;
  /** The on-chain delivery transaction, present only once delivered. */
  txId: string | null;
  recipient: string;
  deliveryNetwork: "solana-devnet" | "solana-mainnet";
  failure: { code: string | null; message: string | null } | null;
  refundedUsd: string | null;
  /** The exact message the recipient wallet must sign, when Crossmint asks. */
  walletProofMessage: string | null;
  quoteExpiresAt: string | null;
}

const decimal = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9]{1,12}(\.[0-9]{1,12})?$/.test(v) ? v : null;

/** Crossmint's human message is shown as-is only after it is made inert. */
const safeText = (v: unknown, max = 240): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
};

const proofMessage = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 4_000 ? v : null;

export function deriveDepositState(order: CrossmintOrder): DepositState {
  const delivery = order.lineItems?.[0]?.delivery?.status;
  const payment = order.payment?.status;
  if (delivery === "completed") return "delivered";
  if (delivery === "failed") return "delivery_failed";
  if (payment === "completed") return "delivering";
  if (payment === "in-progress") return "payment_processing";
  if (payment === "failed" || order.payment?.failureReason) return "payment_failed";
  if (payment === "requires-recipient-verification") return "awaiting_wallet_proof";
  if (payment === "manual-kyc" || payment === "pending-kyc-review") return "identity_review";
  if (payment === "failed-kyc") return "identity_failed";
  if (payment === "requires-kyc") return "verifying_identity";
  if (order.quote?.status === "expired") return "expired";
  return "awaiting_payment";
}

export function toDepositOrderView(
  order: CrossmintOrder,
  recipient: string,
  deliveryNetwork: DepositOrderView["deliveryNetwork"],
): DepositOrderView {
  const item = order.lineItems?.[0];
  const state = deriveDepositState(order);
  const total = order.quote?.totalPrice ?? item?.quote?.totalPrice;
  const range = item?.quote?.quantityRange;
  const min = decimal(range?.lowerBound);
  const max = decimal(range?.upperBound);
  const failure = order.payment?.failureReason;
  const refunded = order.payment?.refunded;
  return {
    orderId: String(order.orderId ?? ""),
    state,
    terminal: TERMINAL_DEPOSIT_STATES.has(state),
    phase: safeText(order.phase, 40),
    paymentStatus: safeText(order.payment?.status, 60),
    deliveryStatus: safeText(item?.delivery?.status, 40),
    totalUsd: (total?.currency ?? "usd").toLowerCase() === "usd" ? decimal(total?.amount) : null,
    receiveUsdc: min && max ? { min, max } : min ? { min, max: min } : null,
    txId: state === "delivered" && typeof item?.delivery?.txId === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(item.delivery.txId)
      ? item.delivery.txId
      : null,
    recipient,
    deliveryNetwork,
    failure:
      state === "payment_failed" || state === "delivery_failed" || state === "identity_failed"
        ? { code: safeText(failure?.code, 64), message: safeText(failure?.message) }
        : null,
    refundedUsd: (refunded?.currency ?? "usd").toLowerCase() === "usd" ? decimal(refunded?.amount) : null,
    // Exact bytes, unsanitised: the wallet must sign precisely this message.
    walletProofMessage: state === "awaiting_wallet_proof" ? proofMessage(order.payment?.preparation?.message) : null,
    quoteExpiresAt: typeof order.quote?.expiresAt === "string" ? order.quote.expiresAt : null,
  };
}
