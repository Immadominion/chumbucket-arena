/**
 * Cash out and wallet top-ups (docs/money-api.md §c, §e): validations, gas,
 * the one transaction shape and its check, and the durable lifecycle
 * (stored before any wallet sees it, signed bytes stored before broadcast,
 * CONFIRMED only on chain proof of the exact amount). Synthetic keys; no RPC.
 */
import { describe, expect, test } from "bun:test";
import { createPrivateKey, sign as edSign } from "node:crypto";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { DepositPerson } from "../src/deposits/accounts.ts";
import { MAINNET_USDC_MINT } from "../src/prediction/PantaChain.ts";
import { InMemoryWalletTransferStore } from "../src/money/store.ts";
import {
  addressShape,
  buildUsdcTransfer,
  checkUsdcTransfer,
  TransferService,
  UnsafeTransfer,
  usdcAccountOf,
  usdcDelta,
  type AccountKind,
  type TransferChainPort,
  type TransferLookup,
} from "../src/money/transfers.ts";
import { FakeBalances, FakeGas } from "./moneyCallsFixtures.ts";

const trading = Keypair.fromSeed(new Uint8Array(32).fill(41));
const phantom = Keypair.fromSeed(new Uint8Array(32).fill(42));
const friend = Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey.toBase58();
const T = trading.publicKey.toBase58();
const P = phantom.publicKey.toBase58();
const blockhash = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
const person: DepositPerson = { userId: "ann", authUserId: "ann", email: null, wallets: [
  { address: T, walletType: "chumbucket", primary: true, session: false },
  { address: P, walletType: "mwa", primary: false, session: false },
] };
const tradingWallet = person.wallets[0]!;

class FakeChain implements TransferChainPort {
  kinds = new Map<string, AccountKind>();
  existing = new Set<string>();
  broadcasts: string[] = [];
  lookup: TransferLookup = { status: "unknown" };
  failedSig = false;
  expired = false;
  verifyInputs: unknown[] = [];
  onBroadcast: () => void = () => {};
  async accountKind(address: string) { return this.kinds.get(address) ?? "none"; }
  async accountExists(address: string) { return this.existing.has(address); }
  async latestBlockhash() { return { blockhash, lastValidBlockHeight: 500 }; }
  async rent(bytes: number) { return BigInt(bytes) * 6960n + 890_880n; }
  async broadcast(tx: { signature: string }) { this.onBroadcast(); this.broadcasts.push(tx.signature); }
  async failed() { return this.failedSig; }
  async neverLanded() { return this.expired; }
  async verifyTransfer(input: unknown) { this.verifyInputs.push(input); return this.lookup; }
}

function rig() {
  let now = 1_760_000_000_000;
  const store = new InMemoryWalletTransferStore(() => now);
  const chain = new FakeChain();
  const balances = new FakeBalances();
  balances.set(T, "25000000");
  balances.set(P, "40000000");
  const gas = new FakeGas();
  let ids = 0;
  const service = new TransferService({ store, chain, balances, gas, now: () => now,
    newId: () => `40000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` });
  chain.onBroadcast = () => {
    // Durable approval BEFORE RPC.
    expect([...store.rows.values()].some(r => r.state === "SUBMITTED" && r.signature !== null)).toBe(true);
  };
  return { store, chain, balances, gas, service, advance: (ms: number) => { now += ms; } };
}
const cashOut = (r: ReturnType<typeof rig>, destination: string, amountBaseUnits = "10000000", idempotencyKey = "cash-out-key-0001") =>
  r.service.cashOut(person, tradingWallet, { destination, amountBaseUnits, idempotencyKey });
const sign = (payload: string, signer = trading) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(payload, "base64")); tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
};

