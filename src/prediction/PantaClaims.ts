/**
 * Win-claim transactions for a resolved Panta market, built by Panta and
 * checked here before any wallet sees them.
 *
 * Primary docs (read 2026-10-02): https://docs.panta.market/api-reference/
 * claims/build.md, positions.md, trades/report.md; guides/how-it-works.md and
 * guides/errors.md. `POST /claim/build/ {wallet, marketId}` returns unsigned
 * `claim_win_usdc` instructions plus `recentBlockhash`; the caller compiles a
 * v0 transaction, the wallet signs, the caller broadcasts on its own RPC, and
 * may report the signature to `POST /trades/` (kind `claim`) for attribution.
 *
 * Unlike the primary buy (PantaExecution), no live claim build has been
 * observed: there was no winning position to build one for. So this profile
 * is DOC-DERIVED, and deliberately narrow. It fails closed: anything outside
 * it is refused, and the app then sends the person to panta.market to claim.
 *
 *  - exactly one instruction on the pinned Panta program whose data starts
 *    with the Anchor discriminator sha256("global:claim_win_usdc")[0..8];
 *  - that instruction names the owner as the only signer, the market, the
 *    three documented derived accounts (winClaim, positionPda, vaultAuthority)
 *    and the owner's own canonical USDC token account, writable;
 *  - optional bounded ComputeBudget and the owner's own canonical USDC ATA
 *    create-idempotent before it, and an optional owner-signed Memo after it;
 *  - no other program at the top level, so nothing can move SOL or USDC
 *    anywhere except through the Panta program's own claim;
 *  - the owner is the fee payer and the only signer; no lookup tables.
 *
 * Settlement proof is independent of Panta: PantaSettlementChain.verifyClaim
 * requires the exact reviewed message, success, and a USDC credit to the owner.
 */
import { createHash } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PACKET_DATA_SIZE, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.ts";
import { VenueError } from "./errors.ts";

const bs58 = utils.bytes.bs58;
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_COMPUTE_PRICE = 1_000_000n;
/** Blockhash lifetime the docs give for a build (~60 s). */
export const CLAIM_APPROVAL_TTL_MS = 60_000;
export const CLAIM_WIN_DISCRIMINATOR = createHash("sha256").update("global:claim_win_usdc").digest().subarray(0, 8);

function canonicalBase58(value: string, bytes: number): boolean {
  try {
    const decoded = bs58.decode(value);
    return decoded.length === bytes && bs58.encode(decoded) === value;
  } catch { return false; }
}
const address = z.string().min(32).max(44).refine(value => canonicalBase58(value, 32));
const base64 = z.string().max(Math.ceil(PACKET_DATA_SIZE / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(value => Buffer.from(value, "base64").toString("base64") === value);
const shares = z.string().regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/).refine(value => /[1-9]/.test(value));
const accountSchema = z.object({ pubkey: address, isSigner: z.boolean(), isWritable: z.boolean() }).strict();
const instructionSchema = z.object({ programId: address, data: base64, accounts: z.array(accountSchema).max(32) }).strict();
const derivedSchema = z.object({ winClaim: address, positionPda: address, vaultAuthority: address }).catchall(address);
const buildSchema = z.object({
  wallet: address, marketId: address,
  outcome: z.string().transform(value => value.toUpperCase()).pipe(z.enum(["YES", "NO"])),
  winningShares: shares,
  instructions: z.array(instructionSchema).min(1).max(8),
  derived: derivedSchema,
  recentBlockhash: address,
  lastValidBlockHeight: z.number().int().positive().safe(),
  // Documented elsewhere in the API family; tolerated only with exact types.
  blockhashExpiryHintSec: z.number().int().min(1).max(300).optional(),
  userId: z.string().regex(/^usr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/).optional(),
}).strict();

export interface PantaClaimReview {
  outcome: "YES" | "NO";
  winningShares: string;
  /** Docs: a resolved winner is worth ~1 USDC per share. An estimate, not a quote. */
  estimatedPayoutUsdc: string;
  attribution: "Powered by Panta";
}
/** JSON-serializable durable server record. Never returned to a client. */
export interface PantaClaimBinding {
  version: 1;
  owner: string;
  venueMarketId: string;
  programId: string;
  messageHash: string;
  lastValidBlockHeight: number;
  createdAt: number;
  expiresAt: number;
  derived: { winClaim: string; positionPda: string; vaultAuthority: string };
  review: PantaClaimReview;
}
export interface PantaPreparedClaim {
  transaction: { venue: "panta"; encoding: "solana-tx-base64"; payload: string; expiresAt: number; demo: false };
  binding: PantaClaimBinding;
}
export interface PantaClaimExecutionConfig {
  request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  programId: string;
  clock?: Clock;
}

function refuse(message: string, code: "VENUE_SCHEMA" | "VENUE_BAD_REQUEST" | "VENUE_MISCONFIGURED" = "VENUE_SCHEMA"): never {
  throw new VenueError(code, `Panta claim: ${message}`, { venue: "panta" });
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) refuse(message);
}
function ownerUsdcAccount(owner: string): string {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(),
    new PublicKey(USDC_MINT).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58();
}
const hashOf = (tx: VersionedTransaction) => createHash("sha256").update(tx.message.serialize()).digest("hex");

