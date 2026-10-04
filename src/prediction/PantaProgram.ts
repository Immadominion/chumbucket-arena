/**
 * Panta's on-chain market program, read directly. Wire shape isolated here.
 *
 * WHY THIS EXISTS. Panta's partner API (`live-api.panta.market`) lists only
 * USDC-quoted markets. The same program also holds SOL-quoted markets, which
 * panta.market lists beside the USDC ones but the partner API never returns.
 * Measured on 2026-10-04: 201 Event accounts, 12 open, of which 6 were
 * SOL-quoted and therefore missing from Chumbucket. A free call needs only the
 * market and its price, so those markets are read here, from the program
 * account itself, and offered for calls. They are never offered for trading:
 * our trade path is Panta's USDC primary-order API.
 *
 * WHAT IS READ, AND FROM WHERE.
 *  - Layout: the `Event` account of program `balr_market`
 *    (6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp), from the Anchor IDL
 *    panta.market ships to browsers. Two IDL versions exist; the newer one
 *    only APPENDS fields, so the prefix decoded here is identical in both and
 *    is everything this module needs. Pinned against real mainnet bytes in
 *    tests/fixtures/pantaChainAccounts.ts.
 *  - Quote asset: never guessed. The program derives a SOL market's address as
 *    PDA("event", creator, sha256(question)) and a USDC market's as
 *    PDA("event_usdc", creator, sha256(question)). Re-deriving it proves the
 *    quote asset AND that the question is the one the market was created
 *    with. An account matching neither is not served.
 *  - Price: `last_yes_price` on the program's 1e9 PRICE_SCALE. Panta's own
 *    API reports exactly this figure as a USDC market's `yesPrice`, and
 *    panta.market shows it (and its complement) as the odds on SOL markets.
 *    It is never converted to USD.
 *  - Result: only the program's own final flags, behind the same gates the
 *    partner adapter applies to its `onChain` block — no pending review, the
 *    review window over, and the market claimable. Never from a price.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { schemaError } from "./errors.ts";
import type { PublishedResolution, RawPayload } from "./PredictionVenue.ts";
import { marketUuid, type MarketStatus, type VenueMarket } from "./types.ts";

export const PANTA_PROGRAM_ID = "6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp";
/** Anchor discriminator of `Event` (identical in both shipped IDL versions). */
export const PANTA_EVENT_DISCRIMINATOR = Uint8Array.from([125, 192, 125, 158, 9, 115, 152, 233]);
/** `VenueMarket.payloadVersion` for a market normalised from its program
 *  account. The partner-API normalisation is PANTA_PAYLOAD_VERSION (1); the
 *  persisted `venue_markets.payload_version` says which one wrote a row, which
 *  is also how a served market knows its quote asset after a restart. */
export const PANTA_CHAIN_PAYLOAD_VERSION = 2;
export const PRICE_SCALE = 1_000_000_000n;

export type PantaQuoteAsset = "SOL" | "USDC";
export type ReviewKind = "None" | "PrimaryInvalidity" | "ResolutionDispute";

/** The decoded prefix of a Panta `Event` account. Times are unix seconds. */
export interface PantaEventAccount {
  creator: string;
  startTime: number;
  endTime: number;
  resolutionTime: number;
  createdAt: number;
  resolvedAt: number;
  cancelledAt: number;
  lastYesPrice: bigint;
  claimableAt: number;
  question: string;
  resolutionRule: string;
  sourceOfTruth: string[];
  isActive: boolean;
  isGraduated: boolean;
  isResolved: boolean;
  isCancelled: boolean;
  yesWins: boolean;
  pendingReview: ReviewKind;
  marketType: "Standard" | "Breaking";
  reviewExpiresAt: number;
}

const REVIEW_KINDS: readonly ReviewKind[] = ["None", "PrimaryInvalidity", "ResolutionDispute"];
const CANCEL_REASONS = 3; // None, FailedToGraduate, Fraudulent
const MARKET_TYPES = ["Standard", "Breaking"] as const;
const MAX_TEXT_BYTES = 4096;
const MAX_SOURCES = 16;