describe("cash out validations", () => {
  test("each refusal is a reason, and nothing is built or stored", async () => {
    const r = rig();
    const pastedUsdcAccount = usdcAccountOf(friend);
    r.chain.kinds.set(pastedUsdcAccount, "token");
    const keypairTokenAccount = Keypair.fromSeed(new Uint8Array(32).fill(44)).publicKey.toBase58();
    r.chain.kinds.set(keypairTokenAccount, "token");
    const program = Keypair.fromSeed(new Uint8Array(32).fill(45)).publicKey.toBase58();
    r.chain.kinds.set(program, "executable");
    const cases: [string, string, string][] = [
      ["not base58", "not-an-address", "ADDRESS"],
      ["the USDC mint", MAINNET_USDC_MINT, "ADDRESS"],
      ["an off-curve address that is no account", new PublicKey(usdcAccountOf(T)).toBase58(), "ADDRESS"],
      ["a pasted USDC account", pastedUsdcAccount, "TOKEN_ACCOUNT"],
      ["a token account at a key", keypairTokenAccount, "TOKEN_ACCOUNT"],
      ["a program", program, "ADDRESS"],
      ["the trading wallet itself", T, "SAME_WALLET"],
    ];
    for (const [label, destination, reason] of cases) {
      const out = await cashOut(r, destination, "10000000", `cash-out-${label.replace(/[^a-z]/g, "")}-key`);
      expect({ label, out: out.status === "INVALID" ? out.reason as string : out.status as string }).toEqual({ label, out: reason });
    }
    expect(await cashOut(r, friend, "25000001", "cash-out-over-key-01")).toMatchObject({ status: "INVALID", reason: "OVER_BALANCE" });
    expect(await cashOut(r, friend, "0", "cash-out-zero-key-01")).toMatchObject({ status: "INVALID", reason: "AMOUNT" });
    expect(r.store.rows.size).toBe(0);
    expect(addressShape(friend)).toBe("wallet");
  });

  test("no SOL for the fee (and the new account's rent) answers NEEDS_GAS", async () => {
    const r = rig();
    r.gas.answer = { needsSol: true, topUp: { amountBaseUnits: "1000000" } };
    expect(await cashOut(r, friend)).toEqual({ status: "NEEDS_GAS", wallet: { address: T, walletType: "chumbucket" },
      topUp: { amountBaseUnits: "1000000" } });
    expect(r.store.rows.size).toBe(0);
  });
});

describe("the transaction: one shape, checked before anyone sees it", () => {
  test("a cash out to a wallet with no USDC account creates it, paid by the sender", async () => {
    const r = rig();
    const out = await cashOut(r, friend);
    if (out.status !== "READY") throw new Error(out.status);
    expect(out.review).toMatchObject({ from: T, to: friend, amountBaseUnits: "10000000", createsAccount: true });
    expect(BigInt(out.review.rentLamports)).toBeGreaterThan(0n);
    expect(out.transfer).toMatchObject({ kind: "cash_out", state: "BUILT", signature: null });
    const bytes = Buffer.from(out.transaction.payload, "base64");
    expect(() => checkUsdcTransfer(bytes, out.review)).not.toThrow();
    const tx = VersionedTransaction.deserialize(bytes);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(T);
    expect(tx.message.compiledInstructions).toHaveLength(4);
    // Stored before any wallet sees it.
    expect(r.store.rows.get(out.transfer.transferId)?.prepared.transaction).toBe(out.transaction.payload);
  });

  test("a destination that already has a USDC account gets only the transfer", async () => {
    const r = rig();
    r.chain.existing.add(usdcAccountOf(friend));
    const out = await cashOut(r, friend);
    if (out.status !== "READY") throw new Error(out.status);
    expect(out.review.createsAccount).toBe(false);
    expect(out.review.rentLamports).toBe("0");
    expect(VersionedTransaction.deserialize(Buffer.from(out.transaction.payload, "base64")).message.compiledInstructions).toHaveLength(3);
  });

  const review = { from: T, to: friend, amountBaseUnits: "10000000", createsAccount: false };
  const compile = (instructions: TransactionInstruction[], payer = trading.publicKey) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message()).serialize();
  const usdc = new PublicKey(MAINNET_USDC_MINT);
  const transfer = (amount = 10_000_000n, to = friend, owner = trading.publicKey) =>
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(usdc, owner, true), usdc, getAssociatedTokenAddressSync(usdc, new PublicKey(to), true), owner, amount, 6);
  const refusals: [string, () => Uint8Array, Partial<typeof review>?][] = [
    ["another amount", () => compile([transfer(10_000_001n)])],
    ["another destination", () => compile([transfer(10_000_000n, P)])],
    ["a SOL transfer riding along", () => compile([transfer(), SystemProgram.transfer({ fromPubkey: trading.publicKey, toPubkey: new PublicKey(friend), lamports: 1 })])],
    ["a second token transfer", () => compile([transfer(), transfer()])],
    ["a compute price above the ceiling", () => compile([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000_000 }), transfer()])],
    ["another fee payer", () => compile([transfer()], phantom.publicKey)],
    ["a missing account creation the review promised", () => compile([transfer()]), { createsAccount: true }],
    ["an account creation the review did not promise", () => Buffer.from(buildUsdcTransfer({ ...review, createsAccount: true }, blockhash).transaction, "base64")],
    ["a signed transaction", () => { const tx = VersionedTransaction.deserialize(compile([transfer()])); tx.sign([trading]); return tx.serialize(); }],
  ];
  for (const [label, bytes, over] of refusals) {
    test(`the check refuses ${label}`, () => {
      expect(() => checkUsdcTransfer(bytes(), { ...review, ...over })).toThrow(UnsafeTransfer);
    });
  }
  test("the check accepts the server's own build, with or without the account creation", () => {
    for (const createsAccount of [true, false]) {
      const built = buildUsdcTransfer({ ...review, createsAccount }, blockhash);
      expect(() => checkUsdcTransfer(Buffer.from(built.transaction, "base64"), { ...review, createsAccount })).not.toThrow();
    }
  });
});

