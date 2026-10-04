/**
 * A call with an amount: one flow for your own call and for Tail/Fade on
 * someone else's (docs/money-api.md §a).
 *
 *   prepareCall  gas, then funds, checked before anything exists; then the
 *                intent is written durably (PENDING) BEFORE the call is
 *                locked, so the call is owner-only from its first instant;
 *                then Panta quotes the buy for the account's own wallet
 *   (the app signs and submits through pantaTrading.submit, unchanged)
 *   FUNDED       only through the fill transition: PantaTradingService's
 *                onFilled (FILLED = Panta confirmed + RPC-proven USDC debit),
 *                or the sweeper reading the same FILLED ledger row. The SQL
 *                guard refuses FUNDED without a FILLED trade.
 *   retry        a fresh quote for the same pending call
 *   keepFree     the owner goes free instead: the pending call is withdrawn
 *                and a fresh free call is made at the current price and time
 *                through the ordinary free path (never the old locked price)
 *   discard      the owner drops it: withdrawn, never shown
 *   sweep        FUNDED repair, and EXPIRED for anything abandoned
 *
 * Nothing here ever marks a call funded on its own say-so, and nothing reads
 * a client's claim about money.
 */
import { createHash } from "node:crypto";
import type { CallsService, FundedCallInput, FundedCallPlan } from "../calls/CallsService.ts";
import type { CallsStore } from "../calls/store.ts";
import type { CallFeedEntry, CallVisibility } from "../calls/types.ts";
import type { DepositPerson, DepositWallet } from "../deposits/accounts.ts";
import type { PantaPreparedOrder } from "../prediction/PantaExecution.ts";
import type { PantaPrepareSession, PantaTradingService } from "../prediction/PantaTradingService.ts";
import type { PantaTradeSession, PantaTradingLedger } from "../prediction/PantaTradingStore.ts";
import type { VenueOrder } from "../prediction/PredictionVenue.ts";
import type { Side } from "../prediction/types.ts";
import { chooseTradingWallet } from "../wallet/tradingWallet.ts";
import { MoneyError } from "./errors.ts";
import type { GasPort } from "./gas.ts";
import type { MoneyCallEnd, MoneyCallRow, MoneyCallStore } from "./store.ts";
import type { MoneyCallIndex } from "./visibility.ts";

/** A pending call's life after its latest quote. */
export const PENDING_TTL_MS = 10 * 60_000;
/** No pending call lives longer than this. */
export const PENDING_MAX_MS = 30 * 60_000;
/** A signature can land until its quote expires; the call outlives it by this. */
const QUOTE_GRACE_MS = 60_000;
/** Panta's longest quote (PantaExecution MAX_SESSION_MS). */
const MAX_QUOTE_MS = 300_000;
/** An intent whose call never appeared is given up after this. */
const NOT_CREATED_GRACE_MS = 2 * 60_000;
export const MONEY_MIN_BASE_UNITS = 1_000_000n;
export const MONEY_PRESETS_BASE_UNITS = ["5000000", "10000000", "25000000"] as const;
export const MONEY_DEFAULT_BASE_UNITS = "5000000";
const CENT = 10_000n;

export type TradeState = "NONE" | "QUOTED" | "SUBMITTED" | "FILLED" | "FAILED";
export interface WalletRef { address: string; walletType: string }

export interface MoneyCallView {
  callId: string;
  kind: "own" | "back" | "fade";
  targetCallId: string | null;
  marketId: string;
  side: Side;
  amountBaseUnits: string;
  wallet: string;
  state: MoneyCallRow["state"];
  trade: TradeState;
  orderId: string | null;
  filledBaseUnits: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  canRetry: boolean;
  canKeepFree: boolean;
  canDiscard: boolean;
}

export type NeedsFunds = { status: "NEEDS_FUNDS"; wallet: WalletRef; balanceBaseUnits: string; neededBaseUnits: string; shortfallBaseUnits: string };
export type NeedsGas = { status: "NEEDS_GAS"; wallet: WalletRef; topUp: { amountBaseUnits: string } | null };
export type Ready = { status: "READY"; moneyCall: MoneyCallView; call: CallFeedEntry; trade: { order: PantaPreparedOrder["order"]; review: PantaPreparedOrder["review"] } };
export type Settled = { status: "SETTLED"; moneyCall: MoneyCallView; call: CallFeedEntry };
export type QuoteResult = NeedsFunds | NeedsGas | Ready;
export type PrepareCallResult = QuoteResult | Settled;

