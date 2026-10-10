/**
 * Bounded primary-buy execution, separate from the read-only PantaVenue.
 * Primary docs (read 2026-09-29): https://docs.panta.market/api-reference/
 * orders/{quote,build,submit,verify}.md, trades/report.md, claims/build.md,
 * positions.md; https://docs.panta.market/guides/{how-it-works,errors}.md.
 *
 * Main owns the pinned POST transport, credentials, response size/time limits,
 * wallet signing/broadcast, and durable storage/serialization by idempotencyKey.
 * Persist the returned binding before exposing an order; supply that trusted
 * server record for replay, submit and verify. Never accept a client-authored
 * binding. There is deliberately no in-memory order registry or automatic retry.
 *
 * Instruction policy primary_order_usdc/observed-v1 is based on Main's unfunded
 * YES 1.00 / NO 2.00 quote/build observations (2026-09-29): 17 data bytes and
 * 12 ordered accounts. The name-derived discriminator agrees with those bytes;
 * this is an observed bounded profile, NOT an authoritative or complete IDL.
 * Main observed canonical USDC ATA create-idempotent and wallet-signed Memo
 * instructions too. Its native Memo uses the API key's usr_ account identity,
 * independently of the app person id. canonicalUserId stays in server storage;
 * no quote/build/trade request forwards it as Panta userId. The native Memo is
 * validated without modification, and its provider id is stored for exact replay.
 * Quote/build observations establish no signature, broadcast
 * or actual fill. Live fill validation remains outstanding; synthetic tests
 * are not chain evidence, and Main owns all integration/enabling decisions.
 * The injected verifier must confirm a successful on-chain transaction with the
 * identical SHA-256 messageHash AND the supplied wallet/market/program/amount,
 * including an actual owner USDC debit of exactly amountBaseUnits.
 * Checking signature existence or a wallet balance alone is insufficient.
 */
import { createHash } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PACKET_DATA_SIZE, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.ts";
import { VenueError, type VenueErrorCode } from "./errors.ts";
import type { CreateOrderInput, UnsignedOrder, VenueOrder } from "./PredictionVenue.ts";

const bs58 = utils.bytes.bs58;
const U64_MAX = (1n << 64n) - 1n;
const USDC_SCALE = 1_000_000n;
const MAX_SESSION_MS = 300_000;
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_COMPUTE_PRICE = 1_000_000n; // micro-lamports per compute unit
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PRIMARY_BUY_DISCRIMINATOR = createHash("sha256").update("global:primary_order_usdc").digest().subarray(0, 8);
const NON_PANTA_PROGRAMS = new Set([
  SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), MEMO_PROGRAM,
  TOKEN_PROGRAM,
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  ATA_PROGRAM,
]);

function canonicalBase58(value: string, bytes: number): boolean {
  try {
    const decoded = bs58.decode(value);
    return decoded.length === bytes && bs58.encode(decoded) === value;
  } catch { return false; }
}
const address = z.string().min(32).max(44).refine(value => canonicalBase58(value, 32));
const signature = z.string().min(64).max(88).refine(value =>
  canonicalBase58(value, 64) && bs58.decode(value).some(byte => byte !== 0));
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const providerAttribution = z.string().min(5).max(128).regex(/^usr_[A-Za-z0-9][A-Za-z0-9_-]*$/);
const baseUnitsPattern = /^[1-9][0-9]{0,19}$/;
const baseUnits = z.string().regex(baseUnitsPattern)
  .refine(value => baseUnitsPattern.test(value) && BigInt(value) <= U64_MAX);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,38})(\.[0-9]{1,18})?$/);
const positiveDecimal = decimal.refine(value => /[1-9]/.test(value));
function usdcBase(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * USDC_SCALE + BigInt(fraction.padEnd(6, "0"));
}
const humanUsdcPattern = /^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$/;
const humanUsdc = z.string().regex(humanUsdcPattern)
  .refine(value => humanUsdcPattern.test(value) && usdcBase(value) <= U64_MAX);
// VERIFY's amountUsdc: integer BASE UNITS (a JSON integer or a digit string),
// or, as live Panta answers since October 2026, human USDC written with a
// decimal point ("2.00"). A digit string stays base units; never coerce an
// unsafe or fractional JSON number.
const pointedUsdc = z.string().regex(/^(0|[1-9][0-9]{0,13})\.[0-9]{1,6}$/);
const verifyAmount = z.union([baseUnits, pointedUsdc, z.number().int().positive().safe()]);
const verifiedBaseUnits = (value: string | number): string =>
  typeof value === "string" && value.includes(".") ? usdcBase(value).toString() : String(value);