export class PantaClaimExecution {
  private readonly clock: Clock;
  constructor(private readonly config: PantaClaimExecutionConfig) {
    if (!address.safeParse(config.programId).success || [SystemProgram.programId.toBase58(), COMPUTE_BUDGET, MEMO_PROGRAM,
      TOKEN_PROGRAM, ATA_PROGRAM].includes(config.programId) || typeof config.request !== "function") {
      refuse("an explicit Panta program and transport are required", "VENUE_MISCONFIGURED");
    }
    this.clock = config.clock ?? systemClock;
  }

  /** Builds and checks one unsigned claim. Never signs, sends or retries. */
  async build(input: { owner: string; venueMarketId: string }): Promise<PantaPreparedClaim> {
    if (!address.safeParse(input.owner).success || !address.safeParse(input.venueMarketId).success ||
        input.owner === input.venueMarketId || input.owner === this.config.programId) {
      refuse("invalid wallet or market", "VENUE_BAD_REQUEST");
    }
    const createdAt = this.clock.now();
    let raw: unknown;
    try { raw = await this.config.request("/claim/build/", { wallet: input.owner, marketId: input.venueMarketId }); }
    catch (error) {
      if (error instanceof VenueError) throw error;
      throw new VenueError("VENUE_UNAVAILABLE", "Panta claim: request unavailable", { venue: "panta" });
    }
    const parsed = buildSchema.safeParse(raw);
    check(parsed.success, "invalid claim build response");
    const build = parsed.data;
    check(build.wallet === input.owner && build.marketId === input.venueMarketId, "claim build is for a different wallet or market");
    const derived = { winClaim: build.derived.winClaim, positionPda: build.derived.positionPda, vaultAuthority: build.derived.vaultAuthority };
    const instructions = build.instructions.map(ix => new TransactionInstruction({
      programId: new PublicKey(ix.programId), data: Buffer.from(ix.data, "base64"),
      keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    }));
    this.validateInstructions(instructions, input.owner, input.venueMarketId, derived);
    let payload: string;
    let transaction: VersionedTransaction;
    try {
      const message = new TransactionMessage({ payerKey: new PublicKey(input.owner), recentBlockhash: build.recentBlockhash,
        instructions }).compileToV0Message();
      transaction = new VersionedTransaction(message);
      const bytes = transaction.serialize();
      check(bytes.length <= PACKET_DATA_SIZE, "transaction exceeds Solana packet size");
      payload = Buffer.from(bytes).toString("base64");
    } catch (error) {
      if (error instanceof VenueError) throw error;
      return refuse("invalid or oversized transaction");
    }
    const expiresAt = createdAt + Math.min(CLAIM_APPROVAL_TTL_MS, (build.blockhashExpiryHintSec ?? 60) * 1000);
    const binding: PantaClaimBinding = {
      version: 1, owner: input.owner, venueMarketId: input.venueMarketId, programId: this.config.programId,
      messageHash: hashOf(transaction), lastValidBlockHeight: build.lastValidBlockHeight, createdAt, expiresAt, derived,
      review: { outcome: build.outcome, winningShares: build.winningShares, estimatedPayoutUsdc: build.winningShares,
        attribution: "Powered by Panta" },
    };
    this.validateTransaction(payload, binding);
    return { transaction: { venue: "panta", encoding: "solana-tx-base64", payload, expiresAt, demo: false }, binding };
  }

  /** Re-checks a stored approval before it is replayed or broadcast. */
  validateTransaction(payload: string, binding: PantaClaimBinding): VersionedTransaction {
    try {
      check(base64.safeParse(payload).success, "noncanonical transaction encoding");
      const bytes = Buffer.from(payload, "base64");
      const tx = VersionedTransaction.deserialize(bytes);
      check(Buffer.from(tx.serialize()).equals(bytes), "noncanonical transaction serialization");
      check(tx.version === 0 && tx.message.addressTableLookups.length === 0 &&
        tx.message.header.numRequiredSignatures === 1 && tx.message.header.numReadonlySignedAccounts === 0 &&
        tx.message.staticAccountKeys[0]?.toBase58() === binding.owner && tx.signatures.length === 1,
        "transaction must be v0 with only the owner as payer and signer");
      for (const ix of tx.message.compiledInstructions) {
        check(!tx.message.isAccountSigner(ix.programIdIndex) && !tx.message.isAccountWritable(ix.programIdIndex),
          "invoked program is writable or a signer");
      }
      check(hashOf(tx) === binding.messageHash, "reviewed message hash mismatch");
      check(binding.programId === this.config.programId, "stored claim names a different program");
      this.validateInstructions(TransactionMessage.decompile(tx.message).instructions, binding.owner, binding.venueMarketId, binding.derived, true);
      return tx;
    } catch (error) {
      if (error instanceof VenueError) throw error;
      return refuse("invalid reviewed transaction");
    }
  }