describe("submit and status", () => {
  test("the owner's signature over the reviewed bytes is stored, then broadcast; CONFIRMED only on chain proof", async () => {
    const r = rig();
    const out = await cashOut(r, friend);
    if (out.status !== "READY") throw new Error(out.status);
    const signed = sign(out.transaction.payload);
    const submitted = await r.service.submit("ann", out.transfer.transferId, signed);
    expect(submitted.state).toBe("SUBMITTED");
    expect(r.chain.broadcasts).toHaveLength(1);
    // Not proven yet: still SUBMITTED.
    expect((await r.service.status("ann", out.transfer.transferId)).state).toBe("SUBMITTED");
    r.chain.lookup = { status: "confirmed", slot: 99 };
    const done = await r.service.status("ann", out.transfer.transferId);
    expect(done).toMatchObject({ state: "CONFIRMED", signature: submitted.signature });
    expect(r.chain.verifyInputs.at(-1)).toMatchObject({ from: T, to: friend, amountBaseUnits: "10000000" });
    expect(r.store.rows.get(out.transfer.transferId)?.confirm_evidence).toMatchObject({ independentlyVerified: true, slot: 99, amountBaseUnits: "10000000" });
    // A replayed submit of the same bytes is idempotent; a different approval is refused.
    expect((await r.service.submit("ann", out.transfer.transferId, signed)).state).toBe("CONFIRMED");
  });

  test("a foreign signature, a changed message or a late approval never reaches broadcast", async () => {
    const r = rig();
    const out = await cashOut(r, friend);
    if (out.status !== "READY") throw new Error(out.status);
    // Another key's signature placed in the owner's slot.
    const forged = VersionedTransaction.deserialize(Buffer.from(out.transaction.payload, "base64"));
    const otherKey = createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 42)]) });
    forged.addSignature(trading.publicKey, edSign(null, forged.message.serialize(), otherKey));
    await expect(r.service.submit("ann", out.transfer.transferId, Buffer.from(forged.serialize()).toString("base64"))).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    const other = buildUsdcTransfer({ from: T, to: friend, amountBaseUnits: "10000000", createsAccount: true }, new PublicKey(new Uint8Array(32).fill(9)).toBase58());
    await expect(r.service.submit("ann", out.transfer.transferId, sign(other.transaction))).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    await expect(r.service.submit("bob", out.transfer.transferId, sign(out.transaction.payload))).rejects.toMatchObject({ code: "NOT_FOUND" });
    r.advance(61_000);
    await expect(r.service.submit("ann", out.transfer.transferId, sign(out.transaction.payload))).rejects.toMatchObject({ code: "EXPIRED" });
    expect(r.chain.broadcasts).toHaveLength(0);
  });

  test("FAILED only on proof: the RPC answered it has no such transaction and the blockhash expired", async () => {
    const r = rig();
    const out = await cashOut(r, friend);
    if (out.status !== "READY") throw new Error(out.status);
    await r.service.submit("ann", out.transfer.transferId, sign(out.transaction.payload));
    expect(await r.service.sweep()).toEqual({ confirmed: 0, failed: 0, errors: [] });
    // The blockhash expired, but the RPC could not answer (or pruned it): never FAILED.
    r.chain.expired = true;
    expect(await r.service.sweep()).toEqual({ confirmed: 0, failed: 0, errors: [] });
    expect((await r.service.status("ann", out.transfer.transferId)).state).toBe("SUBMITTED");
    r.chain.lookup = { status: "missing" };
    expect(await r.service.sweep()).toEqual({ confirmed: 0, failed: 1, errors: [] });
    expect((await r.service.status("ann", out.transfer.transferId)).state).toBe("FAILED");
    await expect(r.service.submit("ann", out.transfer.transferId, sign(out.transaction.payload))).rejects.toMatchObject({ code: "STATE" });
  });

  test("the same tap replays the same review; once signed, it answers the transfer's actual state, never a fresh review", async () => {
    const r = rig();
    const first = await cashOut(r, friend);
    const again = await cashOut(r, friend);
    expect(again).toEqual(first);
    await expect(cashOut(r, friend, "9000000")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(r.store.rows.size).toBe(1);
    if (first.status !== "READY") throw new Error(first.status);
    await r.service.submit("ann", first.transfer.transferId, sign(first.transaction.payload));
    expect(await cashOut(r, friend)).toMatchObject({ status: "SENT", transfer: { transferId: first.transfer.transferId, state: "SUBMITTED" } });
    r.chain.lookup = { status: "confirmed", slot: 5 };
    expect(await cashOut(r, friend)).toMatchObject({ status: "SENT", transfer: { state: "CONFIRMED" } });
    // A FAILED one too: SENT with FAILED, never READY.
    const r2 = rig();
    const lost = await cashOut(r2, friend);
    if (lost.status !== "READY") throw new Error(lost.status);
    await r2.service.submit("ann", lost.transfer.transferId, sign(lost.transaction.payload));
    r2.chain.lookup = { status: "missing" }; r2.chain.expired = true;
    await r2.service.status("ann", lost.transfer.transferId);
    expect(await cashOut(r2, friend)).toMatchObject({ status: "SENT", transfer: { state: "FAILED" } });
  });

  test("one transfer in flight per source wallet, until it is confirmed, failed, or its review expired", async () => {
    const r = rig();
    const first = await cashOut(r, friend, "1000000", "cash-out-key-first");
    if (first.status !== "READY") throw new Error(first.status);
    const second = () => cashOut(r, friend, "2000000", "cash-out-key-second");
    await expect(second()).rejects.toMatchObject({ code: "TRANSFER_IN_FLIGHT",
      publicDetails: { reason: "TRANSFER_IN_FLIGHT", transferId: first.transfer.transferId } });
    // Another source wallet is not held up.
    expect((await r.service.depositFromWallet(person, tradingWallet, { fromWallet: P, amountBaseUnits: "1000000", idempotencyKey: "top-up-key-parallel" })).status).toBe("READY");
    // Signed: still in flight. Confirmed: free again.
    await r.service.submit("ann", first.transfer.transferId, sign(first.transaction.payload));
    await expect(second()).rejects.toMatchObject({ code: "TRANSFER_IN_FLIGHT" });
    r.chain.lookup = { status: "confirmed", slot: 7 };
    await r.service.status("ann", first.transfer.transferId);
    expect((await second()).status).toBe("READY");
    // An expired review is retired, then the next one is built.
    r.advance(61_000);
    expect((await cashOut(r, friend, "3000000", "cash-out-key-third")).status).toBe("READY");
    expect([...r.store.rows.values()].filter(row => row.state === "FAILED").map(row => row.amount_base_units)).toEqual(["2000000"]);
    // The store refuses a second one in flight even if the service were bypassed.
    await expect(r.store.insert({ ...[...r.store.rows.values()].find(row => row.state === "BUILT")!, id: "x", idempotency_key: "cash-out-key-fourth" }))
      .rejects.toThrow("one_in_flight");
  });
});

