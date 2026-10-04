/**
 * The wallet sheet's activity, collectable winnings, the Send-USDC request
 * and the money routes' gates (docs/money-api.md §c, §d, §e).
 */
import { describe, expect, test } from "bun:test";
import { buildActivity, collectableWinnings, solanaPayUri, type UsdcCredit } from "../src/money/activity.ts";
import { moneyRouter } from "../src/api/money.ts";
import { TRPCError } from "@trpc/server";
import { MoneyError } from "../src/money/errors.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { MAINNET_USDC_MINT } from "../src/prediction/PantaChain.ts";
import type { PantaClaimSession } from "../src/prediction/PantaClaimStore.ts";
import type { PantaPosition } from "../src/prediction/PantaPositions.ts";
import type { PantaTradeSession } from "../src/prediction/PantaTradingStore.ts";
import type { WalletTransferRow } from "../src/money/store.ts";
import { PantaReconciler } from "../src/prediction/PantaReconciler.ts";
import { READ_ONLY_MUTATIONS } from "../src/api/writeLimits.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 4, 10, minute)).toISOString();
const trade = (id: string, state: PantaTradeSession["state"], minute: number, signature: string | null = `sig-${id}`) =>
  ({ id, user_id: "ann", call_id: `call-${id}`, market_id: "m", wallet_address: "W", venue_market_id: "vm", side: "YES",
    amount_base_units: "5000000", state, signature, created_at: at(minute), updated_at: at(minute) }) as unknown as PantaTradeSession;
const claim = (id: string, state: PantaClaimSession["state"], minute: number, payout: string | null) =>
  ({ id, user_id: "ann", market_id: "m", wallet_address: "W", venue_market_id: "vm", state, signature: `claim-${id}`,
    prepared: { binding: { review: { winningShares: "9.2" } } },
    confirm_evidence: payout ? { payoutBaseUnits: payout } : null, created_at: at(minute), updated_at: at(minute) }) as unknown as PantaClaimSession;
const transfer = (id: string, kind: WalletTransferRow["kind"], state: WalletTransferRow["state"], minute: number) =>
  ({ id, user_id: "ann", kind, from_wallet: kind === "cash_out" ? "W" : "PHANTOM", to_wallet: kind === "cash_out" ? "FRIEND" : "W",
    amount_base_units: "3000000", state, signature: state === "BUILT" ? null : `transfer-${id}`, created_at: at(minute), updated_at: at(minute) }) as unknown as WalletTransferRow;

