/**
 * Shared rig for money calls (docs/money-api.md §a). Synthetic rows only: no
 * network, no keys, no venue. The Panta side is a ledger whose rows move only
 * when a test says the venue and chain did (submit / fill / fail), so a test
 * can prove nothing on the money side runs ahead of it.
 */
import { CallsService } from "../src/calls/CallsService.ts";
import type { Person } from "../src/calls/types.ts";
import type { DepositPerson } from "../src/deposits/accounts.ts";
import { MoneyCallsService, type BalancePort } from "../src/money/MoneyCallsService.ts";
import type { GasAnswer, GasPort } from "../src/money/gas.ts";
import { InMemoryMoneyCallStore } from "../src/money/store.ts";
import { MoneyCallIndex } from "../src/money/visibility.ts";
import { VenueError } from "../src/prediction/errors.ts";
import { PantaFundingIndex } from "../src/prediction/PantaFunding.ts";
import type { PantaPrepareInput } from "../src/prediction/PantaTradingService.ts";
import type { PantaTradeSession } from "../src/prediction/PantaTradingStore.ts";
import type { VenueOrder } from "../src/prediction/PredictionVenue.ts";
import type { VenueMarket } from "../src/prediction/types.ts";
import { harness, market, person, T0 } from "./socialCallsFixtures.ts";

export const HOUR = 3_600_000;
export const MIN = 60_000;
export const W = {
  ann: "AnnWa11et1111111111111111111111111111111111",
  bob: "BobWa11et1111111111111111111111111111111111",
  cy: "CyWa11et11111111111111111111111111111111111",
  annPhantom: "AnnPhantomWa11et111111111111111111111111111",
};

export function depositPerson(id: keyof typeof W & ("ann" | "bob" | "cy"), extra: string[] = []): DepositPerson {
  return {
    userId: id, authUserId: id, email: null,
    wallets: [{ address: W[id], walletType: "chumbucket", primary: true, session: false },
      ...extra.map(address => ({ address, walletType: "mwa", primary: false, session: false }))],
  };
}

/** The trade ledger and the venue, moved only by the test. */
export class FakePanta {
  rows: PantaTradeSession[] = [];
  prepares: PantaPrepareInput[] = [];
  private orders = 0;
  down = false;
  onFilled: ((row: PantaTradeSession) => void) | null = null;
  constructor(private readonly now: () => number, private readonly sideOf: (callId: string) => "YES" | "NO") {}

  async prepare(userId: string, input: PantaPrepareInput) {
    this.prepares.push(input);
    if (this.down) throw new VenueError("VENUE_UNAVAILABLE", "Panta is unavailable", { venue: "panta" });
    const replay = await this.find(userId, input.idempotencyKey);
    if (replay?.state === "QUOTED" && replay.prepared) return { order: replay.prepared.order, review: replay.prepared.review };
    if (this.rows.some(r => r.user_id === userId && r.call_id === input.callId && r.wallet_address === input.wallet && ["SUBMITTED", "FILLED"].includes(r.state))) {
      throw new VenueError("VENUE_BAD_REQUEST", "This call already has a submitted or filled Panta order", { venue: "panta" });
    }
    const orderId = `ord_${++this.orders}`;
    const at = new Date(this.now()).toISOString();
    const order = { orderId, venue: "panta" as const, venueMarketId: "vm", owner: input.wallet, side: this.sideOf(input.callId),
      amountBaseUnits: input.amountBaseUnits, quotedProbability: null, fundingState: "QUOTED" as const,
      transaction: { venue: "panta" as const, encoding: "solana-tx-base64" as const, payload: "AAAA", expiresAt: this.now() + MIN, demo: false },
      idempotencyKey: input.idempotencyKey, createdAt: this.now(), expiresAt: this.now() + MIN, demo: false };
    const review = { amountUsdc: "1", amountBaseUnits: input.amountBaseUnits, avgPrice: "0.5", feeUsdc: "0.01", expectedShares: "1.9" };
    this.rows.push({
      id: `trade_${this.orders}`, user_id: userId, call_id: input.callId, market_id: "m", wallet_address: input.wallet,
      venue_market_id: "vm", side: order.side, amount_base_units: input.amountBaseUnits, max_slippage_bps: input.maxSlippageBps,
      idempotency_key: input.idempotencyKey, request_fingerprint: "f".repeat(64), state: "QUOTED", provider_order_id: orderId,
      prepared: { order, review, binding: {} } as unknown as PantaTradeSession["prepared"],
      signed_transaction: null, signature: null, fill_evidence: null, created_at: at, updated_at: at,
    });
    return { order, review } as never;
  }
  async reconcile(row: PantaTradeSession) { return this.rows.find(r => r.id === row.id) ?? row; }
  /** The ledger's conditional write (only QUOTED/PREPARING -> FAILED is used by money calls). */
  async update(id: string, previous: PantaTradeSession["state"], patch: Partial<PantaTradeSession>) {
    const row = this.rows.find(r => r.id === id);
    if (!row || row.state !== previous) return null;
    Object.assign(row, patch);
    return row;
  }
  view(row: PantaTradeSession): VenueOrder {
    return { orderId: row.provider_order_id!, venueOrderId: row.provider_order_id, venue: "panta", venueMarketId: row.venue_market_id,
      owner: row.wallet_address, side: row.side, amountBaseUnits: row.amount_base_units,
      filledBaseUnits: row.state === "FILLED" ? row.amount_base_units : "0",
      fundingState: row.state === "PREPARING" ? "QUOTED" : row.state, fillTxSignature: row.state === "FILLED" ? row.signature : null,
      createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at), idempotencyKey: row.idempotency_key, demo: false };
  }
  async find(userId: string, key: string) { return this.rows.find(r => r.user_id === userId && r.idempotency_key === key) ?? null; }
  async latestForCall(userId: string, callId: string) {
    return [...this.rows].reverse().find(r => r.user_id === userId && r.call_id === callId && r.signature !== null &&
      ["SUBMITTED", "FILLED", "FAILED"].includes(r.state)) ?? null;
  }
  private move(orderId: string, from: PantaTradeSession["state"][], to: PantaTradeSession["state"]): PantaTradeSession {
    const row = this.rows.find(r => r.provider_order_id === orderId);
    if (!row || !from.includes(row.state)) throw new Error(`synthetic ledger: ${orderId} cannot go ${to}`);
    row.state = to;
    row.updated_at = new Date(this.now()).toISOString();
    if (to === "SUBMITTED") { row.signature = `sig${orderId}`.padEnd(64, "1"); row.signed_transaction = "AAAA"; }
    return row;
  }
  /** The person's wallet signed and the BFF broadcast it: SUBMITTED, not funded. */
  submit(orderId: string) { return this.move(orderId, ["QUOTED"], "SUBMITTED"); }
  /** Panta confirmed and RPC proved the debit: FILLED is durable, then onFilled, as PantaTradingService does. */
  fill(orderId: string) { const row = this.move(orderId, ["SUBMITTED"], "FILLED"); this.onFilled?.(row); return row; }
  /** The chain said it failed. */
  fail(orderId: string) { return this.move(orderId, ["QUOTED", "SUBMITTED"], "FAILED"); }
}

