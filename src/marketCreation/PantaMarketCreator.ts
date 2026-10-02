/**
 * Server-side Panta market creation, separate from the read-only PantaVenue and
 * the primary-buy PantaExecution. Primary docs (read 2026-10-02):
 * https://docs.panta.market/api-reference/markets/{overview,image-upload,quote,
 * build,register}.md and https://docs.panta.market/guides/{how-it-works,
 * authentication,errors}.md. Research notes: docs/panta-market-creation.md.
 *
 * Flow: image-upload (signed Cloudinary form) -> quote (fee, createId,
 * expectedEventPda) -> build (unsigned VersionedTransaction) -> the creator's
 * wallet signs -> WE broadcast -> register (Panta verifies on-chain, writes the
 * catalog). The API key stays here; the client sees only the reviewed unsigned
 * transaction, the fee and the expected market address.
 *
 * Transaction policy `panta-create/docs-v1` is derived from the documentation,
 * NOT from a live unsigned build (none was taken: creating costs a real fee and
 * development must not create a market). It is deliberately narrow and fails
 * closed: one signer that is the fee payer, the quoted blockhash, no lookup
 * tables, and only Panta / ComputeBudget / ATA-create-idempotent / Memo at the
 * top level. USDC can only move inside the pinned Panta program; the exact
 * debit is proven after landing by PantaChain.verifyTransaction. If Panta's
 * real create needs another top-level program, prepare refuses with
 * MC_SCHEMA and nothing reaches a wallet — widen the policy only after reading
 * an actual unsigned build.
 */
import { createHash } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PACKET_DATA_SIZE, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { systemClock, type Clock } from "../prediction/clock.ts";
import { MAINNET_USDC_MINT } from "../prediction/PantaChain.ts";
import { PANTA_BASE_URL } from "../prediction/PantaVenue.ts";
import { registerSecret } from "../prediction/redact.ts";
import { coverPng } from "./cover.ts";
import { MarketCreationError, PANTA_CREATE_CODES, PANTA_CREATE_FIELDS, pantaRefusalMessage } from "./errors.ts";
import { pantaTimes, type MarketDraft, type PantaCreateCategory } from "./rules.ts";

export const CREATE_POLICY = "panta-create/docs-v1";
const bs58 = utils.bytes.bs58;
const MAX_SESSION_MS = 300_000;
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_COMPUTE_PRICE = 1_000_000n; // micro-lamports per compute unit
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_PROGRAM = ComputeBudgetProgram.programId.toBase58();

export type CreatePath = "/markets/create/image-upload/" | "/markets/create/quote/" | "/markets/create/build/" | "/markets/register/";
const CREATE_PATHS = new Set<string>(["/markets/create/image-upload/", "/markets/create/quote/", "/markets/create/build/", "/markets/register/"]);
export type CreateRequest = (path: CreatePath, body: Record<string, unknown>) => Promise<unknown>;
/** Upload PNG bytes to a signed Cloudinary form; returns the response JSON. */
export type CoverUpload = (uploadUrl: string, fields: Record<string, string>, png: Uint8Array) => Promise<unknown>;