export interface PrepareCallInput {
  call: FundedCallInput;
  amountBaseUnits: string;
  idempotencyKey: string;
  wallet?: string | undefined;
  confidence: number | null;
  thesis: string | null;
  visibility: CallVisibility;
  maxSlippageBps: number;
}

export interface BalancePort {
  read(wallet: string): Promise<{ usdcBaseUnits: string; lamports: string }>;
}

export interface MoneyCallsDeps {
  store: MoneyCallStore;
  index: MoneyCallIndex;
  calls: {
    service: Pick<CallsService, "planFundedCall" | "lockFundedCall" | "publishFundedCall" | "withdrawFundedCall" |
      "restoreFundedCall" | "takesCalls" | "getCall" | "assertFreeReplacement" | "replaceFundedCallWithFree" | "priceReadable">;
    store: Pick<CallsStore, "getCall" | "liveCallByUserOnMarket">;
    /** Every queued call write is durable (or this throws). */
    flush(): Promise<void>;
  };
  /** Panta trading. `forRead` keeps reads working while new approvals are paused; throws when not configured. */
  trading(forRead: boolean): Pick<PantaTradingService, "prepare" | "reconcile" | "view">;
  /** The private trade ledger; null when Panta is not configured. `update` retires an unsigned quote. */
  ledger(): Pick<PantaTradingLedger, "find" | "latestForCall" | "update"> | null;
  balances: BalancePort | null;
  gas: GasPort;
  /** The per-approval USDC ceiling (PANTA_MAX_AMOUNT_BASE_UNITS). */
  maxBaseUnits: bigint | null;
  /** CHUMBUCKET_WALLET_ENABLED: the Chumbucket wallet is the trading wallet. */
  chumbucketWallet: boolean;
  /** Whether our trade path can buy on this market (a USDC-quoted Panta market). Absent: every market. */
  tradable?: (marketId: string) => boolean;
  now?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const tradeKey = (row: MoneyCallRow) => `${row.idempotency_key}.t${row.attempts}`;

/** "$5", "$5.25": copy only. Amounts stay base-unit strings everywhere else. */
export function dollars(baseUnits: string | bigint): string {
  const v = BigInt(baseUnits);
  const cents = (v + 5_000n) / CENT;
  const whole = cents / 100n, rest = cents % 100n;
  return rest === 0n ? `$${whole}` : `$${whole}.${rest.toString().padStart(2, "0")}`;
}

export class MoneyCallsService {
  constructor(private readonly deps: MoneyCallsDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }

  // ── prepare ────────────────────────────────────────────────────────────────

  async prepareCall(person: DepositPerson, input: PrepareCallInput): Promise<PrepareCallResult> {
    const amount = this.amount(input.amountBaseUnits);
    const fingerprint = createHash("sha256").update(JSON.stringify(["money-call", input.call, input.amountBaseUnits,
      input.wallet ?? null, input.confidence, input.thesis, input.visibility, input.maxSlippageBps])).digest("hex");
    const existing = await this.deps.store.byKey(person.userId, input.idempotencyKey);
    if (existing) return this.replay(person, existing, fingerprint, input);

    const wallet = this.wallet(person, input.wallet);
    const plan = this.deps.calls.service.planFundedCall(input.call, person.userId);
    // A SOL-quoted market takes calls, never trades: refused before anything exists.
    if (this.deps.tradable && !this.deps.tradable(plan.marketId)) {
      throw new MoneyError("NOT_TRADABLE", "This market takes free calls only.");
    }
    // Panta must be taking approvals before a call exists that would wait on one.
    this.deps.trading(false);
    const blocked = await this.readiness(person, wallet, amount);
    if (blocked) return blocked;

    const now = this.now();
    const row = await this.deps.store.insert({
      call_id: plan.callId, user_id: person.userId, market_id: plan.marketId, side: plan.side, kind: plan.kind,
      target_call_id: plan.targetCallId, amount_base_units: amount.toString(), max_slippage_bps: input.maxSlippageBps,
      wallet_address: wallet.address, idempotency_key: input.idempotencyKey, request_fingerprint: fingerprint,
      expires_at: iso(now + PENDING_TTL_MS), created_at: iso(now),
    });
    if (!row) {
      const raced = await this.deps.store.byKey(person.userId, input.idempotencyKey);
      if (!raced) throw new MoneyError("UNAVAILABLE", "We couldn't save this call just now. Nothing was charged. Try again.");
      return this.replay(person, raced, fingerprint, input);
    }
    // Private BEFORE it exists: the call is never public for an instant.
    this.deps.index.put(row);
    const entry = await this.lock(row, plan, input);
    return this.quote(person, row, undefined, entry);
  }

