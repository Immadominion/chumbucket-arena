/**
 * Packet F — the vocabulary of relational notifications and of a person's
 * record.
 *
 * Two rules govern every shape in this file:
 *
 *   1. A NOTIFICATION CARRIES FACTS, NOT MONEY AND NOT PROSE. There is no
 *      amount, no stake, no P&L, no balance, no signature, no secret and no
 *      thesis field on any type here, and `src/notifications/safety.ts` checks
 *      that at runtime for every payload that leaves the service — so a field
 *      added later fails immediately rather than shipping.
 *   2. A RECORD INCLUDES ITS MISSES. `CallRecordCounts` has `incorrect` as a
 *      required field, both arms of `RecordDisplay` carry it, and
 *      `src/notifications/record.ts` is the only constructor — and it refuses a
 *      set of counts whose arithmetic does not close. There is no shape in this
 *      file that can express a record with the losses left out.
 *
 * The frozen §3 scalars (`CallOutcome`, `Side`, `Resolution`, `FundingState`,
 * `VenueMarket`) are NOT redeclared here. They are imported from Packet B's
 * `src/prediction/types.ts`, which owns them.
 */

import type { CallOutcome, FundingState, Side } from "../prediction/types.ts";

export type { CallOutcome, FundingState, Side };

// ── the four kinds, and nothing else ─────────────────────────────────────────

/**
 * The four events that make the loop return.
 *
 * What is deliberately absent: any broadcast kind. There is no FOLLOWED_CALL
 * and no "someone you follow just called" — that fires on other people's
 * activity rather than on yours, and the copy it invites ("a caller you follow
 * just called") is the urgency §0 forbids. Every kind below is about something
 * that happened to the RECIPIENT'S OWN call.
 */
export type NotificationKind = "BACKED" | "FADED" | "RESOLVED" | "REMATCH";

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "BACKED",
  "FADED",
  "RESOLVED",
  "REMATCH",
] as const;

/**
 * Why a rematch is available.
 *   'challenge'          — somebody challenged a call of yours.
 *   'rival_called_again' — somebody you FADED has gone on record again.
 */
export type RematchReason = "challenge" | "rival_called_again";

export const REMATCH_REASONS: readonly RematchReason[] = ["challenge", "rival_called_again"] as const;

/**
 * A delivered notification, mirroring `public.social_notifications` column for
 * column so the in-memory store and the SQL enforce the same invariants.
 *
 * Note every column that is NOT here, because the SQL table does not have one
 * either: no title, no body, no note, no thesis, no amount, no stake, no
 * balance, no signature, no wallet. Copy is rendered at read time from `kind`
 * (see `copy.ts`); a stored body cannot leak what was never stored.
 */
export interface SocialNotification {
  id: string;
  /** canonical public.users.id — NEVER a wallet (§0.3) */
  recipientUserId: string;
  kind: NotificationKind;
  /** The other person. `null` for RESOLVED, and only for RESOLVED: the venue
   *  published the result and the venue is not a person (§0.2). */
  actorUserId: string | null;
  /** The RECIPIENT'S OWN call this is about. Never someone else's. */
  subjectCallId: string;
  /** The back / fade / challenge that caused it, when one did. */
  responseId: string | null;
  /** REMATCH/'rival_called_again' only: the rival's NEW call. */
  rivalCallId: string | null;
  /** RESOLVED only. A verbatim quote of `call_results.outcome`; never PENDING. */
  outcome: Exclude<CallOutcome, "PENDING"> | null;
  rematchReason: RematchReason | null;
  /** Unique per recipient. Composed only from fields that are non-null for this
   *  kind — see `dedupeKeyFor`. */
  dedupeKey: string;
  /** unix ms */
  createdAt: number;
  /** unix ms, or null while unread */
  readAt: number | null;
}

/** The other person, as a notification is allowed to describe them. */
export interface NotificationActor {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** One of the app's five fixed avatars, so the actor's own picture renders. */
  avatarId: number | null;
}