function canonicalBase58(value: string, bytes: number): boolean {
  try {
    const decoded = bs58.decode(value);
    return decoded.length === bytes && bs58.encode(decoded) === value;
  } catch { return false; }
}
const address = z.string().min(32).max(44).refine(value => canonicalBase58(value, 32));
const signatureSchema = z.string().min(64).max(88).refine(value =>
  canonicalBase58(value, 64) && bs58.decode(value).some(byte => byte !== 0));
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const expiry = z.string().max(40).datetime({ offset: true });
const hint = z.number().int().min(1).max(MAX_SESSION_MS / 1000);
const base64 = z.string().min(4).max(Math.ceil(PACKET_DATA_SIZE / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(value => Buffer.from(value, "base64").toString("base64") === value);

// Unobserved live shapes: known fields are typed exactly, unknown fields are
// dropped (not trusted), and every echo must agree with what we asked for.
const uploadSchema = z.object({
  uploadUrl: z.string().max(256).regex(/^https:\/\/api\.cloudinary\.com\/v1_1\/[A-Za-z0-9_-]{1,64}\/image\/upload$/),
  publicId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_./-]+$/),
  expiresAt: expiry.optional(),
  fields: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.union([z.string().max(512), z.number(), z.boolean()]))
    .refine(fields => Object.keys(fields).length <= 24 && !("file" in fields)),
});
const cloudinarySchema = z.object({
  secure_url: z.string().max(2048).regex(/^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_-]{1,64}\/image\/upload\/[^\s?#]+$/),
  public_id: z.string().max(256).optional(),
});
const quoteSchema = z.object({
  createId: identifier, expectedEventPda: address, paymentUsdc: baseUnits,
  liquidityInjectionUsdc: baseUnits, platformRevenueUsdc: baseUnits,
  marketType: z.literal("standard").optional(), expiresAt: expiry, blockhashExpiryHintSec: hint.optional(),
});
const buildSchema = z.object({
  createId: identifier, expectedEventPda: address.optional(), transaction: base64,
  recentBlockhash: address, lastValidBlockHeight: z.number().int().positive().safe(),
  blockhashExpiryHintSec: hint.optional(), buildFingerprint: z.string().min(1).max(256),
  paymentUsdc: baseUnits.optional(), liquidityInjectionUsdc: baseUnits.optional(), platformRevenueUsdc: baseUnits.optional(),
  marketType: z.literal("standard").optional(),
  derived: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,40}$/), address)
    .refine(derived => Object.keys(derived).length <= 16 && typeof derived.event === "string"),
  expiresAt: expiry,
});
const registerSchema = z.object({
  createId: identifier.optional(), marketId: address, status: z.literal("registered"),
  signature: signatureSchema.optional(), images: z.array(z.string().max(2048)).max(4).optional(),
});

/** The durable, server-only record of one reviewed create. JSON-serialisable. */
export interface CreateBinding {
  version: 1;
  policy: typeof CREATE_POLICY;
  createId: string;
  eventPda: string;
  wallet: string;
  programId: string;
  paymentBaseUnits: string;
  liquidityBaseUnits: string;
  platformBaseUnits: string;
  startTime: number;
  endTime: number;
  resolutionTime: number;
  category: PantaCreateCategory;
  question: string;
  imageUrl: string;
  transaction: string;
  messageHash: string;
  lastValidBlockHeight: number;
  buildFingerprint: string;
  createdAt: number;
  expiresAt: number;
}
const bindingSchema = z.object({
  version: z.literal(1), policy: z.literal(CREATE_POLICY), createId: identifier, eventPda: address, wallet: address,
  programId: address, paymentBaseUnits: baseUnits, liquidityBaseUnits: baseUnits, platformBaseUnits: baseUnits,
  startTime: z.number().int().positive(), endTime: z.number().int().positive(), resolutionTime: z.number().int().positive(),
  category: z.string(), question: z.string().min(1).max(512), imageUrl: z.string().max(2048),
  transaction: base64, messageHash: z.string().regex(/^[0-9a-f]{64}$/),
  lastValidBlockHeight: z.number().int().positive().safe(), buildFingerprint: z.string().min(1).max(256),
  createdAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe(),
}).strict();

export interface PantaMarketCreatorConfig {
  request: CreateRequest;
  upload: CoverUpload;
  programId: string;
  /** Refuse any quote whose total fee exceeds this (USDC base units). */
  maxFeeBaseUnits: string;
  clock?: Clock;
}

function schema(message: string): never {
  throw new MarketCreationError("MC_SCHEMA", `Panta's create response failed a safety check (${message}). Nothing was signed.`);
}
function parse<S extends z.ZodTypeAny>(s: S, value: unknown, label: string): z.infer<S> {
  const result = s.safeParse(value);
  if (!result.success) schema(label);
  return result.data;
}
export const messageHashOf = (tx: VersionedTransaction): string =>
  createHash("sha256").update(tx.message.serialize()).digest("hex");