  private async replay(person: DepositPerson, row: MoneyCallRow, fingerprint: string, input: PrepareCallInput): Promise<PrepareCallResult> {
    if (row.request_fingerprint !== fingerprint) {
      throw new MoneyError("IDEMPOTENCY_CONFLICT", "This tap was already used for a different call. Try again.");
    }
    if (row.state === "PENDING" && (await this.latest(row))?.state === "FILLED") row = await this.markFunded(row);
    if (row.state !== "PENDING") {
      return { status: "SETTLED", moneyCall: await this.describe(row), call: this.entry(row) };
    }
    // The intent was saved but the reply (or the call) was lost: finish it.
    let entry: CallFeedEntry | undefined;
    if (!this.deps.calls.store.getCall(row.call_id)) {
      entry = await this.lock(row, { callId: row.call_id, kind: row.kind, marketId: row.market_id, side: row.side, targetCallId: row.target_call_id }, input);
    }
    return this.quote(person, row, input.wallet, entry);
  }

  /** Lock the call under its recorded id; a call that cannot be locked leaves an expired intent, never a ghost. */
  private async lock(row: MoneyCallRow, plan: FundedCallPlan, input: PrepareCallInput): Promise<CallFeedEntry> {
    try {
      const entry = this.deps.calls.service.lockFundedCall(plan,
        { confidence: input.confidence, thesis: input.thesis, visibility: input.visibility }, row.user_id);
      // The trade ledger references the persisted call, never a ghost.
      await this.deps.calls.flush();
      return entry;
    } catch (error) {
      await this.end(row, "not_created").catch(() => undefined);
      throw error;
    }
  }

  // ── retry ──────────────────────────────────────────────────────────────────

  async retry(person: DepositPerson, callId: string, walletHint?: string): Promise<QuoteResult> {
    const row = await this.own(person.userId, callId);
    if (row.state !== "PENDING") throw new MoneyError("STATE", this.stateCopy(row));
    return this.quote(person, row, walletHint);
  }

  /**
   * The live quote for a PENDING call, or a fresh one (a new attempt): never a
   * second buy while one is going through, and never past the call's life.
   */
  private async quote(person: DepositPerson, row: MoneyCallRow, walletHint?: string, entry?: CallFeedEntry): Promise<QuoteResult> {
    const ledger = this.deps.ledger();
    const latest = ledger ? await ledger.latestForCall(person.userId, row.call_id) : null;
    if (latest?.state === "FILLED") {
      await this.markFunded(row);
      throw new MoneyError("STATE", "This call is already funded.");
    }
    if (latest?.state === "SUBMITTED") throw new MoneyError("IN_FLIGHT", this.inFlightCopy(row));
    await this.assertAlive(row);
    const wallet = walletHint ? this.wallet(person, walletHint) : this.recordedWallet(person, row);
    const current = ledger ? await ledger.find(person.userId, tradeKey(row)) : null;
    const now = this.now();
    const call = entry ?? this.entry(row);
    if (current?.state === "PREPARING") throw new MoneyError("IN_FLIGHT", "Your quote is on its way. Try again in a moment.");
    if (current?.state === "QUOTED" && current.prepared && current.wallet_address === wallet.address &&
        current.prepared.order.expiresAt > now + 5_000) {
      // A dropped reply: the same quote, never a second build.
      return { status: "READY", moneyCall: this.viewOf(row, latest, current), call,
        trade: { order: current.prepared.order, review: current.prepared.review } };
    }
    if (!this.deps.calls.service.takesCalls(row.market_id)) {
      throw new MoneyError("MARKET_CLOSED", "This market stopped taking calls, so this call can't be funded.");
    }
    const created = Date.parse(row.created_at);
    if (now + MAX_QUOTE_MS + QUOTE_GRACE_MS > created + PENDING_MAX_MS) {
      throw new MoneyError("EXPIRED", "This call timed out. Make it again.");
    }
    const blocked = await this.readiness(person, wallet, BigInt(row.amount_base_units));
    if (blocked) return blocked;

    let next = row;
    if (current || wallet.address !== row.wallet_address) {
      // Only the newest attempt's quote can ever be signed.
      await this.retireQuote(row);
      const bumped = await this.deps.store.update(row.call_id, { state: "PENDING", attempts: row.attempts },
        { attempts: row.attempts + 1, wallet_address: wallet.address });
      if (!bumped) throw new MoneyError("STATE", "This call just changed. Check it again.");
      next = bumped;
      this.deps.index.put(next);
    }
    const prepared = await this.deps.trading(false).prepare(person.userId, {
      callId: next.call_id, wallet: wallet.address, amountBaseUnits: next.amount_base_units,
      idempotencyKey: tradeKey(next), maxSlippageBps: next.max_slippage_bps,
    }, this.session(person));
    const expires = Math.min(created + PENDING_MAX_MS, Math.max(now + PENDING_TTL_MS, prepared.order.expiresAt + QUOTE_GRACE_MS));
    if (expires > Date.parse(next.expires_at)) {
      const extended = await this.deps.store.update(next.call_id, { state: "PENDING", attempts: next.attempts }, { expires_at: iso(expires) });
      if (extended) { next = extended; this.deps.index.put(next); }
    }
    const quoted = { state: "QUOTED", provider_order_id: prepared.order.orderId } as Pick<PantaTradeSession, "state" | "provider_order_id">;
    return { status: "READY", moneyCall: this.viewOf(next, latest, quoted), call, trade: prepared };
  }