export class FakeBalances implements BalancePort {
  held = new Map<string, { usdcBaseUnits: string; lamports: string }>();
  down = false;
  set(wallet: string, usdc: string, lamports = "50000000") { this.held.set(wallet, { usdcBaseUnits: usdc, lamports }); }
  async read(wallet: string) {
    if (this.down) throw new Error("rpc down");
    return this.held.get(wallet) ?? { usdcBaseUnits: "0", lamports: "0" };
  }
}

export class FakeGas implements GasPort {
  answer: GasAnswer = { needsSol: false };
  async forTrade() { return this.answer; }
  async forTransfer() { return this.answer; }
}

export function moneyRig(opts: { markets?: VenueMarket[]; people?: Person[] } = {}) {
  const h = harness({
    people: opts.people ?? [person("ann"), person("bob"), person("cy")],
    markets: opts.markets ?? [market("m", { closesAt: T0 + 10 * HOUR }), market("n", { closesAt: T0 + 10 * HOUR })],
  });
  let seq = 0;
  const funding = new PantaFundingIndex(null);
  const panta = new FakePanta(() => h.clock.now(), callId => h.calls.getCall(callId)!.side);
  const store = new InMemoryMoneyCallStore({
    now: () => h.clock.now(),
    filled: async (u, c) => panta.rows.some(r => r.user_id === u && r.call_id === c && r.state === "FILLED"),
    inFlight: async (u, c) => panta.rows.some(r => r.user_id === u && r.call_id === c && ["SUBMITTED", "FILLED"].includes(r.state)),
    callExists: id => h.calls.getCall(id) !== undefined,
  });
  const index = new MoneyCallIndex(store);
  const calls = new CallsService({ store: h.calls, markets: h.rt.markets, clock: h.clock, moneyCalls: index, funding,
    newId: kind => `${kind}-${String(++seq).padStart(3, "0")}` });
  const balances = new FakeBalances();
  balances.set(W.ann, "50000000"); balances.set(W.bob, "50000000"); balances.set(W.cy, "50000000");
  const gas = new FakeGas();
  let flushes = 0;
  const money = new MoneyCallsService({
    store, index,
    calls: { service: calls, store: h.calls, flush: async () => { flushes++; } },
    trading: () => panta,
    ledger: () => panta,
    balances, gas, maxBaseUnits: 100_000_000n, chumbucketWallet: true, now: () => h.clock.now(),
  });
  panta.onFilled = row => {
    funding.markFilled(row.call_id, Date.parse(row.updated_at), { id: row.id, amountBaseUnits: row.amount_base_units, side: row.side });
    void money.onFilled(row);
  };
  return { h, calls, money, store, index, panta, balances, gas, funding, get flushes() { return flushes; } };
}

let keys = 0;
export const key = (): string => `tap-key-${String(++keys).padStart(8, "0")}-abcdef`;

export function own(marketId = "m", side: "YES" | "NO" = "YES", amountBaseUnits = "5000000") {
  return { call: { kind: "own" as const, marketId, side }, amountBaseUnits, idempotencyKey: key(), confidence: null, thesis: null,
    visibility: "public" as const, maxSlippageBps: 100 };
}
export function respond(kind: "back" | "fade", targetCallId: string, amountBaseUnits = "5000000") {
  return { call: { kind, targetCallId }, amountBaseUnits, idempotencyKey: key(), confidence: null, thesis: null,
    visibility: "public" as const, maxSlippageBps: 100 };
}

/** Let fire-and-forget fill handlers settle. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 0));
