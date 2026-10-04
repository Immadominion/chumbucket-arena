/**
 * The money flows, as steps the sheets walk through, on the BFF's own routes
 * (docs/money-api.md):
 *
 *   a call     money.prepareCall ─┬─ NEEDS_FUNDS → the deposit sheet, then the same ask again
 *                                 ├─ NEEDS_GAS   → a silent gasless top-up, then the same ask again
 *                                 └─ READY       → the review (checked buy) → confirm → pantaTrading.submit
 *   a transfer money.cashOutPrepare / depositFromWalletPrepare → (gas) → review → sign → transferSubmit
 *   a win      pantaTrading.claimPrepare → sign → claimSubmit
 *
 * Every signature goes through a `checkedSigner` (trade.ts), which checks the
 * exact bytes against what the person reviewed — and against what they asked
 * for here, not only what the BFF answered — before any wallet sees them.
 * Nothing here says a trade or a transfer is done: only the BFF does, after
 * the chain shows it.
 *
 * Pure (the BFF and the wallet are injected): the BFF repo's bun tests import it.
 */

import type {
  ClaimPrepared,
  ClaimView,
  MoneyCallView,
  PrepareCallResult,
  TopUpOrder,
  TopUpResult,
  TransferPrepareResult,
  TransferView,
  WalletRef,
  WinningsItem,
} from "./money";
import { UnsafeTransaction } from "./pantaBuyCheck";
import { base64ToBytes, bytesToBase64 } from "./solanaTx";
import { confirmTrade, reviewPrepared, TradeError, type ReviewedTrade, type TradeOrder, type TradeSigner } from "./trade";
import type { CallFeedEntry, Side } from "./types";

/** Finds the person's own wallet that signs for `address` (the Chumbucket wallet or a browser wallet). */
export type SignerFor = (address: string) => Promise<TradeSigner>;

export interface MoneyFlowApi {
  submitTrade(orderId: string, signedTransaction: string): Promise<TradeOrder>;
  topUpOrder(wallet: string, amountBaseUnits: string): Promise<TopUpOrder>;
  topUpExecute(requestId: string, signedTransaction: string): Promise<TopUpResult>;
  transferSubmit(transferId: string, signedTransaction: string): Promise<TransferView>;
  claimPrepare(orderId: string, idempotencyKey: string): Promise<ClaimPrepared>;
  claimSubmit(claimId: string, signedTransaction: string): Promise<ClaimView>;
}

/** Why a flow stopped, for one plain line (never a provider's words). */
export class MoneyStop extends Error {
  constructor(
    readonly kind: "gas" | "swap" | "unsafe",
    message: string,
  ) {
    super(message);
  }
}

const GAS_ROUNDS = 2;

// ── gas ──────────────────────────────────────────────────────────────────────

/**
 * The silent gasless top-up: a little of the wallet's USDC for the SOL a
 * trade or a transfer needs. Checked like every other signature (the swap
 * spends exactly the quoted USDC from the person's own account into their
 * own SOL; someone else pays its fee). Answers "funds" when the wallet has
 * no USDC to swap; throws [MoneyStop] for anything else that stops it.
 */
export async function topUp(
  deps: { api: Pick<MoneyFlowApi, "topUpOrder" | "topUpExecute">; signerFor: SignerFor; now?: () => number },
  wallet: string,
  amountBaseUnits: string,
): Promise<"done" | "funds"> {
  const now = deps.now ?? Date.now;
  const order = await deps.api.topUpOrder(wallet, amountBaseUnits);
  if (order.status === "REFUSED") {
    if (order.reason === "ENOUGH_SOL") return "done";
    if (order.reason === "NEEDS_USDC") return "funds";
    throw new MoneyStop("gas", order.message);
  }
  if (order.review.wallet !== wallet || order.review.usdcInBaseUnits !== amountBaseUnits) {
    throw new MoneyStop("unsafe", "This didn’t check out. Nothing was signed.");
  }
  const signer = await deps.signerFor(wallet);
  let signed: Uint8Array;
  try {
    ({ signed } = await signer.signSwap(base64ToBytes(order.transaction), {
      owner: wallet,
      inAmount: BigInt(order.review.usdcInBaseUnits),
      router: order.review.router,
      quotedOutLamports: BigInt(order.review.solOutLamports),
      feeBps: order.review.feeBps,
      nowSeconds: Math.floor(now() / 1000),
    }));
  } catch (e) {
    if (e instanceof UnsafeTransaction) throw new MoneyStop("unsafe", "This didn’t check out. Nothing was signed.");
    throw new TradeError("declined");
  }
  const result = await deps.api.topUpExecute(order.requestId, bytesToBase64(signed));
  if (result.status !== "SUCCESS") throw new MoneyStop("swap", result.message);
  return "done";
}