describe("top up from a linked wallet", () => {
  test("from one of the account's own wallets into the trading wallet, paid by that wallet", async () => {
    const r = rig();
    const out = await r.service.depositFromWallet(person, tradingWallet, { fromWallet: P, amountBaseUnits: "15000000", idempotencyKey: "top-up-key-000001" });
    if (out.status !== "READY") throw new Error(out.status);
    expect(out.review).toMatchObject({ from: P, to: T, createsAccount: true });
    expect(out.transfer.kind).toBe("deposit");
    const submitted = await r.service.submit("ann", out.transfer.transferId, sign(out.transaction.payload, phantom));
    expect(submitted.state).toBe("SUBMITTED");
  });
  test("a wallet that is not the account's, or the trading wallet itself, is refused", async () => {
    const r = rig();
    expect(await r.service.depositFromWallet(person, tradingWallet, { fromWallet: friend, amountBaseUnits: "1000000", idempotencyKey: "top-up-key-000002" }))
      .toMatchObject({ status: "INVALID", reason: "NOT_YOUR_WALLET" });
    expect(await r.service.depositFromWallet(person, tradingWallet, { fromWallet: T, amountBaseUnits: "1000000", idempotencyKey: "top-up-key-000003" }))
      .toMatchObject({ status: "INVALID", reason: "SAME_WALLET" });
    expect(await r.service.depositFromWallet(person, tradingWallet, { fromWallet: P, amountBaseUnits: "40000001", idempotencyKey: "top-up-key-000004" }))
      .toMatchObject({ status: "INVALID", reason: "OVER_BALANCE" });
  });
});

test("usdcDelta reads an owner's USDC change from a transaction's own balances", () => {
  const bal = (owner: string, amount: string, mint = MAINNET_USDC_MINT) => ({ owner, mint, uiTokenAmount: { amount, decimals: 6 } });
  const meta = { preTokenBalances: [bal(T, "25000000"), bal(friend, "0")], postTokenBalances: [bal(T, "15000000"), bal(friend, "10000000")] };
  expect(usdcDelta(meta, T)).toBe(-10_000_000n);
  expect(usdcDelta(meta, friend)).toBe(10_000_000n);
  expect(usdcDelta({ preTokenBalances: null, postTokenBalances: [] }, T)).toBeNull();
});