  private validateInstructions(instructions: TransactionInstruction[], owner: string, market: string,
    derived: PantaClaimBinding["derived"], compiled = false): void {
    check(instructions.length >= 1 && instructions.length <= 6, "invalid instruction count");
    const ata = ownerUsdcAccount(owner);
    const program = this.config.programId;
    const reserved = new Set([program, MEMO_PROGRAM, COMPUTE_BUDGET]);
    for (const key of [market, derived.winClaim, derived.positionPda, derived.vaultAuthority]) {
      check(key !== owner && !reserved.has(key), "claim account aliases the owner or a program");
    }
    check(new Set([market, derived.winClaim, derived.positionPda, derived.vaultAuthority, ata]).size === 5,
      "claim accounts must be distinct");
    let stage = 0; // ComputeBudget* -> ATA? -> one claim -> Memo?
    let seenLimit = false, seenPrice = false, seenAta = false, seenClaim = false, seenMemo = false;
    for (const ix of instructions) {
      const id = ix.programId.toBase58();
      check(ix.keys.every(k => !k.isSigner || k.pubkey.toBase58() === owner), "foreign instruction signer");
      check(ix.data.length <= 566 && ix.keys.length <= 24, "invalid instruction accounts or data");
      if (id === COMPUTE_BUDGET) {
        check(stage === 0 && ix.keys.length === 0, "ComputeBudget must precede the claim and have no accounts");
        if (ix.data[0] === 2 && ix.data.length === 5) {
          const units = ix.data.readUInt32LE(1);
          check(!seenLimit && units > 0 && units <= MAX_COMPUTE_UNITS, "unbounded or duplicate compute limit");
          seenLimit = true;
        } else if (ix.data[0] === 3 && ix.data.length === 9) {
          check(!seenPrice && ix.data.readBigUInt64LE(1) <= MAX_COMPUTE_PRICE, "unbounded or duplicate compute price");
          seenPrice = true;
        } else check(false, "unsupported ComputeBudget instruction");
      } else if (id === ATA_PROGRAM) {
        check(!seenAta && stage === 0 && ix.data.equals(Buffer.from([1])), "only one canonical ATA create-idempotent is allowed");
        const expected = [owner, ata, owner, USDC_MINT, SystemProgram.programId.toBase58(), TOKEN_PROGRAM];
        check(ix.keys.length === expected.length && ix.keys.every((k, i) => k.pubkey.toBase58() === expected[i]),
          "ATA instruction must create the owner's own USDC account");
        check(ix.keys[0]!.isSigner && ix.keys[0]!.isWritable && ix.keys[1]!.isWritable, "ATA payer and account privileges differ");
        seenAta = true; stage = 1;
      } else if (id === program) {
        check(!seenClaim && stage <= 1, "exactly one claim instruction is allowed");
        check(ix.data.length >= 8 && ix.data.length <= 40 && ix.data.subarray(0, 8).equals(CLAIM_WIN_DISCRIMINATOR),
          "Panta instruction is not claim_win_usdc");
        const keys = ix.keys.map(k => k.pubkey.toBase58());
        check(new Set(keys).size === keys.length, "duplicate claim accounts");
        check(!keys.some(k => reserved.has(k)), "claim instruction names a program as an account");
        const ownerMeta = ix.keys.find(k => k.pubkey.toBase58() === owner);
        check(ownerMeta?.isSigner === true, "owner must sign the claim");
        for (const key of [market, derived.winClaim, derived.positionPda, derived.vaultAuthority]) {
          check(keys.includes(key), "claim omits the market or a documented derived account");
        }
        const ataMeta = ix.keys.find(k => k.pubkey.toBase58() === ata);
        check(ataMeta?.isWritable === true, "claim must pay the owner's own USDC account");
        seenClaim = true; stage = 2;
      } else if (id === MEMO_PROGRAM) {
        check(!seenMemo && stage === 2, "a Memo may only follow the claim");
        check(ix.keys.length === 1 && ix.keys[0]!.pubkey.toBase58() === owner && ix.keys[0]!.isSigner &&
          (compiled || !ix.keys[0]!.isWritable), "Memo must be signed by the owner alone");
        check(Buffer.from(ix.data.toString("utf8"), "utf8").equals(ix.data) && !/[\u0000-\u001f\u007f]/.test(ix.data.toString("utf8")),
          "Memo must be printable text");
        seenMemo = true; stage = 3;
      } else check(false, "unsupported instruction program");
    }
    check(seenClaim, "a claim_win_usdc instruction is required");
  }
}