  // ── the owner's choices ────────────────────────────────────────────────────

  /**
   * Go free instead. The pending money call is withdrawn (it stays off every
   * record) and a FRESH free call is made at the current price and time,
   * through the ordinary free path and its checks; that new call is returned.
   * Market closed or no readable price: refused, and the pending call is left
   * as it was, to be discarded or to expire. Never while a buy is going
   * through; the live unsigned quote is retired first, so it can't be signed
   * after the call went free.
   */
  async keepFree(userId: string, callId: string): Promise<{ moneyCall: MoneyCallView; call: CallFeedEntry }> {
    let row = await this.own(userId, callId);
    if (row.state === "FREE") {
      // A dropped reply: the free call made for it is the person's live call on that market.
      const live = this.deps.calls.store.liveCallByUserOnMarket(userId, row.market_id);
      if (live) return { moneyCall: await this.describe(row), call: this.deps.calls.service.getCall({ callId: live.id }, userId).entry };
    }
    if (row.state !== "PENDING") throw new MoneyError("STATE", this.stateCopy(row));
    const latest = await this.latest(row);
    if (latest?.state === "FILLED") {
      row = await this.markFunded(row);
      return { moneyCall: await this.describe(row), call: this.entry(row) };
    }
    if (latest?.state === "SUBMITTED") throw new MoneyError("IN_FLIGHT", this.inFlightCopy(row));
    await this.assertAlive(row);
    const calls = this.deps.calls.service;
    if (!calls.takesCalls(row.market_id)) {
      throw new MoneyError("MARKET_CLOSED", "This market stopped taking calls, so there's no free call to make.");
    }
    if (!calls.priceReadable(row.market_id)) {
      throw new MoneyError("PRICE_UNAVAILABLE", "This market's price isn't available right now. Try again in a minute.");
    }
    calls.assertFreeReplacement(callId, userId);
    await this.retireQuote(row);
    // Calls first, ledger second: a crash in between leaves a withdrawn call
    // with a PENDING row the sweeper expires, never a live private call.
    const entry = calls.replaceFundedCallWithFree(callId, userId);
    await this.deps.calls.flush();
    const saved = await this.deps.store.update(callId, { state: "PENDING", attempts: row.attempts }, { state: "FREE", ended_reason: "kept_free" });
    row = saved ?? (await this.deps.store.byCall(userId, callId)) ?? row;
    this.deps.index.put(row);
    return { moneyCall: await this.describe(row), call: entry };
  }