// ── a call with an amount ────────────────────────────────────────────────────

export type CallStep =
  | { step: "funds"; wallet: WalletRef; neededBaseUnits: string; shortfallBaseUnits: string | null }
  | { step: "review"; reviewed: ReviewedTrade; moneyCall: MoneyCallView; call: CallFeedEntry }
  | { step: "settled"; moneyCall: MoneyCallView; call: CallFeedEntry };

/** What the person asked for: the amount, the side and the market (Tail takes the call's side, Fade the other). */
export interface CallIntent {
  amountBaseUnits: string;
  side: Side;
  marketId: string;
}

/**
 * One turn of a call with an amount: ask (prepareCall, or retry), run any
 * top-up silently and ask again, and stop at what needs the person — the
 * deposit sheet, or the review of a checked buy.
 */
export async function advanceCall(
  ask: () => Promise<PrepareCallResult>,
  intent: CallIntent,
  deps: { api: Pick<MoneyFlowApi, "topUpOrder" | "topUpExecute">; signerFor: SignerFor; now?: () => number },
): Promise<CallStep> {
  for (let round = 0; ; round++) {
    const answer = await ask();
    if (answer.status === "NEEDS_FUNDS") {
      return { step: "funds", wallet: answer.wallet, neededBaseUnits: answer.neededBaseUnits, shortfallBaseUnits: answer.shortfallBaseUnits };
    }
    if (answer.status === "NEEDS_GAS") {
      // Never ask the person for SOL: no top-up on this server is the generic error.
      if (!answer.topUp || round >= GAS_ROUNDS) throw new MoneyStop("gas", "This can’t go through right now. Nothing was spent.");
      const done = await topUp(deps, answer.wallet.address, answer.topUp.amountBaseUnits);
      if (done === "funds") {
        const needed = (BigInt(intent.amountBaseUnits) + BigInt(answer.topUp.amountBaseUnits)).toString();
        return { step: "funds", wallet: answer.wallet, neededBaseUnits: needed, shortfallBaseUnits: null };
      }
      continue;
    }
    const { moneyCall, call } = answer;
    if (
      moneyCall.amountBaseUnits !== intent.amountBaseUnits ||
      moneyCall.side !== intent.side ||
      moneyCall.marketId !== intent.marketId ||
      call.call.id !== moneyCall.callId ||
      call.market.id !== intent.marketId ||
      call.call.side !== intent.side
    ) {
      throw new TradeError("mismatch");
    }
    if (answer.status === "SETTLED") return { step: "settled", moneyCall, call };
    const signer = await deps.signerFor(moneyCall.wallet);
    const reviewed = await reviewPrepared({
      prepared: answer.trade,
      venueMarketId: call.market.venueMarketId,
      side: intent.side,
      amountBaseUnits: intent.amountBaseUnits,
      signer,
      ...(deps.now ? { now: deps.now } : {}),
    });
    return { step: "review", reviewed, moneyCall, call };
  }
}

/** After the person confirmed: the wallet signs exactly the reviewed buy, the BFF submits it (SUBMITTED, never done). */
export function confirmCall(api: Pick<MoneyFlowApi, "submitTrade">, reviewed: ReviewedTrade, now?: () => number): Promise<TradeOrder> {
  return confirmTrade({ api, reviewed, ...(now ? { now } : {}) });
}

// ── a transfer: cash out, or from your wallet ────────────────────────────────

export type TransferReady = Extract<TransferPrepareResult, { status: "READY" }>;

export type TransferStep = { step: "invalid"; reason: string; message: string } | { step: "review"; ready: TransferReady };

/** What the person asked to move: from which wallet, to which, how much. */
export interface TransferIntent {
  from: string;
  to: string;
  amountBaseUnits: string;
}

