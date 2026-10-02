/**
 * Packet F — a person's record, and the rule about when a percentage is honest.
 *
 * FOUR PROPERTIES, EACH ENFORCED RATHER THAN DOCUMENTED
 *
 *   1. A RECORD INCLUDES ITS MISSES. `buildCounts` is the only constructor, it
 *      takes the four outcomes together, and `assertRecordComplete` refuses any
 *      set whose arithmetic does not close. Both arms of `RecordDisplay` carry
 *      `incorrect`, so no rendering path omits it either. The SQL side says the
 *      same thing as a CHECK (`resolved_count = correct + incorrect + void`)
 *      and as a monotonicity trigger, so a miss cannot be un-counted after the
 *      fact — see 20260913150500_social_notifications_category_record.sql.
 *
 *   2. VOID IS NEVER A WIN AND NEVER A LOSS (§3). It is counted — it is part of
 *      what happened — and it is excluded from `decided`, which is the only
 *      base an accuracy is ever computed over.
 *
 *   3. PENDING COUNTS TOWARDS NOTHING. A call with no venue evidence is
 *      PENDING, forever if that is how long the venue takes (§0.2). It appears
 *      so a person can see what is outstanding, and it enters no ratio.
 *
 *   4. FREE ACCURACY AND FUNDED P&L ARE NEVER BLENDED. The two funding classes
 *      are separate bands, `PersonRecord` has no `overall` field, and there is
 *      no money field anywhere in this module — the funded band carries
 *      accuracy counts only. P&L lives with Packet B's venue positions.
 *
 * ── THE THRESHOLD ───────────────────────────────────────────────────────────
 *
 * `MIN_DECIDED_FOR_ACCURACY = 10`. Below ten DECIDED calls the product reports
 * raw counts and no percentage. Two independent reasons, either sufficient:
 *
 *   · RESOLUTION. With n decided calls, one call moves the headline by 100/n
 *     points. At n = 10 that is already 10 points; below 10 a single call moves
 *     a displayed percentage by more than ten points, so the number describes
 *     the last call rather than the record.
 *   · DISCRIMINATION. Against a null of a coin flip, a flawless run of 10 has
 *     probability 2^-10 ≈ 0.1%; of 5, 3.1%; of 3, 12.5%. Ten is the smallest
 *     round n at which a perfect record is not plausibly luck at the 1% level.
 *     The 95% Wilson interval for 10/10 is roughly [72%, 100%]; for 3/3 it is
 *     roughly [44%, 100%], which does not even exclude a coin.
 *
 * It thresholds on DECIDED, not on RESOLVED. Nine VOIDs and one CORRECT is ten
 * resolved calls and one piece of information; thresholding on resolved would
 * publish "100%" off a single call. §3 calls VOID "never a win or a loss", and
 * a value that is neither cannot be evidence of accuracy either — so this file
 * reads "minimum resolved" as "minimum decided" and says so out loud.
 *
 * It is a constant and not a config knob on purpose. A server that can be
 * configured to report 100% from one call is a server that will be.
 */

import { NotificationsError } from "./errors.ts";
import {
  fundingClassOf,
  type CallOutcome,
  type CallRecordCounts,
  type CategoryRecord,
  type FundingClass,
  type FundingState,
  type PersonRecord,
  type RecordBand,
  type RecordDisplay,
} from "./types.ts";

/**
 * The minimum number of DECIDED calls (CORRECT + INCORRECT) before a percentage
 * is shown. The same literal is the generation expression of
 * `public.call_category_records.accuracy_reportable`, and
 * tests/socialNotificationsRecord.test.ts reads the migration and asserts the
 * two agree — so the schema and the BFF cannot drift into disagreeing about
 * when a number is honest.
 */
export const MIN_DECIDED_FOR_ACCURACY = 10;

