/**
 * SOL for fees, from the person's own USDC, through a Jupiter swap whose
 * network fee someone else pays — so a wallet holding 0 SOL can do it.
 *
 * Invariants:
 *   1. The swap is the person's: their verified wallet is the taker, they sign
 *      it with their own wallet (wallet app or the one on their phone), and
 *      their USDC buys SOL into that same wallet. This server holds no key.
 *   2. Nothing reaches a wallet before `checkGaslessSwap` (static rules) AND
 *      `SwapInspector` (lookup tables resolved, simulated on mainnet: exactly
 *      the reviewed USDC leaves, at least the reviewed SOL arrives) pass.
 *   3. Only a transaction someone else pays for is ever offered. If Jupiter
 *      would make the person pay gas (they have none), we say so instead.
 *   4. Execute forwards ONLY the exact reviewed message, signed by the person
 *      — the signature is verified here first — and only once per order.
 *   5. Jupiter's body text never becomes our message. Keys never leave.
 */

import { createPublicKey, verify } from "node:crypto";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { DepositPerson } from "../deposits/accounts.ts";
import type { WalletBalanceReader } from "../deposits/balance.ts";
import { chooseDepositWallet } from "../deposits/service.ts";
import { isDepositError } from "../deposits/errors.ts";
import type { SolTopUpConfig } from "./config.ts";
import type { SwapInspector } from "./inspect.ts";
import { JupiterHttpError, type JupiterOrder, type JupiterTransport } from "./jupiter.ts";
import { GASLESS_SOL_CEILING_LAMPORTS, solNeed, tradesCovered, type RentReader, type SolNeed } from "./need.ts";
import {
  checkGaslessSwap,
  JUPITER_GAS_WALLET,
  messageHashOf,
  SwapCheckError,
  USDC_MINT,
  WSOL_MINT,
  type CheckedSwap,
  type SwapRouter,
} from "./verify.ts";

export type TopUpErrorCode =
  | "UNAVAILABLE"
  | "SIGNED_OUT"
  | "NOT_LINKED"
  | "NO_WALLET"
  | "WALLET_NOT_YOURS"
  | "AMOUNT_OUT_OF_RANGE"
  | "NEEDS_USDC"
  | "ENOUGH_SOL"
  | "BELOW_GASLESS_MINIMUM"
  | "NOT_GASLESS"
  | "SWAP_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "EXPIRED"
  | "SIGNATURE_MISMATCH"
  | "IN_PROGRESS"
  | "BALANCE_UNAVAILABLE";

export class TopUpError extends Error {
  constructor(
    readonly code: TopUpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TopUpError";
  }
}

export const isTopUpError = (e: unknown): e is TopUpError => e instanceof TopUpError;

const NOTHING_SIGNED = "Nothing was signed.";

type Action = "plan" | "order" | "execute";
const LIMITS: Record<Action, number> = { plan: 20, order: 8, execute: 8 };

export class TopUpRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  take(userId: string, action: Action): void {
    const key = `${userId}:${action}`;
    const cutoff = this.now() - 60_000;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= LIMITS[action]) {
      throw new TopUpError("RATE_LIMITED", "That's a lot of tries in a minute. Give it a moment and try again.");
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value as string);
  }
}

export interface TopUpPlan {
  wallet: string;
  network: "solana-mainnet";
  lamports: string;
  usdcBaseUnits: string;
  readAt: string;
  perTradeLamports: string;
  floorLamports: string;
  /** New Panta positions this wallet's SOL pays for today. */
  tradesCoveredNow: number;
  /** Not enough SOL for even one new position. */
  needsSol: boolean;
  /** Jupiter only sponsors gas below 0.01 SOL. */
  gaslessEligible: boolean;
  /** Why no swap is suggested, when none is. */
  blocker: "ENOUGH_SOL" | "NEEDS_USDC" | null;
  suggestion: {
    amountBaseUnits: string;
    /** Jupiter's current quote for this amount, before any fee for gas. */
    estimatedLamports: string;
    tradesCovered: number;
  } | null;
  limits: { minBaseUnits: string; maxBaseUnits: string };
}