describe("money activity", () => {
  test("trades, claims, cash outs and deposits merge newest first, each from its own proven source", () => {
    const credits: UsdcCredit[] = [
      { signature: "card-deposit", amountBaseUnits: "20000000", at: Date.parse(at(1)), from: null },
      { signature: "claim-c1", amountBaseUnits: "9200000", at: Date.parse(at(6)), from: null },          // the claim, listed once
      { signature: "transfer-t2", amountBaseUnits: "3000000", at: Date.parse(at(8)), from: "PHANTOM" },  // our own top-up, listed once
    ];
    const items = buildActivity({
      trades: [trade("a", "FILLED", 2), trade("b", "SUBMITTED", 3), trade("c", "FAILED", 4), trade("q", "QUOTED", 5, null)],
      claims: [claim("c1", "CONFIRMED", 6, "9200000"), claim("c2", "SUBMITTED", 7, null)],
      transfers: [transfer("t1", "cash_out", "CONFIRMED", 9), transfer("t2", "deposit", "SUBMITTED", 8), transfer("t3", "cash_out", "BUILT", 10)],
      credits,
      market: () => ({ question: "Will it?" }) as never,
      limit: 20,
    });
    expect(items.map(i => [i.kind, i.direction, i.state, i.amountBaseUnits])).toEqual([
      ["cash_out", "out", "done", "3000000"],
      ["deposit", "in", "pending", "3000000"],
      ["claim", "in", "pending", "9200000"],
      ["claim", "in", "done", "9200000"],
      ["trade", "out", "failed", "5000000"],
      ["trade", "out", "pending", "5000000"],
      ["trade", "out", "done", "5000000"],
      ["deposit", "in", "done", "20000000"],
    ]);
    expect(items[0]).toMatchObject({ counterparty: "FRIEND", signature: "transfer-t1" });
    expect(items.find(i => i.kind === "trade")).toMatchObject({ question: "Will it?", side: "YES" });
    expect(buildActivity({ trades: [trade("a", "FILLED", 2)], claims: [], transfers: [], credits, market: () => undefined, limit: 2 })).toHaveLength(2);
  });

  test("collectable winnings: won and claimable or being collected, with what collecting pays", () => {
    const position = (orderId: string, status: PantaPosition["status"], value: string | null, claimId: string | null = null) =>
      ({ orderId, callId: `call-${orderId}`, marketId: "m", question: "Will it?", side: "YES", owner: "W", status,
        valueBaseUnits: value, costBaseUnits: "5000000", claim: claimId ? { claimId } : null }) as unknown as PantaPosition;
    const out = collectableWinnings({ positions: [
      position("o1", "won_claimable", "9200000"),
      position("o2", "claiming", "4000000", "claim-2"),
      position("o3", "won", "1000000"),
      position("o4", "lost", "0"),
      position("o5", "claimed", "7000000"),
      position("o6", "open", "5100000"),
    ] });
    expect(out.items.map(i => [i.orderId, i.state, i.amountBaseUnits, i.claimId])).toEqual([
      ["o1", "COLLECTABLE", "9200000", null],
      ["o2", "COLLECTING", "4000000", "claim-2"],
    ]);
    expect(out.totalBaseUnits).toBe("9200000");
  });

  test("Send USDC is a Solana Pay transfer request for the trading wallet", () => {
    expect(solanaPayUri("W", MAINNET_USDC_MINT)).toBe(`solana:W?spl-token=${MAINNET_USDC_MINT}`);
    expect(solanaPayUri("W", MAINNET_USDC_MINT, "2500000")).toBe(`solana:W?amount=2.5&spl-token=${MAINNET_USDC_MINT}`);
    expect(solanaPayUri("W", MAINNET_USDC_MINT, "5000000")).toBe(`solana:W?amount=5&spl-token=${MAINNET_USDC_MINT}`);
  });
});