/** Copy for the below-threshold case. Says what is missing, not "coming soon". */
export const BELOW_THRESHOLD_REASON = `A percentage needs at least ${MIN_DECIDED_FOR_ACCURACY} calls the venue has actually decided. Until then this is the record itself.`;

export const EMPTY_COUNTS: CallRecordCounts = Object.freeze({
  correct: 0,
  incorrect: 0,
  voided: 0,
  resolved: 0,
  decided: 0,
  pending: 0,
});

/**
 * The ONLY way to make a `CallRecordCounts`.
 *
 * It takes all four outcome tallies at once, so there is no partial call that
 * could produce a record with the misses left out, and it derives `resolved`
 * and `decided` rather than accepting them — a caller cannot claim a total that
 * disagrees with its parts.
 */
export function buildCounts(input: {
  correct: number;
  incorrect: number;
  voided: number;
  pending: number;
}): CallRecordCounts {
  // Only the four tallies. Callers pass their whole cell, which also carries
  // `lastResolvedAt` — null until something in that cell resolves — and
  // checking that as a count refused every record with only pending calls
  // (and with it every derive-on-read inbox request).
  const tallies = { correct: input.correct, incorrect: input.incorrect, voided: input.voided, pending: input.pending };
  for (const [k, v] of Object.entries(tallies)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new NotificationsError(
        "RECORD_INCOMPLETE",
        `a record's ${k} must be a non-negative integer (got ${String(v)})`,
        { details: { field: k, value: v } },
      );
    }
  }
  const counts: CallRecordCounts = {
    correct: input.correct,
    incorrect: input.incorrect,
    voided: input.voided,
    // VOID is part of what happened…
    resolved: input.correct + input.incorrect + input.voided,
    // …and no part of what was decided (§3).
    decided: input.correct + input.incorrect,
    pending: input.pending,
  };
  assertRecordComplete(counts);
  return counts;
}

/**
 * Refuse a record whose arithmetic does not close.
 *
 * This is what makes "there must be no way to compute a record that omits
 * incorrect calls" true for a hand-built object as well as for a derived one: a
 * `{ correct: 10, incorrect: 0, resolved: 10 }` that was really 10 correct out
 * of 14 cannot pass, because `resolved` has to equal the sum of its parts and
 * `decided` has to equal correct + incorrect.
 */
export function assertRecordComplete(counts: CallRecordCounts): void {
  const sum = counts.correct + counts.incorrect + counts.voided;
  if (counts.resolved !== sum) {
    throw new NotificationsError(
      "RECORD_INCOMPLETE",
      `a record must account for every resolved call: resolved=${counts.resolved} but correct+incorrect+void=${sum}. A record that can shed its misses is not a record (contracts §3).`,
      { details: { counts } },
    );
  }
  if (counts.decided !== counts.correct + counts.incorrect) {
    throw new NotificationsError(
      "RECORD_INCOMPLETE",
      `a record's decided count is correct+incorrect and nothing else: got ${counts.decided}, expected ${counts.correct + counts.incorrect}. VOID is never a win and never a loss (contracts §3).`,
      { details: { counts } },
    );
  }
}

/** Fold one §3 CallOutcome into a running tally. PENDING lands in `pending`. */
export function tally(
  acc: { correct: number; incorrect: number; voided: number; pending: number },
  outcome: CallOutcome,
): void {
  switch (outcome) {
    case "CORRECT":
      acc.correct++;
      return;
    case "INCORRECT":
      acc.incorrect++;
      return;
    case "VOID":
      acc.voided++;
      return;
    case "PENDING":
      acc.pending++;
      return;
  }
}

/**
 * How a record may be shown.
 *
 * Below the threshold the returned object has NO `accuracy` field at all — not
 * a null one, not a zero one. A client cannot render a percentage it was never
 * handed, which is the same discipline Packet D uses for `crowdSplit`.
 */