export interface TopUpReview {
  wallet: string;
  usdcInBaseUnits: string;
  /** Jupiter's quote, net of its fee. */
  solOutLamports: string;
  /** The least the signed transaction can deliver (after slippage). */
  solOutMinLamports: string;
  /** What the mainnet simulation delivered just now. */
  simulatedLamports: string;
  feeBps: number;
  router: SwapRouter;
  /** Who pays the Solana network fee: Jupiter, or the quoting market maker. */
  networkFeePaidBy: "jupiter" | "market_maker";
  feePayer: string;
  tradesCovered: number;
}

export interface TopUpOrderView {
  requestId: string;
  /** Base64 unsigned v0 transaction: what the person's wallet signs. */
  transaction: string;
  expiresAt: string;
  review: TopUpReview;
}

export type TopUpResult =
  | { status: "SUCCESS"; signature: string; usdcSpentBaseUnits: string | null; solReceivedLamports: string | null }
  | { status: "FAILED"; message: string }
  | { status: "UNKNOWN"; message: string };

interface Pending {
  userId: string;
  wallet: string;
  requestId: string;
  messageHash: string;
  unsigned: Uint8Array;
  ownerSignatureIndex: number;
  expiresAt: number;
  state: "ready" | "executing" | "unknown" | "done";
  signed?: string;
  result?: TopUpResult;
}

export interface SolTopUpDeps {
  config: SolTopUpConfig;
  jupiter: JupiterTransport;
  inspector: SwapInspector;
  rent: RentReader;
  balances: WalletBalanceReader;
  limiter?: TopUpRateLimiter;
  now?: () => number;
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
/** An SPL token account's size, for the WSOL account's rent. */
const TOKEN_ACCOUNT_BYTES = 165;
/** A Metis order's blockhash lives ~60–90 s; the review never outlives 60 s. */
const ORDER_TTL_MS = 60_000;
const PRICE_TTL_MS = 30_000;

export class SolTopUpService {
  private readonly now: () => number;
  private readonly limiter: TopUpRateLimiter;
  private readonly pending = new Map<string, Pending>();
  private price: { at: number; in: bigint; out: bigint } | null = null;

  constructor(private readonly deps: SolTopUpDeps) {
    this.now = deps.now ?? Date.now;
    this.limiter = deps.limiter ?? new TopUpRateLimiter(this.now);
  }

  get config(): SolTopUpConfig {
    return this.deps.config;
  }

  // ── plan ──────────────────────────────────────────────────────────────────

  async plan(person: DepositPerson, walletHint?: string): Promise<TopUpPlan> {
    this.limiter.take(person.userId, "plan");
    const wallet = this.wallet(person, walletHint);
    const [balance, need] = await Promise.all([this.balance(wallet), this.need()]);
    const lamports = BigInt(balance.lamports);
    const usdc = BigInt(balance.usdcBaseUnits);
    const { minUsdcBaseUnits: min, maxUsdcBaseUnits: max, targetUsdcBaseUnits: target, tradesToCover } = this.deps.config;
    const coveredNow = tradesCovered(lamports, need);
    const needsSol = coveredNow < 1;
    const gaslessEligible = lamports < GASLESS_SOL_CEILING_LAMPORTS;

    let blocker: TopUpPlan["blocker"] = null;
    let suggestion: TopUpPlan["suggestion"] = null;
    if (!gaslessEligible || coveredNow >= tradesToCover) {
      blocker = "ENOUGH_SOL";
    } else {
      const price = await this.quotePrice(target);
      const goal = need.floorLamports + BigInt(tradesToCover) * need.perTradeLamports;
      const short = goal > lamports ? goal - lamports : 0n;
      // USDC for the shortfall at today's price, 5% headroom, rounded up to
      // $0.25, never below the owner's usual $1 and never above the cap.
      let amount = (short * price.in * 105n) / (price.out * 100n);
      amount = ((amount + 249_999n) / 250_000n) * 250_000n;
      if (amount < target) amount = target;
      if (amount < min) amount = min;
      if (amount > max) amount = max;
      if (usdc < amount) {
        blocker = "NEEDS_USDC";
      } else {
        const estimated = (amount * price.out) / price.in;
        suggestion = {
          amountBaseUnits: amount.toString(),
          estimatedLamports: estimated.toString(),
          tradesCovered: tradesCovered(lamports + estimated, need),
        };
      }
    }
    return {
      wallet,
      network: "solana-mainnet",
      lamports: balance.lamports,
      usdcBaseUnits: balance.usdcBaseUnits,
      readAt: balance.readAt,
      perTradeLamports: need.perTradeLamports.toString(),
      floorLamports: need.floorLamports.toString(),
      tradesCoveredNow: coveredNow,
      needsSol,
      gaslessEligible,
      blocker,
      suggestion,
      limits: { minBaseUnits: min.toString(), maxBaseUnits: max.toString() },
    };
  }