const millis = z.number().int().nonnegative().safe();
const blockHeight = z.number().int().positive().safe();
const expiry = z.string().max(40).datetime({ offset: true });
const hint = z.number().int().min(1).max(MAX_SESSION_MS / 1000);
const nativeSide = z.enum(["yes", "no"]);
const side = z.enum(["YES", "NO"]);
const slippage = z.number().int().min(0).max(5000);
const base64 = z.string().max(Math.ceil(PACKET_DATA_SIZE / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(value => Buffer.from(value, "base64").toString("base64") === value);
const accountSchema = z.object({ pubkey: address, isSigner: z.boolean(), isWritable: z.boolean() }).strict();
const instructionSchema = z.object({ programId: address, data: base64,
  accounts: z.array(accountSchema).max(32) }).strict();
const derivedSchema = z.object({ userPosition: address, marketConfig: address, userTokenAccount: address,
  vaultTokenAccount: address, treasuryTokenAccount: address, vaultAuthority: address }).strict();
/** Echoed accounts are bound to the reviewed instruction, not guessed PDA seeds. */
export type PantaBuyAccounts = z.infer<typeof derivedSchema>;
type InstructionIntent = Pick<PantaOrderBinding, "owner" | "venueMarketId" | "side" | "amountBaseUnits" |
  "quoteId" | "providerOrderId" | "derived"> & { providerAttributionUserId?: string };

// Independently declared endpoint schemas: their monetary units are different.
// Quote's official example omits wallet; an echo, when present, must agree.
const quoteSchema = z.object({ quoteId: identifier, wallet: address.optional(),
  marketId: address, side: nativeSide, amountUsdc: humanUsdc, shares: positiveDecimal,
  avgPrice: positiveDecimal, feeUsdc: humanUsdc, expiresAt: expiry,
  blockhashExpiryHintSec: hint.optional(), userId: providerAttribution.optional() }).strict();
const buildSchema = z.object({ orderId: identifier, quoteId: identifier, wallet: address,
  marketId: address, side: nativeSide, amountUsdc: humanUsdc,
  expectedShares: positiveDecimal, feeUsdc: humanUsdc, status: z.literal("built"),
  instructions: z.array(instructionSchema).min(1).max(16), recentBlockhash: address,
  lastValidBlockHeight: blockHeight, expiresAt: expiry, blockhashExpiryHintSec: hint.optional(),
  derived: derivedSchema,
  userId: providerAttribution.optional() }).strict();
const submitSchema = z.object({ orderId: identifier, status: z.literal("submitted"), signature }).strict();
const verifySchema = z.object({ orderId: identifier,
  status: z.enum(["built", "submitted", "confirmed", "failed", "expired"]),
  signature: signature.nullable().optional(), wallet: address.optional(),
  marketId: address.optional(), side: nativeSide.optional(), amountUsdc: verifyAmount.optional(),
  // Live Panta also reports these. Typed, informational, never a money gate.
  expectedShares: decimal.optional(), feeUsdc: humanUsdc.optional(),
  lastError: z.string().max(500).optional(), expiresAt: expiry.optional(),
}).strict();
// Missing attribution is absence of fill evidence. Present fields must still
// conform to their exact types; unknown fields/statuses remain schema failures.
const tradeSchema = z.object({ signature: signature.optional(), status: z.literal("processed").optional(),
  marketId: address.optional(), wallet: address.optional(), side: nativeSide.optional(),
  kind: z.enum(["buy", "claim"]).optional(),
  // Live Panta reports the amount both ways; the base units must be the reviewed stake.
  amountUsdc: humanUsdc.optional(), amountUsdcBase: baseUnits.optional() }).strict();

const reviewSchema = z.object({ amountUsdc: humanUsdc, amountBaseUnits: baseUnits,
  avgPrice: positiveDecimal, feeUsdc: humanUsdc, expectedShares: positiveDecimal,
  maxSlippageBps: slippage, currency: z.literal("USDC"), priceUnit: z.literal("USDC/share"),
  sharesUnit: z.literal("shares"), quotedProbability: z.null(), attribution: z.literal("Powered by Panta") }).strict();
/** avgPrice is the native quote value; feeUsdc/expectedShares are native build values. */
export type PantaOrderReview = z.infer<typeof reviewSchema>;
const unsignedSchema = z.object({ orderId: identifier, venue: z.literal("panta"),
  venueMarketId: address, owner: address, side, amountBaseUnits: baseUnits,
  quotedProbability: z.null(), fundingState: z.literal("QUOTED"),
  transaction: z.object({ venue: z.literal("panta"), encoding: z.literal("solana-tx-base64"),
    payload: base64.refine(value => value.length > 0), expiresAt: millis, demo: z.literal(false) }).strict(),
  idempotencyKey: identifier, createdAt: millis, expiresAt: millis, demo: z.literal(false) }).strict();
const bindingSchema = z.object({ version: z.literal(1), quoteId: identifier, providerOrderId: identifier,
  owner: address, venueMarketId: address, side, amountBaseUnits: baseUnits, amountUsdc: humanUsdc,
  idempotencyKey: identifier, canonicalUserId: identifier.nullable(), providerAttributionUserId: providerAttribution, programId: address,
  createdAt: millis, expiresAt: millis, lastValidBlockHeight: blockHeight,
  signature: signature.nullable(), messageHash: z.string().regex(/^[a-f0-9]{64}$/),
  // Set only for verification when the wallet app amended the reviewed message (walletAmendment.ts).
  signedMessageHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  derived: derivedSchema, unsignedOrder: unsignedSchema, review: reviewSchema }).strict();
/** JSON-serializable durable server record; Main owns its storage and identity. */
export type PantaOrderBinding = Omit<z.infer<typeof bindingSchema>, "unsignedOrder" | "providerAttributionUserId"> & {
  unsignedOrder: UnsignedOrder;
  /** Private provider account metadata. Never infer an app person from this id. */
  readonly providerAttributionUserId: string;
};
/** canonicalUserId MUST be Main's verified person id; it is never forwarded to Panta. */
export type PantaBuyInput = CreateOrderInput & { maxSlippageBps?: number; canonicalUserId?: string };
export interface PantaPreparedOrder {
  order: UnsignedOrder;
  binding: PantaOrderBinding;
  review: PantaOrderReview;
}
const inputSchema = z.object({ idempotencyKey: identifier, owner: address, venueMarketId: address,
  side, amountBaseUnits: baseUnits, limitProbability: z.null().optional(),
  maxSlippageBps: slippage.optional(), canonicalUserId: identifier.optional() }).strict();
export interface PantaExecutionConfig {
  request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  clock?: Clock;
  programId: string;
  /** Server-configured account bound to the Panta API key, not an app person. */
  providerUserId: string;
  verifyTransaction: (input: { signature: string; owner: string; market: string; programId: string;
    amountBaseUnits: string; feeBaseUnits?: string; messageHash: string }) => Promise<boolean>;
}
/** Strictly parsed provider evidence, attached ONLY after the independent RPC gate. */
export interface PantaFillEvidence {
  providerVerify: z.infer<typeof verifySchema>;
  providerTrade: z.infer<typeof tradeSchema>;
  messageHash: string;
  independentlyVerified: true;
  expectedShares: string;
}
export interface PantaVerifiedOrder extends VenueOrder {
  fillEvidence?: PantaFillEvidence;
  /** Provider session TTL expiry is diagnostic, never proof the TX failed. */
  providerStatus?: z.infer<typeof verifySchema>["status"];
}

function check(condition: unknown, message: string, code: VenueErrorCode = "VENUE_SCHEMA"): asserts condition {
  if (!condition) throw new VenueError(code, `Panta execution: ${message}`, { venue: "panta" });
}
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, label: string): z.infer<S> {
  const result = schema.safeParse(value);
  check(result.success, `invalid ${label}`);
  return result.data;
}
function formatUsdc(value: string): string {
  const units = BigInt(value);
  return `${units / USDC_SCALE}.${(units % USDC_SCALE).toString().padStart(6, "0")}`;
}
function messageHash(transaction: VersionedTransaction): string {
  return createHash("sha256").update(transaction.message.serialize()).digest("hex");
}

export class PantaExecution {
  private readonly clock: Clock;
  private readonly programId: string;
  private readonly providerUserId: string;
  private readonly request: PantaExecutionConfig["request"];
  private readonly verifyTransaction: PantaExecutionConfig["verifyTransaction"];

  constructor(config: PantaExecutionConfig) {
    check(address.safeParse(config.programId).success && !NON_PANTA_PROGRAMS.has(config.programId),
      "an explicit Panta program is required", "VENUE_MISCONFIGURED");
    check(typeof config.request === "function" && typeof config.verifyTransaction === "function",
      "transport and independent verifier are required", "VENUE_MISCONFIGURED");
    check(providerAttribution.safeParse(config.providerUserId).success,
      "a pinned Panta partner account is required", "VENUE_MISCONFIGURED");
    this.clock = config.clock ?? systemClock;
    this.programId = config.programId;
    this.providerUserId = config.providerUserId;
    this.request = config.request;
    this.verifyTransaction = config.verifyTransaction;
  }

  /**
   * Bootstrap creates a binding. For an existing key, Main must load and supply
   * its durable binding as the second argument: replay returns the EXACT order
   * without quote/build calls. Main must serialize bootstrap across processes.
   */
  async buildBuy(input: PantaBuyInput, binding?: PantaOrderBinding): Promise<PantaPreparedOrder> {
    check(inputSchema.safeParse(input).success, "invalid buy intent or unsupported probability limit", "VENUE_BAD_REQUEST");
    const intent = inputSchema.parse(input);
    const maxSlippageBps = intent.maxSlippageBps ?? 100;
    if (binding !== undefined) {
      const saved = this.validateBinding(binding);
      check(saved.idempotencyKey === intent.idempotencyKey && saved.owner === intent.owner &&
        saved.venueMarketId === intent.venueMarketId && saved.side === intent.side &&
        saved.amountBaseUnits === intent.amountBaseUnits && saved.canonicalUserId === (intent.canonicalUserId ?? null) &&
        saved.review.maxSlippageBps === maxSlippageBps, "replay intent differs", "IDEMPOTENCY_CONFLICT");
      this.requireFuture(saved.expiresAt);
      return { order: saved.unsignedOrder, binding: saved, review: saved.review };
    }
    check(intent.owner !== intent.venueMarketId && intent.owner !== this.programId && intent.venueMarketId !== this.programId,
      "wallet, market and program must be distinct", "VENUE_BAD_REQUEST");
    const createdAt = this.now();
    const amountUsdc = formatUsdc(intent.amountBaseUnits);
    const providerSide = intent.side === "YES" ? "yes" : "no";
    const quote = parse(quoteSchema, await this.post("/primaryorderquote/", {
      wallet: intent.owner, marketId: intent.venueMarketId, side: providerSide, amountUsdc,
    }), "quote response");
    check((quote.wallet === undefined || quote.wallet === intent.owner) && quote.marketId === intent.venueMarketId &&
      quote.side === providerSide && usdcBase(quote.amountUsdc).toString() === intent.amountBaseUnits,
      "quote intent mismatch");
    check(usdcBase(quote.feeUsdc) <= BigInt(intent.amountBaseUnits), "quote fee exceeds deposit");
    const quoteExpiry = this.sessionExpiry(quote.expiresAt);
    const buildStartedAt = this.now();
    const build = parse(buildSchema, await this.post("/primaryorderbuild/", {
      quoteId: quote.quoteId, wallet: intent.owner, maxSlippageBps,
    }), "build response");
    check(build.quoteId === quote.quoteId && build.wallet === intent.owner && build.marketId === intent.venueMarketId &&
      build.side === providerSide && usdcBase(build.amountUsdc).toString() === intent.amountBaseUnits,
      "build intent mismatch");
    check(usdcBase(build.feeUsdc) <= BigInt(intent.amountBaseUnits), "build fee exceeds deposit");
    const expiresAt = Math.min(quoteExpiry, this.sessionExpiry(build.expiresAt),
      buildStartedAt + (build.blockhashExpiryHintSec ?? 60) * 1000);
    this.requireFuture(expiresAt);
    const instructions = build.instructions.map(ix => new TransactionInstruction({
      programId: new PublicKey(ix.programId), data: Buffer.from(ix.data, "base64"),
      keys: ix.accounts.map(account => ({ pubkey: new PublicKey(account.pubkey),
        isSigner: account.isSigner, isWritable: account.isWritable })),
    }));
    const instructionIntent: InstructionIntent = { owner: intent.owner, venueMarketId: intent.venueMarketId,
      side: intent.side, amountBaseUnits: intent.amountBaseUnits, quoteId: quote.quoteId,
      providerOrderId: build.orderId, derived: build.derived, providerAttributionUserId: this.providerUserId };
    const providerAttributionUserId = this.validateInstructions(instructions, instructionIntent, "wire");
    check((quote.userId === undefined || quote.userId === providerAttributionUserId) &&
      (build.userId === undefined || build.userId === providerAttributionUserId), "provider attribution echo differs from native Memo");
    let payload: string;
    try {
      const message = new TransactionMessage({ payerKey: new PublicKey(intent.owner),
        recentBlockhash: build.recentBlockhash, instructions }).compileToV0Message();
      const bytes = new VersionedTransaction(message).serialize();
      check(bytes.length <= PACKET_DATA_SIZE, "transaction exceeds Solana packet size");
      payload = Buffer.from(bytes).toString("base64");
    } catch { throw new VenueError("VENUE_SCHEMA", "Panta execution: invalid or oversized transaction", { venue: "panta" }); }
    const transaction = this.validateTransaction(payload, { ...instructionIntent, providerAttributionUserId });
    const order: UnsignedOrder = { orderId: build.orderId, venue: "panta", venueMarketId: intent.venueMarketId,
      owner: intent.owner, side: intent.side, amountBaseUnits: intent.amountBaseUnits, quotedProbability: null,
      fundingState: "QUOTED", transaction: { venue: "panta", encoding: "solana-tx-base64", payload, expiresAt, demo: false },
      idempotencyKey: intent.idempotencyKey, createdAt, expiresAt, demo: false };
    const review: PantaOrderReview = { amountUsdc, amountBaseUnits: intent.amountBaseUnits,
      avgPrice: quote.avgPrice, feeUsdc: build.feeUsdc, expectedShares: build.expectedShares, maxSlippageBps,
      currency: "USDC", priceUnit: "USDC/share", sharesUnit: "shares", quotedProbability: null, attribution: "Powered by Panta" };
    const saved = this.validateBinding({ version: 1, quoteId: quote.quoteId, providerOrderId: build.orderId,
      owner: intent.owner, venueMarketId: intent.venueMarketId, side: intent.side, amountBaseUnits: intent.amountBaseUnits,
      amountUsdc, idempotencyKey: intent.idempotencyKey, canonicalUserId: intent.canonicalUserId ?? null, providerAttributionUserId,
      programId: this.programId, createdAt, expiresAt, lastValidBlockHeight: build.lastValidBlockHeight,
      signature: null, messageHash: messageHash(transaction), derived: build.derived, unsignedOrder: order, review });
    this.requireFuture(saved.expiresAt);
    return { order: saved.unsignedOrder, binding: saved, review: saved.review };
  }

  /** Register a broadcast signature; it never broadcasts, probes RPC, or fills. */
  async submit(binding: PantaOrderBinding, submittedSignature: string): Promise<PantaOrderBinding> {
    const saved = this.validateBinding(binding);
    check(signature.safeParse(submittedSignature).success, "invalid submitted signature", "VENUE_BAD_REQUEST");
    check(saved.signature === null || saved.signature === submittedSignature, "signature cannot change", "IDEMPOTENCY_CONFLICT");
    // An acknowledged signature stays replayable even after the build TTL.
    if (saved.signature === submittedSignature) return saved;
    this.requireFuture(saved.expiresAt);
    const ack = parse(submitSchema, await this.post("/primaryordersubmit/", {
      orderId: saved.providerOrderId, signature: submittedSignature, wallet: saved.owner,
    }), "submit response");
    check(ack.orderId === saved.providerOrderId && ack.signature === submittedSignature, "submit acknowledgement mismatch");
    return { ...saved, signature: submittedSignature };
  }

  /** Reconciliation may run after TTL: only provider confirmed + both gates fill. */
  async verify(binding: PantaOrderBinding): Promise<PantaVerifiedOrder> {
    const saved = this.validateBinding(binding);
    const pending = (): PantaVerifiedOrder => this.venueOrder(saved, saved.signature === null ?
      (saved.expiresAt <= this.now() ? "FAILED" : "QUOTED") : "SUBMITTED");
    if (saved.signature === null) return pending();
    const verification = parse(verifySchema, await this.post("/primaryorderverify/", {
      orderId: saved.providerOrderId, wallet: saved.owner, signature: saved.signature,
    }), "verify response");
    check(verification.orderId === saved.providerOrderId &&
      (verification.signature == null || verification.signature === saved.signature) &&
      (verification.wallet === undefined || verification.wallet === saved.owner) &&
      (verification.marketId === undefined || verification.marketId === saved.venueMarketId) &&
      (verification.side === undefined || verification.side === saved.side.toLowerCase()) &&
      (verification.amountUsdc === undefined || verifiedBaseUnits(verification.amountUsdc) === saved.amountBaseUnits),
      "verify intent or signature mismatch");
    if (verification.status === "failed") return this.venueOrder(saved, "FAILED");
    if (verification.status === "expired") return { ...pending(), providerStatus: "expired" };
    if (verification.status !== "confirmed") return pending();
    // Panta says confirmed but a gate below is not met yet: still pending, and
    // marked so a reconciler never reads an unseen signature as "never landed".
    const confirmedPending = (): PantaVerifiedOrder => ({ ...pending(), providerStatus: "confirmed" });
    if (verification.signature !== saved.signature || verification.marketId !== saved.venueMarketId ||
        verification.side !== saved.side.toLowerCase() || verification.amountUsdc === undefined) return confirmedPending();
    const trade = parse(tradeSchema, await this.post("/trades/", {
      signature: saved.signature, wallet: saved.owner, marketId: saved.venueMarketId,
      quoteId: saved.quoteId, clientOrderId: saved.idempotencyKey,
    }), "trade report response");
    if (trade.amountUsdcBase !== undefined && trade.amountUsdcBase !== saved.amountBaseUnits) return confirmedPending();
    if (trade.status !== "processed" || trade.kind !== "buy" || trade.signature !== saved.signature ||
        trade.wallet !== saved.owner || trade.marketId !== saved.venueMarketId || trade.side !== saved.side.toLowerCase()) return confirmedPending();
    let independentlyVerified: boolean;
    try {
      independentlyVerified = await this.verifyTransaction({ signature: saved.signature, owner: saved.owner,
        market: saved.venueMarketId, programId: this.programId, amountBaseUnits: saved.amountBaseUnits,
        // The program takes the reviewed fee from the owner in the same transaction.
        feeBaseUnits: usdcBase(saved.review.feeUsdc).toString(),
        messageHash: saved.signedMessageHash ?? saved.messageHash });
    } catch { throw new VenueError("VENUE_UNAVAILABLE", "Panta execution: independent verification unavailable", { venue: "panta" }); }
    if (independentlyVerified !== true) return confirmedPending();
    return { ...this.venueOrder(saved, "FILLED"), fillEvidence: { providerVerify: verification, providerTrade: trade,
      messageHash: saved.signedMessageHash ?? saved.messageHash, independentlyVerified: true, expectedShares: saved.review.expectedShares } };
  }

  private validateBinding(value: unknown): PantaOrderBinding {
    const saved = parse(bindingSchema, value, "durable binding");
    const order = saved.unsignedOrder;
    check(saved.programId === this.programId && saved.providerAttributionUserId === this.providerUserId &&
      saved.owner !== saved.venueMarketId && saved.owner !== this.programId &&
      saved.venueMarketId !== this.programId && saved.createdAt <= this.now() && saved.expiresAt > saved.createdAt &&
      saved.expiresAt - saved.createdAt <= MAX_SESSION_MS, "binding program, identity or lifetime mismatch");
    check(order.orderId === saved.providerOrderId && order.owner === saved.owner && order.venueMarketId === saved.venueMarketId &&
      order.side === saved.side && order.amountBaseUnits === saved.amountBaseUnits && order.idempotencyKey === saved.idempotencyKey &&
      order.createdAt === saved.createdAt && order.expiresAt === saved.expiresAt && order.transaction.expiresAt === saved.expiresAt,
      "binding and unsigned order differ");
    check(saved.amountUsdc === formatUsdc(saved.amountBaseUnits) && saved.review.amountUsdc === saved.amountUsdc &&
      saved.review.amountBaseUnits === saved.amountBaseUnits && usdcBase(saved.review.feeUsdc) <= BigInt(saved.amountBaseUnits),
      "binding review amount mismatch");
    const transaction = this.validateTransaction(order.transaction.payload, saved);
    check(messageHash(transaction) === saved.messageHash, "reviewed message hash mismatch");
    return saved;
  }

  private validateTransaction(payload: string, intent: InstructionIntent & { providerAttributionUserId: string }): VersionedTransaction {
    try {
      check(base64.safeParse(payload).success, "noncanonical transaction encoding");
      const bytes = Buffer.from(payload, "base64");
      check(bytes.length > 0 && bytes.length <= PACKET_DATA_SIZE, "invalid transaction size");
      const tx = VersionedTransaction.deserialize(bytes);
      check(tx.version === 0 && tx.message.addressTableLookups.length === 0 &&
        tx.message.header.numRequiredSignatures === 1 && tx.message.header.numReadonlySignedAccounts === 0 &&
        tx.message.staticAccountKeys[0]?.toBase58() === intent.owner && tx.signatures.length === 1 &&
        tx.signatures.every(sig => sig.length === 64 && sig.every(byte => byte === 0)),
        "transaction must be unsigned v0 with only the owner as payer/signer");
      check(Buffer.from(tx.serialize()).equals(bytes), "noncanonical transaction serialization");
      check(new Set(tx.message.staticAccountKeys.map(key => key.toBase58())).size === tx.message.staticAccountKeys.length,
        "duplicate compiled account keys");
      for (const ix of tx.message.compiledInstructions) {
        check(!tx.message.isAccountSigner(ix.programIdIndex) && !tx.message.isAccountWritable(ix.programIdIndex),
          "invoked program is writable or a signer");
      }
      const instructions = TransactionMessage.decompile(tx.message).instructions;
      this.validateInstructions(instructions, intent, "compiled");
      const used = new Set(instructions.flatMap(ix => [ix.programId.toBase58(), ...ix.keys.map(key => key.pubkey.toBase58())]));
      check(used.size === tx.message.staticAccountKeys.length && tx.message.staticAccountKeys.every(key => used.has(key.toBase58())),
        "unused or unknown compiled account keys");
      return tx;
    } catch { throw new VenueError("VENUE_SCHEMA", "Panta execution: invalid reviewed transaction", { venue: "panta" }); }
  }

  private validateInstructions(instructions: TransactionInstruction[], intent: InstructionIntent, mode: "wire" | "compiled"): string {
    check(instructions.length >= 2 && instructions.length <= 5, "invalid instruction count");
    const { owner, venueMarketId, derived } = intent;
    const ata = PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(),
      new PublicKey(USDC_MINT).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58();
    check(derived.userTokenAccount === ata, "user token account is not the owner's canonical USDC ATA");
    const meta = (pubkey: string, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
    const buyAccounts = [meta(owner, true, true), meta(venueMarketId, true), meta(derived.marketConfig),
      meta(derived.vaultAuthority), meta(derived.vaultTokenAccount, true), meta(derived.userPosition, true),
      meta(USDC_MINT), meta(ata, true), meta(derived.treasuryTokenAccount, true),
      meta(TOKEN_PROGRAM), meta(ATA_PROGRAM), meta(SystemProgram.programId.toBase58())];
    check(new Set(buyAccounts.map(account => account.pubkey)).size === 12 &&
      buyAccounts.every(account => account.pubkey !== this.programId && account.pubkey !== MEMO_PROGRAM &&
        account.pubkey !== ComputeBudgetProgram.programId.toBase58()), "aliased primary-buy account roles");
    const checkAccounts = (ix: TransactionInstruction, expected: z.infer<typeof accountSchema>[]) => {
      check(ix.keys.length === expected.length, "unexpected instruction account count");
      for (const [index, account] of expected.entries()) {
        // Solana merges privileges globally. Only the duplicated wallet roles
        // in ATA and Memo may gain signer/writable flags after compilation.
        const promoted = mode === "compiled" && account.pubkey === owner;
        const actual = ix.keys[index]!;
        check(actual.pubkey.toBase58() === account.pubkey && actual.isSigner === (promoted || account.isSigner) &&
          actual.isWritable === (promoted || account.isWritable), "instruction account identity or privileges differ");
      }
    };
    const buyData = Buffer.alloc(17);
    PRIMARY_BUY_DISCRIMINATOR.copy(buyData);
    buyData[8] = intent.side === "YES" ? 0 : 1;
    buyData.writeBigUInt64LE(BigInt(intent.amountBaseUnits), 9);
    let stage = 0; // ComputeBudget* -> ATA? -> one primary buy -> one Memo
    let seenAta = false;
    let seenBuy = false;
    let seenMemo = false;
    let providerAttributionUserId: string | undefined;
    let seenLimit = false;
    let seenPrice = false;
    for (const ix of instructions) {
      const program = ix.programId.toBase58();
      check(ix.keys.length <= 12 && ix.data.length <= PACKET_DATA_SIZE, "invalid instruction accounts or data");
      check(ix.keys.every(key => !key.isSigner || key.pubkey.toBase58() === owner), "foreign instruction signer");
      if (program === this.programId) {
        check(!seenBuy && stage <= 1 && ix.data.equals(buyData), "primary-buy instruction or side/amount mismatch");
        checkAccounts(ix, buyAccounts);
        seenBuy = true;
        stage = 2;
      } else if (program === ATA_PROGRAM) {
        check(!seenAta && stage === 0 && ix.data.equals(Buffer.from([1])), "only one canonical ATA create-idempotent is allowed");
        checkAccounts(ix, [meta(owner, true, true), meta(ata, true), meta(owner), meta(USDC_MINT),
          meta(SystemProgram.programId.toBase58()), meta(TOKEN_PROGRAM)]);
        seenAta = true;
        stage = 1;
      } else if (program === ComputeBudgetProgram.programId.toBase58()) {
        check(stage === 0 && ix.keys.length === 0, "ComputeBudget must precede the buy and have no accounts");
        if (ix.data[0] === 2 && ix.data.length === 5) {
          const units = ix.data.readUInt32LE(1);
          check(!seenLimit && units > 0 && units <= MAX_COMPUTE_UNITS, "unbounded or duplicate compute limit");
          seenLimit = true;
        } else if (ix.data[0] === 3 && ix.data.length === 9) {
          check(!seenPrice && ix.data.readBigUInt64LE(1) <= MAX_COMPUTE_PRICE, "unbounded or duplicate compute price");
          seenPrice = true;
        } else check(false, "unsupported ComputeBudget instruction");
      } else if (program === MEMO_PROGRAM) {
        check(!seenMemo && stage === 2, "exactly one attribution Memo must follow the buy");
        checkAccounts(ix, [meta(owner, false, true)]);
        const text = ix.data.toString("utf8"), prefix = "panta:v1:", suffix = `:${intent.quoteId}:${intent.providerOrderId}`;
        check(text.startsWith(prefix) && text.endsWith(suffix) && Buffer.from(text, "utf8").equals(ix.data), "invalid attribution Memo");
        const memoUserId = text.slice(prefix.length, text.length - suffix.length);
        check(providerAttribution.safeParse(memoUserId).success, "invalid native provider attribution identifier");
        check(intent.providerAttributionUserId === undefined ? mode === "wire" : memoUserId === intent.providerAttributionUserId,
          "Memo attribution differs from the stored provider account");
        providerAttributionUserId = memoUserId;
        seenMemo = true;
        stage = 3;
      } else check(false, "unsupported instruction program");
    }
    check(seenBuy && seenMemo, "one configured primary buy and one attribution Memo are required");
    check(providerAttributionUserId !== undefined, "native provider attribution is required");
    return providerAttributionUserId;
  }

  private venueOrder(binding: PantaOrderBinding, fundingState: "QUOTED" | "SUBMITTED" | "FAILED" | "FILLED"): PantaVerifiedOrder {
    return { orderId: binding.providerOrderId, venueOrderId: binding.providerOrderId, venue: "panta", venueMarketId: binding.venueMarketId,
      owner: binding.owner, side: binding.side, amountBaseUnits: binding.amountBaseUnits,
      filledBaseUnits: fundingState === "FILLED" ? binding.amountBaseUnits : "0", fundingState,
      fillTxSignature: fundingState === "FILLED" ? binding.signature : null, createdAt: binding.createdAt,
      updatedAt: this.now(), idempotencyKey: binding.idempotencyKey, demo: false };
  }
  private now(): number {
    const now = this.clock.now();
    check(millis.safeParse(now).success, "invalid clock", "VENUE_MISCONFIGURED");
    return now;
  }
  private sessionExpiry(value: string): number {
    const at = Date.parse(value);
    this.requireFuture(at);
    check(at - this.now() <= MAX_SESSION_MS, "unbounded provider expiry");
    return at;
  }
  private requireFuture(at: number): void {
    check(millis.safeParse(at).success && at > this.now(), "order session expired or invalid", "VENUE_BAD_REQUEST");
  }
  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    try { return await this.request(path, body); }
    catch (error) {
      // Main's trusted transport owns business-code mapping and sanitization.
      // Preserve its actionable VenueError; never expose an arbitrary rejection.
      if (error instanceof VenueError) throw error;
      throw new VenueError("VENUE_UNAVAILABLE", "Panta execution: request unavailable", { venue: "panta" });
    }
  }
}