describe("money routes", () => {
  test("off by default: status says so, and every other procedure refuses before reading anything", async () => {
    const app = await createApp({ config: loadConfig({}) });
    const caller = moneyRouter.createCaller({ app });
    expect(await caller.status()).toMatchObject({ enabled: false, reason: "Calls with money aren't available yet.", defaultAmountBaseUnits: null });
    for (const call of [
      () => caller.wallet(), () => caller.pending(), () => caller.activity(), () => caller.winnings(), () => caller.depositOptions(),
      () => caller.prepareCall({ kind: "own", marketId: "m", side: "YES", amountBaseUnits: "5000000", idempotencyKey: "tap-key-0000000001" }),
      () => caller.cashOutPrepare({ destination: "x", amountBaseUnits: "1", idempotencyKey: "tap-key-0000000002" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Calls with money aren't available yet." });
    }
  });

  test("on, a signed-out caller is UNAUTHORIZED; inputs are strict", async () => {
    const app = await createApp({ config: loadConfig({ MONEY_CALLS_ENABLED: "true" }) });
    const caller = moneyRouter.createCaller({ app });
    expect((await caller.status()).enabled).toBe(false); // Panta trading is not configured here
    await expect(caller.wallet()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.prepareCall({ kind: "own", marketId: "m", side: "YES", amountBaseUnits: "5000000",
      idempotencyKey: "tap-key-0000000003", userId: "someone" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("an error's public details reach the client as data.details; nothing else of a cause does", () => {
    const format = (moneyRouter._def._config as { errorFormatter: (o: unknown) => { data: Record<string, unknown> } }).errorFormatter;
    const shape = { message: "m", code: -32009, data: { code: "CONFLICT", httpStatus: 409, path: "money.cashOutPrepare" } };
    const inFlight = new TRPCError({ code: "CONFLICT", message: "m",
      cause: new MoneyError("TRANSFER_IN_FLIGHT", "m", { reason: "TRANSFER_IN_FLIGHT", transferId: "40000000-0000-4000-8000-000000000001" }) });
    expect(format({ shape, error: inFlight, type: "mutation", path: "money.cashOutPrepare", input: undefined, ctx: undefined }).data.details)
      .toEqual({ reason: "TRANSFER_IN_FLIGHT", transferId: "40000000-0000-4000-8000-000000000001" });
    // Every money refusal carries a stable reason; mapped call/venue refusals too.
    const reasonOf = (cause: unknown) => format({ shape, error: new TRPCError({ code: "PRECONDITION_FAILED", message: "m", cause }),
      type: "mutation", path: "money.retry", input: undefined, ctx: undefined }).data.details;
    expect(reasonOf(new MoneyError("PRICE_MOVED", "m"))).toEqual({ reason: "PRICE_MOVED" });
    expect(reasonOf(new MoneyError("NOT_TRADABLE", "m"))).toEqual({ reason: "NOT_TRADABLE" });
    expect(reasonOf(new MoneyError("EXPIRED", "m", { reason: "REVIEW_EXPIRED" }))).toEqual({ reason: "REVIEW_EXPIRED" });
    expect(reasonOf({ publicDetails: { reason: "MARKET_CLOSED" } })).toEqual({ reason: "MARKET_CLOSED" });
    const other = new TRPCError({ code: "BAD_GATEWAY", message: "m", cause: new Error("secret upstream body") });
    expect(format({ shape, error: other, type: "mutation", path: "x", input: undefined, ctx: undefined }).data).not.toHaveProperty("details");
  });

  test("through the router, a refusal reaches the client with its reason", async () => {
    const app = await createApp({ config: loadConfig({}) });
    const error = await moneyRouter.createCaller({ app }).wallet().catch((e: unknown) => e) as TRPCError;
    expect(error.code).toBe("PRECONDITION_FAILED");
    const format = (moneyRouter._def._config as { errorFormatter: (o: unknown) => { data: Record<string, unknown> } }).errorFormatter;
    const shape = { message: error.message, code: -32012, data: { code: error.code, httpStatus: 412, path: "money.wallet" } };
    expect(format({ shape, error, type: "mutation", path: "money.wallet", input: undefined, ctx: undefined }).data.details).toEqual({ reason: "DISABLED" });
  });

  test("polled money reads never spend the write budget", () => {
    for (const path of ["money.status", "money.callStatus", "money.pending", "money.wallet", "money.activity", "money.transferStatus",
      "money.winnings", "money.depositOptions"]) expect(READ_ONLY_MUTATIONS.has(path)).toBe(true);
    for (const path of ["money.prepareCall", "money.retry", "money.keepFree", "money.discard", "money.cashOutPrepare",
      "money.depositFromWalletPrepare", "money.transferSubmit"]) expect(READ_ONLY_MUTATIONS.has(path)).toBe(false);
  });
});

test("the Panta reconciler runs the money sweep after the fills are known", async () => {
  const order: string[] = [];
  const reconciler = new PantaReconciler({
    ledger: { submitted: async () => [] }, trading: { reconcile: async row => row },
    funding: { refresh: async () => { order.push("funding"); return 0; } },
    money: { sweep: async () => { order.push("money"); return { funded: 1, expired: 2, transfersConfirmed: 1, transfersFailed: 0, errors: ["X"] }; } },
  });
  expect(await reconciler.runOnce()).toMatchObject({ moneyFunded: 1, moneyExpired: 2, transfersSettled: 1, errors: ["X"] });
  expect(order).toEqual(["funding", "money"]);
});