  // ── order ─────────────────────────────────────────────────────────────────

  async order(person: DepositPerson, input: { wallet?: string | undefined; amountBaseUnits: string }): Promise<TopUpOrderView> {
    this.limiter.take(person.userId, "order");
    const wallet = this.wallet(person, input.wallet);
    const amount = BigInt(input.amountBaseUnits);
    const { minUsdcBaseUnits: min, maxUsdcBaseUnits: max } = this.deps.config;
    if (amount < min || amount > max) {
      throw new TopUpError("AMOUNT_OUT_OF_RANGE", `Choose from ${usdc(min)} to ${usdc(max)} USDC.`);
    }
    const [balance, need, tokenRent] = await Promise.all([this.balance(wallet), this.need(), this.tokenAccountRent()]);
    if (BigInt(balance.usdcBaseUnits) < amount) {
      throw new TopUpError("NEEDS_USDC", `This wallet has ${usdc(BigInt(balance.usdcBaseUnits))} USDC. Add funds first. ${NOTHING_SIGNED}`);
    }
    if (BigInt(balance.lamports) >= GASLESS_SOL_CEILING_LAMPORTS) {
      throw new TopUpError("ENOUGH_SOL", "This wallet already has SOL for network fees.");
    }

    // Two routers we can check end to end. A JupiterZ quote that can't be
    // built is retried once on Metis alone.
    let order = await this.jupiterOrder({ wallet, amount, excludeRouters: "dflow,okx" });
    if (!buildable(order) && order.router === "jupiterz") {
      order = await this.jupiterOrder({ wallet, amount, excludeRouters: "dflow,okx,jupiterz" });
    }
    const transaction = this.acceptable(order, wallet, amount);
    const router = order.router as SwapRouter;
    const nowMs = this.now();
    let bytes: Uint8Array;
    let checked: CheckedSwap;
    try {
      bytes = Buffer.from(transaction, "base64");
      checked = checkGaslessSwap(bytes, {
        owner: wallet,
        inAmount: amount,
        router,
        quotedOutLamports: BigInt(order.outAmount),
        feeBps: Math.ceil(order.feeBps ?? 0),
        nowSeconds: Math.floor(nowMs / 1000),
      });
      if (checked.feePayer !== order.signatureFeePayer) throw new SwapCheckError("fee payer differs from the quote");
      if (router === "metis" && checked.feePayer !== JUPITER_GAS_WALLET) throw new SwapCheckError("unknown sponsor");
      // The rent repaid can only be what the close just refunded: a token
      // account's rent today (verify.ts's ceiling is the old, higher rate).
      if (checked.rentRepayLamports > tokenRent) throw new SwapCheckError("rent repayment above today's rent");
    } catch (error) {
      if (error instanceof SwapCheckError) {
        throw new TopUpError("SWAP_REJECTED", `The swap Jupiter offered didn't pass our checks. ${NOTHING_SIGNED} Try again in a moment.`);
      }
      throw error;
    }

    const tx = VersionedTransaction.deserialize(bytes);
    let effect;
    try {
      effect = await this.deps.inspector.inspect(tx, wallet, checked);
    } catch (error) {
      if (error instanceof SwapCheckError) {
        throw new TopUpError("SWAP_REJECTED", `This swap wouldn't go through right now. ${NOTHING_SIGNED} Try again in a moment.`);
      }
      throw new TopUpError("PROVIDER_UNAVAILABLE", `We couldn't check this swap on Solana just now. ${NOTHING_SIGNED} Try again in a moment.`);
    }
    if (effect.usdcDelta !== -amount || effect.lamportsDelta < checked.minOutLamports) {
      throw new TopUpError("SWAP_REJECTED", `The swap Jupiter offered didn't match its quote. ${NOTHING_SIGNED}`);
    }

    const requestId = order.requestId ?? "";
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) {
      throw new TopUpError("PROVIDER_UNAVAILABLE", `Jupiter's answer was incomplete. ${NOTHING_SIGNED}`);
    }
    const expiresAt = Math.min(nowMs + ORDER_TTL_MS, fillExpiry(order) ?? Number.POSITIVE_INFINITY);
    this.sweep(nowMs);
    this.pending.set(requestId, {
      userId: person.userId,
      wallet,
      requestId,
      messageHash: checked.messageHash,
      unsigned: bytes,
      ownerSignatureIndex: checked.ownerSignatureIndex,
      expiresAt,
      state: "ready",
    });
    const solOut = BigInt(order.outAmount) < checked.expectedOutLamports ? BigInt(order.outAmount) : checked.expectedOutLamports;
    return {
      requestId,
      transaction,
      expiresAt: new Date(expiresAt).toISOString(),
      review: {
        wallet,
        usdcInBaseUnits: amount.toString(),
        solOutLamports: solOut.toString(),
        solOutMinLamports: checked.minOutLamports.toString(),
        simulatedLamports: effect.lamportsDelta.toString(),
        feeBps: checked.feeBps,
        router,
        networkFeePaidBy: router === "metis" ? "jupiter" : "market_maker",
        feePayer: checked.feePayer,
        tradesCovered: tradesCovered(BigInt(balance.lamports) + checked.minOutLamports, need),
      },
    };
  }