/** A bounds-checked little-endian Borsh reader. Any overrun is schema drift. */
class Reader {
  private offset = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): number {
    if (this.offset + n > this.bytes.length) throw schemaError("panta", "event account truncated");
    const at = this.offset;
    this.offset += n;
    return at;
  }
  skip(n: number): void { this.need(n); }
  u8(): number { return this.view.getUint8(this.need(1)); }
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw schemaError("panta", "event account boolean");
    return v === 1;
  }
  u32(): number { return this.view.getUint32(this.need(4), true); }
  /** An i64 timestamp, in seconds. Negative or absurd values are drift. */
  seconds(): number {
    const v = this.view.getBigInt64(this.need(8), true);
    if (v < 0n || v > 10_000_000_000n) throw schemaError("panta", "event account timestamp");
    return Number(v);
  }
  u128(): bigint {
    const at = this.need(16);
    return this.view.getBigUint64(at, true) | (this.view.getBigUint64(at + 8, true) << 64n);
  }
  pubkey(): string { const at = this.need(32); return new PublicKey(this.bytes.subarray(at, at + 32)).toBase58(); }
  string(): string {
    const len = this.u32();
    if (len > MAX_TEXT_BYTES) throw schemaError("panta", "event account text length");
    const at = this.need(len);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes.subarray(at, at + len)); }
    catch { throw schemaError("panta", "event account text encoding"); }
  }
  variant(count: number): number {
    const v = this.u8();
    if (v >= count) throw schemaError("panta", "event account enum");
    return v;
  }
}

/** Decode a Panta `Event` account. Throws VENUE_SCHEMA on anything unexpected. */
export function decodePantaEvent(data: Uint8Array): PantaEventAccount {
  if (data.length < 8 || !PANTA_EVENT_DISCRIMINATOR.every((b, i) => data[i] === b)) {
    throw schemaError("panta", "not a Panta event account");
  }
  const r = new Reader(data);
  r.skip(8);
  const creator = r.pubkey();
  const startTime = r.seconds(), endTime = r.seconds(), resolutionTime = r.seconds();
  const createdAt = r.seconds(), resolvedAt = r.seconds(), cancelledAt = r.seconds();
  r.skip(16 * 4); // total_yes_shares, total_no_shares, virtual_sol_reserves, virtual_yes_shares
  const lastYesPrice = r.u128();
  r.skip(16 * 3); // total_volume, total_yes_volume, total_no_volume
  r.skip(8); // total_trades
  r.skip(16 * 5); // total_revenue, total_creator_fees, total_protocol_fees, primary_pool_lamports, graduation_threshold
  const claimableAt = r.seconds();
  r.skip(16); // creator_seed_lamports
  const question = r.string();
  const resolutionRule = r.string();
  const sources = r.u32();
  if (sources > MAX_SOURCES) throw schemaError("panta", "event account source count");
  const sourceOfTruth = Array.from({ length: sources }, () => r.string());
  r.skip(16); // active_volume
  r.skip(3); // bump, vault_bump, creator_fee_vault_bump
  const isActive = r.bool(), isGraduated = r.bool(), isResolved = r.bool(), isCancelled = r.bool();
  const yesWins = r.bool();
  r.bool(); // is_whitelisted_creator
  const pendingReview = REVIEW_KINDS[r.variant(REVIEW_KINDS.length)]!;
  r.variant(CANCEL_REASONS);
  const marketType = MARKET_TYPES[r.variant(MARKET_TYPES.length)]!;
  r.seconds(); // flash_acquisition_end
  r.bool(); // event_in_progress
  r.seconds(); // primary_phase_end_time
  const reviewExpiresAt = r.seconds();
  return { creator, startTime, endTime, resolutionTime, createdAt, resolvedAt, cancelledAt, lastYesPrice,
    claimableAt, question, resolutionRule, sourceOfTruth, isActive, isGraduated, isResolved, isCancelled,
    yesWins, pendingReview, marketType, reviewExpiresAt };
}

