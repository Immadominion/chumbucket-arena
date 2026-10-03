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
import type { CallRecordCounts, RecordDisplay } from "../notifications/types.ts";
import type { CallFunding } from "../prediction/PantaFunding.ts";

export type { CallOutcome, FundingState, MarketSnapshot, Resolution, Side, VenueMarket };
export type { CallRecordCounts, RecordDisplay };
export type { CallFunding };

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
 * account — the default in this slice. It is held server-side (the directory
 * maps wallets to people) and is NEVER put on the wire: every social payload
 * passes through `redactWallets` (M2). A person reads their own wallet from
 * `account.me`.
 */
export interface Person {
  id: string;
  handle: string;
  displayName: string;
  /** An absolute https URL, when the person has one. */
  avatarUrl: string | null;
  /** One of the app's five fixed avatars (1..5), chosen by the person. */
  avatarId?: number | null;
  walletAddress: string | null;
  /** Settled calls only. VOID is excluded from BOTH numerator and denominator:
   *  a void is never a win and never a loss (§3). */
  settledCalls: number;
  correctCalls: number;
  /** The person's own profile line (`public.users.bio`). Absent when unset. */
  bio?: string | null;
  /** unix ms the account was created (`public.users.created_at`). Absent
   *  when the directory row does not carry one — never a guessed date. */
  joinedAt?: number | null;
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
  /**
   * Set only when the author backed THIS call with a Panta position whose
   * fill was confirmed (provider attribution + RPC proof). No amount, wallet
   * or order id. `call.fundingState` stays the immutable free/funded
   * provenance, so free-call accuracy is unaffected.
   */
  funding?: CallFunding | null;
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
  /** When this market stops taking new calls (close minus the cut-off). Null without a close. */
  callsCloseAt?: number | null;
  /** The server's call cut-off before market close, in ms. */
  callCutoffMs?: number;
  servedAt: number;
}

export interface CallDetail {
  entry: CallFeedEntry;
  parent: CallFeedEntry | null;
  responses: CallResponse[];
  /**
   * The thesis thread: timestamped follow-ups the AUTHOR appended after the
   * call locked, oldest first. The original `call.thesis` is untouched by any
   * of them — an update is a new row, never an edit (see `ThesisUpdate`).
   */
  updates: ThesisUpdate[];
  /** False when this call cannot take a new update: the server cannot persist
   *  updates yet (its table is absent), or the call was withdrawn. A client
   *  then offers no "Add update" action that would only fail. */
  updatesAvailable: boolean;
}

export interface PersonDetail {
  person: Person;
  calls: CallFeedEntry[];
  viewerIsFollowing: boolean;
  servedAt: number;
  /** People who follow this person. A count only: the lists are not public. */
  followerCount: number;
  /** People this person follows. A count only. */
  followingCount: number;
  /** The record the public sees — see `PublicRecord`. */
  record: PublicRecord;
}

// ── the thesis thread ────────────────────────────────────────────────────────

/**
 * One timestamped follow-up to a call's reason, written by the call's author.
 *
 * APPEND-ONLY. The original thesis is frozen with the call at `lockedAt`
 * (§0.1), and nothing here changes that: an update is a separate row with its
 * own `createdAt`, after the lock, so a reader can always tell what was said
 * before the result from what was said after. There is no edit and no delete —
 * the SQL trigger refuses both for every role, as the store does.
 */
export interface ThesisUpdate {
  id: string;
  callId: string;
  /** canonical public.users.id of the call's author — nobody else may write one */
  authorUserId: string;
  /** 1..280 chars, trimmed */
  body: string;
  createdAt: number;
}

/** Per call, so a thread stays a thread and not a second feed. */
export const MAX_THESIS_UPDATES_PER_CALL = 20;

// ── the people layer ─────────────────────────────────────────────────────────

/**
 * What the public may see of a person's record.
 *
 * SCOPE: free calls the author made PUBLIC — including ones later hidden.
 *   · followers-only calls are excluded, so an aggregate never discloses a
 *     call outside the audience its author chose (visibility is fixed at lock
 *     time, before any result, so excluding it cannot launder a record);
 *   · hidden calls are INCLUDED, because hiding happens after the fact and a
 *     record that withdrawing the losses could improve would be worth nothing
 *     (§3: "it does not rewrite CallResult or accuracy history");
 *   · funded positions are never blended in — that is a different band.
 *
 * `display` is `record.ts`'s `displayFor`: below the minimum decided sample it
 * has NO accuracy field at all, so no client can render a percentage it was
 * never handed.
 */
export interface PublicRecord {
  counts: CallRecordCounts;
  display: RecordDisplay;
}

/** A person as the people surfaces list them. Never a wallet. */
export interface PersonCard {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** One of the app's five fixed avatars (1..5), when the person chose one. */
  avatarId?: number | null;
  record: PublicRecord;
  viewerIsFollowing: boolean;
}

export type LeaderboardWindow = "7d" | "30d" | "all";

export interface LeaderboardRow {
  /** 1-based. Present only for a person with enough decided calls to rank. */
  rank: number | null;
  person: Omit<PersonCard, "record" | "viewerIsFollowing">;
  record: PublicRecord;
}

export interface Leaderboard {
  window: LeaderboardWindow;
  /** People with at least `minimumDecided` decided calls in the window, best first. */
  ranked: LeaderboardRow[];
  /** People with at least one decided call in the window but too few to rank.
   *  Ordered by evidence (decided count), never by a ratio they have not earned. */
  building: LeaderboardRow[];
  /** The signed-in viewer's own row, or null when signed out. A viewer with no
   *  decided call in the window still gets a row (all counts zero). */
  viewer: (LeaderboardRow & { decidedToRank: number }) | null;
  minimumDecided: number;
  /** Plain-language ranking rule, shown under the board. */
  rule: string;
  servedAt: number;
}

/**
 * An open call surfaced on Home's "Top calls" strip.
 *
 * `responses` is backs + fades + challenges: engagement with no direction, so
 * it says "people are answering this" and never "people agree". The directional
 * `split` follows the crowd-split gate — null until the VIEWER has their own
 * call on this market — so the strip cannot leak what `markets.detail`
 * withholds.
 */
export interface TopCall {
  call: Call;
  author: Omit<PersonCard, "viewerIsFollowing">;
  market: VenueMarket;
  responses: number;
  split: { backs: number; fades: number } | null;
  viewerHasCalled: boolean;
}

/** A person's latest live public call, for people.suggested. No money. */
export interface LatestLiveCall {
  callId: string;
  side: Side;
  marketId: string;
  question: string;
  closesAt: number | null;
}

/** Why someone is suggested. Evidence only — never money. */
export type SuggestionReason = "ranked" | "top_call" | "building" | "recent" | "friend";

export interface SuggestedPerson extends PersonCard {
  latestLiveCall: LatestLiveCall | null;
  reason: SuggestionReason;
}

/** people.suggested — who to follow during onboarding. */
export interface SuggestedPeople {
  /** The session's friends from the old app who are Chumbucket people.
   *  Always empty for a signed-out caller. */
  friends: SuggestedPerson[];
  /** People with at least one public free call, best evidence first. */
  people: SuggestedPerson[];
  servedAt: number;
}

export interface TopCallsPage {
  entries: TopCall[];
  servedAt: number;
}

export interface PeopleSearchResult {
  query: string;
  people: PersonCard[];
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