/** The blockhash the reviewed create was built on (validated at prepare). */
export const recentBlockhashOf = (binding: Pick<CreateBinding, "transaction">): string =>
  VersionedTransaction.deserialize(Buffer.from(binding.transaction, "base64")).message.recentBlockhash;

export class PantaMarketCreator {
  private readonly clock: Clock;
  constructor(private readonly config: PantaMarketCreatorConfig) {
    if (!address.safeParse(config.programId).success || [SYSTEM_PROGRAM, COMPUTE_PROGRAM, MEMO_PROGRAM, ATA_PROGRAM, TOKEN_PROGRAM].includes(config.programId)) {
      throw new MarketCreationError("MC_DISABLED", "Market creation needs the pinned Panta program.");
    }
    if (!/^[1-9][0-9]{0,15}$/.test(config.maxFeeBaseUnits)) throw new MarketCreationError("MC_DISABLED", "Market creation needs a fee cap.");
    this.clock = config.clock ?? systemClock;
  }

  /** Signed Cloudinary form from Panta, then the category cover. Returns `secure_url`. */
  async uploadCover(category: PantaCreateCategory): Promise<string> {
    const form = parse(uploadSchema, await this.config.request("/markets/create/image-upload/", {}), "image upload form");
    const fields = Object.fromEntries(Object.entries(form.fields).map(([key, value]) => [key, String(value)]));
    let uploaded: unknown;
    try { uploaded = await this.config.upload(form.uploadUrl, fields, coverPng(category)); }
    catch (error) {
      if (error instanceof MarketCreationError) throw error;
      throw new MarketCreationError("MC_PANTA_UNAVAILABLE", "The market cover could not be uploaded. Nothing was created.");
    }
    const result = parse(cloudinarySchema, uploaded, "cover upload");
    if (result.public_id !== undefined && result.public_id !== form.publicId) schema("cover id");
    return result.secure_url;
  }

  /** Quote + build + bounded validation. The result is safe to show a wallet. */
  async prepare(input: { wallet: string; draft: MarketDraft & { category: PantaCreateCategory }; imageUrl: string }): Promise<CreateBinding> {
    if (!address.safeParse(input.wallet).success || input.wallet === this.config.programId) {
      throw new MarketCreationError("MC_INVALID", "Use a valid Solana wallet address.", { field: "wallet" });
    }
    const createdAt = this.clock.now();
    const times = pantaTimes(input.draft, createdAt);
    if (!times) throw new MarketCreationError("MC_STATE", "Trading closes too soon to publish this market on Panta.");
    const quote = parse(quoteSchema, await this.config.request("/markets/create/quote/", {
      wallet: input.wallet, question: input.draft.question, resolutionRule: input.draft.rules,
      sourcesOfTruth: input.draft.sources, category: input.draft.category, ...times, marketType: "standard",
      ...(input.draft.description ? { description: input.draft.description } : {}), imageUrl: input.imageUrl,
    }), "quote");
    const payment = BigInt(quote.paymentUsdc);
    if (payment <= 0n || BigInt(quote.liquidityInjectionUsdc) + BigInt(quote.platformRevenueUsdc) !== payment) schema("fee breakdown");
    if (payment > BigInt(this.config.maxFeeBaseUnits)) {
      throw new MarketCreationError("MC_FEE_TOO_HIGH", `Panta's creation fee (${formatUsdc(quote.paymentUsdc)} USDC) is above Chumbucket's limit. Nothing was signed.`);
    }
    const quoteExpiry = this.sessionExpiry(quote.expiresAt);
    const buildStartedAt = this.clock.now();
    const build = parse(buildSchema, await this.config.request("/markets/create/build/", {
      createId: quote.createId, wallet: input.wallet,
    }), "build");
    if (build.createId !== quote.createId || (build.expectedEventPda ?? quote.expectedEventPda) !== quote.expectedEventPda ||
        build.derived.event !== quote.expectedEventPda ||
        (build.paymentUsdc ?? quote.paymentUsdc) !== quote.paymentUsdc ||
        (build.liquidityInjectionUsdc ?? quote.liquidityInjectionUsdc) !== quote.liquidityInjectionUsdc ||
        (build.platformRevenueUsdc ?? quote.platformRevenueUsdc) !== quote.platformRevenueUsdc) schema("build echo");
    const expiresAt = Math.min(quoteExpiry, this.sessionExpiry(build.expiresAt),
      buildStartedAt + (build.blockhashExpiryHintSec ?? 60) * 1000);
    if (expiresAt <= this.clock.now()) throw new MarketCreationError("MC_PANTA_UNAVAILABLE", "Panta's create session expired before review. Try again.");
    const tx = this.validateTransaction(build.transaction, {
      wallet: input.wallet, eventPda: quote.expectedEventPda, recentBlockhash: build.recentBlockhash,
      derived: Object.values(build.derived),
    });
    return this.validateBinding({
      version: 1, policy: CREATE_POLICY, createId: quote.createId, eventPda: quote.expectedEventPda, wallet: input.wallet,
      programId: this.config.programId, paymentBaseUnits: quote.paymentUsdc, liquidityBaseUnits: quote.liquidityInjectionUsdc,
      platformBaseUnits: quote.platformRevenueUsdc, ...times, category: input.draft.category, question: input.draft.question,
      imageUrl: input.imageUrl, transaction: build.transaction, messageHash: messageHashOf(tx),
      lastValidBlockHeight: build.lastValidBlockHeight, buildFingerprint: build.buildFingerprint, createdAt, expiresAt,
    });
  }