const program = new PublicKey(PANTA_PROGRAM_ID);
/** The quote asset the program's own address derivation proves, or null. */
export function pantaQuoteAsset(address: string, event: Pick<PantaEventAccount, "creator" | "question">): PantaQuoteAsset | null {
  let creator: PublicKey;
  try { creator = new PublicKey(event.creator); } catch { return null; }
  const hash = createHash("sha256").update(event.question, "utf8").digest();
  const derive = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed), creator.toBuffer(), hash], program)[0].toBase58();
  if (derive("event") === address) return "SOL";
  if (derive("event_usdc") === address) return "USDC";
  return null;
}

/** An exact decimal string for `value / 1e9`: 671739755n -> "0.671739755". */
function scaled(value: bigint): string {
  const whole = value / PRICE_SCALE;
  const fraction = (value % PRICE_SCALE).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** YES and NO per-share prices as panta.market shows them, or nulls when the
 *  program reports no usable price (a price of 0 or 1 is not a live market). */
export function pantaEventPrices(event: Pick<PantaEventAccount, "lastYesPrice">): { yesPrice: string | null; noPrice: string | null } {
  const yes = event.lastYesPrice;
  if (yes <= 0n || yes >= PRICE_SCALE) return { yesPrice: null, noPrice: null };
  return { yesPrice: scaled(yes), noPrice: scaled(PRICE_SCALE - yes) };
}

/** Panta's phase vocabulary, from the program's own flags. */
function phaseOf(e: PantaEventAccount): string {
  if (e.isCancelled) return "cancelled";
  if (e.isResolved) return "resolved";
  return e.isGraduated ? "secondary" : "primary";
}

/** The program's own published result, or null while it is not final. */
export function pantaEventResolution(e: PantaEventAccount, nowMs: number): PublishedResolution | null {
  const past = (seconds: number) => seconds > 0 && seconds * 1000 <= nowMs;
  if (e.pendingReview !== "None" || e.reviewExpiresAt * 1000 > nowMs) return null;
  if (e.isCancelled) return past(e.cancelledAt) ? { resolution: "VOID", resolvedAt: e.cancelledAt * 1000 } : null;
  if (!e.isResolved || !past(e.resolvedAt) || !past(e.claimableAt)) return null;
  return { resolution: e.yesWins ? "YES" : "NO", resolvedAt: e.resolvedAt * 1000 };
}

/** What a call can rely on: the program's status, never optimistic past close. */
export function pantaEventStatus(e: PantaEventAccount, nowMs: number): MarketStatus {
  const published = pantaEventResolution(e, nowMs);
  if (published) return published.resolution === "VOID" ? "CANCELLED" : "RESOLVED";
  if (e.isCancelled) return "CANCELLED";
  if (e.isResolved) return "CLOSED_PENDING_RESOLUTION";
  if (e.endTime === 0 || e.endTime * 1000 <= nowMs) return "CLOSED_PENDING_RESOLUTION";
  // Inactive, or under a review that may cancel it: no new calls.
  return !e.isActive || e.pendingReview !== "None" ? "PAUSED" : "OPEN";
}

/** The captured evidence for one account read: the bytes themselves. */
export interface PantaChainBody {
  source: "solana-account";
  cluster: "mainnet-beta";
  programId: string;
  account: string;
  owner: string;
  slot: number;
  dataEncoding: "base64";
  data: string;
  quoteAsset: PantaQuoteAsset;
  /** panta.market's display category for this market; null when unavailable. */
  category: string | null;
  /** Derived from `data` (see pantaEventPrices); the stored prices must match. */
  yesPrice: string | null;
  noPrice: string | null;
}

export interface PantaChainRead {
  address: string;
  event: PantaEventAccount;
  quoteAsset: PantaQuoteAsset;
  raw: RawPayload;
  fetchedAt: number;
}

const CATEGORY = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const FALLBACK_CATEGORY = "other";

/** Build the evidence + decoded view for one account the RPC returned. */
export function pantaChainRead(input: { address: string; owner: string; data: Uint8Array; slot: number;
  fetchedAt: number; category: string | null }): PantaChainRead {
  if (input.owner !== PANTA_PROGRAM_ID) throw schemaError("panta", "event account owner");
  const event = decodePantaEvent(input.data);
  const quoteAsset = pantaQuoteAsset(input.address, event);
  if (!quoteAsset) throw schemaError("panta", "event address does not derive from its question");
  const category = input.category && CATEGORY.test(input.category) ? input.category : null;
  const body: PantaChainBody = { source: "solana-account", cluster: "mainnet-beta", programId: PANTA_PROGRAM_ID,
    account: input.address, owner: input.owner, slot: input.slot, dataEncoding: "base64",
    data: Buffer.from(input.data).toString("base64"), quoteAsset, category, ...pantaEventPrices(event) };
  const raw: RawPayload = { venue: "panta", venueMarketId: input.address, payloadVersion: PANTA_CHAIN_PAYLOAD_VERSION,
    fetchedAt: input.fetchedAt, body };
  return { address: input.address, event, quoteAsset, raw, fetchedAt: input.fetchedAt };
}

/** Re-derive a read from captured evidence, checking every derived field. */
export function pantaChainReadFromRaw(raw: RawPayload, venueMarketId: string): PantaChainRead {
  const b = raw.body as Partial<PantaChainBody> | null;
  if (raw.venue !== "panta" || raw.payloadVersion !== PANTA_CHAIN_PAYLOAD_VERSION || raw.venueMarketId !== venueMarketId ||
      !b || b.source !== "solana-account" || b.account !== venueMarketId || typeof b.data !== "string" ||
      typeof b.owner !== "string" || typeof b.slot !== "number") {
    throw schemaError("panta", "chain evidence envelope");
  }
  const read = pantaChainRead({ address: venueMarketId, owner: b.owner, data: Buffer.from(b.data, "base64"),
    slot: b.slot, fetchedAt: raw.fetchedAt, category: b.category ?? null });
  const body = read.raw.body as PantaChainBody;
  if (body.quoteAsset !== b.quoteAsset || body.yesPrice !== b.yesPrice || body.noPrice !== b.noPrice) {
    throw schemaError("panta", "chain evidence does not match its bytes");
  }
  return { ...read, raw };
}

/** Explorer page for the account: a place anyone can check the evidence. */
export const pantaAccountUrl = (address: string): string => `https://explorer.solana.com/address/${address}`;

/** The normalized market for a read. Category is display-only metadata. */
export function normalizePantaChainMarket(read: PantaChainRead, nowMs: number): VenueMarket {
  const e = read.event;
  const category = (read.raw.body as PantaChainBody).category ?? FALLBACK_CATEGORY;
  return { id: marketUuid("panta", read.address), venue: "panta", venueEventId: read.address,
    venueMarketId: read.address, question: e.question, rulesText: e.resolutionRule, category,
    outcomes: [{ side: "YES", label: "Yes" }, { side: "NO", label: "No" }],
    status: pantaEventStatus(e, nowMs), rawStatus: phaseOf(e), opensAt: null,
    closesAt: e.endTime === 0 ? null : e.endTime * 1000,
    resolvesAt: e.resolutionTime === 0 ? null : e.resolutionTime * 1000,
    resolutionSource: pantaAccountUrl(read.address), lastSyncedAt: read.fetchedAt,
    payloadVersion: PANTA_CHAIN_PAYLOAD_VERSION };
}

/** True when `chainPriceEvidence` would accept these prices for this raw. */
export function pantaChainPriceEvidenceMatches(body: unknown, s: { yesPrice: string | null; noPrice: string | null; currency: string }): boolean {
  const b = body as Partial<PantaChainBody> | null;
  return !!b && b.source === "solana-account" && b.quoteAsset === s.currency &&
    b.yesPrice === s.yesPrice && b.noPrice === s.noPrice;
}