/** Ask for the transfer (running any top-up silently) and check the answer is what was asked. */
export async function prepareTransfer(
  ask: () => Promise<TransferPrepareResult>,
  intent: TransferIntent,
  deps: { api: Pick<MoneyFlowApi, "topUpOrder" | "topUpExecute">; signerFor: SignerFor; now?: () => number },
): Promise<TransferStep> {
  for (let round = 0; ; round++) {
    const answer = await ask();
    if (answer.status === "INVALID") return { step: "invalid", reason: answer.reason, message: answer.message };
    if (answer.status === "NEEDS_GAS") {
      if (!answer.topUp || round >= GAS_ROUNDS) throw new MoneyStop("gas", "This can’t go through right now. Nothing was sent.");
      const done = await topUp(deps, answer.wallet.address, answer.topUp.amountBaseUnits);
      if (done === "funds") throw new MoneyStop("gas", "This can’t go through right now. Nothing was sent.");
      continue;
    }
    const { review, transfer, transaction } = answer;
    if (
      review.from !== intent.from ||
      review.to !== intent.to ||
      review.amountBaseUnits !== intent.amountBaseUnits ||
      transfer.from !== intent.from ||
      transfer.to !== intent.to ||
      transfer.amountBaseUnits !== intent.amountBaseUnits ||
      transaction.encoding !== "solana-tx-base64"
    ) {
      throw new TradeError("mismatch");
    }
    return { step: "review", ready: answer };
  }
}

/** After the person confirmed: sign exactly the reviewed transfer (checked inside the signer), submit it. */
export async function sendTransfer(
  api: Pick<MoneyFlowApi, "transferSubmit">,
  signer: TradeSigner,
  ready: TransferReady,
  now: () => number = Date.now,
): Promise<TransferView> {
  if (ready.transaction.expiresAt <= now()) throw new TradeError("expired");
  let signed: Uint8Array;
  try {
    signed = await signer.signTransfer(base64ToBytes(ready.transaction.payload), {
      from: ready.review.from,
      to: ready.review.to,
      amountBaseUnits: ready.review.amountBaseUnits,
      createsAccount: ready.review.createsAccount,
    });
  } catch (e) {
    throw new TradeError(e instanceof UnsafeTransaction ? "unsafe" : "declined");
  }
  if (ready.transaction.expiresAt <= now()) throw new TradeError("expired");
  return api.transferSubmit(ready.transfer.transferId, bytesToBase64(signed));
}

// ── a win ────────────────────────────────────────────────────────────────────

/**
 * `Collect $9.20`: the claim the BFF builds for this won position, signed
 * by its own wallet after the claim check, then submitted. A position that
 * already has a claim going answers that claim instead of a second one.
 */
export async function collectWin(
  deps: { api: Pick<MoneyFlowApi, "claimPrepare" | "claimSubmit">; signerFor: SignerFor; now?: () => number },
  item: Pick<WinningsItem, "orderId" | "wallet" | "side">,
  idempotencyKey: string,
): Promise<ClaimView> {
  const now = deps.now ?? Date.now;
  const prepared = await deps.api.claimPrepare(item.orderId, idempotencyKey);
  const { claim, transaction, review } = prepared;
  if (claim.owner !== item.wallet || claim.orderId !== item.orderId) throw new TradeError("mismatch");
  if (!transaction || !review) return claim;
  if (review.outcome !== item.side || transaction.encoding !== "solana-tx-base64") throw new TradeError("mismatch");
  if (transaction.expiresAt <= now()) throw new TradeError("expired");
  const signer = await deps.signerFor(item.wallet);
  let signed: Uint8Array;
  try {
    signed = await signer.signClaim(base64ToBytes(transaction.payload), {
      owner: item.wallet,
      venueMarketId: claim.venueMarketId,
      outcome: review.outcome,
      winningShares: review.winningShares,
    });
  } catch (e) {
    throw new TradeError(e instanceof UnsafeTransaction ? "unsafe" : "declined");
  }
  return deps.api.claimSubmit(claim.claimId, bytesToBase64(signed));
}

/** The one line a stopped money flow shows. `fallback` is the plain line for anything unexpected. */
export function stopLine(e: unknown, fallback: string): string {
  if (e instanceof MoneyStop) return e.message;
  if (e instanceof TradeError) {
    return e.kind === "declined"
      ? "Not signed. Nothing was spent."
      : e.kind === "expired"
        ? "The price moved. Try again."
        : e.kind === "unsafe"
          ? "This didn’t check out. Nothing was signed."
          : "Something changed on the way. Nothing was sent.";
  }
  return fallback;
}
