/**
 * The funded-position lifecycle after a buy: claims, the server reconciler,
 * positions and the funded-call marker. SYNTHETIC keys and rows only; no
 * network, no real Panta response, no signature that reaches any chain.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { PantaClaimExecution, CLAIM_WIN_DISCRIMINATOR } from "../src/prediction/PantaClaims.ts";
import { PantaClaimService } from "../src/prediction/PantaClaimService.ts";
import type { PantaClaimSession, PantaClaimStore, PantaClaimState } from "../src/prediction/PantaClaimStore.ts";
import { PantaReconciler } from "../src/prediction/PantaReconciler.ts";
import { PantaFundingIndex } from "../src/prediction/PantaFunding.ts";
import { PantaPositionsService, perShare, valueBaseUnits, fromFixed18, toFixed18, pantaMarketUrl } from "../src/prediction/PantaPositions.ts";
import { PantaHoldings } from "../src/prediction/PantaHoldings.ts";
import { MAINNET_USDC_MINT } from "../src/prediction/PantaChain.ts";
import type { PantaTradeSession } from "../src/prediction/PantaTradingStore.ts";
import type { MarketResolutionRecord, VenueMarket } from "../src/prediction/types.ts";
import type { SharePriceSnapshot } from "../src/prediction/sharePrices.ts";
import { TestClock } from "./predictionFixtures.ts";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(9));
const wallet = owner.publicKey.toBase58();
const stranger = Keypair.fromSeed(new Uint8Array(32).fill(19)).publicKey.toBase58();
const addr = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const market = addr(3), program = addr(2), blockhash = addr(4);
const winClaim = addr(11), positionPda = addr(12), vaultAuthority = addr(13), vaultToken = addr(14);
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const SYSTEM = SystemProgram.programId.toBase58();
const ownerAta = PublicKey.findProgramAddressSync([owner.publicKey.toBuffer(), new PublicKey(TOKEN).toBuffer(),
  new PublicKey(MAINNET_USDC_MINT).toBuffer()], new PublicKey(ATA))[0].toBase58();
const user = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const callId = "30000000-0000-4000-8000-000000000001";
const marketUuid = "20000000-0000-4000-8000-000000000001";
const meta = (pubkey: string, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

function claimInstructions(over: { data?: Buffer; extra?: unknown[]; drop?: string; signer?: string } = {}) {
  const limit = Buffer.alloc(5); limit[0] = 2; limit.writeUInt32LE(200_000, 1);
  const accounts = [meta(over.signer ?? wallet, true, true), meta(market, true), meta(winClaim, true), meta(positionPda, true),
    meta(vaultAuthority), meta(vaultToken, true), meta(ownerAta, true), meta(MAINNET_USDC_MINT), meta(TOKEN), meta(SYSTEM)]
    .filter(a => a.pubkey !== over.drop);
  return [
    { programId: COMPUTE, data: limit.toString("base64"), accounts: [] },
    { programId: ATA, data: "AQ==", accounts: [meta(wallet, true, true), meta(ownerAta, true), meta(wallet), meta(MAINNET_USDC_MINT), meta(SYSTEM), meta(TOKEN)] },
    { programId: program, data: (over.data ?? Buffer.from(CLAIM_WIN_DISCRIMINATOR)).toString("base64"), accounts },
    ...(over.extra ?? []),
  ];
}
function claimBuild(over: Record<string, unknown> = {}, ixOver: Parameters<typeof claimInstructions>[0] = {}) {
  return { wallet, marketId: market, outcome: "YES", winningShares: "38.4", instructions: claimInstructions(ixOver),
    derived: { winClaim, positionPda, vaultAuthority }, recentBlockhash: blockhash, lastValidBlockHeight: 1_000, ...over };
}
function execution(response: () => unknown, clock = new TestClock()) {
  const calls: string[] = [];
  const exec = new PantaClaimExecution({ programId: program, clock, request: async (path, body) => {
    calls.push(`${path}:${JSON.stringify(body)}`);
    return response();
  } });
  return { exec, calls, clock };
}
const sign = (payload: string, signer = owner) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(payload, "base64")); tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
};

describe("win-claim transactions are checked before any wallet sees them", () => {
  test("a documented claim build compiles to one owner-signed v0 claim with a pinned message hash", async () => {
    const { exec, calls } = execution(() => claimBuild({ outcome: "yes" }));
    const prepared = await exec.build({ owner: wallet, venueMarketId: market });
    expect(calls).toEqual([`/claim/build/:${JSON.stringify({ wallet, marketId: market })}`]);
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction.payload, "base64"));
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(wallet);
    expect(createHash("sha256").update(tx.message.serialize()).digest("hex")).toBe(prepared.binding.messageHash);
    expect(prepared.binding.review).toEqual({ outcome: "YES", winningShares: "38.4", estimatedPayoutUsdc: "38.4", attribution: "Powered by Panta" });
    expect(prepared.transaction.expiresAt - prepared.binding.createdAt).toBe(60_000);
    expect(() => exec.validateTransaction(prepared.transaction.payload, prepared.binding)).not.toThrow();
  });

  const transfer = { programId: SYSTEM, data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]).toString("base64"),
    accounts: [meta(wallet, true, true), meta(stranger, true)] };
  const refusals: [string, () => unknown][] = [
    ["a top-level SOL transfer", () => claimBuild({}, { extra: [transfer] })],
    ["a buy discriminator instead of a claim", () => claimBuild({}, { data: createHash("sha256").update("global:primary_order_usdc").digest().subarray(0, 8) })],
    ["a claim missing the documented win-claim account", () => claimBuild({}, { drop: winClaim })],
    ["a claim that does not pay the owner's own USDC account", () => claimBuild({}, { drop: ownerAta })],
    ["a foreign signer", () => claimBuild({}, { signer: stranger })],
    ["a build for another wallet", () => claimBuild({ wallet: stranger })],
    ["a build for another market", () => claimBuild({ marketId: addr(21) })],
    ["an unknown response field", () => claimBuild({ transferTo: stranger })],
    ["a non-numeric share count", () => claimBuild({ winningShares: "lots" })],
    ["an empty instruction list", () => claimBuild({ instructions: [] })],
  ];
  for (const [label, response] of refusals) {
    test(`refuses ${label}`, async () => {
      const { exec } = execution(response);
      await expect(exec.build({ owner: wallet, venueMarketId: market })).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    });
  }

  test("a stored approval whose bytes changed is refused on replay", async () => {
    const { exec } = execution(() => claimBuild());
    const prepared = await exec.build({ owner: wallet, venueMarketId: market });
    const other = await execution(() => claimBuild({ recentBlockhash: addr(31) })).exec.build({ owner: wallet, venueMarketId: market });
    expect(() => exec.validateTransaction(other.transaction.payload, prepared.binding)).toThrow("reviewed message hash");
  });
});

class MemoryClaims implements PantaClaimStore {
  rows = new Map<string, PantaClaimSession>();
  async find(u: string, k: string) { return [...this.rows.values()].find(r => r.user_id === u && r.idempotency_key === k) ?? null; }
  async byId(u: string, id: string) { const r = this.rows.get(id); return r && r.user_id === u ? r : null; }
  async activeFor(u: string, w: string, m: string) {
    return [...this.rows.values()].find(r => r.user_id === u && r.wallet_address === w && r.venue_market_id === m &&
      (r.state === "SUBMITTED" || r.state === "CONFIRMED")) ?? null;
  }
  async listForUser(u: string) { return [...this.rows.values()].filter(r => r.user_id === u && ["SUBMITTED", "CONFIRMED", "FAILED"].includes(r.state)); }
  async submitted() { return [...this.rows.values()].filter(r => r.state === "SUBMITTED"); }
  async reserve(i: Parameters<PantaClaimStore["reserve"]>[0]) {
    if (await this.find(i.user_id, i.idempotency_key)) return null;
    const at = new Date().toISOString();
    const row: PantaClaimSession = { ...i, state: "PREPARING", prepared: null, signed_transaction: null, signature: null, confirm_evidence: null, created_at: at, updated_at: at };
    this.rows.set(row.id, row); return row;
  }
  async update(id: string, prev: PantaClaimState, patch: Partial<PantaClaimSession>) {
    const row = this.rows.get(id); if (!row || row.state !== prev) return null;
    const next = { ...row, ...patch, updated_at: new Date().toISOString() }; this.rows.set(id, next); return next;
  }
}

function filledTrade(over: Partial<PantaTradeSession> = {}): PantaTradeSession {
  const at = new Date(1_760_000_000_000).toISOString();
  return { id: "40000000-0000-4000-8000-000000000001", user_id: user, call_id: callId, market_id: marketUuid, wallet_address: wallet,
    venue_market_id: market, side: "YES", amount_base_units: "2000000", max_slippage_bps: 100, idempotency_key: "synthetic-buy-key",
    request_fingerprint: "f".repeat(64), state: "FILLED", provider_order_id: "ord_synthetic",
    prepared: { review: { expectedShares: "4", avgPrice: "0.5" }, binding: { lastValidBlockHeight: 500 } } as unknown as PantaTradeSession["prepared"],
    signed_transaction: "AA==", signature: "5".repeat(88).slice(0, 87),
    fill_evidence: { fillTxSignature: "sig_fill" } as unknown as PantaTradeSession["fill_evidence"],
    created_at: at, updated_at: at, ...over };
}

function claimRig() {
  const clock = new TestClock();
  const claims = new MemoryClaims();
  const trade = filledTrade();
  const trades = { byOrder: async (u: string, id: string) => (u === trade.user_id && id === trade.provider_order_id ? trade : null) };
  let proof: { payoutBaseUnits: string; slot: number } | null = null, chainFailed = false, dropped = false, broadcasts = 0;
  const reports: unknown[] = [];
  const { exec } = execution(() => claimBuild(), clock);
  const service = new PantaClaimService({ claims, trades, execution: exec, now: () => clock.now(),
    chain: { broadcast: async () => { broadcasts++; expect([...claims.rows.values()].some(r => r.state === "SUBMITTED")).toBe(true); },
      failed: async () => chainFailed, neverLanded: async () => dropped, verifyClaim: async () => proof },
    report: async body => { reports.push(body); return { signature: (body as { signature: string }).signature, status: "processed", kind: "claim" }; } });
  return { clock, claims, trade, service, reports, get broadcasts() { return broadcasts; },
    pay(amount = "38400000") { proof = { payoutBaseUnits: amount, slot: 9 }; }, fail() { chainFailed = true; }, drop() { dropped = true; } };
}

describe("claims: durable intent, exact approval, proof of payout", () => {
  test("prepare saves the reviewed claim before returning it, and the same key replays the same bytes", async () => {
    const h = claimRig();
    const first = await h.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0001" });
    expect(first.claim.state).toBe("BUILT");
    expect([...h.claims.rows.values()][0]!.prepared?.transaction.payload).toBe(first.transaction!.payload);
    const again = await h.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0001" });
    expect(again.transaction).toEqual(first.transaction);
    expect(JSON.stringify(first)).not.toMatch(/messageHash|signed_transaction|request_fingerprint/);
  });

  test("only the person's own confirmed position can be claimed", async () => {
    const h = claimRig();
    await expect(h.service.prepare(other, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0002" })).rejects.toThrow("own confirmed");
    (h.trade as { state: string }).state = "SUBMITTED";
    await expect(h.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0003" })).rejects.toThrow("own confirmed");
  });

  test("submit commits the exact signed bytes before broadcast and refuses a foreign or changed approval", async () => {
    const h = claimRig();
    const p = await h.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0004" });
    const forged = Buffer.from(sign(p.transaction!.payload), "base64"); forged[5] = forged[5]! ^ 0xff;
    await expect(h.service.submit(user, p.claim.claimId, forged.toString("base64"))).rejects.toThrow("Wallet approval");
    await expect(h.service.submit(user, p.claim.claimId, p.transaction!.payload)).rejects.toThrow("Wallet approval");
    await expect(h.service.submit(other, p.claim.claimId, sign(p.transaction!.payload))).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
    expect(h.broadcasts).toBe(0);
    const signed = sign(p.transaction!.payload);
    const view = await h.service.submit(user, p.claim.claimId, signed);
    expect(view.state).toBe("SUBMITTED"); expect(h.broadcasts).toBe(1);
    // A retry re-sends the identical bytes; it never prepares or signs again.
    expect((await h.service.submit(user, p.claim.claimId, signed)).state).toBe("SUBMITTED");
    expect(h.broadcasts).toBe(2);
    const second = await h.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0005" });
    expect(second.transaction).toBeNull(); expect(second.claim.claimId).toBe(p.claim.claimId);
  });

  test("an approval after expiry is never broadcast", async () => {
    const h = claimRig();
    const p = await h.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0006" });
    h.clock.advance(61_000);
    await expect(h.service.submit(user, p.claim.claimId, sign(p.transaction!.payload))).rejects.toThrow("expired");
    await expect(h.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0006" })).rejects.toThrow("expired");
    expect(h.broadcasts).toBe(0);
  });

  test("CONFIRMED needs chain proof of a USDC payout; FAILED needs the chain to say so", async () => {
    const h = claimRig();
    const p = await h.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0007" });
    await h.service.submit(user, p.claim.claimId, sign(p.transaction!.payload));
    expect((await h.service.status(user, p.claim.claimId)).state).toBe("SUBMITTED");
    h.pay();
    const done = await h.service.status(user, p.claim.claimId);
    expect(done).toMatchObject({ state: "CONFIRMED", payoutBaseUnits: "38400000" });
    expect([...h.claims.rows.values()][0]!.confirm_evidence).toMatchObject({ independentlyVerified: true, providerTrade: { kind: "claim" } });
    expect(h.reports).toHaveLength(1);

    const g = claimRig();
    const q = await g.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0008" });
    await g.service.submit(user, q.claim.claimId, sign(q.transaction!.payload));
    g.drop();
    expect((await g.service.status(user, q.claim.claimId)).state).toBe("FAILED");
    // A failed claim never blocks a fresh one.
    expect((await g.service.prepare(user, { orderId: "ord_synthetic", idempotencyKey: "claim-key-0009" })).transaction).not.toBeNull();
  });
});

describe("the server reconciler", () => {
  function reconcilerRig(rows: PantaTradeSession[], outcome: (row: PantaTradeSession) => PantaTradeSession["state"]) {
    const clock = new TestClock();
    const seen: string[] = [];
    const funding = new PantaFundingIndex({ filledSince: async () => [{ call_id: callId, updated_at: new Date(clock.now()).toISOString() }] });
    const reconciler = new PantaReconciler({ clock, funding, maxPerPass: 2,
      ledger: { submitted: async () => rows.filter(r => r.state === "SUBMITTED") },
      trading: { reconcile: async row => { seen.push(row.id); const state = outcome(row); const next = { ...row, state };
        rows.splice(rows.indexOf(row), 1, next); return next; } } });
    return { clock, seen, reconciler, funding };
  }
  const submitted = (n: number) => filledTrade({ id: `40000000-0000-4000-8000-00000000000${n}`, state: "SUBMITTED", call_id: `30000000-0000-4000-8000-00000000000${n}` });

  test("verifies SUBMITTED orders on a bounded cadence and backs off while they stay pending", async () => {
    const rows = [submitted(1), submitted(2), submitted(3)];
    const h = reconcilerRig(rows, () => "SUBMITTED");
    const first = await h.reconciler.runOnce();
    expect(first).toMatchObject({ checked: 2, pending: 2, filled: 0 });
    await h.reconciler.runOnce();
    expect(h.seen).toEqual([rows[0]!.id, rows[1]!.id, rows[2]!.id]);
    h.clock.advance(15_000);
    await h.reconciler.runOnce();
    expect(h.seen.slice(3)).toEqual([rows[0]!.id, rows[1]!.id]);
  });

  test("a proven fill or failure leaves the queue; the funded marker loads from confirmed fills only", async () => {
    const rows = [submitted(1), submitted(2)];
    const h = reconcilerRig(rows, row => (row.id.endsWith("1") ? "FILLED" : "FAILED"));
    const report = await h.reconciler.runOnce();
    expect(report).toMatchObject({ checked: 2, filled: 1, failed: 1, pending: 0, fundedCallsLoaded: 1 });
    expect((await h.reconciler.runOnce()).checked).toBe(0);
    expect(h.funding.fundingOf(callId)).toMatchObject({ state: "FILLED", venue: "panta" });
    expect(h.funding.fundingOf("30000000-0000-4000-8000-000000000099")).toBeNull();
  });

  test("a failing row never stops the pass, and logs carry codes only", async () => {
    const rows = [submitted(1), submitted(2)];
    const h = reconcilerRig(rows, row => { if (row.id.endsWith("1")) throw new Error("secret approval bytes"); return "FILLED"; });
    const report = await h.reconciler.runOnce();
    expect(report.filled).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});

describe("positions: cost, price, PnL and claim state from proven sources", () => {
  test("exact decimal arithmetic in base units", () => {
    expect(toFixed18("0.52")).toBe(520_000_000_000_000_000n);
    expect(valueBaseUnits("38.40", "0.52")).toBe(19_968_000n);
    expect(perShare("2000000", "4")).toBe("0.5");
    expect(fromFixed18(-1_500_000_000_000_000_000n)).toBe("-1.5");
    expect(perShare("2000000", "0")).toBeNull();
  });

  function positionsRig(opts: { resolution?: "YES" | "NO" | "VOID"; status?: VenueMarket["status"]; holdings?: unknown; price?: string | null; claims?: PantaClaimSession[]; rows?: PantaTradeSession[] }) {
    const clock = new TestClock();
    const m = { id: marketUuid, question: "Synthetic question?", status: opts.status ?? "OPEN", closesAt: clock.now() + 3_600_000 } as VenueMarket;
    const snap = opts.price === null ? undefined : { yesPrice: opts.price ?? "0.75", noPrice: "0.3", observedAt: clock.now() - 1000 } as SharePriceSnapshot;
    const service = new PantaPositionsService({ now: () => clock.now(),
      ledger: { listForUser: async u => (u === user ? opts.rows ?? [filledTrade()] : []) },
      claims: { listForUser: async () => opts.claims ?? [] },
      markets: { getMarket: id => (id === marketUuid ? m : undefined), latestSharePrice: () => snap,
        getResolution: () => (opts.resolution ? { resolution: opts.resolution } as MarketResolutionRecord : undefined) },
      holdings: { holdings: async () => (opts.holdings === undefined ? [] : opts.holdings as never) } });
    return service;
  }

  test("an open position is marked to the side's current Panta price", async () => {
    const page = await positionsRig({}).positions(user);
    expect(page.positions[0]).toMatchObject({ status: "open", costBaseUnits: "2000000", shares: "4", entryPrice: "0.5",
      currentPrice: "0.75", valueBaseUnits: "3000000", pnlBaseUnits: "1000000", callId, pantaUrl: pantaMarketUrl(market) });
    expect(page.totals).toEqual({ costBaseUnits: "2000000", valueBaseUnits: "3000000", pnlBaseUnits: "1000000", counted: 1 });
    expect(page.sell.supported).toBe(false);
    expect(JSON.stringify(page)).not.toMatch(/signed_transaction|prepared|messageHash|idempotency/);
  });

  test("a winner is claimable only when Panta says so; a claimed winner and a loser settle at 1 and 0", async () => {
    const claimable = [{ venueMarketId: market, side: "YES", shares: "4", phase: "resolved", claimable: true, claimed: false, outcome: "YES" }];
    expect((await positionsRig({ resolution: "YES", holdings: claimable }).positions(user)).positions[0])
      .toMatchObject({ status: "won_claimable", currentPrice: "1", valueBaseUnits: "4000000", pnlBaseUnits: "2000000", walletShares: "4" });
    expect((await positionsRig({ resolution: "YES" }).positions(user)).positions[0]!.status).toBe("won");
    expect((await positionsRig({ resolution: "YES", holdings: [{ ...claimable[0], claimable: false, claimed: true }] }).positions(user)).positions[0]!.status).toBe("claimed");
    expect((await positionsRig({ resolution: "NO" }).positions(user)).positions[0]).toMatchObject({ status: "lost", valueBaseUnits: "0", pnlBaseUnits: "-2000000" });
    expect((await positionsRig({ resolution: "VOID" }).positions(user)).positions[0]).toMatchObject({ status: "void", valueBaseUnits: null, pnlBaseUnits: null });
  });

  test("pending and failed orders show without inventing a value; unavailable holdings are said so", async () => {
    const rows = [filledTrade({ state: "SUBMITTED", fill_evidence: null }), filledTrade({ state: "FAILED", fill_evidence: null, provider_order_id: "ord_failed" })];
    const page = await positionsRig({ rows, holdings: null }).positions(user);
    expect(page.positions.map(p => [p.status, p.valueBaseUnits])).toEqual([["pending", null], ["failed", null]]);
    expect(page.totals.counted).toBe(0);
    const unavailable = await positionsRig({ holdings: null }).positions(user);
    expect(unavailable.holdings).toBe("unavailable");
    expect((await positionsRig({}).positions(other)).positions).toEqual([]);
  });

  test("a closed market without a published result is awaiting, not lost", async () => {
    expect((await positionsRig({ status: "CLOSED_PENDING_RESOLUTION" }).positions(user)).positions[0]!.status).toBe("awaiting_result");
  });
});

describe("Panta holdings reader", () => {
  const key = "pk_live_synthetic_holdings";
  test("parses rows, caches per wallet, skips a malformed row and never echoes the key", async () => {
    const clock = new TestClock(); let calls = 0;
    const reader = new PantaHoldings({ apiKey: key, clock, fetchImpl: Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls++;
      expect(String(url)).toBe(`https://live-api.panta.market/api/v1/positions/?wallet=${wallet}`);
      expect(init?.redirect).toBe("error");
      return Response.json({ wallet, positions: [
        { marketId: market, category: "crypto", side: "yes", shares: "38.40", phase: "resolved", claimable: true, claimed: false, outcome: "yes" },
        { marketId: "not-an-address", side: "yes", shares: "1", phase: "primary", claimable: false, claimed: false, outcome: null },
      ] });
    }, { preconnect: fetch.preconnect }) });
    const rows = await reader.holdings(wallet);
    expect(rows).toEqual([{ venueMarketId: market, side: "YES", shares: "38.40", phase: "resolved", claimable: true, claimed: false, outcome: "YES" }]);
    await reader.holdings(wallet); expect(calls).toBe(1);
    clock.advance(31_000); await reader.holdings(wallet); expect(calls).toBe(2);
  });

  test("a rate limit pauses reads and answers unavailable instead of zero", async () => {
    const clock = new TestClock(); let calls = 0;
    const reader = new PantaHoldings({ apiKey: key, clock, fetchImpl: Object.assign(async () => {
      calls++; return new Response(JSON.stringify({ code: "RATE_LIMITED", key }), { status: 429, headers: { "retry-after": "30" } });
    }, { preconnect: fetch.preconnect }) });
    expect(await reader.holdings(wallet)).toBeNull();
    expect(await reader.holdings(wallet)).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("lifecycle routes are private to the verified person", () => {
  test("positions, call order and claims need a session; a wallet string is not one", async () => {
    const { loadConfig } = await import("../src/config.ts");
    const { createApp } = await import("../src/app.ts");
    const { pantaTradingRouter } = await import("../src/api/pantaTrading.ts");
    const { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } = await import("../src/auth/AuthIdentityRuntime.ts");
    const { setPantaLifecycle, setPantaTradingRuntime, PANTA_MAINNET_PROGRAM_ID } = await import("../src/prediction/PantaTradingRuntime.ts");
    const { FakeIdentityStore, FakeJwtVerifier } = await import("./authIdentityFixtures.ts");
    const { asWallet } = await import("../src/domain/ids.ts");
    const cfg = loadConfig({ PANTA_API_KEY: "pk_live_synthetic_lifecycle", PANTA_PARTNER_USER_ID: "usr_synthetic_partner",
      PANTA_PROGRAM_ID: PANTA_MAINNET_PROGRAM_ID, PANTA_SCHEMA_READY: "true", FUNDED_POSITIONS: "true",
      SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", SOLANA_NETWORK: "mainnet-beta" });
    const app = await createApp({ config: cfg });
    primeAuthIdentityRuntime(cfg, { store: new FakeIdentityStore().addUser("auth-test", user),
      verifier: new FakeJwtVerifier().issue("synthetic-session", "auth-test"), policy: resolveAuthIdentityPolicy(cfg) });
    const clock = new TestClock();
    const positions = new PantaPositionsService({ now: () => clock.now(),
      ledger: { listForUser: async u => (u === user ? [filledTrade()] : []) }, claims: null,
      markets: { getMarket: () => undefined, getResolution: () => undefined }, holdings: null });
    const trading = { callOrder: async (u: string) => ({ order: u === user ? null : null }) } as never;
    setPantaLifecycle(cfg, { trading, claims: null, positions, holdings: null, ledger: null, claimStore: null, funding: new PantaFundingIndex(null) });

    const anonymous = pantaTradingRouter.createCaller({ app, wallet: asWallet(wallet) });
    await expect(anonymous.positions()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.callOrder({ callId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const caller = pantaTradingRouter.createCaller({ app, supabaseAccessToken: "synthetic-session" });
    const page = await caller.positions();
    expect(page.positions).toHaveLength(1);
    expect(page.positions[0]).toMatchObject({ callId, status: "awaiting_result", question: null });
    await expect(caller.claimPrepare({ orderId: "ord_synthetic", idempotencyKey: "claim-key-0010" }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: "Panta claims are not configured on this server" });
    // No procedure takes a person, wallet or user id as input.
    await expect(caller.positions({ userId: other } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A pinned trading-only runtime has no durable positions beside it: an honest refusal.
    setPantaTradingRuntime(cfg, trading);
    await expect(caller.positions()).rejects.toMatchObject({ code: "FORBIDDEN", message: "Panta positions are not configured on this server" });
  });
});
