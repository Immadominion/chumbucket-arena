/**
 * A call with an amount through the REAL PantaTradingService (synthetic
 * Panta, chain and keys): the quote is for the account's own wallet, the
 * signed buy is stored before broadcast, and the call becomes FUNDED only
 * when the fill transition proves FILLED (Panta confirmed + RPC debit).
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { CallsService } from "../src/calls/CallsService.ts";
import { MoneyCallsService } from "../src/money/MoneyCallsService.ts";
import { InMemoryMoneyCallStore } from "../src/money/store.ts";
import { MoneyCallIndex } from "../src/money/visibility.ts";
import { MAINNET_USDC_MINT } from "../src/prediction/PantaChain.ts";
import { PantaExecution } from "../src/prediction/PantaExecution.ts";
import { PantaFundingIndex } from "../src/prediction/PantaFunding.ts";
import { PantaTradingService } from "../src/prediction/PantaTradingService.ts";
import type { PantaCallIntent, PantaTradeSession, PantaTradingLedger } from "../src/prediction/PantaTradingStore.ts";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { FakeBalances, FakeGas } from "./moneyCallsFixtures.ts";
import { harness, market as fixtureMarket, person, T0 } from "./socialCallsFixtures.ts";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(9));
const wallet = owner.publicKey.toBase58();
const addr = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const venueMarket = addr(3), program = addr(2), blockhash = addr(4);
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM = "11111111111111111111111111111111";
const userUsdc = PublicKey.findProgramAddressSync([owner.publicKey.toBuffer(), new PublicKey(TOKEN).toBuffer(), new PublicKey(MAINNET_USDC_MINT).toBuffer()],
  new PublicKey(ATA))[0].toBase58();
const derived = { marketConfig: addr(5), vaultAuthority: addr(6), vaultTokenAccount: addr(7), userPosition: addr(8), userTokenAccount: userUsdc, treasuryTokenAccount: addr(10) };

function instructions() {
  const meta = (pubkey: string, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const data = Buffer.alloc(17); createHash("sha256").update("global:primary_order_usdc").digest().copy(data, 0, 0, 8); data[8] = 0; data.writeBigUInt64LE(1_000_000n, 9);
  return [
    { programId: ATA, data: "AQ==", accounts: [meta(wallet, true, true), meta(userUsdc, true), meta(wallet), meta(MAINNET_USDC_MINT), meta(SYSTEM), meta(TOKEN)] },
    { programId: program, data: data.toString("base64"), accounts: [meta(wallet, true, true), meta(venueMarket, true), meta(derived.marketConfig), meta(derived.vaultAuthority),
      meta(derived.vaultTokenAccount, true), meta(derived.userPosition, true), meta(MAINNET_USDC_MINT), meta(userUsdc, true), meta(derived.treasuryTokenAccount, true),
      meta(TOKEN), meta(ATA), meta(SYSTEM)] },
    { programId: MEMO, data: Buffer.from("panta:v1:usr_synthetic_partner:qt_test:ord_test").toString("base64"), accounts: [meta(wallet, false, true)] },
  ];
}

class Ledger implements PantaTradingLedger {
  rows = new Map<string, PantaTradeSession>();
  constructor(private readonly intent: (userId: string, callId: string) => PantaCallIntent | null) {}
  async callIntent(userId: string, callId: string) { return this.intent(userId, callId); }
  async find(u: string, k: string) { return [...this.rows.values()].find(r => r.user_id === u && r.idempotency_key === k) ?? null; }
  async byOrder(u: string, id: string) { return [...this.rows.values()].find(r => r.user_id === u && r.provider_order_id === id) ?? null; }
  async activeForCall(u: string, c: string, w: string) {
    return [...this.rows.values()].find(r => r.user_id === u && r.call_id === c && r.wallet_address === w && ["SUBMITTED", "FILLED"].includes(r.state)) ?? null;
  }
  async reserve(i: Parameters<PantaTradingLedger["reserve"]>[0]) {
    if (await this.find(i.user_id, i.idempotency_key)) return null;
    const at = new Date(T0).toISOString();
    const row: PantaTradeSession = { ...i, state: "PREPARING", provider_order_id: null, prepared: null, signed_transaction: null, signature: null,
      fill_evidence: null, created_at: at, updated_at: at };
    this.rows.set(row.id, row); return row;
  }
  async update(id: string, state: PantaTradeSession["state"], patch: Partial<PantaTradeSession>) {
    const row = this.rows.get(id); if (!row || row.state !== state) return null;
    const next = { ...row, ...patch }; this.rows.set(id, next); return next;
  }
  async submitted() { return [...this.rows.values()].filter(r => r.state === "SUBMITTED"); }
  async listForUser(u: string) { return [...this.rows.values()].filter(r => r.user_id === u && r.signature); }
  async latestForCall(u: string, c: string) {
    return [...this.rows.values()].reverse().find(r => r.user_id === u && r.call_id === c && r.signature && ["SUBMITTED", "FILLED", "FAILED"].includes(r.state)) ?? null;
  }
  async filledSince() { return []; }
}

test("prepare → sign → submit → FILLED: FUNDED only after the fill transition proves it", async () => {
  const h = harness({ people: [person("ann"), person("bob")], markets: [fixtureMarket("m", { closesAt: T0 + 10 * 3_600_000 })] });
  let confirmed = false;
  const broadcasts: string[] = [];
  const execution = new PantaExecution({ programId: program, providerUserId: "usr_synthetic_partner", clock: h.clock, verifyTransaction: async () => true,
    request: async (path, body) => {
      const expiresAt = new Date(h.clock.now() + 60_000).toISOString();
      if (path === "/primaryorderquote/") return { quoteId: "qt_test", marketId: venueMarket, side: "yes", amountUsdc: body.amountUsdc, shares: "1.9", avgPrice: "0.5", feeUsdc: "0.01", expiresAt };
      if (path === "/primaryorderbuild/") return { orderId: "ord_test", quoteId: "qt_test", wallet, marketId: venueMarket, side: "yes", amountUsdc: "1.000000",
        expectedShares: "1.9", feeUsdc: "0.01", status: "built", recentBlockhash: blockhash, lastValidBlockHeight: 123, expiresAt, derived, instructions: instructions() };
      if (path === "/primaryordersubmit/") return { orderId: body.orderId, status: "submitted", signature: body.signature };
      if (path === "/primaryorderverify/") return { orderId: body.orderId, status: confirmed ? "confirmed" : "submitted", signature: body.signature,
        marketId: venueMarket, side: "yes", amountUsdc: 1000000 };
      if (path === "/trades/") return { signature: body.signature, status: "processed", wallet, marketId: venueMarket, side: "yes", kind: "buy" };
      throw new Error(`unexpected synthetic endpoint ${path}`);
    } });
  const venue = new PantaVenue({ apiKey: "pk_live_synthetic_money_test", clock: h.clock, fetchImpl: Object.assign(async () => new Response(JSON.stringify({
    marketId: venueMarket, category: "crypto", title: "Synthetic question?", description: "Synthetic rules", phase: "primary", status: "primary", resolved: false,
    startTime: Math.floor(h.clock.now() / 1000) - 3600, endTime: Math.floor(h.clock.now() / 1000) + 86400, resolutionTime: null, yesPrice: "0.5", noPrice: "0.5",
    onChain: { isActive: true, resolutionRule: "Synthetic rules" } })), { preconnect: fetch.preconnect }) });
  const ledger = new Ledger((userId, callId) => {
    const call = h.calls.getCall(callId);
    return call && call.userId === userId ? { callId, marketId: call.marketId, venueMarketId: venueMarket, side: call.side } : null;
  });
  const funding = new PantaFundingIndex(null);
  const store = new InMemoryMoneyCallStore({ now: () => h.clock.now(),
    filled: async (u, c) => [...ledger.rows.values()].some(r => r.user_id === u && r.call_id === c && r.state === "FILLED") });
  const index = new MoneyCallIndex(store);
  let seq = 0;
  const calls = new CallsService({ store: h.calls, markets: h.rt.markets, clock: h.clock, moneyCalls: index, funding,
    newId: kind => `${kind}-${++seq}` });
  let money!: MoneyCallsService;
  const trading = new PantaTradingService({ store: ledger, execution, venue, maxAmountBaseUnits: "100000000", now: () => h.clock.now(),
    wallets: { status: async (userId, address) => userId === "ann" && address === wallet ? "active" : "none" },
    chain: { broadcast: async tx => { broadcasts.push(tx.signature); }, failed: async () => false, neverLanded: async () => false },
    onFilled: row => { funding.markFilled(row.call_id, h.clock.now(), { id: row.id, amountBaseUnits: row.amount_base_units, side: row.side }); void money.onFilled(row); } });
  const balances = new FakeBalances();
  balances.set(wallet, "5000000");
  money = new MoneyCallsService({ store, index, calls: { service: calls, store: h.calls, flush: async () => {} },
    trading: () => trading, ledger: () => ledger, balances, gas: new FakeGas(), maxBaseUnits: 100_000_000n, chumbucketWallet: true, now: () => h.clock.now() });

  const ann = { userId: "ann", authUserId: "ann", email: null, wallets: [{ address: wallet, walletType: "chumbucket", primary: true, session: false }] };
  const out = await money.prepareCall(ann, { call: { kind: "own", marketId: "m", side: "YES" }, amountBaseUnits: "1000000",
    idempotencyKey: "integration-tap-key-0001", confidence: null, thesis: null, visibility: "public", maxSlippageBps: 100 });
  if (out.status !== "READY") throw new Error(out.status);
  expect(out.trade.order).toMatchObject({ owner: wallet, amountBaseUnits: "1000000", fundingState: "QUOTED" });
  const callId = out.call.call.id;

  const tx = VersionedTransaction.deserialize(Buffer.from(out.trade.order.transaction.payload, "base64"));
  tx.sign([owner]);
  const submitted = await trading.submit("ann", out.trade.order.orderId, Buffer.from(tx.serialize()).toString("base64"));
  expect(submitted.fundingState).toBe("SUBMITTED");
  expect(broadcasts).toHaveLength(1);

  // Panta has not confirmed: the shared transition keeps it SUBMITTED, and the call PENDING and private.
  let status = await money.status("ann", callId);
  expect(status.moneyCall).toMatchObject({ state: "PENDING", trade: "SUBMITTED" });
  expect(calls.isPrivate(callId)).toBe(true);
  expect(() => calls.getCall({ callId }, "bob")).toThrow();
  expect(calls.getCall({ callId }, "ann").entry.funding).toBeUndefined();

  confirmed = true;
  status = await money.status("ann", callId);
  expect(status.moneyCall).toMatchObject({ state: "FUNDED", trade: "FILLED", filledBaseUnits: "1000000" });
  expect(status.order?.fundingState).toBe("FILLED");
  expect(calls.getCall({ callId }, "bob").entry.funding).toMatchObject({ state: "FILLED", amountBaseUnits: "1000000", side: "YES" });
});