export function displayFor(counts: CallRecordCounts): RecordDisplay {
  assertRecordComplete(counts);
  const shared = {
    correct: counts.correct,
    incorrect: counts.incorrect,
    voided: counts.voided,
    decided: counts.decided,
    pending: counts.pending,
    minimumDecided: MIN_DECIDED_FOR_ACCURACY,
  };
  if (counts.decided < MIN_DECIDED_FOR_ACCURACY) {
    return { mode: "counts", reason: BELOW_THRESHOLD_REASON, ...shared };
  }
  return { mode: "accuracy", accuracy: counts.correct / counts.decided, ...shared };
}

/** Sum category counts into a band total. Derived the same way, so it closes too. */
export function sumCounts(parts: readonly CallRecordCounts[]): CallRecordCounts {
  return buildCounts({
    correct: parts.reduce((n, c) => n + c.correct, 0),
    incorrect: parts.reduce((n, c) => n + c.incorrect, 0),
    voided: parts.reduce((n, c) => n + c.voided, 0),
    pending: parts.reduce((n, c) => n + c.pending, 0),
  });
}

/** One resolved/unresolved call, as the record builder needs to see it. */
export interface RecordInput {
  category: string;
  fundingState: FundingState;
  outcome: CallOutcome;
  /** unix ms of the venue resolution, or null while PENDING */
  resolvedAt: number | null;
}

/**
 * Build a person's whole record in one pass.
 *
 * The pass is deliberately singular: correct and incorrect come out of the same
 * loop over the same inputs, so there is no code path that could produce one
 * without the other. It mirrors the single `GROUP BY` in
 * `public.call_category_record_rebuild`.
 *
 * Every call counts, INCLUDING hidden and followers-only ones. §3: "Deleting a
 * public call hides it from distribution; it does not rewrite CallResult or
 * accuracy history." A record that could be laundered by withdrawing the losses
 * would be worth nothing.
 */
export function buildPersonRecord(
  who: { userId: string; handle: string; displayName: string },
  inputs: readonly RecordInput[],
  servedAt: number,
): PersonRecord {
  const bands = new Map<FundingClass, Map<string, { correct: number; incorrect: number; voided: number; pending: number; lastResolvedAt: number | null }>>([
    ["free", new Map()],
    ["funded", new Map()],
  ]);

  for (const input of inputs) {
    const band = bands.get(fundingClassOf(input.fundingState));
    if (!band) continue;
    const key = input.category || "uncategorised";
    const cell =
      band.get(key) ?? { correct: 0, incorrect: 0, voided: 0, pending: 0, lastResolvedAt: null };
    tally(cell, input.outcome);
    if (input.outcome !== "PENDING" && input.resolvedAt !== null) {
      cell.lastResolvedAt = Math.max(cell.lastResolvedAt ?? 0, input.resolvedAt);
    }
    band.set(key, cell);
  }

  return {
    userId: who.userId,
    handle: who.handle,
    displayName: who.displayName,
    free: bandOf("free", bands.get("free")!),
    funded: bandOf("funded", bands.get("funded")!),
    minimumDecidedForAccuracy: MIN_DECIDED_FOR_ACCURACY,
    servedAt,
  };
}

function bandOf(
  fundingClass: FundingClass,
  cells: Map<string, { correct: number; incorrect: number; voided: number; pending: number; lastResolvedAt: number | null }>,
): RecordBand {
  const byCategory: CategoryRecord[] = [...cells.entries()]
    .map(([category, cell]) => {
      const counts = buildCounts(cell);
      return { category, counts, lastResolvedAt: cell.lastResolvedAt, display: displayFor(counts) };
    })
    // Most-decided first, then alphabetical: a stable order that does not rank
    // people and does not privilege whichever category resolved most recently.
    .sort((a, b) => b.counts.decided - a.counts.decided || a.category.localeCompare(b.category));

  const total = sumCounts(byCategory.map((c) => c.counts));
  return { fundingClass, total, display: displayFor(total), byCategory };
}