  /** Panta's fail-closed on-chain check + catalog write. Idempotent per signature. */
  async register(binding: CreateBinding, signature: string): Promise<{ marketId: string }> {
    const saved = this.validateBinding(binding);
    if (!signatureSchema.safeParse(signature).success) throw new MarketCreationError("MC_INVALID", "Invalid transaction signature.");
    const result = parse(registerSchema, await this.config.request("/markets/register/", { createId: saved.createId, signature }), "register");
    if (result.marketId !== saved.eventPda || (result.createId !== undefined && result.createId !== saved.createId) ||
        (result.signature !== undefined && result.signature !== signature)) schema("register echo");
    return { marketId: result.marketId };
  }

  /** Re-validate a stored binding before trusting any of it. */
  validateBinding(value: unknown): CreateBinding {
    const saved = parse(bindingSchema, value, "stored create") as CreateBinding;
    if (saved.programId !== this.config.programId || saved.expiresAt <= saved.createdAt ||
        saved.expiresAt - saved.createdAt > MAX_SESSION_MS ||
        BigInt(saved.liquidityBaseUnits) + BigInt(saved.platformBaseUnits) !== BigInt(saved.paymentBaseUnits) ||
        BigInt(saved.paymentBaseUnits) <= 0n ||
        !(saved.startTime < saved.endTime && saved.endTime <= saved.resolutionTime)) schema("stored create");
    const tx = VersionedTransaction.deserialize(Buffer.from(saved.transaction, "base64"));
    if (messageHashOf(tx) !== saved.messageHash || tx.message.staticAccountKeys[0]?.toBase58() !== saved.wallet) schema("stored transaction");
    return saved;
  }

  private sessionExpiry(value: string): number {
    const at = Date.parse(value);
    const now = this.clock.now();
    if (!Number.isFinite(at) || at - now > MAX_SESSION_MS) schema("session expiry");
    if (at <= now) throw new MarketCreationError("MC_PANTA_UNAVAILABLE", "Panta's create session expired before review. Try again.");
    return at;
  }

