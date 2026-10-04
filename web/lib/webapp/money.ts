/**
 * Calls with money (Chumbucket Money v1), as the web app reads and shows
 * them: the BFF's `money.*` wire shapes (docs/money-api.md, mirrored here,
 * never a source of truth) and the small rules every money surface shares:
 *
 *   - money is dollars on screen and integer USDC base units on the wire
 *     ("5000000" is $5);
 *   - the amount row: `Free · $5 · $10 · $25 · +`, defaulting to the last
 *     amount this viewer used, else the server's default, else $5;
 *   - the call's button follows the amount: `Call YES` (ink, Free) or
 *     `Call YES · $5` (pink);
 *   - nothing reads as funded before the BFF says FUNDED (a confirmed fill).
 *
 * Pure (no DOM, no clock of its own): the BFF repo's bun tests import it.
 */

import type { KeyValueStorage } from "./cache";
import { isAddress } from "./solanaV0";
import type { PreparedTrade, TradeOrder } from "./trade";
import type { CallFeedEntry, Market, Side } from "./types";

// ── wire shapes ──────────────────────────────────────────────────────────────

export interface MoneyStatus {
  enabled: boolean;
  reason: string | null;
  presetsBaseUnits: string[];
  minBaseUnits: string;
  maxBaseUnits: string | null;
  defaultAmountBaseUnits: string | null;
  pendingTtlMs: number;
}

export type MoneyCallState = "PENDING" | "FUNDED" | "FREE" | "EXPIRED";
export type MoneyTradeState = "NONE" | "QUOTED" | "SUBMITTED" | "FILLED" | "FAILED";
export type MoneyCallKind = "own" | "back" | "fade";

export interface MoneyCallView {
  callId: string;
  kind: MoneyCallKind;
  targetCallId: string | null;
  marketId: string;
  side: Side;
  amountBaseUnits: string;
  wallet: string;
  state: MoneyCallState;
  trade: MoneyTradeState;
  orderId: string | null;
  filledBaseUnits: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  canRetry: boolean;
  canKeepFree: boolean;
  canDiscard: boolean;
}

export interface WalletRef {
  address: string;
  walletType: string;
}

export type PrepareCallResult =
  | { status: "NEEDS_FUNDS"; wallet: WalletRef; balanceBaseUnits: string; neededBaseUnits: string; shortfallBaseUnits: string }
  | { status: "NEEDS_GAS"; wallet: WalletRef; topUp: { amountBaseUnits: string } | null }
  | { status: "READY"; moneyCall: MoneyCallView; call: CallFeedEntry; trade: PreparedTrade }
  | { status: "SETTLED"; moneyCall: MoneyCallView; call: CallFeedEntry };

export type RetryResult = Exclude<PrepareCallResult, { status: "SETTLED" }>;

/** What a call with an amount is: your own call on a market, or Tail / Fade of someone's call. */
export type MoneyCallTarget = { kind: "own"; marketId: string; side: Side } | { kind: "back" | "fade"; targetCallId: string };

export type PrepareCallInput = MoneyCallTarget & {
  amountBaseUnits: string;
  idempotencyKey: string;
  thesis?: string | null;
  visibility?: "public" | "followers";
};

export interface MoneyWallet {
  /** The trading wallet; null: the account has no wallet yet. */
  wallet: WalletRef | null;
  /** Null only with no wallet. */
  balance: { usdcBaseUnits: string; lamports: string; slot: number } | null;
  /** Null: no wallet, or the fees could not be checked just now. */
  gas: { needsTopUp: boolean; topUp: { amountBaseUnits: string } | null } | null;
}

export type ActivityKind = "trade" | "claim" | "deposit" | "cash_out";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
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

export interface TransferReview {
  from: string;
  to: string;
  amountBaseUnits: string;
  createsAccount: boolean;
  networkFeeLamports: string;
  rentLamports: string;
}

