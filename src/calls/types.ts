/**
 * Packet D — the social-call vocabulary.
 *
 * Everything here is either a FROZEN §3 shape reproduced verbatim, or a view
 * model the mobile slice already declares in
 * `lib/features/calls/data/calls_repository.dart`. The frozen SCALARS (Side,
 * Resolution, CallOutcome, FundingState, VenueMarket, MarketSnapshot) are NOT
 * redeclared here — they are imported from Packet B's `src/prediction/types.ts`,
 * which owns them, and so is `deriveCallOutcome`. One definition, one rule.
 *
 * Wire rules that travel with these types (§3):
 *   - every timestamp is unix MILLISECONDS, integer, UTC
 *   - every probability is a `number` in [0,1]
 *   - no user stake, payout or transaction. Optional Panta entryPrice is a
 *     non-executable venue unit-price observation, not money put at risk.
 *     A funded venue position remains a separate artefact referencing a call.
 */

import type {
  CallOutcome,
  FundingState,
  MarketSnapshot,
  Resolution,
  Side,
  VenueMarket,
} from "../prediction/types.ts";
import type { SharePriceSnapshot } from "../prediction/sharePrices.ts";

export type { CallOutcome, FundingState, MarketSnapshot, Resolution, Side, VenueMarket };

// ── §3 frozen shapes ─────────────────────────────────────────────────────────

export type CallVisibility = "public" | "followers";
export type CallResponseKind = "back" | "fade" | "challenge";

export const CALL_VISIBILITIES: readonly CallVisibility[] = ["public", "followers"] as const;
export const CALL_RESPONSE_KINDS: readonly CallResponseKind[] = ["back", "fade", "challenge"] as const;

/** §3, verbatim. Note what is absent: any amount, stake, escrow or signature. */
export interface Call {
  id: string;
  /** canonical public.users.id — NEVER a wallet */
  userId: string;
  marketId: string;
  side: Side;
  /** [0,1], self-reported, optional */
  confidence: number | null;
  /** <= 280 chars */
  thesis: string | null;
  entryProbability: number | null;
  snapshotId: string | null;
  /** Panta's immutable observed unit prices; not a stake or executable quote. */
  entryPrice?: SharePriceSnapshot | null;
  visibility: CallVisibility;
  createdAt: number;
  /** immutable from this instant */
  lockedAt: number;
  /** set when this call came from a Back/Fade */
  parentCallId: string | null;
  /** 'NONE' for a free call */
  fundingState: FundingState;
}

/** §3, verbatim. back/fade ALWAYS create the actor's own call. */
export interface CallResponse {
  id: string;
  actorUserId: string;
  targetCallId: string;
  kind: CallResponseKind;
  resultingCallId: string | null;
  createdAt: number;
}

/** §3, verbatim. Service-derived only. */
export interface CallResult {
  callId: string;
  outcome: CallOutcome;
  resolution: Resolution | null;
  resolvedAt: number | null;
  /** the venue evidence this was derived from */
  marketResolutionId: string | null;
  derivedAt: number;
}

// ── storage records: the frozen shape plus the columns the wire never sees ───

/**
 * A stored call. `hiddenAt` is the soft delete (§3: "Deleting a public call
 * hides it from distribution; it does not rewrite CallResult or accuracy
 * history"). It is deliberately NOT part of `Call`: the wire shape stays
 * exactly §3, and a hidden call never reaches the wire at all.
 */
export interface CallRecord extends Call {
  hiddenAt: number | null;
  hiddenReason: string | null;
}

/** The wire projection of a stored call. Drops the storage-only columns. */
export function toCall(rec: CallRecord): Call {
  const { hiddenAt: _h, hiddenReason: _r, ...call } = rec;
  return call;
}

export interface CallResponseRecord extends CallResponse {
  note: string | null;
}

export function toCallResponse(rec: CallResponseRecord): CallResponse {
  const { note: _n, ...response } = rec;
  return response;
}

// ── view models the mobile slice already declares ────────────────────────────

/**
 * A person, keyed by the canonical `public.users.id`. `walletAddress` is a
 * LINKED CREDENTIAL, not the identity (§0.3), and is null for a wallet-less
 * account — the default in this slice.
 */