  private validateTransaction(payload: string, intent: { wallet: string; eventPda: string; recentBlockhash: string; derived: string[] }): VersionedTransaction {
    let tx: VersionedTransaction;
    const bytes = Buffer.from(payload, "base64");
    try { tx = VersionedTransaction.deserialize(bytes); } catch { return schema("transaction encoding"); }
    try {
      const message = tx.message;
      const keys = message.staticAccountKeys.map(key => key.toBase58());
      const ok = bytes.length <= PACKET_DATA_SIZE && Buffer.from(tx.serialize()).equals(bytes) &&
        (tx.version === 0 || tx.version === "legacy") &&
        (tx.version === "legacy" || message.addressTableLookups.length === 0) &&
        message.header.numRequiredSignatures === 1 && message.header.numReadonlySignedAccounts === 0 &&
        keys[0] === intent.wallet && tx.signatures.length === 1 && tx.signatures[0]!.every(byte => byte === 0) &&
        message.recentBlockhash === intent.recentBlockhash && new Set(keys).size === keys.length;
      if (!ok) return schema("transaction envelope");
      for (const ix of message.compiledInstructions) {
        if (message.isAccountSigner(ix.programIdIndex) || message.isAccountWritable(ix.programIdIndex)) return schema("invoked program privileges");
      }
      const instructions = TransactionMessage.decompile(message).instructions;
      const used = new Set(instructions.flatMap(ix => [ix.programId.toBase58(), ...ix.keys.map(key => key.pubkey.toBase58())]));
      if (used.size !== keys.length || !keys.every(key => used.has(key))) return schema("unused account keys");
      let panta = 0, memo = 0, ata = 0, limit = false, price = false, eventWritten = false;
      const ataOwners = new Set([intent.wallet, ...intent.derived]);
      for (const ix of instructions) {
        const program = ix.programId.toBase58();
        if (ix.keys.some(key => key.isSigner && key.pubkey.toBase58() !== intent.wallet)) return schema("foreign signer");
        if (program === this.config.programId) {
          panta++;
          if (ix.keys.some(key => key.pubkey.toBase58() === intent.eventPda && key.isWritable)) eventWritten = true;
          if (!ix.keys.some(key => key.pubkey.toBase58() === intent.wallet && key.isSigner)) return schema("creator must sign the create");
        } else if (program === COMPUTE_PROGRAM) {
          if (ix.keys.length !== 0 || panta > 0) return schema("compute budget placement");
          if (ix.data[0] === 2 && ix.data.length === 5) {
            const units = ix.data.readUInt32LE(1);
            if (limit || units <= 0 || units > MAX_COMPUTE_UNITS) return schema("compute limit");
            limit = true;
          } else if (ix.data[0] === 3 && ix.data.length === 9) {
            if (price || ix.data.readBigUInt64LE(1) > MAX_COMPUTE_PRICE) return schema("compute price");
            price = true;
          } else return schema("compute budget instruction");
        } else if (program === ATA_PROGRAM) {
          // Create-idempotent only, paid by the creator, for USDC, owned by the
          // creator or an account Panta named in `derived`. It moves no USDC.
          const [payer, account, owner, mint, system, token] = ix.keys.map(key => key.pubkey.toBase58());
          if (++ata > 3 || ix.keys.length !== 6 || !ix.data.equals(Buffer.from([1])) || payer !== intent.wallet ||
              mint !== MAINNET_USDC_MINT || system !== SYSTEM_PROGRAM || token !== TOKEN_PROGRAM || !owner || !ataOwners.has(owner)) return schema("token account creation");
          const expected = PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(),
            new PublicKey(MAINNET_USDC_MINT).toBuffer()], new PublicKey(ATA_PROGRAM), )[0].toBase58();
          if (account !== expected) return schema("token account address");
        } else if (program === MEMO_PROGRAM) {
          if (++memo > 1 || ix.data.length > 566) return schema("memo");
        } else return schema(`unexpected program ${program.slice(0, 8)}`);
      }
      if (panta < 1 || panta > 2 || !eventWritten) return schema("Panta create instruction");
      return tx;
    } catch (error) {
      if (error instanceof MarketCreationError) throw error;
      return schema("transaction structure");
    }
  }
}