/**
 * A notification on the wire: the facts, plus the copy rendered from a fixed
 * template, plus the public market subject.
 *
 * `marketQuestion` is the venue's own question text, reproduced verbatim and
 * never paraphrased (§4). It is a structured field rather than part of `body`
 * on purpose: the copy rules in `copy.ts` bind the copy WE write, and splicing
 * arbitrary venue text into a sentence would make those rules uncheckable.
 */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  rematchReason: RematchReason | null;
  /** null for RESOLVED */
  actor: NotificationActor | null;
  subjectCallId: string;
  rivalCallId: string | null;
  marketId: string;
  /** the venue's own question, verbatim */
  marketQuestion: string | null;
  category: string | null;
  /** the recipient's own side on the subject call */
  side: Side;
  outcome: Exclude<CallOutcome, "PENDING"> | null;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
  unread: number;
  /** unix ms the server produced this page */
  servedAt: number;
}

// ── the record ───────────────────────────────────────────────────────────────

/**
 * Free and funded never share a row. §0.1: a call is not a trade, and a funded
 * venue position is a separate artefact that REFERENCES a call.
 */
export type FundingClass = "free" | "funded";

export const FUNDING_CLASSES: readonly FundingClass[] = ["free", "funded"] as const;

/** A free call is `fundingState === 'NONE'` and nothing else (§3). */
export const fundingClassOf = (state: FundingState): FundingClass =>
  state === "NONE" ? "free" : "funded";

/**
 * The counts behind a record.
 *
 * `incorrect` is a REQUIRED field, and `decided` is derived rather than stored,
 * so the only way to get a ratio out of this object is over correct + incorrect.
 * `voided` is present and excluded from `decided`: a VOID is never a win and
 * never a loss (§3). `pending` counts towards nothing at all.
 *
 * Build these through `buildCounts` in `record.ts`, which refuses any set whose
 * arithmetic does not close.
 */
export interface CallRecordCounts {
  correct: number;
  incorrect: number;
  voided: number;
  /** = correct + incorrect + voided */
  resolved: number;
  /** = correct + incorrect. The ONLY base an accuracy may be computed over. */
  decided: number;
  pending: number;
}

/**
 * How a record may be shown.
 *
 * This is a discriminated union rather than `accuracy: number | null` for one
 * reason: in the `counts` arm there is NO accuracy field at all, so a client
 * below the threshold cannot render a percentage even by ignoring a flag. Both
 * arms carry `incorrect`, so no rendering path omits the misses.
 */
export type RecordDisplay =
  | {
      mode: "counts";
      /** why no percentage is being shown, in copy a person can read */
      reason: string;
      correct: number;
      incorrect: number;
      voided: number;
      decided: number;
      pending: number;
      minimumDecided: number;
    }
  | {
      mode: "accuracy";
      /** [0,1], over decided calls only */
      accuracy: number;
      correct: number;
      incorrect: number;
      voided: number;
      decided: number;
      pending: number;
      minimumDecided: number;
    };

export interface CategoryRecord {
  category: string;
  counts: CallRecordCounts;
  /** unix ms of the most recent venue resolution in this category, or null */
  lastResolvedAt: number | null;
  display: RecordDisplay;
}

/**
 * One funding class of a person's record. There is no field on this type that
 * mixes the two classes, and no field that holds money — a funded band carries
 * accuracy counts only, because P&L belongs to Packet B's venue positions.
 */
export interface RecordBand {
  fundingClass: FundingClass;
  total: CallRecordCounts;
  display: RecordDisplay;
  byCategory: CategoryRecord[];
}

/**
 * A person's record. Two bands, never blended: there is deliberately no
 * `overall` field, because an overall number would be exactly the blend the
 * product rule forbids.
 */
export interface PersonRecord {
  userId: string;
  handle: string;
  displayName: string;
  free: RecordBand;
  funded: RecordBand;
  minimumDecidedForAccuracy: number;
  /** unix ms */
  servedAt: number;
}
