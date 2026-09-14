/**
 * Normalized prediction vocabulary — FROZEN by
 * docs/contracts/pivot-contracts-v1.md §3. Do NOT rename or restructure anything
 * in this file; the same names exist verbatim in Dart on the mobile side.
 *
 * Wire rules that travel with these types:
 *   - every timestamp is unix MILLISECONDS, integer, UTC
 *   - every probability is a `number` in [0,1]
 *   - every money amount is INTEGER BASE UNITS AS A STRING — never a float
 */

import { createHash } from "node:crypto";

// ── §3 frozen vocabulary ─────────────────────────────────────────────────────

export type Side = "YES" | "NO";
export type Resolution = "YES" | "NO" | "VOID"; // VOID = cancelled/abandoned; never a win or a loss

export type MarketStatus =
  | "OPEN" // accepting calls and (if funded) orders
  | "CLOSED_PENDING_RESOLUTION" // closed, outcome not yet published
  | "RESOLVED" // venue published a Resolution
  | "CANCELLED" // venue voided the market
  | "PAUSED"; // venue halted trading, may reopen

export type CallOutcome = "PENDING" | "CORRECT" | "INCORRECT" | "VOID";

export type FundingState =
  | "NONE" // free call — the default, and the only state the MVP ships
  | "QUOTED" // a fresh quote was shown; nothing signed
  | "SUBMITTED" // transaction signed and sent; NOT yet money
  | "FILLED" // venue CONFIRMED the fill — the only state that may read "funded"
  | "PARTIAL"
  | "FAILED"
  | "CLOSED"
  | "CLAIMABLE"
  | "CLAIMED";

/**
 * Which adapter produced a row. 'fixture' is ALWAYS demo data.
 *
 * 'polymarket' is a READ-ONLY venue: real markets, real prices, real
 * resolutions, but no trading through us. It exists because it needs no API
 * key, so the product can run on real data before a Jupiter key exists.
 */
export type VenueId = "jupiter" | "polymarket" | "fixture";

export interface VenueMarket {
  id: string; // Chumbucket UUID — the stable id everything references
  venue: VenueId; // 'fixture' = demo catalog; MUST be visibly labelled in UI
  venueEventId: string;
  venueMarketId: string; // preserved verbatim, never re-encoded
  question: string; // the exact question shown to the user
  rulesText: string; // the venue's exact resolution criteria — never paraphrased
  category: string; // 'crypto' for MVP
  outcomes: { side: Side; label: string }[];
  status: MarketStatus;
  rawStatus: string; // the venue's own status string, unmapped
  opensAt: number | null;
  closesAt: number | null;
  resolvesAt: number | null;
  resolutionSource: string | null;
  lastSyncedAt: number;
  payloadVersion: number; // bump when the adapter's normalisation changes
}

export interface MarketSnapshot {
  marketId: string;
  yesProbability: number; // [0,1]
  observedAt: number;
  source: "venue" | "fixture";
}

// ── Runtime companions to the frozen unions ──────────────────────────────────

export const SIDES: readonly Side[] = ["YES", "NO"] as const;
export const RESOLUTIONS: readonly Resolution[] = ["YES", "NO", "VOID"] as const;
export const MARKET_STATUSES: readonly MarketStatus[] = [
  "OPEN",
  "CLOSED_PENDING_RESOLUTION",
  "RESOLVED",
  "CANCELLED",
  "PAUSED",
] as const;
export const FUNDING_STATES: readonly FundingState[] = [
  "NONE",
  "QUOTED",
  "SUBMITTED",
  "FILLED",
  "PARTIAL",
  "FAILED",
  "CLOSED",
  "CLAIMABLE",
  "CLAIMED",
] as const;

export const isSide = (v: unknown): v is Side => v === "YES" || v === "NO";
export const isResolution = (v: unknown): v is Resolution =>
  v === "YES" || v === "NO" || v === "VOID";
export const isMarketStatus = (v: unknown): v is MarketStatus =>
  MARKET_STATUSES.includes(v as MarketStatus);
export const isFundingState = (v: unknown): v is FundingState =>
  FUNDING_STATES.includes(v as FundingState);

/**
 * A market whose price will never move again. Settled markets may be cached for
 * far longer than open ones (contracts §4).
 */
export const isSettledStatus = (s: MarketStatus): boolean => s === "RESOLVED" || s === "CANCELLED";

/**
 * Deterministic result derivation — the ONLY permitted rule (contracts §3).
 * Late resolution stays PENDING. No admin override, no client input, no other branch.
 */
export function deriveCallOutcome(side: Side, resolution: Resolution | null): CallOutcome {
  if (resolution === null) return "PENDING";
  if (resolution === "VOID") return "VOID";
  return resolution === side ? "CORRECT" : "INCORRECT";
}

// ── Money on the wire: integer base units as a string, never a float ─────────

/** Integer base units as a decimal string (e.g. "1500000" = 1.5 USDC at 6dp). */
export type BaseUnits = string;

const BASE_UNITS_RE = /^(0|[1-9][0-9]{0,38})$/;

export const isBaseUnits = (v: unknown): v is BaseUnits =>
  typeof v === "string" && BASE_UNITS_RE.test(v);

export const isProbability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export const isUnixMillis = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

// ── Stable Chumbucket market ids ─────────────────────────────────────────────

/**
 * A fixed namespace UUID for Chumbucket venue markets. `VenueMarket.id` is a
 * deterministic UUIDv5 over `<venue>:<venueMarketId>` so that re-syncing the
 * same venue market always yields the SAME Chumbucket id — which is what makes
 * polling idempotent and restart-safe without a database round-trip.
 */
const MARKET_NAMESPACE = "3f1b2c5a-9d44-4c7e-8a10-6b2f0d8e41c9";

function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const marketUuid = (venue: VenueId, venueMarketId: string): string =>
  uuidV5(`${venue}:${venueMarketId}`, MARKET_NAMESPACE);

// ── Demo-data safety ─────────────────────────────────────────────────────────

/** Every fixture question carries this prefix so a screenshot can never lie. */
export const DEMO_LABEL = "[DEMO]";

/** True for anything produced by the fixture catalog. */
export const isDemoMarket = (m: Pick<VenueMarket, "venue">): boolean => m.venue === "fixture";

/**
 * Venue evidence that a resolution is real. Fixture rows are structurally demo
 * and can never be laundered into a live result.
 */
export interface MarketResolutionRecord {
  id: string;
  marketId: string;
  venue: VenueId;
  venueMarketId: string;
  resolution: Resolution;
  resolvedAt: number;
  /** The venue's own resolution-source string, verbatim. */
  evidenceSource: string;
  /** The raw provider payload the resolution was read out of. */
  rawEvidence: unknown;
  recordedAt: number;
  /** true when this came from the fixture catalog — never a live result. */
  demo: boolean;
}