export interface Person {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  walletAddress: string | null;
  /** Settled calls only. VOID is excluded from BOTH numerator and denominator:
   *  a void is never a win and never a loss (§3). */
  settledCalls: number;
  correctCalls: number;
}

/**
 * How the community called a market. The server sends this ONLY once the caller
 * has a locked call on that market — see `CallsService.marketDetail`. A client
 * that asks early is sent `null`, so it cannot render what it was never handed.
 */
export interface CrowdSplit {
  marketId: string;
  yesCalls: number;
  noCalls: number;
}

export interface CallFeedEntry {
  call: Call;
  author: Person;
  market: VenueMarket;
  result: CallResult | null;
  /** Engagement counts on this specific call — NOT a crowd forecast. */
  backCount: number;
  fadeCount: number;
  /** True when the viewer already has their own call on `market`. */
  viewerHasCalled: boolean;
}

export interface CallFeedPage {
  entries: CallFeedEntry[];
  nextCursor: string | null;
  /** unix ms the server produced this page */
  servedAt: number;
}

export interface MarketDetail {
  market: VenueMarket;
  snapshot: MarketSnapshot | null;
  sharePrice?: SharePriceSnapshot | null;
  viewerCall: CallFeedEntry | null;
  /** null until the viewer has locked a call on this market */
  crowdSplit: CrowdSplit | null;
  servedAt: number;
}

export interface CallDetail {
  entry: CallFeedEntry;
  parent: CallFeedEntry | null;
  responses: CallResponse[];
}

export interface PersonDetail {
  person: Person;
  calls: CallFeedEntry[];
  viewerIsFollowing: boolean;
  servedAt: number;
}

/**
 * A targeted rematch invitation produced by a `challenge` response.
 *
 * NOT a frozen contract type: §3 freezes `kind = 'challenge'` but declares no
 * invitation shape. It deliberately carries NO amount, NO escrow and NO
 * transaction — a challenge is a dare to go on record, not a wager. There is no
 * field here that could make `hasEscrow` true, and `assertMoneyFree` is applied
 * to every one of these before it leaves the service.
 */
export interface ChallengeInvitation {
  id: string;
  fromUserId: string;
  toUserId: string;
  marketId: string;
  sourceCallId: string;
  responseId: string;
  note: string | null;
  createdAt: number;
}

export interface CallResponseResult {
  response: CallResponse;
  /** back/fade -> the actor's OWN call. challenge -> null, always. */
  resultingCall: CallFeedEntry | null;
  /** challenge -> the invitation. back/fade -> null. */
  invitation: ChallengeInvitation | null;
}

// ── inputs ───────────────────────────────────────────────────────────────────

export interface CreateCallInput {
  marketId: string;
  side: Side;
  confidence?: number | null;
  thesis?: string | null;
  visibility?: CallVisibility;
  snapshotId?: string | null;
  parentCallId?: string | null;
}

export interface RespondToCallInput {
  targetCallId: string;
  kind: CallResponseKind;
  confidence?: number | null;
  thesis?: string | null;
  visibility?: CallVisibility;
  note?: string | null;
}

// ── the money-free guarantee, made checkable ─────────────────────────────────

/**
 * Field names that would mean money. A challenge — and anything derived from
 * one — must contain none of them, at any depth.
 */
const MONEY_KEY = /(amount|stake|escrow|wager|payout|price|fee|lamport|baseunits|units|currency|token|signature|tx|txn|transaction|balance|collateral|deposit)/i;

/**
 * Throws if a payload carries anything money-shaped. Called on every challenge
 * invitation before it leaves the service, so "a challenge carries no amount,
 * no escrow and no transaction" is checked at runtime and not merely typed —
 * a future field added to `ChallengeInvitation` fails this immediately.
 */
export function assertMoneyFree(value: unknown, what: string, path = ""): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertMoneyFree(v, what, `${path}[${i}]`));
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (MONEY_KEY.test(key)) {
      throw new Error(
        `${what} must carry no money: found a money-shaped field "${path}${path ? "." : ""}${key}". A challenge is a dare to go on record, not a wager (contracts §3).`,
      );
    }
    assertMoneyFree(v, what, `${path}${path ? "." : ""}${key}`);
  }
}