export interface TransferView {
  transferId: string;
  kind: "cash_out" | "deposit";
  from: string;
  to: string;
  amountBaseUnits: string;
  state: "BUILT" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  signature: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type TransferPrepareResult =
  | { status: "INVALID"; reason: string; message: string }
  | { status: "NEEDS_GAS"; wallet: WalletRef; topUp: { amountBaseUnits: string } | null }
  /** The same key after it was signed: its actual state, never a new review. */
  | { status: "SENT"; transfer: TransferView }
  | {
      status: "READY";
      transfer: TransferView;
      transaction: { encoding: "solana-tx-base64"; payload: string; expiresAt: number };
      review: TransferReview;
    };

export interface WinningsItem {
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

export interface Winnings {
  items: WinningsItem[];
  totalBaseUnits: string;
}

export interface DepositOptions {
  tradingWallet: WalletRef | null;
  sendUsdc: { address: string; mint: string; network: "solana-mainnet"; uri: string } | null;
  card: {
    available: boolean;
    testMode: boolean;
    reason: string | null;
    presetsUsd: string[];
    limits: { minUsd: string; maxUsd: string } | null;
  };
  fromWallet: { wallets: WalletRef[] };
}

/** `pantaTrading.claimPrepare` / `claimSubmit` / `claim`. */
export interface ClaimView {
  claimId: string;
  orderId: string;
  venueMarketId: string;
  owner: string;
  state: "BUILT" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  signature: string | null;
  payoutBaseUnits: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface ClaimPrepared {
  claim: ClaimView;
  /** Null when this position already has a claim in flight or settled. */
  transaction: { encoding: "solana-tx-base64"; payload: string; expiresAt: number } | null;
  review: { outcome: Side; winningShares: string; estimatedPayoutUsdc: string } | null;
}

/** `solTopUp.order`: a gasless swap to sign, or why none is offered. */
export type TopUpOrder =
  | {
      status: "READY";
      requestId: string;
      transaction: string;
      expiresAt: string;
      review: {
        wallet: string;
        usdcInBaseUnits: string;
        solOutLamports: string;
        solOutMinLamports: string;
        feeBps: number;
        router: "metis" | "jupiterz";
        feePayer: string;
      };
    }
  | { status: "REFUSED"; reason: "NEEDS_USDC" | "ENOUGH_SOL" | "BELOW_GASLESS_MINIMUM" | "NOT_GASLESS"; message: string };

export type TopUpResult =
  | { status: "SUCCESS"; signature: string }
  | { status: "FAILED"; message: string }
  | { status: "UNKNOWN"; message: string };

/** `deposits.create` (the card path, Crossmint). */
export interface CardDeposit {
  order: CardOrder;
  checkoutUrl: string;
}

export interface CardOrder {
  orderId: string;
  state: string;
  terminal: boolean;
  failure: { code: string | null; message: string | null } | null;
  walletProofMessage: string | null;
}

export interface MoneyCallStatus {
  moneyCall: MoneyCallView;
  order: TradeOrder | null;
}

// ── dollars ──────────────────────────────────────────────────────────────────

const BASE = 1_000_000n;

function parseUnits(value: string | bigint | null | undefined): bigint {
  if (typeof value === "bigint") return value < 0n ? 0n : value;
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value) ? BigInt(value) : 0n;
}

const thousands = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * An amount, in dollars, rounded down to the cent: "$5", "$9.20", "$1,250".
 * Whole dollars drop the cents. Never more than the base units say.
 */
export function usd(baseUnits: string | bigint | null | undefined): string {
  const units = parseUnits(baseUnits);
  const cents = units / 10_000n;
  const whole = cents / 100n;
  const rest = cents % 100n;
  return rest === 0n ? `$${thousands(whole)}` : `$${thousands(whole)}.${rest.toString().padStart(2, "0")}`;
}

/** A balance, always to the cent ("$12.19", "$0.00"), rounded down. */
export function balanceUsd(baseUnits: string | bigint | null | undefined): string {
  const cents = parseUnits(baseUnits) / 10_000n;
  return `$${thousands(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A side as a market names it when that says more than YES / NO ("Lakers"), else YES / NO. */
export function sideName(market: Pick<Market, "outcomes"> | null | undefined, side: Side): string {
  const label = market?.outcomes.find((o) => o.side === side)?.label;
  return label && label.toUpperCase() !== side ? label : side;
}

/**
 * An amount to the last base unit, never rounded: what a signature moves.
 * "$5", "$9.20", "$12.190001".
 */
export function exactUsd(baseUnits: string | bigint | null | undefined): string {
  const units = parseUnits(baseUnits);
  const frac = units % BASE;
  if (frac === 0n) return `$${thousands(units / BASE)}`;
  const digits = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `$${thousands(units / BASE)}.${digits.padEnd(2, "0")}`;
}

/** "$5 on YES": a confirmed fill's stamp. */
export const onSide = (baseUnits: string, side: string): string => `${usd(baseUnits)} on ${side}`;

/** Base units as the decimal dollars a card checkout takes ("5000000" → "5", "5250000" → "5.25"). */
export function usdDecimal(baseUnits: string): string {
  const cents = parseUnits(baseUnits) / 10_000n;
  const rest = cents % 100n;
  return rest === 0n ? (cents / 100n).toString() : `${cents / 100n}.${rest.toString().padStart(2, "0")}`;
}

/** A dollar amount someone typed ("5", "$5.50", "1,000") as base units; null when it isn't one. */
export function parseUsd(text: string, opts: { cents?: boolean } = {}): bigint | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  const m = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,6}))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (opts.cents !== false && frac.length > 2) return null;
  return BigInt(m[1]!) * BASE + BigInt(frac.padEnd(6, "0"));
}

// ── the amount row ───────────────────────────────────────────────────────────

/** `null` is Free; otherwise USDC base units. */
export type Amount = string | null;

export const DEFAULT_AMOUNT = "5000000";
const FALLBACK_PRESETS = ["5000000", "10000000", "25000000"];

/** The chips after Free: the server's presets (`$5 · $10 · $25`). */
export function presetAmounts(status: Pick<MoneyStatus, "presetsBaseUnits"> | null | undefined): string[] {
  const list = (status?.presetsBaseUnits ?? []).filter((p) => /^[1-9][0-9]{0,15}$/.test(p));
  return (list.length ? list : FALLBACK_PRESETS).slice(0, 4);
}

const lastAmountKey = (userId: string) => `cb.app.lastAmount.${userId}`;

/** The last amount this viewer used here: a per-browser convenience, never trusted. */
export function readLastAmount(storage: KeyValueStorage | null, userId: string): Amount | undefined {
  try {
    const raw = storage?.getItem(lastAmountKey(userId));
    if (raw === "free") return null;
    return raw && /^[1-9][0-9]{0,15}$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastAmount(storage: KeyValueStorage | null, userId: string, amount: Amount): void {
  try {
    storage?.setItem(lastAmountKey(userId), amount ?? "free");
  } catch {
    // Remembering is a convenience; the call still goes through.
  }
}

/** Whether `amount` is one the server takes: whole cents, at least the minimum, at most the maximum. */
export function amountProblem(amount: bigint, status: Pick<MoneyStatus, "minBaseUnits" | "maxBaseUnits">): "cents" | "min" | "max" | null {
  if (amount % 10_000n !== 0n) return "cents";
  if (amount < parseUnits(status.minBaseUnits || "1000000")) return "min";
  if (status.maxBaseUnits && amount > parseUnits(status.maxBaseUnits)) return "max";
  return null;
}

/**
 * The amount the row starts on: the last one this viewer used, else the
 * server's default (its own memory of the last amount), else $5. A remembered
 * amount the server no longer takes falls back the same way.
 */
export function defaultAmount(status: MoneyStatus, remembered: Amount | undefined): Amount {
  const fits = (a: string | null | undefined): a is string => !!a && /^[1-9][0-9]{0,15}$/.test(a) && amountProblem(BigInt(a), status) === null;
  if (remembered === null) return null;
  if (fits(remembered)) return remembered;
  if (fits(status.defaultAmountBaseUnits)) return status.defaultAmountBaseUnits;
  return fits(DEFAULT_AMOUNT) ? DEFAULT_AMOUNT : presetAmounts(status).find(fits) ?? null;
}

/** A custom amount someone typed, checked against the server's limits. */
export function customAmount(
  text: string,
  status: Pick<MoneyStatus, "minBaseUnits" | "maxBaseUnits">,
): { ok: true; amount: string } | { ok: false; problem: "format" | "cents" | "min" | "max" } {
  const units = parseUsd(text);
  if (units === null || units <= 0n) return { ok: false, problem: "format" };
  const problem = amountProblem(units, status);
  return problem ? { ok: false, problem } : { ok: true, amount: units.toString() };
}

export function amountHint(problem: "format" | "cents" | "min" | "max", status: Pick<MoneyStatus, "minBaseUnits" | "maxBaseUnits">): string {
  if (problem === "min") return `At least ${usd(status.minBaseUnits)}`;
  if (problem === "max") return `Up to ${usd(status.maxBaseUnits)}`;
  return "Dollars and cents";
}

/** The call's button: `Call YES` / `Call YES · $5`; Tail and Fade for someone's call. */
export function callCta(kind: MoneyCallKind, side: string, amount: Amount): string {
  const verb = kind === "own" ? "Call" : kind === "fade" ? "Fade" : amount ? "Tail" : "Back";
  return amount ? `${verb} ${side} · ${usd(amount)}` : `${verb} ${side}`;
}

/** What the person's balance can pay for right now (null: unknown, so ask the server). */
export function covers(wallet: MoneyWallet | null | undefined, amount: string): boolean | null {
  if (!wallet?.balance) return null;
  return parseUnits(wallet.balance.usdcBaseUnits) >= parseUnits(amount);
}

// ── where a call with money stands ───────────────────────────────────────────

export type CallProgress = "pending" | "funded" | "free" | "expired" | "stuck";

/**
 * Funded only when the BFF says FUNDED (its fill transition wrote FILLED).
 * A PENDING call with an order going through is pending; one whose order
 * failed, or whose quote lapsed, is stuck: the person chooses to try again,
 * keep it free or drop it.
 */
export function progressOf(view: Pick<MoneyCallView, "state" | "trade">): CallProgress {
  if (view.state === "FUNDED") return "funded";
  if (view.state === "FREE") return "free";
  if (view.state === "EXPIRED") return "expired";
  // A fill seen but not yet written FUNDED still reads as going through.
  if (view.trade === "SUBMITTED" || view.trade === "FILLED") return "pending";
  return "stuck";
}

/**
 * The owner's own mark on a call with money intent that isn't funded: never
 * pink. Pending is going through; expired, or replaced by a fresh free call
 * (keep free), never went through.
 */
export function pendingMark(entry: Pick<CallFeedEntry, "money">): { amount: string; state: "pending" | "expired" | "replaced" } | null {
  const m = entry.money;
  if (!m || !/^[1-9][0-9]{0,15}$/.test(m.amountBaseUnits)) return null;
  return { amount: usd(m.amountBaseUnits), state: m.state === "PENDING" ? "pending" : m.state === "FREE" ? "replaced" : "expired" };
}

/** A call counts as funded (the $ stamp, the ordering) only once its confirmed fills reach $1. */
export const FUNDED_MIN_BASE_UNITS = 1_000_000n;

/**
 * "$5 on YES" for a FILLED call whose amount the BFF sends and that reached
 * $1; null otherwise (the plain mark: a dust fill buys no stamp).
 */
export function fundedStamp(entry: Pick<CallFeedEntry, "funding" | "money">, sideName: (side: Side) => string): string | null {
  const f = entry.funding;
  if (!f || entry.money?.state === "PENDING") return null;
  if (f.state !== undefined && f.state !== "FILLED") return null;
  if (!f.amountBaseUnits || !/^[1-9][0-9]{0,15}$/.test(f.amountBaseUnits) || (f.side !== "YES" && f.side !== "NO")) return null;
  if (BigInt(f.amountBaseUnits) < FUNDED_MIN_BASE_UNITS) return null;
  return onSide(f.amountBaseUnits, sideName(f.side));
}

// ── the deposit sheet ────────────────────────────────────────────────────────

export type DepositTile =
  | { id: "send"; address: string; uri: string; ok: boolean }
  | { id: "wallet"; wallets: WalletRef[] }
  | { id: "card"; test: boolean; presetsUsd: string[] };

/** Mainnet USDC: the only token "Send USDC" ever asks for. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** The Solana Pay link the QR encodes, built here from the checked address (never the server's string). */
export const sendUsdcUri = (address: string): string => `solana:${address}?spl-token=${USDC_MINT}`;

/**
 * The deposit sheet's choices, in order: "From your wallet" (one approval)
 * when the account has another wallet and this browser has a wallet that
 * can sign, "Send USDC" (address + QR), and the card only when the server
 * offers it (test money only ever to admins, and always said so).
 *
 * "Send USDC" is `ok` only when its address is the trading wallet (and the
 * one this browser knows independently, when it knows one) and its mint is
 * USDC; otherwise the sheet shows an error, never a QR.
 */
export function depositTiles(options: DepositOptions | null | undefined, browserCanSign: boolean, knownTradingWallet?: string | null): DepositTile[] {
  if (!options) return [];
  const tiles: DepositTile[] = [];
  if (browserCanSign && options.fromWallet.wallets.length) tiles.push({ id: "wallet", wallets: options.fromWallet.wallets });
  const send = options.sendUsdc;
  if (send) {
    const ok =
      isAddress(send.address) &&
      send.mint === USDC_MINT &&
      send.address === options.tradingWallet?.address &&
      (knownTradingWallet == null || send.address === knownTradingWallet);
    tiles.push({ id: "send", address: send.address, uri: ok ? sendUsdcUri(send.address) : "", ok });
  }
  if (options.card.available) tiles.push({ id: "card", test: options.card.testMode, presetsUsd: options.card.presetsUsd });
  return tiles;
}

/**
 * The Solana wallet this browser's own session signed in with: GoTrue's web3
 * identity (`web3:solana:<address>`, and its custom claims when present; if
 * both are there they must agree). Null for an X or Google session.
 */
export function sessionWallet(identities: unknown): string | null {
  if (!Array.isArray(identities)) return null;
  for (const raw of identities) {
    if (!raw || typeof raw !== "object") continue;
    const identity = raw as Record<string, unknown>;
    if (identity.provider !== "web3") continue;
    const data = (identity.identity_data ?? {}) as Record<string, unknown>;
    const claims = (data.custom_claims ?? {}) as Record<string, unknown>;
    const providerId = typeof data.sub === "string" ? data.sub : typeof identity.id === "string" ? identity.id : undefined;
    const fromId = providerId?.startsWith("web3:solana:") ? providerId.slice("web3:solana:".length) : undefined;
    const fromClaims = claims.chain === "solana" && typeof claims.address === "string" ? claims.address : undefined;
    if (fromId && fromClaims && fromId !== fromClaims) continue;
    const address = fromId ?? fromClaims;
    if (address && isAddress(address)) return address;
  }
  return null;
}

/**
 * The trading wallet a deposit may go to, as this browser knows it on its
 * own. With the Chumbucket wallet on, its own address. Otherwise money.wallet's
 * answer only when it is one of this browser's own wallets (the wallet the
 * session signed in with, a wallet connected here, or the account's own
 * wallet); anything else is refused, and an answer still missing waits.
 */
export function knownTradingWallet(input: {
  chumbucket: { enabled: boolean; address: string | null };
  moneyWallet: string | null | undefined;
  ownWallets: readonly string[];
  /** The browser's own wallets have all been read (session, profile). */
  ownKnown: boolean;
}): { state: "known"; address: string } | { state: "waiting" } | { state: "refused" } {
  if (input.chumbucket.enabled) return input.chumbucket.address ? { state: "known", address: input.chumbucket.address } : { state: "waiting" };
  const candidate = input.moneyWallet ?? null;
  if (!candidate) return { state: "waiting" };
  if (input.ownWallets.includes(candidate)) return { state: "known", address: candidate };
  return input.ownKnown ? { state: "refused" } : { state: "waiting" };
}

/** The funds a call waited for have landed: the balance now covers what it needs. */
export function fundsLanded(wallet: MoneyWallet | null | undefined, neededBaseUnits: string): boolean {
  return !!wallet?.balance && parseUnits(wallet.balance.usdcBaseUnits) >= parseUnits(neededBaseUnits) && parseUnits(neededBaseUnits) > 0n;
}

/** Any new USDC since the sheet opened (the "Send USDC" watch with no call waiting). */
export function balanceRose(before: string | null | undefined, wallet: MoneyWallet | null | undefined): boolean {
  return !!wallet?.balance && before != null && parseUnits(wallet.balance.usdcBaseUnits) > parseUnits(before);
}

// ── the wallet sheet ─────────────────────────────────────────────────────────

/**
 * The cash-out form, before anything is asked of the server: a wallet
 * address that is not your own, and an amount within your balance. `max`
 * sends the whole balance to the last base unit.
 */
export function cashOutForm(
  input: { address: string; amount: string; max: boolean },
  wallet: MoneyWallet | null | undefined,
): { ok: true; destination: string; amountBaseUnits: string } | { ok: false; field: "address" | "amount"; line: string | null } {
  const destination = input.address.trim();
  const balance = parseUnits(wallet?.balance?.usdcBaseUnits);
  if (!destination) return { ok: false, field: "address", line: null };
  if (!isAddress(destination)) return { ok: false, field: "address", line: "That isn’t a Solana address" };
  if (wallet?.wallet && destination === wallet.wallet.address) return { ok: false, field: "address", line: "That’s this wallet" };
  if (input.max) {
    return balance > 0n ? { ok: true, destination, amountBaseUnits: balance.toString() } : { ok: false, field: "amount", line: "Nothing to cash out" };
  }
  if (!input.amount.trim()) return { ok: false, field: "amount", line: null };
  const units = parseUsd(input.amount);
  if (units === null || units <= 0n) return { ok: false, field: "amount", line: "Dollars and cents" };
  if (units > balance) return { ok: false, field: "amount", line: `You have ${balanceUsd(balance)}` };
  return { ok: true, destination, amountBaseUnits: units.toString() };
}

/** One activity row: its icon, its sign, and the line it reads as. */
export function activityRow(item: ActivityItem): { icon: string; amount: string; tone: "in" | "out" | "muted"; title: string } {
  const icon =
    item.state === "failed"
      ? "cancel"
      : item.state === "pending"
        ? "sand-watch"
        : item.kind === "trade"
          ? "chart-pie"
          : item.kind === "claim"
            ? "award"
            : item.kind === "deposit"
              ? "arrow-down"
              : "arrow-up";
  const sign = item.direction === "in" ? "+" : "−";
  const title =
    item.question ??
    (item.kind === "deposit" ? "Added" : item.kind === "cash_out" ? "Cashed out" : item.kind === "claim" ? "Collected" : "Call");
  return { icon, amount: `${sign}${usd(item.amountBaseUnits)}`, tone: item.state === "failed" ? "muted" : item.direction, title };
}

/** Public chain data only: the explorer page for a signature. */
export const explorerTx = (signature: string): string => `https://solscan.io/tx/${encodeURIComponent(signature)}`;

/** Total of the winnings still to collect (COLLECTABLE items only), as the server sums it. */
export function collectable(w: Winnings | null | undefined): WinningsItem[] {
  return (w?.items ?? []).filter((i) => i.state === "COLLECTABLE");
}