export function formatUsdc(baseUnitsValue: string): string {
  const units = BigInt(baseUnitsValue);
  const whole = units / 1_000_000n, cents = (units % 1_000_000n) / 10_000n;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

/**
 * Server-held Panta create transport. Session-opening POSTs are not retried.
 * A refusal is reduced to an allowlisted provider code and field name; the
 * provider's free-text message and body are never forwarded or logged.
 */
export function pantaCreatePost(apiKey: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): CreateRequest {
  registerSecret(apiKey);
  if (!/^pk_live_[A-Za-z0-9_-]+$/.test(apiKey)) throw new MarketCreationError("MC_DISABLED", "Market creation needs a live server-held Panta key.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (path, body) => {
    if (!CREATE_PATHS.has(path)) throw new MarketCreationError("MC_DISABLED", "Unsupported Panta create operation.");
    let res: Response;
    try {
      res = await fetchImpl(`${PANTA_BASE_URL}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } catch {
      throw new MarketCreationError("MC_PANTA_UNAVAILABLE", "Panta did not answer. Nothing was created.");
    }
    let text: string;
    try { text = await res.text(); } catch { throw new MarketCreationError("MC_PANTA_UNAVAILABLE", "Panta did not answer. Nothing was created."); }
    if (text.length > 262_144 || text.includes(apiKey)) throw new MarketCreationError("MC_SCHEMA", "Panta's response failed a safety check. Nothing was signed.");
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = undefined; }
    if (!res.ok) {
      const envelope = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const providerCode = typeof envelope.code === "string" && PANTA_CREATE_CODES.has(envelope.code) ? envelope.code : undefined;
      const fields = envelope.fields && typeof envelope.fields === "object" ? Object.keys(envelope.fields) : [];
      const named = typeof envelope.field === "string" ? [envelope.field, ...fields] : fields;
      const field = named.find(name => PANTA_CREATE_FIELDS.has(name));
      if (res.status === 429 || providerCode === "RATE_LIMITED") {
        throw new MarketCreationError("MC_RATE_LIMITED", pantaRefusalMessage("RATE_LIMITED", undefined), { providerCode: "RATE_LIMITED" });
      }
      if (res.status >= 500 || res.status === 401 || providerCode === "UNAUTHORIZED" || providerCode === "INTERNAL_ERROR") {
        // A rejected server key is our configuration, not the person's market.
        throw new MarketCreationError("MC_PANTA_UNAVAILABLE", "Panta market creation is unavailable right now. Nothing was created.", { ...(providerCode ? { providerCode } : {}) });
      }
      throw new MarketCreationError("MC_PANTA_REFUSED", pantaRefusalMessage(providerCode, field), {
        ...(providerCode ? { providerCode } : {}), ...(field ? { field } : {}),
      });
    }
    if (data === undefined) throw new MarketCreationError("MC_SCHEMA", "Panta's response failed a safety check. Nothing was signed.");
    if (data && typeof data === "object") {
      const flags = data as Record<string, unknown>;
      if (flags.demo === true || flags.testMode === true || /sandbox|fixture|test mode/i.test(String(flags.disclaimer ?? ""))) {
        throw new MarketCreationError("MC_SCHEMA", "Panta answered in test mode. Nothing was created.");
      }
    }
    return data;
  };
}

/** Multipart POST of the cover to Panta's signed Cloudinary form. */
export function cloudinaryUpload(options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): CoverUpload {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (uploadUrl, fields, png) => {
    if (!/^https:\/\/api\.cloudinary\.com\/v1_1\/[A-Za-z0-9_-]{1,64}\/image\/upload$/.test(uploadUrl)) {
      throw new MarketCreationError("MC_SCHEMA", "Unexpected cover upload destination.");
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append("file", new Blob([png], { type: "image/png" }), "cover.png");
    const res = await fetchImpl(uploadUrl, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
    const text = await res.text();
    if (!res.ok || text.length > 65_536) throw new MarketCreationError("MC_PANTA_UNAVAILABLE", "The market cover could not be uploaded. Nothing was created.");
    try { return JSON.parse(text); } catch { throw new MarketCreationError("MC_SCHEMA", "Unexpected cover upload response."); }
  };
}
