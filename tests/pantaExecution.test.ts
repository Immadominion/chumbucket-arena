/**
 * SYNTHETIC ONLY: constructed provider responses and an injected RPC verifier.
 * The observed-v1 layout/YES-NO byte samples and two public addresses were
 * supplied by Main's unfunded probes; all other addresses/evidence are made up.
 * These tests make no live request, sign/broadcast nothing, and prove no fill or
 * authoritative IDL. Main's signed transaction and attribution checks remain
 * responsible for enforcing real server-owned identity.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PACKET_DATA_SIZE, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ManualClock } from "../src/prediction/clock.ts";
import { VenueError } from "../src/prediction/errors.ts";
import { PantaExecution, type PantaBuyAccounts, type PantaBuyInput, type PantaExecutionConfig,
  type PantaOrderBinding, type PantaPreparedOrder } from "../src/prediction/PantaExecution.ts";

const bs58 = utils.bytes.bs58;
const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte)).toBase58();
const OWNER = key(11), MARKET = key(22), PROGRAM = key(33), FOREIGN = key(44), BLOCKHASH = key(55);
const SIG = bs58.encode(Buffer.alloc(64, 7)), OTHER_SIG = bs58.encode(Buffer.alloc(64, 8));
const NOW = 1_790_000_000_000;
const PROVIDER_USER = "usr_synthetic_partner";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OBSERVED_WALLET = "J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf";
const OBSERVED_MARKET = "6yEBmxJu2oWdubFVKZshVVUpLLsXd61csSfmf8y4Qtwd";
const QUOTE = "/primaryorderquote/", BUILD = "/primaryorderbuild/", SUBMIT = "/primaryordersubmit/";
const VERIFY = "/primaryorderverify/", TRADE = "/trades/";
const nativePrice = "1.250000000000000001";
const nativeShares = "1234.123456789123456789";
const intent = (patch: Partial<PantaBuyInput> = {}): PantaBuyInput => ({ idempotencyKey: "synthetic-buy-1",
  owner: OWNER, venueMarketId: MARKET, side: "YES", amountBaseUnits: "20000000", ...patch });
const wire = (instruction: TransactionInstruction) => ({ programId: instruction.programId.toBase58(),
  data: instruction.data.toString("base64"), accounts: instruction.keys.map(account => ({
    pubkey: account.pubkey.toBase58(), isSigner: account.isSigner, isWritable: account.isWritable,
  })) });
type WireInstruction = ReturnType<typeof wire>;
const account = (pubkey: string, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
function derivedFor(owner = OWNER): PantaBuyAccounts {
  const userTokenAccount = PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),
    new PublicKey(TOKEN).toBuffer(), new PublicKey(USDC).toBuffer()], new PublicKey(ATA))[0].toBase58();
  return { userPosition: key(61), marketConfig: key(62), userTokenAccount, vaultTokenAccount: key(63),
    treasuryTokenAccount: key(64), vaultAuthority: key(65) };
}
function pantaInstruction(input = intent(), derived = derivedFor(input.owner)): WireInstruction {
  const data = Buffer.from("2e89447431590df7000000000000000000", "hex");
  data[8] = input.side === "YES" ? 0 : 1;
  data.writeBigUInt64LE(BigInt(input.amountBaseUnits), 9);
  return { programId: PROGRAM, data: data.toString("base64"), accounts: [
    account(input.owner, true, true), account(input.venueMarketId, true), account(derived.marketConfig),
    account(derived.vaultAuthority), account(derived.vaultTokenAccount, true), account(derived.userPosition, true),
    account(USDC), account(derived.userTokenAccount, true), account(derived.treasuryTokenAccount, true),
    account(TOKEN), account(ATA), account(SystemProgram.programId.toBase58()),
  ] };
}
function ataInstruction(input = intent(), derived = derivedFor(input.owner)): WireInstruction {
  return { programId: ATA, data: Buffer.from([1]).toString("base64"), accounts: [account(input.owner, true, true),
    account(derived.userTokenAccount, true), account(input.owner), account(USDC),
    account(SystemProgram.programId.toBase58()), account(TOKEN)] };
}
function memoInstruction(input = intent(), userId = PROVIDER_USER): WireInstruction {
  return { programId: MEMO, data: Buffer.from(`panta:v1:${userId}:qt_synthetic:ord_synthetic`).toString("base64"),
    accounts: [account(input.owner, false, true)] };
}
function observedInstructions(input = intent(), derived = derivedFor(input.owner)): WireInstruction[] {
  return [ataInstruction(input, derived), pantaInstruction(input, derived), memoInstruction(input)];
}
// Main's unit/PG fixtures can reproduce this shape with their pinned mock
// program and six synthetic derived addresses. Old opaque 3-byte buys and
// derived.event fixtures deliberately do not satisfy observed-v1 validation.
function syntheticBuild(input = intent()) {
  const units = BigInt(input.amountBaseUnits), derived = derivedFor(input.owner);
  return { orderId: "ord_synthetic", quoteId: "qt_synthetic", wallet: input.owner,
    marketId: input.venueMarketId, side: input.side.toLowerCase(),
    amountUsdc: `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`,
    expectedShares: nativeShares, feeUsdc: "0.400001", status: "built",
    instructions: observedInstructions(input, derived), derived, recentBlockhash: BLOCKHASH,
    lastValidBlockHeight: 123_456, expiresAt: new Date(NOW + 120_000).toISOString(), blockhashExpiryHintSec: 60 };
}
type RpcInput = Parameters<PantaExecutionConfig["verifyTransaction"]>[0];
type RigOptions = {
  input?: PantaBuyInput;
  clock?: ManualClock;
  quote?: Record<string, unknown>;
  build?: Record<string, unknown>;
  submit?: Record<string, unknown>;
  verify?: Record<string, unknown>;
  trade?: Record<string, unknown>;
  rpc?: boolean;
  failPath?: string;
  failure?: unknown;
  rpcFailure?: unknown;
};
function rig(options: RigOptions = {}) {
  const clock = options.clock ?? new ManualClock(NOW);
  const input = options.input ?? intent();
  const units = BigInt(input.amountBaseUnits);
  const amountUsdc = `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;
  const nativeSide = input.side.toLowerCase();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const rpcCalls: RpcInput[] = [];
  const responses: Record<string, unknown> = {
    [QUOTE]: { quoteId: "qt_synthetic", marketId: input.venueMarketId, side: nativeSide, amountUsdc,
      shares: "38.420000", avgPrice: nativePrice, feeUsdc: "0.400000",
      expiresAt: new Date(NOW + 90_000).toISOString(), blockhashExpiryHintSec: 60, ...options.quote },
    [BUILD]: { ...syntheticBuild(input), ...options.build },
    [SUBMIT]: { orderId: "ord_synthetic", status: "submitted", signature: SIG, ...options.submit },
    [VERIFY]: { orderId: "ord_synthetic", status: "confirmed", signature: SIG,
      marketId: input.venueMarketId, side: nativeSide,
      amountUsdc: units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : input.amountBaseUnits, ...options.verify },
    [TRADE]: { signature: SIG, status: "processed", marketId: input.venueMarketId,
      wallet: input.owner, side: nativeSide, kind: "buy", ...options.trade },
  };
  const config: PantaExecutionConfig = { clock, programId: PROGRAM, providerUserId: PROVIDER_USER,
    request: async (path, body) => {
      calls.push({ path, body: structuredClone(body) });
      if (path === options.failPath) throw options.failure;
      return structuredClone(responses[path]);
    },
    verifyTransaction: async data => {
      rpcCalls.push(structuredClone(data));
      if (options.rpcFailure !== undefined) throw options.rpcFailure;
      return options.rpc ?? true;
    },
  };
  return { execution: new PantaExecution(config), config, clock, input, calls, rpcCalls, responses };
}
type Rig = ReturnType<typeof rig>;
async function submitted(r: Rig): Promise<PantaOrderBinding> {
  const prepared = await r.execution.buildBuy(r.input);
  return r.execution.submit(prepared.binding, SIG);
}
function revisedPayload(binding: PantaOrderBinding, change: (tx: VersionedTransaction) => void,
  updateHash = true): PantaOrderBinding {
  const saved = structuredClone(binding);
  const tx = VersionedTransaction.deserialize(Buffer.from(saved.unsignedOrder.transaction.payload, "base64"));
  change(tx);
  saved.unsignedOrder.transaction.payload = Buffer.from(tx.serialize()).toString("base64");
  if (updateHash) saved.messageHash = createHash("sha256").update(tx.message.serialize()).digest("hex");
  return saved;
}

describe("synthetic Panta quote/build and exact durable review", () => {
  test("official quote without wallet echo compiles unsigned v0 and retains exact native strings", async () => {
    const r = rig();
    const result: PantaPreparedOrder = await r.execution.buildBuy(r.input);
    expect(result.review).toEqual({ amountUsdc: "20.000000", amountBaseUnits: "20000000", avgPrice: nativePrice,
      feeUsdc: "0.400001", expectedShares: nativeShares, maxSlippageBps: 100, currency: "USDC",
      priceUnit: "USDC/share", sharesUnit: "shares", quotedProbability: null, attribution: "Powered by Panta" });
    expect(result.order).toMatchObject({ venue: "panta", fundingState: "QUOTED", quotedProbability: null,
      owner: OWNER, side: "YES", amountBaseUnits: "20000000", demo: false });
    expect(result.binding).toMatchObject({ owner: OWNER, venueMarketId: MARKET, side: "YES",
      providerOrderId: "ord_synthetic", quoteId: "qt_synthetic", idempotencyKey: "synthetic-buy-1",
      amountBaseUnits: "20000000", signature: null, createdAt: NOW, expiresAt: NOW + 60_000 });
    expect(result.order).toEqual(result.binding.unsignedOrder);
    expect(result.binding).not.toHaveProperty("wallet");
    expect(result.binding).not.toHaveProperty("marketId");
    expect(result.binding).not.toHaveProperty("orderId");
    const bytes = Buffer.from(result.order.transaction.payload, "base64");
    expect(bytes.length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(bytes.toString("base64")).toBe(result.order.transaction.payload);
    const tx = VersionedTransaction.deserialize(bytes);
    expect(tx.version).toBe(0);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0]?.toBase58()).toBe(OWNER);
    expect(tx.signatures.every(sig => sig.every(byte => byte === 0))).toBe(true);
    expect(result.binding.messageHash).toBe(createHash("sha256").update(tx.message.serialize()).digest("hex"));
    expect(r.calls).toEqual([
      { path: QUOTE, body: { wallet: OWNER, marketId: MARKET, side: "yes", amountUsdc: "20.000000" } },
      { path: BUILD, body: { wallet: OWNER, quoteId: "qt_synthetic", maxSlippageBps: 100 } },
    ]);
    expect(r.rpcCalls).toEqual([]);
  });

  for (const [units, amountUsdc] of [
    ["1", "0.000001"], ["9007199254740993", "9007199254.740993"],
    ["18446744073709551615", "18446744073709.551615"],
  ]) test(`USDC bigint conversion stays exact: ${units}`, async () => {
    const r = rig({ input: intent({ amountBaseUnits: units! }), quote: { feeUsdc: "0" }, build: { feeUsdc: "0" } });
    const result = await r.execution.buildBuy(r.input);
    expect(result.order.amountBaseUnits).toBe(units!);
    expect(result.review.amountUsdc).toBe(amountUsdc!);
    expect(r.calls[0]?.body.amountUsdc).toBe(amountUsdc!);
  });

  test("equivalent quote/build human decimal representations compare in integer units", async () => {
    const r = rig({ quote: { amountUsdc: "20.0", wallet: OWNER }, build: { amountUsdc: "20" } });
    expect((await r.execution.buildBuy(r.input)).binding.amountBaseUnits).toBe("20000000");
  });

  test("NO stays NO without probability complements; canonical identity is never forwarded", async () => {
    const r = rig({ input: intent({ side: "NO", maxSlippageBps: 0, canonicalUserId: "verified-person-1" }) });
    const result = await r.execution.buildBuy(r.input);
    expect(result.binding.side).toBe("NO");
    expect(result.binding.canonicalUserId).toBe("verified-person-1");
    expect(result.order.quotedProbability).toBeNull();
    expect(r.calls[0]?.body).toMatchObject({ side: "no" });
    expect(r.calls[1]?.body).toMatchObject({ maxSlippageBps: 0 });
    expect(result.binding.providerAttributionUserId).toBe(PROVIDER_USER);
    const saved = await r.execution.submit(result.binding, SIG);
    const filled = await r.execution.verify(saved);
    expect(filled.fundingState).toBe("FILLED");
    for (const call of r.calls) expect(call.body).not.toHaveProperty("userId");
  });

  test("fresh execution instance replays exact durable order without quote/build requests", async () => {
    const first = rig();
    const original = await first.execution.buildBuy(first.input);
    const persisted: PantaOrderBinding = JSON.parse(JSON.stringify(original.binding));
    const restarted = rig();
    const replayed = await restarted.execution.buildBuy(first.input, persisted);
    expect(replayed).toEqual(original);
    expect(replayed.order).toEqual(replayed.binding.unsignedOrder);
    expect(restarted.calls).toEqual([]);
  });

  for (const patch of [
    { owner: FOREIGN }, { venueMarketId: FOREIGN }, { side: "NO" as const },
    { amountBaseUnits: "20000001" }, { idempotencyKey: "other-key" },
    { maxSlippageBps: 101 }, { canonicalUserId: "another-person" },
  ]) test(`durable replay rejects changed intent: ${Object.keys(patch)[0]}`, async () => {
    const r = rig(); const original = await r.execution.buildBuy(r.input);
    await expect(r.execution.buildBuy(intent(patch), original.binding)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(r.calls).toHaveLength(2);
  });
});

describe("synthetic intent, schema, precision and freshness guards", () => {
  for (const bad of ["0", "01", "-1", "1.1", "1e6", "NaN", "", "18446744073709551616", "999999999999999999999"]) {
    test(`invalid input base units do not reach transport: ${bad}`, async () => {
      const r = rig();
      await expect(r.execution.buildBuy(intent({ amountBaseUnits: bad }))).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST" });
      expect(r.calls).toEqual([]);
    });
  }
  for (const patch of [
    { maxSlippageBps: -1 }, { maxSlippageBps: 5001 }, { maxSlippageBps: 0.5 }, { maxSlippageBps: Infinity },
    { limitProbability: 0.5 }, { owner: "invalid" }, { idempotencyKey: "" }, { userId: "client-assertion" },
  ]) test(`invalid/unsupported input is rejected: ${Object.keys(patch)[0]}=${String(Object.values(patch)[0])}`, async () => {
    const r = rig();
    await expect(r.execution.buildBuy({ ...r.input, ...patch } as PantaBuyInput)).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST" });
    expect(r.calls).toEqual([]);
  });
  for (const patch of [
    { wallet: FOREIGN }, { marketId: FOREIGN }, { side: "no" }, { amountUsdc: "20.000001" },
    { amountUsdc: 20 }, { amountUsdc: "20.0000001" }, { amountUsdc: "18446744073709.551616" },
    { amountUsdc: "1e1" }, { avgPrice: 1.25 }, { avgPrice: "NaN" }, { shares: "0" },
    { quoteId: undefined }, { unexpected: "untrusted-provider-body" }, { feeUsdc: "21" },
    { userId: "contradictory-person" },
  ]) test(`quote refuses schema/intent tampering: ${Object.entries(patch)[0]?.join("=")}`, async () => {
    const r = rig({ input: intent({ canonicalUserId: "verified-person-1" }), quote: patch });
    await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.calls.map(call => call.path)).toEqual([QUOTE]);
  });
  for (const patch of [
    { wallet: FOREIGN }, { wallet: undefined }, { marketId: FOREIGN }, { side: "no" },
    { amountUsdc: "20.000001" }, { amountUsdc: 20 }, { amountUsdc: "20.0000001" },
    { quoteId: "qt_other" }, { orderId: "" }, { status: "confirmed" },
    { expectedShares: 12 }, { feeUsdc: "0.0000001" }, { feeUsdc: "21" },
    { recentBlockhash: "not-a-blockhash" }, { lastValidBlockHeight: 0 }, { lastValidBlockHeight: Infinity },
    { lastValidBlockHeight: Number.MAX_SAFE_INTEGER + 1 }, { lastValidBlockHeight: 1.5 },
    { lastValidBlockHeight: "123" }, { derived: { event: FOREIGN, vaultAuthority: FOREIGN } },
    { userId: "contradictory-person" }, { extra: true },
  ]) test(`build refuses schema/intent tampering: ${Object.entries(patch)[0]?.join("=")}`, async () => {
    const r = rig({ input: intent({ canonicalUserId: "verified-person-1" }), build: patch });
    await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.calls.map(call => call.path)).toEqual([QUOTE, BUILD]);
  });
  for (const endpoint of ["quote", "build"] as const) {
    test(`${endpoint} rejects expired sessions without retry`, async () => {
      const r = rig({ [endpoint]: { expiresAt: new Date(NOW).toISOString() } });
      await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST" });
      expect(r.calls).toHaveLength(endpoint === "quote" ? 1 : 2);
    });
    test(`${endpoint} rejects invalid or unbounded expiry`, async () => {
      for (const expiresAt of ["not-a-date", new Date(NOW + 300_001).toISOString()]) {
        const r = rig({ [endpoint]: { expiresAt } });
        await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
      }
    });
  }
  test("expired exact replay and first submit cannot refresh the reviewed blockhash", async () => {
    const r = rig(); const result = await r.execution.buildBuy(r.input);
    r.clock.advance(60_000);
    await expect(r.execution.buildBuy(r.input, result.binding)).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST" });
    await expect(r.execution.submit(result.binding, SIG)).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST" });
    expect(r.calls).toHaveLength(2);
  });
  for (const path of [QUOTE, BUILD]) test(`${path} never automatically retries and preserves sanitized business errors`, async () => {
    const failure = new VenueError("VENUE_BAD_REQUEST", "Panta amount is below the minimum", { venue: "panta" });
    const r = rig({ failPath: path, failure });
    await expect(r.execution.buildBuy(r.input)).rejects.toBe(failure);
    expect(r.calls.filter(call => call.path === path)).toHaveLength(1);
  });
  test("arbitrary transport rejection and schema diagnostics never expose provider bodies", async () => {
    const marker = "untrusted-provider-body-marker";
    const r = rig({ failPath: QUOTE, failure: new Error(marker) });
    try { await r.execution.buildBuy(r.input); throw new Error("expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(VenueError);
      expect(String(error)).not.toContain(marker);
      expect(error).not.toHaveProperty("cause");
    }
    const changed = rig({ quote: { unexpected: marker } });
    await expect(changed.execution.buildBuy(changed.input)).rejects.toThrow("invalid quote response");
  });
});

describe("synthetic bounded instruction and transaction guards", () => {
  for (const [side, units, hex] of [
    ["YES", "1000000", "2e89447431590df70040420f0000000000"],
    ["NO", "2000000", "2e89447431590df70180841e0000000000"],
  ] as const) test(`observed ${side} bytes with supplied public wallet/market compile without signing`, async () => {
    const input = intent({ owner: OBSERVED_WALLET, venueMarketId: OBSERVED_MARKET, side, amountBaseUnits: units });
    const r = rig({ input }); const prepared = await r.execution.buildBuy(input);
    const wireInstructions = (r.responses[BUILD] as ReturnType<typeof syntheticBuild>).instructions;
    expect(Buffer.from(wireInstructions[1]!.data, "base64").toString("hex")).toBe(hex);
    expect(hex.slice(0, 16)).toBe(createHash("sha256").update("global:primary_order_usdc").digest("hex").slice(0, 16));
    expect(prepared.binding.derived).toEqual(derivedFor(OBSERVED_WALLET));
    expect(prepared.binding.derived).not.toHaveProperty("event");
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.order.transaction.payload, "base64"));
    const instructions = TransactionMessage.decompile(tx.message).instructions;
    expect(instructions.map(ix => ix.programId.toBase58())).toEqual([ATA, PROGRAM, MEMO]);
    expect(instructions[1]!.data.toString("hex")).toBe(hex);
    expect(instructions[1]!.keys).toHaveLength(12);
    expect(wireInstructions[0]!.accounts[2]).toEqual(account(OBSERVED_WALLET));
    expect(wireInstructions[2]!.accounts[0]).toEqual(account(OBSERVED_WALLET, false, true));
    expect(instructions[0]!.keys[0]!.pubkey.equals(instructions[0]!.keys[2]!.pubkey)).toBe(true);
    expect(instructions[0]!.keys[2]).toMatchObject({ isSigner: true, isWritable: true });
    expect(instructions[2]!.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(tx.message.staticAccountKeys.filter(pubkey => pubkey.toBase58() === OBSERVED_WALLET)).toHaveLength(1);
    expect(tx.signatures[0]?.every(byte => byte === 0)).toBe(true);
    expect(prepared.order.fundingState).toBe("QUOTED");
    const restarted = rig();
    expect(await restarted.execution.buildBuy(input, JSON.parse(JSON.stringify(prepared.binding)))).toEqual(prepared);
    expect(restarted.calls).toEqual([]);
    expect(r.rpcCalls).toEqual([]);
  });
  test("a canonical USDC ATA may already exist; buy plus bound signed Memo still compiles", async () => {
    const r = rig({ build: { instructions: [pantaInstruction(), memoInstruction()] } });
    expect((await r.execution.buildBuy(r.input)).order.fundingState).toBe("QUOTED");
  });
  test("canonical person stays private while the native Memo is pinned to the partner account", async () => {
    const input = intent({ canonicalUserId: "8d6fd31b-54ed-4a32-8dd8-7ae80b8b35e4" });
    const r = rig({ input }); const prepared = await r.execution.buildBuy(input);
    expect(prepared.binding.canonicalUserId).toBe(input.canonicalUserId!);
    expect(r.calls[0]?.body).not.toHaveProperty("userId");
    expect(r.calls[1]?.body).not.toHaveProperty("userId");
    expect(prepared.binding.providerAttributionUserId).toBe(PROVIDER_USER);
    const memo = TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(prepared.order.transaction.payload, "base64")).message).instructions.at(-1)!;
    expect(memo.data.toString("utf8")).toBe(`panta:v1:${PROVIDER_USER}:qt_synthetic:ord_synthetic`);
    const wrong = observedInstructions(input); wrong[2] = memoInstruction(input, "usr_other_partner");
    const bad = rig({ input, build: { instructions: wrong } });
    await expect(bad.execution.buildBuy(input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
  });
  test("a different partner key cannot replay or reconcile a persisted approval", async () => {
    const r = rig(); const prepared = await r.execution.buildBuy(r.input);
    const other = new PantaExecution({ ...r.config, providerUserId: "usr_other_partner" });
    await expect(other.buildBuy(r.input, prepared.binding)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    await expect(other.verify({ ...prepared.binding, signature: SIG })).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.calls).toHaveLength(2); expect(r.rpcCalls).toEqual([]);
  });
  for (const [index, label] of [
    [2, "marketConfig"], [3, "vaultAuthority"], [4, "vaultTokenAccount"], [5, "userPosition"],
    [6, "USDC mint"], [7, "userTokenAccount"], [8, "treasuryTokenAccount"], [9, "classic Token"],
    [10, "ATA program"], [11, "System program"],
  ] as const) test(`each ordered buy account is bound: ${label}`, async () => {
    const instructions = observedInstructions(); instructions[1]!.accounts[index]!.pubkey = FOREIGN;
    const r = rig({ build: { instructions } });
    await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.rpcCalls).toEqual([]);
  });
  for (const field of Object.keys(derivedFor()) as (keyof PantaBuyAccounts)[]) {
    test(`derived ${field} cannot contradict the reviewed accounts`, async () => {
      const r = rig({ build: { derived: { ...derivedFor(), [field]: FOREIGN } } });
      await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    });
    test(`derived ${field} is required, with no permissive old event schema`, async () => {
      const r = rig({ build: { derived: { ...derivedFor(), [field]: undefined } } });
      await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    });
  }
  test("readonly role aliases cannot acquire wallet or token-account privileges", async () => {
    const derived = { ...derivedFor(), marketConfig: OWNER };
    const r = rig({ build: { derived, instructions: observedInstructions(intent(), derived) } });
    await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
  });
  test("bounded ComputeBudget prefixes and observed signed attribution Memo are supported", async () => {
    const r = rig({ build: { instructions: [
      wire(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })),
      wire(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000n })),
      ...observedInstructions(),
    ] } });
    expect((await r.execution.buildBuy(r.input)).order.fundingState).toBe("QUOTED");
  });
  const changeBuyData = (ixs: WireInstruction[], change: (data: Buffer) => void) => {
    const data = Buffer.from(ixs[1]!.data, "base64"); change(data); ixs[1]!.data = data.toString("base64");
  };
  const unsafeInstructions: [string, (ixs: WireInstruction[]) => void][] = [
    ["foreign signer", ixs => { ixs[1]!.accounts[2]!.isSigner = true; }],
    ["foreign market", ixs => { ixs[1]!.accounts[1]!.pubkey = FOREIGN; }],
    ["readonly market", ixs => { ixs[1]!.accounts[1]!.isWritable = false; }],
    ["missing owner signer", ixs => { ixs[1]!.accounts[0]!.isSigner = false; }],
    ["unknown program", ixs => { ixs[1]!.programId = FOREIGN; }],
    ["System transfer", ixs => { ixs.unshift(wire(SystemProgram.transfer({ fromPubkey: new PublicKey(OWNER), toPubkey: new PublicKey(FOREIGN), lamports: 1 }))); }],
    ["Token transfer", ixs => { ixs.unshift({ ...pantaInstruction(), programId: TOKEN }); }],
    ["missing Panta program", ixs => { ixs.splice(1, 1); }],
    ["duplicate primary buy", ixs => { ixs.splice(2, 0, pantaInstruction()); }],
    ["extra buy accounts", ixs => { ixs[1]!.accounts.push({ ...ixs[1]!.accounts[1]! }); }],
    ["noncanonical base64", ixs => { ixs[1]!.data = "Zh=="; }],
    ["unpadded base64", ixs => { ixs[1]!.data = "Zg"; }],
    ["empty Panta data", ixs => { ixs[1]!.data = ""; }],
    ["too many instructions", ixs => { ixs.push(...Array.from({ length: 17 }, () => pantaInstruction())); }],
    ["oversized instruction", ixs => { ixs[1]!.data = Buffer.alloc(1100).toString("base64"); }],
    ["wrong primary discriminator", ixs => changeBuyData(ixs, data => { data[0] = data[0]! ^ 1; })],
    ["wrong intent side", ixs => changeBuyData(ixs, data => { data[8] = 1; })],
    ["unknown side enum", ixs => changeBuyData(ixs, data => { data[8] = 2; })],
    ["wrong u64 amount", ixs => changeBuyData(ixs, data => { data.writeBigUInt64LE(20_000_001n, 9); })],
    ["big-endian amount", ixs => changeBuyData(ixs, data => { data.writeBigUInt64BE(20_000_000n, 9); })],
    ["truncated primary data", ixs => { ixs[1]!.data = Buffer.from(ixs[1]!.data, "base64").subarray(0, 16).toString("base64"); }],
    ["extra primary data", ixs => { ixs[1]!.data = Buffer.concat([Buffer.from(ixs[1]!.data, "base64"), Buffer.from([0])]).toString("base64"); }],
    ["compute price cap", ixs => { ixs.unshift(wire(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_001n }))); }],
    ["compute limit cap", ixs => { ixs.unshift(wire(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_001 }))); }],
    ["zero compute limit", ixs => { ixs.unshift(wire(ComputeBudgetProgram.setComputeUnitLimit({ units: 0 }))); }],
    ["duplicate compute price", ixs => { ixs.unshift(wire(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })), wire(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2 }))); }],
    ["unsupported heap request", ixs => { ixs.unshift(wire(ComputeBudgetProgram.requestHeapFrame({ bytes: 32_768 }))); }],
    ["compute after ATA", ixs => { ixs.splice(1, 0, wire(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))); }],
    ["ATA foreign owner", ixs => { ixs[0]!.accounts[2]!.pubkey = FOREIGN; }],
    ["ATA foreign payer", ixs => { ixs[0]!.accounts[0]!.pubkey = FOREIGN; }],
    ["ATA foreign mint", ixs => { ixs[0]!.accounts[3]!.pubkey = FOREIGN; }],
    ["ATA noncanonical address", ixs => { ixs[0]!.accounts[1]!.pubkey = FOREIGN; }],
    ["ATA foreign token program", ixs => { ixs[0]!.accounts[5]!.pubkey = FOREIGN; }],
    ["ATA foreign system program", ixs => { ixs[0]!.accounts[4]!.pubkey = FOREIGN; }],
    ["ATA create instead of create-idempotent", ixs => { ixs[0]!.data = Buffer.from([0]).toString("base64"); }],
    ["ATA recover-nested", ixs => { ixs[0]!.data = Buffer.from([2]).toString("base64"); }],
    ["ATA excess data", ixs => { ixs[0]!.data = Buffer.from([1, 0]).toString("base64"); }],
    ["ATA unexpected wallet signer flag on raw owner role", ixs => { ixs[0]!.accounts[2]!.isSigner = true; }],
    ["duplicate ATA", ixs => { ixs.unshift(ataInstruction()); }],
    ["ATA after buy", ixs => { const ata = ixs.shift()!; ixs.splice(1, 0, ata); }],
    ["unsigned attribution Memo", ixs => { ixs[2]!.accounts[0]!.isSigner = false; }],
    ["foreign Memo signer", ixs => { ixs[2]!.accounts[0]!.pubkey = FOREIGN; }],
    ["writable Memo flag in raw instruction", ixs => { ixs[2]!.accounts[0]!.isWritable = true; }],
    ["arbitrary Memo", ixs => { ixs[2]!.data = Buffer.from("arbitrary text").toString("base64"); }],
    ["wrong Memo quote", ixs => { ixs[2]!.data = Buffer.from("panta:v1:api-default-person:qt_other:ord_synthetic").toString("base64"); }],
    ["wrong Memo order", ixs => { ixs[2]!.data = Buffer.from("panta:v1:api-default-person:qt_synthetic:ord_other").toString("base64"); }],
    ["invalid UTF-8 Memo", ixs => { ixs[2]!.data = Buffer.concat([Buffer.from("panta:v1:"), Buffer.from([0xff]), Buffer.from(":qt_synthetic:ord_synthetic")]).toString("base64"); }],
    ["missing Memo", ixs => { ixs.pop(); }],
    ["duplicate Memo", ixs => { ixs.push(memoInstruction()); }],
    ["Memo before buy", ixs => { [ixs[1], ixs[2]] = [ixs[2]!, ixs[1]!]; }],
    ["extra Memo account", ixs => { ixs[2]!.accounts.push(account(FOREIGN)); }],
    ["writable invoked program", ixs => { ixs[1]!.accounts[10]!.isWritable = true; }],
  ];
  for (const [label, change] of unsafeInstructions) test(`rejects ${label}`, async () => {
    const instructions = observedInstructions(); change(instructions);
    const r = rig({ build: { instructions } });
    await expect(r.execution.buildBuy(r.input)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.rpcCalls).toEqual([]);
  });

  for (const programId of ["invalid", SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(),
    MEMO, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"])
    test(`program configuration must explicitly identify Panta: ${programId}`, () => {
      const r = rig();
      expect(() => new PantaExecution({ ...r.config, programId })).toThrow(VenueError);
      expect(r.calls).toEqual([]);
    });

  test("all persisted transaction checks rerun even with a recomputed message hash", async () => {
    const r = rig(); const prepared = await r.execution.buildBuy(r.input);
    const nonzeroSignature = revisedPayload(prepared.binding, tx => { tx.signatures[0]![0] = 1; });
    await expect(r.execution.submit(nonzeroSignature, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    const lookup = revisedPayload(prepared.binding, tx => {
      if (tx.message.version === 0) tx.message.addressTableLookups.push({ accountKey: new PublicKey(FOREIGN), writableIndexes: [0], readonlyIndexes: [] });
    });
    await expect(r.execution.submit(lookup, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    const changedMessage = revisedPayload(prepared.binding, tx => { tx.message.recentBlockhash = FOREIGN; }, false);
    await expect(r.execution.submit(changedMessage, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    const extraBytes = structuredClone(prepared.binding);
    extraBytes.unsignedOrder.transaction.payload = Buffer.concat([
      Buffer.from(prepared.order.transaction.payload, "base64"), Buffer.from([0]),
    ]).toString("base64");
    await expect(r.execution.submit(extraBytes, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.calls).toHaveLength(2);
  });
  test("compiled global privilege promotions are limited to the expected wallet roles", async () => {
    const r = rig(); const prepared = await r.execution.buildBuy(r.input);
    const writableConfig = revisedPayload(prepared.binding, tx => {
      const message = TransactionMessage.decompile(tx.message);
      const buy = message.instructions.find(ix => ix.programId.toBase58() === PROGRAM)!;
      buy.keys[2]!.isWritable = true;
      tx.message = message.compileToV0Message();
    });
    await expect(r.execution.submit(writableConfig, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    const unusedKey = revisedPayload(prepared.binding, tx => {
      tx.message.staticAccountKeys.push(new PublicKey(FOREIGN));
      tx.message.header.numReadonlyUnsignedAccounts++;
    });
    await expect(r.execution.submit(unusedKey, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    const wrongAmount = revisedPayload(prepared.binding, tx => {
      const buy = tx.message.compiledInstructions.find(ix => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() === PROGRAM)!;
      const data = Buffer.from(buy.data); data.writeBigUInt64LE(21_000_000n, 9); buy.data = data;
    });
    await expect(r.execution.verify({ ...wrongAmount, signature: SIG })).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    const wrongSide = revisedPayload(prepared.binding, tx => {
      const buy = tx.message.compiledInstructions.find(ix => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() === PROGRAM)!;
      buy.data[8] = 1;
    });
    await expect(r.execution.verify({ ...wrongSide, signature: SIG })).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.calls).toHaveLength(2); expect(r.rpcCalls).toEqual([]);
  });
  test("binding side/amount/derived/Memo identity are rechecked against bytes, beyond duplicated JSON fields", async () => {
    const r = rig(); const prepared = await r.execution.buildBuy(r.input);
    const amount = structuredClone(prepared.binding);
    amount.amountBaseUnits = amount.unsignedOrder.amountBaseUnits = amount.review.amountBaseUnits = "21000000";
    amount.amountUsdc = amount.review.amountUsdc = "21.000000";
    const side = structuredClone(prepared.binding); side.side = side.unsignedOrder.side = "NO";
    const provider = structuredClone(prepared.binding); provider.providerOrderId = provider.unsignedOrder.orderId = "ord_other";
    const derived = structuredClone(prepared.binding); derived.derived.marketConfig = FOREIGN;
    for (const saved of [amount, side, provider, derived,
      { ...prepared.binding, quoteId: "qt_other" }, { ...prepared.binding, providerAttributionUserId: "usr_other_partner" }]) {
      await expect(r.execution.submit(saved, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
      await expect(r.execution.verify({ ...saved, signature: SIG })).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    }
    expect(r.calls).toHaveLength(2); expect(r.rpcCalls).toEqual([]);
  });
  test("foreign payer and legacy payloads cannot substitute for the durable unsigned v0 order", async () => {
    const r = rig(); const prepared = await r.execution.buildBuy(r.input);
    const ix = pantaInstruction();
    const instruction = new TransactionInstruction({ programId: new PublicKey(ix.programId),
      data: Buffer.from(ix.data, "base64"), keys: ix.accounts.map(account => ({ ...account, pubkey: new PublicKey(account.pubkey) })) });
    for (const legacy of [false, true]) {
      const message = new TransactionMessage({ payerKey: new PublicKey(legacy ? OWNER : FOREIGN), recentBlockhash: BLOCKHASH,
        instructions: [instruction] });
      const tx = new VersionedTransaction(legacy ? message.compileToLegacyMessage() : message.compileToV0Message());
      const saved = structuredClone(prepared.binding);
      saved.unsignedOrder.transaction.payload = Buffer.from(tx.serialize()).toString("base64");
      saved.messageHash = createHash("sha256").update(tx.message.serialize()).digest("hex");
      await expect(r.execution.submit(saved, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    }
  });
});

describe("synthetic durable submit binding", () => {
  test("signature is attached only after matching acknowledgement, with idempotent restart/TTL replay", async () => {
    const r = rig(); const original = await r.execution.buildBuy(r.input);
    const acknowledged = await r.execution.submit(original.binding, SIG);
    expect(original.binding.signature).toBeNull();
    expect(acknowledged.signature).toBe(SIG);
    expect(original.order).toEqual(acknowledged.unsignedOrder);
    expect(r.calls[2]).toEqual({ path: SUBMIT, body: { orderId: "ord_synthetic", wallet: OWNER, signature: SIG } });
    const restarted = rig({ clock: r.clock });
    r.clock.advance(120_000);
    expect(await restarted.execution.submit(JSON.parse(JSON.stringify(acknowledged)), SIG)).toEqual(acknowledged);
    await expect(restarted.execution.submit(acknowledged, OTHER_SIG)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(restarted.calls).toEqual([]);
  });
  for (const patch of [{ orderId: "ord_other" }, { signature: OTHER_SIG }, { status: "confirmed" }, { signature: undefined }])
    test(`submit acknowledgement cannot mutate the binding: ${Object.entries(patch)[0]?.join("=")}`, async () => {
      const r = rig({ submit: patch }); const original = await r.execution.buildBuy(r.input);
      await expect(r.execution.submit(original.binding, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
      expect(original.binding.signature).toBeNull();
    });
  for (const invalid of ["not-a-signature", bs58.encode(Buffer.alloc(64)), OWNER]) test(`invalid signature: ${invalid}`, async () => {
    const r = rig(); const original = await r.execution.buildBuy(r.input);
    await expect(r.execution.submit(original.binding, invalid)).rejects.toMatchObject({ code: "VENUE_BAD_REQUEST" });
    expect(r.calls).toHaveLength(2);
  });
  for (const patch of [
    { owner: FOREIGN }, { venueMarketId: FOREIGN }, { side: "NO" }, { amountBaseUnits: "20000001" },
    { providerOrderId: "ord_other" }, { idempotencyKey: "other-key" }, { createdAt: NOW - 1 },
    { expiresAt: NOW + 1 }, { programId: FOREIGN }, { messageHash: "0".repeat(64) }, { amountUsdc: "21.000000" },
  ]) test(`binding tampering is rejected before submit/verify: ${Object.keys(patch)[0]}`, async () => {
    const r = rig(); const original = await r.execution.buildBuy(r.input);
    const saved = { ...original.binding, ...patch } as PantaOrderBinding;
    await expect(r.execution.submit(saved, SIG)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    await expect(r.execution.verify({ ...saved, signature: SIG })).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.calls).toHaveLength(2);
    expect(r.rpcCalls).toEqual([]);
  });
});

describe("synthetic provider attribution plus independent reviewed-message verification", () => {
  test("FILLED requires all gates and records USDC deposit units, never share quantity as USDC", async () => {
    const r = rig(); const binding = await submitted(r);
    const order = await r.execution.verify(binding);
    expect(order).toMatchObject({ venue: "panta", orderId: "ord_synthetic", venueOrderId: "ord_synthetic",
      owner: OWNER, venueMarketId: MARKET, side: "YES", amountBaseUnits: "20000000",
      filledBaseUnits: "20000000", fundingState: "FILLED", fillTxSignature: SIG, demo: false });
    expect(order.fillEvidence).toMatchObject({ messageHash: binding.messageHash, independentlyVerified: true,
      expectedShares: nativeShares, providerVerify: { amountUsdc: 20000000 }, providerTrade: { kind: "buy", status: "processed" } });
    expect(r.rpcCalls).toEqual([{ signature: SIG, owner: OWNER, market: MARKET, programId: PROGRAM,
      amountBaseUnits: "20000000", feeBaseUnits: "400001", messageHash: binding.messageHash }]);
    expect(r.calls.at(-1)).toEqual({ path: TRADE, body: { signature: SIG, wallet: OWNER, marketId: MARKET,
      quoteId: "qt_synthetic", clientOrderId: "synthetic-buy-1" } });
  });
  test("trusted durable approval verifies confirmed order after expiry without submit or rebuild", async () => {
    const initial = rig(); const prepared = await initial.execution.buildBuy(initial.input);
    // Main has validated the durable signed TX's crypto/message before recording
    // row.signature; the initial submit callback was lost. No live TX is used.
    const durable: PantaOrderBinding = JSON.parse(JSON.stringify(prepared.binding));
    initial.clock.advance(120_000);
    const restarted = rig({ clock: initial.clock });
    const recovered = await restarted.execution.verify({ ...durable, signature: SIG });
    expect(recovered.fundingState).toBe("FILLED");
    expect(recovered.fillTxSignature).toBe(SIG);
    expect(restarted.calls.map(call => call.path)).toEqual([VERIFY, TRADE]);
    expect(restarted.calls[0]?.body).toEqual({ orderId: durable.providerOrderId, wallet: durable.owner, signature: SIG });
    expect(restarted.rpcCalls[0]?.messageHash).toBe(durable.messageHash);
    expect(durable.signature).toBeNull();
  });
  test("unsigned built and expired orders cannot trigger blind provider/RPC probes", async () => {
    const r = rig(); const prepared = await r.execution.buildBuy(r.input);
    expect((await r.execution.verify(prepared.binding)).fundingState).toBe("QUOTED");
    r.clock.advance(60_000);
    expect((await r.execution.verify(prepared.binding)).fundingState).toBe("FAILED");
    expect(r.calls).toHaveLength(2); expect(r.rpcCalls).toEqual([]);
  });
  for (const status of ["built", "submitted", "failed", "expired"]) test(`provider ${status} is never FILLED`, async () => {
    const r = rig({ verify: { status } }); const binding = await submitted(r);
    const order = await r.execution.verify(binding);
    expect(order.fundingState).toBe(status === "failed" ? "FAILED" : "SUBMITTED");
    expect(order.filledBaseUnits).toBe("0"); expect(order.fillTxSignature).toBeNull();
    expect(r.calls.some(call => call.path === TRADE)).toBe(false); expect(r.rpcCalls).toEqual([]);
  });
  test("provider expiry for a durable signed/broadcast approval stays pending and exposes session expiry", async () => {
    const r = rig({ verify: { status: "expired" } }); const binding = await submitted(r);
    r.clock.advance(120_000);
    const order = await r.execution.verify(JSON.parse(JSON.stringify(binding)));
    expect(order).toMatchObject({ fundingState: "SUBMITTED", providerStatus: "expired", filledBaseUnits: "0", fillTxSignature: null });
    expect(order.fillEvidence).toBeUndefined();
    expect(r.calls.filter(call => call.path === SUBMIT)).toHaveLength(1);
    expect(r.calls.some(call => call.path === TRADE)).toBe(false);
    expect(r.rpcCalls).toEqual([]);
  });
  for (const patch of [
    { status: "unknown" }, { orderId: "ord_other" }, { signature: OTHER_SIG }, { wallet: FOREIGN },
    { marketId: FOREIGN }, { side: "no" }, { amountUsdc: 20 }, { amountUsdc: "20.01" }, { amountUsdc: "20.0000001" },
    { amountUsdc: 20_000_000.5 }, { amountUsdc: Number.MAX_SAFE_INTEGER + 1 }, { extra: true },
  ]) test(`verify schema/binding mismatch fails loudly: ${Object.entries(patch)[0]?.join("=")}`, async () => {
    const r = rig({ verify: patch }); const binding = await submitted(r);
    await expect(r.execution.verify(binding)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
    expect(r.calls.some(call => call.path === TRADE)).toBe(false); expect(r.rpcCalls).toEqual([]);
  });
  test("live Panta replies (human amount, fee, shares, expiry) FILL against the stake plus the reviewed fee", async () => {
    // Shapes as mainnet Panta answered for a real $2 buy on 2026-10-10.
    const r = rig({
      verify: { amountUsdc: "20.00", wallet: OWNER, expectedShares: nativeShares, feeUsdc: "0.40", lastError: "",
        expiresAt: new Date(NOW + 60_000).toISOString().replace(/\.\d+Z$/, "Z") },
      trade: { amountUsdc: "20.00", amountUsdcBase: "20000000" },
    });
    const binding = await submitted(r);
    const filled = await r.execution.verify(binding);
    expect(filled.fundingState).toBe("FILLED");
    expect(r.rpcCalls).toHaveLength(1);
    expect(r.rpcCalls[0]).toMatchObject({ amountBaseUnits: "20000000", feeBaseUnits: "400001" });
    // As the ledger's FILLED check requires: base units, and the reviewed message hash.
    expect(filled.fillEvidence?.providerVerify).toMatchObject({ amountUsdc: "20000000", amountUsdcReported: "20.00" });
    expect(filled.fillEvidence?.messageHash).toBe(binding.messageHash);
    expect(filled.fillEvidence?.signedMessageHash).toBeUndefined();
  });
  test("a trade report for another stake is not a fill", async () => {
    const r = rig({ trade: { amountUsdc: "21.00", amountUsdcBase: "21000000" } });
    const binding = await submitted(r);
    expect((await r.execution.verify(binding)).fundingState).toBe("SUBMITTED");
    expect(r.rpcCalls).toEqual([]);
  });
  for (const field of ["signature", "marketId", "side", "amountUsdc"]) test(`confirmed but incomplete verify evidence stays SUBMITTED: ${field}`, async () => {
    const r = rig({ verify: { [field]: undefined } }); const binding = await submitted(r);
    expect((await r.execution.verify(binding)).fundingState).toBe("SUBMITTED");
    expect(r.calls.some(call => call.path === TRADE)).toBe(false); expect(r.rpcCalls).toEqual([]);
  });
  for (const patch of [
    { status: undefined }, { kind: undefined }, { kind: "claim" }, { wallet: undefined }, { wallet: FOREIGN },
    { marketId: undefined }, { marketId: FOREIGN }, { side: undefined }, { side: "no" },
    { signature: undefined }, { signature: OTHER_SIG },
  ]) test(`incomplete/wrong trade attribution stays SUBMITTED: ${Object.entries(patch)[0]?.join("=")}`, async () => {
    const r = rig({ trade: patch }); const binding = await submitted(r);
    const order = await r.execution.verify(binding);
    expect(order.fundingState).toBe("SUBMITTED"); expect(order.fillTxSignature).toBeNull();
    expect(order.filledBaseUnits).toBe("0"); expect(order.fillEvidence).toBeUndefined();
    expect(r.rpcCalls).toEqual([]);
  });
  for (const patch of [{ wallet: 123 }, { side: "YES" }, { status: "invented-status" }, { extra: true }])
    test(`malformed attribution schema remains loud: ${Object.entries(patch)[0]?.join("=")}`, async () => {
      const r = rig({ trade: patch }); const binding = await submitted(r);
      await expect(r.execution.verify(binding)).rejects.toMatchObject({ code: "VENUE_SCHEMA" });
      expect(r.rpcCalls).toEqual([]);
    });
  test("provider confirmed and trade processed cannot fill when independent RPC returns false", async () => {
    const r = rig({ rpc: false }); const binding = await submitted(r);
    const result = await r.execution.verify(binding);
    expect(result.fundingState).toBe("SUBMITTED"); expect(result.fillTxSignature).toBeNull();
    expect(result.filledBaseUnits).toBe("0"); expect(result.fillEvidence).toBeUndefined();
    expect(r.rpcCalls).toHaveLength(1);
  });
  test("unsafe numeric verification units fail, but exact large integer strings verify", async () => {
    const r = rig({ input: intent({ amountBaseUnits: "9007199254740993" }) });
    const binding = await submitted(r);
    expect((await r.execution.verify(binding)).filledBaseUnits).toBe("9007199254740993");
    expect(r.rpcCalls[0]?.amountBaseUnits).toBe("9007199254740993");
  });
  test("independent verifier exceptions cannot expose raw RPC/provider errors", async () => {
    const r = rig({ rpcFailure: new Error("untrusted-rpc-body") }); const binding = await submitted(r);
    await expect(r.execution.verify(binding)).rejects.toThrow("independent verification unavailable");
  });
});