  async discard(userId: string, callId: string): Promise<{ moneyCall: MoneyCallView }> {
    let row = await this.own(userId, callId);
    if (row.state === "PENDING") {
      const latest = await this.latest(row);
      if (latest?.state === "FILLED") row = await this.markFunded(row);
      else {
        if (latest?.state === "SUBMITTED") throw new MoneyError("IN_FLIGHT", this.inFlightCopy(row));
        await this.retireQuote(row);
        row = await this.end(row, "discarded");
      }
    } else if (row.state !== "EXPIRED") throw new MoneyError("STATE", this.stateCopy(row));
    return { moneyCall: await this.describe(row) };
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** The owner's money call, its SUBMITTED order re-checked first (the shared fill transition). */
  async status(userId: string, callId: string): Promise<{ moneyCall: MoneyCallView; order: VenueOrder | null }> {
    let row = await this.own(userId, callId);
    const ledger = this.deps.ledger();
    let latest = ledger ? await ledger.latestForCall(userId, callId) : null;
    if (latest?.state === "SUBMITTED") {
      try { latest = await this.deps.trading(true).reconcile(latest); }
      catch { /* still pending: the answer says SUBMITTED, the reconciler keeps checking */ }
    }
    if (latest?.state === "FILLED" && row.state !== "FUNDED") row = await this.markFunded(row);
    const current = ledger ? await ledger.find(userId, tradeKey(row)) : null;
    const shown = latest && (latest.state === "SUBMITTED" || latest.state === "FILLED") ? latest
      : current?.prepared ? current : latest;
    let order: VenueOrder | null = null;
    if (shown?.prepared) {
      try { order = this.deps.trading(true).view(shown); } catch { order = null; }
    }
    return { moneyCall: this.viewOf(row, latest, current), order };
  }

  async pending(userId: string): Promise<{ calls: Array<{ moneyCall: MoneyCallView; call: CallFeedEntry }> }> {
    const rows = await this.deps.store.pendingForUser(userId, 20);
    const out: Array<{ moneyCall: MoneyCallView; call: CallFeedEntry }> = [];
    for (const row of rows) {
      if (!this.deps.calls.store.getCall(row.call_id)) continue;
      out.push({ moneyCall: await this.describe(row), call: this.entry(row) });
    }
    return { calls: out };
  }

  async defaultAmount(userId: string): Promise<string> {
    return (await this.deps.store.lastAmount(userId)) ?? MONEY_DEFAULT_BASE_UNITS;
  }

  // ── the fill transition and the sweeper ────────────────────────────────────

  /** A confirmed fill (PantaTradingService.onFilled, after FILLED is durable). */
  async onFilled(trade: PantaTradeSession): Promise<void> {
    if (trade.state !== "FILLED") return;
    const row = this.deps.index.get(trade.call_id) ?? await this.deps.store.byCall(trade.user_id, trade.call_id);
    if (row && row.state !== "FUNDED") await this.markFunded(row);
  }

  /**
   * One pass: FUNDED for every pending call whose order filled; EXPIRED for
   * every one past its time, on a market that stopped taking calls, or whose
   * call never appeared, with nothing going through. Never expires a call
   * with a SUBMITTED or FILLED order (the SQL guard refuses it too).
   */
  async sweep(): Promise<{ funded: number; expired: number; errors: string[] }> {
    const report = { funded: 0, expired: 0, errors: [] as string[] };
    const ledger = this.deps.ledger();
    const now = this.now();
    for (const row of this.deps.index.pending()) {
      try {
        const latest = ledger ? await ledger.latestForCall(row.user_id, row.call_id) : null;
        if (latest?.state === "FILLED") { await this.markFunded(row); report.funded++; continue; }
        if (latest?.state === "SUBMITTED") continue;
        const exists = this.deps.calls.store.getCall(row.call_id) !== undefined;
        let reason: MoneyCallEnd | null = null;
        if (!exists) { if (now - Date.parse(row.created_at) > NOT_CREATED_GRACE_MS) reason = "not_created"; }
        else if (!this.deps.calls.service.takesCalls(row.market_id)) reason = "market_closed";
        else if (now >= Date.parse(row.expires_at)) reason = "expired";
        if (reason) { await this.retireQuote(row); await this.end(row, reason); report.expired++; }
      } catch (error) {
        report.errors.push(error instanceof MoneyError ? error.code : "MONEY_SWEEP_FAILED");
      }
    }
    return report;
  }

  private async markFunded(row: MoneyCallRow): Promise<MoneyCallRow> {
    if (row.state === "FUNDED") return row;
    const saved = await this.deps.store.update(row.call_id, { state: row.state, attempts: row.attempts }, { state: "FUNDED", ended_reason: "filled" });
    const next = saved ?? (await this.deps.store.byCall(row.user_id, row.call_id)) ?? row;
    this.deps.index.put(next);
    if (next.state === "FUNDED") {
      if (row.state === "EXPIRED") this.deps.calls.service.restoreFundedCall(row.call_id);
      this.deps.calls.service.publishFundedCall(row.call_id);
      await this.deps.calls.flush();
    }
    return next;
  }

  private async end(row: MoneyCallRow, reason: Exclude<MoneyCallEnd, "filled" | "kept_free">): Promise<MoneyCallRow> {
    const saved = await this.deps.store.update(row.call_id, { state: "PENDING", attempts: row.attempts }, { state: "EXPIRED", ended_reason: reason });
    if (!saved) {
      const fresh = await this.deps.store.byCall(row.user_id, row.call_id);
      if (fresh) this.deps.index.put(fresh);
      if (fresh?.state === "EXPIRED") return fresh;
      throw new MoneyError("STATE", "This call just changed. Check it again.");
    }
    this.deps.index.put(saved);
    if (this.deps.calls.store.getCall(row.call_id)) {
      this.deps.calls.service.withdrawFundedCall(row.call_id);
      await this.deps.calls.flush();
    }
    return saved;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * The current attempt's unsigned quote can no longer be signed: QUOTED (or
   * still PREPARING) becomes FAILED, the trade ledger's own allowed move. If
   * a signature got there first, that buy is going through and nothing ends.
   */
  private async retireQuote(row: MoneyCallRow): Promise<void> {
    const ledger = this.deps.ledger();
    if (!ledger) return;
    const current = await ledger.find(row.user_id, tradeKey(row));
    if (!current || (current.state !== "QUOTED" && current.state !== "PREPARING")) return;
    if (await ledger.update(current.id, current.state, { state: "FAILED" })) return;
    const now = await ledger.find(row.user_id, tradeKey(row));
    if (now?.state === "SUBMITTED" || now?.state === "FILLED") throw new MoneyError("IN_FLIGHT", this.inFlightCopy(row));
  }

  /**
   * A pending call past its time is over even before the sweeper gets to it:
   * it is expired now (nothing is going through, checked by the caller) and
   * no choice is offered.
   */
  private async assertAlive(row: MoneyCallRow): Promise<void> {
    if (this.now() < Date.parse(row.expires_at)) return;
    await this.end(row, "expired").catch(() => undefined);
    throw new MoneyError("EXPIRED", "This call wasn't finished in time. Make it again.");
  }

  private amount(value: string): bigint {
    if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new MoneyError("AMOUNT", "Choose an amount in dollars.");
    const amount = BigInt(value);
    const max = this.deps.maxBaseUnits;
    if (amount % CENT !== 0n || amount < MONEY_MIN_BASE_UNITS || (max !== null && amount > max)) {
      throw new MoneyError("AMOUNT", max !== null ? `Choose from $1 to ${dollars(max)}.` : "Choose $1 or more.");
    }
    return amount;
  }

  /** One of the account's own proven wallets: the one named, or the trading wallet. */
  private wallet(person: DepositPerson, hint?: string): DepositWallet {
    if (hint) {
      const named = person.wallets.find(w => w.address === hint);
      if (!named) throw new MoneyError("WALLET_NOT_LINKED", "Link this wallet to your account first");
      return named;
    }
    const chosen = chooseTradingWallet(person, this.deps.chumbucketWallet);
    if (!chosen) throw new MoneyError("NO_WALLET", "Set up your wallet first.");
    return chosen;
  }

  /** The wallet this call was quoted for, still the account's own. */
  private recordedWallet(person: DepositPerson, row: MoneyCallRow): DepositWallet {
    const held = person.wallets.find(w => w.address === row.wallet_address);
    if (!held) throw new MoneyError("WALLET_NOT_LINKED", "Link this wallet to your account first");
    return held;
  }

  private session(person: DepositPerson): PantaPrepareSession {
    return { signInWallet: person.wallets.find(w => w.session)?.address ?? null };
  }

  /** Gas, then funds. Nothing is written for either answer. */
  private async readiness(person: DepositPerson, wallet: DepositWallet, amount: bigint): Promise<NeedsFunds | NeedsGas | null> {
    if (!this.deps.balances) throw new MoneyError("UNAVAILABLE", "Balances aren't available on this server.");
    let balance: { usdcBaseUnits: string; lamports: string };
    try { balance = await this.deps.balances.read(wallet.address); }
    catch { throw new MoneyError("UNAVAILABLE", "We couldn't read your balance just now. Nothing was charged. Try again in a moment."); }
    const gas = await this.deps.gas.forTrade(person, wallet.address, BigInt(balance.lamports));
    const topUp = gas.needsSol && gas.topUp ? BigInt(gas.topUp.amountBaseUnits) : 0n;
    const usdc = BigInt(balance.usdcBaseUnits);
    const needed = amount + topUp;
    const ref = { address: wallet.address, walletType: wallet.walletType };
    if (usdc < needed) {
      return { status: "NEEDS_FUNDS", wallet: ref, balanceBaseUnits: usdc.toString(), neededBaseUnits: needed.toString(),
        shortfallBaseUnits: (needed - usdc).toString() };
    }
    if (gas.needsSol) return { status: "NEEDS_GAS", wallet: ref, topUp: gas.topUp };
    return null;
  }

  private async own(userId: string, callId: string): Promise<MoneyCallRow> {
    const row = await this.deps.store.byCall(userId, callId);
    if (!row) throw new MoneyError("NOT_FOUND", "We couldn't find that call.");
    return row;
  }

  private async latest(row: MoneyCallRow): Promise<PantaTradeSession | null> {
    const ledger = this.deps.ledger();
    return ledger ? ledger.latestForCall(row.user_id, row.call_id) : null;
  }

  private entry(row: MoneyCallRow): CallFeedEntry {
    try { return this.deps.calls.service.getCall({ callId: row.call_id }, row.user_id).entry; }
    catch { throw new MoneyError("NOT_FOUND", "We couldn't find that call."); }
  }

  private async describe(row: MoneyCallRow): Promise<MoneyCallView> {
    const ledger = this.deps.ledger();
    const latest = ledger ? await ledger.latestForCall(row.user_id, row.call_id) : null;
    const current = ledger ? await ledger.find(row.user_id, tradeKey(row)) : null;
    return this.viewOf(row, latest, current);
  }

  private viewOf(row: MoneyCallRow, latest: Pick<PantaTradeSession, "state" | "provider_order_id" | "amount_base_units"> | null,
    current: Pick<PantaTradeSession, "state" | "provider_order_id"> | null): MoneyCallView {
    // A buy going through or done outranks a newer unsigned quote.
    const shown = latest && (latest.state === "SUBMITTED" || latest.state === "FILLED") ? latest
      : current && current.state !== "PREPARING" ? current : latest;
    const trade: TradeState = !shown || shown.state === "PREPARING" ? "NONE" : shown.state;
    const inFlight = trade === "SUBMITTED";
    const pending = row.state === "PENDING" && this.now() < Date.parse(row.expires_at);
    const takes = pending && this.deps.calls.service.takesCalls(row.market_id);
    return {
      callId: row.call_id, kind: row.kind, targetCallId: row.target_call_id, marketId: row.market_id, side: row.side,
      amountBaseUnits: row.amount_base_units, wallet: row.wallet_address, state: row.state, trade,
      orderId: shown?.provider_order_id ?? null,
      filledBaseUnits: row.state === "FUNDED" && latest?.state === "FILLED" && "amount_base_units" in latest
        ? String(latest.amount_base_units) : null,
      createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at), expiresAt: Date.parse(row.expires_at),
      canRetry: pending && !inFlight, canKeepFree: pending && !inFlight && takes, canDiscard: pending && !inFlight,
    };
  }

  private inFlightCopy(row: MoneyCallRow): string {
    return `Your ${dollars(row.amount_base_units)} is still going through. Check back in a moment.`;
  }

  private stateCopy(row: MoneyCallRow): string {
    switch (row.state) {
      case "FUNDED": return "This call is already funded.";
      case "FREE": return "You went free on this one; your free call is the one on record.";
      case "EXPIRED": return "This call wasn't finished in time. Make it again.";
      case "PENDING": return "This call is still waiting for its money.";
    }
  }
}