  // ── execute ───────────────────────────────────────────────────────────────

  async execute(person: DepositPerson, input: { requestId: string; signedTransaction: string }): Promise<TopUpResult> {
    this.limiter.take(person.userId, "execute");
    const pending = this.pending.get(input.requestId);
    // Someone else's order reads exactly like a missing one.
    if (!pending || pending.userId !== person.userId) {
      throw new TopUpError("NOT_FOUND", "We couldn't find that swap. Start again.");
    }
    if (pending.state === "done" && pending.result) {
      if (pending.signed !== input.signedTransaction) throw new TopUpError("SIGNATURE_MISMATCH", "That swap already finished.");
      return pending.result;
    }
    if (pending.state === "executing") throw new TopUpError("IN_PROGRESS", "This swap is already being sent. Check your balance in a moment.");
    if (pending.state === "unknown" && pending.signed !== input.signedTransaction) {
      throw new TopUpError("SIGNATURE_MISMATCH", "This swap was already sent once. Check your balance before trying again.");
    }
    if (pending.state === "ready" && this.now() > pending.expiresAt) {
      this.pending.delete(input.requestId);
      throw new TopUpError("EXPIRED", "This quote expired. Get a fresh one. Nothing was sent.");
    }
    this.checkSigned(pending, input.signedTransaction);

    pending.state = "executing";
    pending.signed = input.signedTransaction;
    let result: TopUpResult;
    try {
      const reply = await this.deps.jupiter.execute(input.signedTransaction, pending.requestId);
      if (reply.status === "Success" && reply.signature && /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(reply.signature)) {
        result = {
          status: "SUCCESS",
          signature: reply.signature,
          usdcSpentBaseUnits: reply.totalInputAmount ?? reply.inputAmountResult ?? null,
          solReceivedLamports: reply.totalOutputAmount ?? reply.outputAmountResult ?? null,
        };
      } else {
        result = { status: "FAILED", message: executeFailureCopy(reply.code ?? null) };
      }
      pending.state = "done";
      pending.result = result;
      return result;
    } catch {
      // Jupiter may have landed it. Resending these same bytes is safe (one
      // signature can land once); anything else waits for the balance.
      pending.state = "unknown";
      return {
        status: "UNKNOWN",
        message: "We couldn't hear back from Jupiter. Check your balance in a moment before trying again.",
      };
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private wallet(person: DepositPerson, hint?: string): string {
    try {
      return chooseDepositWallet(person, hint).address;
    } catch (error) {
      if (isDepositError(error)) {
        throw new TopUpError(error.code === "WALLET_NOT_YOURS" ? "WALLET_NOT_YOURS" : "NO_WALLET", error.message);
      }
      throw error;
    }
  }

  private async balance(wallet: string) {
    try {
      return await this.deps.balances.read(wallet);
    } catch {
      throw new TopUpError("BALANCE_UNAVAILABLE", "We couldn't read your wallet just now. Try again in a moment.");
    }
  }

  private async need(): Promise<SolNeed> {
    try {
      return await solNeed(this.deps.rent);
    } catch {
      throw new TopUpError("BALANCE_UNAVAILABLE", "We couldn't read Solana's fees just now. Try again in a moment.");
    }
  }

  /** Today's rent for a 165-byte token account (the WSOL account a swap opens). */
  private async tokenAccountRent(): Promise<bigint> {
    try {
      return await this.deps.rent.minimumBalance(TOKEN_ACCOUNT_BYTES);
    } catch {
      throw new TopUpError("BALANCE_UNAVAILABLE", "We couldn't read Solana's fees just now. Try again in a moment.");
    }
  }

  /** Today's USDC -> SOL price from a quote with no taker (nothing to sign). */
  private async quotePrice(amount: bigint): Promise<{ in: bigint; out: bigint }> {
    const held = this.price;
    if (held && this.now() - held.at < PRICE_TTL_MS) return held;
    let order: JupiterOrder;
    try {
      order = await this.deps.jupiter.order({ inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: amount.toString() });
    } catch {
      throw new TopUpError("PROVIDER_UNAVAILABLE", "We couldn't reach Jupiter for a price just now. Try again in a moment.");
    }
    const inAmount = BigInt(order.inAmount);
    const out = BigInt(order.outAmount);
    if (order.inputMint !== USDC_MINT || order.outputMint !== WSOL_MINT || inAmount <= 0n || out <= 0n) {
      throw new TopUpError("PROVIDER_UNAVAILABLE", "Jupiter's price didn't look right. Try again in a moment.");
    }
    this.price = { at: this.now(), in: inAmount, out };
    return this.price;
  }

  private async jupiterOrder(input: { wallet: string; amount: bigint; excludeRouters: string }): Promise<JupiterOrder> {
    try {
      return await this.deps.jupiter.order({
        inputMint: USDC_MINT,
        outputMint: WSOL_MINT,
        amount: input.amount.toString(),
        taker: input.wallet,
        excludeRouters: input.excludeRouters,
      });
    } catch (error) {
      if (error instanceof JupiterHttpError && error.status === 429) {
        throw new TopUpError("RATE_LIMITED", "Lots of people are swapping right now. Try again in a minute.");
      }
      if (error instanceof JupiterHttpError && (error.status === 401 || error.status === 403)) {
        throw new TopUpError("UNAVAILABLE", "Swapping USDC for SOL isn't set up correctly yet.");
      }
      throw new TopUpError("PROVIDER_UNAVAILABLE", `We couldn't reach Jupiter just now. ${NOTHING_SIGNED} Try again in a moment.`);
    }
  }

  /** The order's unsigned transaction, but only a gasless one for this exact swap. */
  private acceptable(order: JupiterOrder, wallet: string, amount: bigint): string {
    if (order.inputMint !== USDC_MINT || order.outputMint !== WSOL_MINT || order.inAmount !== amount.toString() || (order.taker ?? wallet) !== wallet) {
      throw new TopUpError("PROVIDER_UNAVAILABLE", `Jupiter answered for a different swap. ${NOTHING_SIGNED}`);
    }
    if (!buildable(order)) {
      const code = order.errorCode ?? null;
      if (order.router !== "jupiterz" && code === 1) {
        throw new TopUpError("NEEDS_USDC", `This wallet doesn't have that much USDC. ${NOTHING_SIGNED}`);
      }
      if (order.router !== "jupiterz" && code === 3) {
        throw new TopUpError(
          "BELOW_GASLESS_MINIMUM",
          "Jupiter only pays the network fee on bigger swaps right now. Try a larger amount, or send a little SOL from another wallet.",
        );
      }
      throw new TopUpError("NOT_GASLESS", "Jupiter can't cover the network fee for this swap right now. Try again in a minute, or send a little SOL from another wallet.");
    }
    const payer = order.signatureFeePayer;
    const priority = order.prioritizationFeePayer;
    if (order.gasless !== true || !payer || payer === wallet || (priority && priority === wallet) ||
        (order.router !== "metis" && order.router !== "jupiterz")) {
      throw new TopUpError("NOT_GASLESS", "Jupiter can't cover the network fee for this swap right now. Try again in a minute, or send a little SOL from another wallet.");
    }
    return order.transaction!;
  }

  /** Exactly the reviewed message, with a valid signature from the person in
   *  their slot and every other slot as Jupiter left it. */
  private checkSigned(pending: Pending, payload: string): void {
    const mismatch = () => new TopUpError("SIGNATURE_MISMATCH", "Your wallet signed something other than the reviewed swap. Nothing was sent.");
    let tx: VersionedTransaction;
    try {
      const bytes = Buffer.from(payload, "base64");
      if (bytes.toString("base64") !== payload || bytes.length > 1232) throw mismatch();
      tx = VersionedTransaction.deserialize(bytes);
    } catch {
      throw mismatch();
    }
    if (messageHashOf(tx) !== pending.messageHash) throw mismatch();
    const before = VersionedTransaction.deserialize(pending.unsigned);
    if (tx.signatures.length !== before.signatures.length) throw mismatch();
    for (let i = 0; i < tx.signatures.length; i++) {
      if (i === pending.ownerSignatureIndex) continue;
      if (!Buffer.from(tx.signatures[i]!).equals(Buffer.from(before.signatures[i]!))) throw mismatch();
    }
    const signature = tx.signatures[pending.ownerSignatureIndex]!;
    const key = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([SPKI_ED25519, new PublicKey(pending.wallet).toBuffer()]) });
    if (signature.every((b) => b === 0) || !verify(null, tx.message.serialize(), key, signature)) throw mismatch();
  }

  private sweep(now: number): void {
    for (const [id, p] of this.pending) {
      if ((p.state === "ready" && now > p.expiresAt + 60_000) || now > p.expiresAt + 3_600_000) this.pending.delete(id);
    }
    while (this.pending.size > 5_000) this.pending.delete(this.pending.keys().next().value as string);
  }
}

const buildable = (order: JupiterOrder) => typeof order.transaction === "string" && order.transaction.length > 0;

function fillExpiry(order: JupiterOrder): number | null {
  if (order.router !== "jupiterz" || order.expireAt === undefined) return null;
  const raw = order.expireAt;
  const value = typeof raw === "number" ? raw : /^[0-9]+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function executeFailureCopy(code: number | null): string {
  if (code === -2003 || code === -1004) return "The quote expired before it landed. Nothing was swapped. Get a fresh quote.";
  if (code === -1000 || code === -2000) return "The swap didn't land on Solana. Nothing was swapped. Try again.";
  if (code === -2004) return "The market maker turned the swap down. Nothing was swapped. Try again.";
  return "Jupiter couldn't complete the swap. Nothing was swapped. Try again.";
}

export function usdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const cents = (baseUnits % 1_000_000n) / 10_000n;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

