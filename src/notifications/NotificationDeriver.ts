/**
 * The derivation pass — Packet D's rows in, notifications and records out.
 *
 * WHY A PASS AND NOT A HOOK
 *
 * `src/calls/**` is Packet D's and is read, never edited (§6), so this packet
 * cannot call out from `CallsService` when somebody backs a call. That turns
 * out to be the better design anyway, for the same reason Packet D's
 * `ResolutionSync` is a pass rather than a callback:
 *
 *   IDEMPOTENT   — running it twice creates nothing the second time. Not
 *                  because a cursor said so, but because every notification has
 *                  a dedupe key and the store refuses a second row under the
 *                  same one. Replay is a no-op by construction, not by
 *                  bookkeeping.
 *   RESTART-SAFE — a brand-new process with an empty everything derives the
 *                  whole correct inbox from the rows Packet D already has. A
 *                  dropped hook would have lost a notification forever; a
 *                  dropped pass loses nothing, because the next pass repairs it.
 *   ORDER-FREE   — it does not matter whether the back or the resolution
 *                  happened first, or whether the process was up.
 *
 * §8 FINDING 6, AND HOW THIS AVOIDS IT
 *
 * The legacy activity dedupe is `UNIQUE(network, tx_signature, type)` with
 * `tx_signature` NULLABLE; PostgreSQL treats NULLs as distinct, so off-chain
 * rows never conflict and duplicate without bound. Here, every kind's dedupe key
 * quotes exactly one field that the kind's shape rule makes non-null, and
 * `dedupeKeyFor` THROWS rather than substitute a placeholder for a missing one.
 * There is no null anywhere in the uniqueness argument, in SQL or in TypeScript.
 *
 * WHAT IS NEVER DERIVED HERE
 *
 *   · A broadcast. There is no "someone you follow just called" pass. Every
 *     notification below is about the recipient's OWN call.
 *   · A count. No notification says how many people did anything.
 *   · A result. PENDING is never announced, and the outcome is read from Packet
 *     D's `CallResult`, never recomputed (§0.2).
 *   · A notification about your own action. Checked here AND in the store AND
 *     in the SQL trigger.
 */

import { systemClock, type Clock } from "../prediction/clock.ts";
import { isNotificationsError } from "./errors.ts";
import type { VenueMarketReader } from "../calls/markets.ts";
import { buildCounts, tally } from "./record.ts";
import { canSee, type CallRecord, type SocialGraphReader } from "./sources.ts";
import type { NotificationDraft, NotificationsStore } from "./store.ts";
import { fundingClassOf, type FundingClass, type NotificationKind, type SocialNotification } from "./types.ts";

export interface DeriveReport {
  /** Candidate notifications considered this pass. */
  considered: number;
  /** Rows actually written. */
  created: number;
  /** The rows written this pass, in derivation order — what a push goes out for. */
  fresh: SocialNotification[];
  /** True when this pass re-read every row rather than only the recent ones. */
  fullScan: boolean;
  /** Candidates that were already delivered — the replay case. */
  duplicates: number;
  /** Candidates refused because the recipient could not see the call involved. */
  withheld: number;
  createdByKind: Record<NotificationKind, number>;
  /** Record rows written. */
  recordRows: number;
  /** True when the pass stopped early on `maxPerPass` NEW rows. */
  truncated: boolean;
}

export interface NotificationDeriverDeps {
  store: NotificationsStore;
  graph: SocialGraphReader;
  markets: VenueMarketReader;
  clock?: Clock;
  /** Injectable so ids are deterministic in a test. */
  newId?: () => string;
  /** Bound on the rows ONE pass may write. Replays are free and never count. */
  maxPerPass?: number;
  /**
   * Rows whose triggering instant is older than the last completed pass minus
   * this window are not re-read on an incremental pass. The overlap absorbs
   * clock skew between a row's timestamp and the moment it reached the mirror;
   * re-reading is harmless, because a replay is a no-op.
   */
  overlapMs?: number;
  /** How often an incremental deriver still re-reads everything, as a repair. */
  fullScanEveryMs?: number;
}

export class NotificationDeriver {
  private readonly store: NotificationsStore;
  private readonly graph: SocialGraphReader;
  private readonly markets: VenueMarketReader;
  private readonly clock: Clock;
  private readonly maxPerPass: number;
  private readonly overlapMs: number;
  private readonly fullScanEveryMs: number;
  private readonly newId: () => string;
  private seq = 0;
  /** Start of the last pass that was not truncated; null = never (full scan next). */
  private cursor: number | null = null;
  private lastFullScanAt = Number.NEGATIVE_INFINITY;

  constructor(deps: NotificationDeriverDeps) {
    this.store = deps.store;
    this.graph = deps.graph;
    this.markets = deps.markets;
    this.clock = deps.clock ?? systemClock;
    this.maxPerPass = deps.maxPerPass ?? 500;
    this.overlapMs = deps.overlapMs ?? 120_000;
    this.fullScanEveryMs = deps.fullScanEveryMs ?? 3_600_000;
    this.newId = deps.newId ?? (() => `notif_${++this.seq}_${this.clock.now().toString(36)}`);
  }

  /** Notifications and records, in one pass. Safe to run on a loop. */
  runOnce(): DeriveReport {
    const report = this.deriveNotifications();
    report.recordRows = this.rebuildRecords();
    return report;
  }

  // ── notifications ─────────────────────────────────────────────────────────

  deriveNotifications(): DeriveReport {
    const passStartedAt = this.clock.now();
    const fullScan = this.cursor === null || passStartedAt - this.lastFullScanAt >= this.fullScanEveryMs;
    const since = fullScan ? null : (this.cursor as number) - this.overlapMs;
    const report: DeriveReport = {
      considered: 0,
      created: 0,
      fresh: [],
      fullScan,
      duplicates: 0,
      withheld: 0,
      createdByKind: { BACKED: 0, FADED: 0, RESOLVED: 0, REMATCH: 0 },
      recordRows: 0,
      truncated: false,
    };

    for (const draft of this.candidates(report, since)) {
      report.considered++;
      const { notification, created } = this.store.insertIfAbsent(draft, this.newId(), { actor: "service" });
      if (created) {
        report.created++;
        report.createdByKind[draft.kind]++;
        report.fresh.push(notification);
        // The cap bounds WRITES. A replayed fact costs nothing and must never
        // be what stops a pass: counting duplicates against the cap meant that
        // past ~500 historical candidates every pass truncated on rows it had
        // already delivered, and new notifications stopped for good (M4).
        if (report.created >= this.maxPerPass) {
          report.truncated = true;
          break;
        }
      } else {
        report.duplicates++;
      }
    }

    // A truncated pass leaves the cursor where it was, so the next pass resumes
    // over the same window; everything it already wrote replays for free.
    if (!report.truncated) {
      this.cursor = passStartedAt;
      if (fullScan) this.lastFullScanAt = passStartedAt;
    }
    return report;
  }

  /**
   * Every notification the current state of Packet D's rows justifies.
   *
   * Deterministic order — responses by `createdAt` then id, calls by `lockedAt`
   * then id — so a replay produces the same sequence and the same winner when
   * two candidates share a dedupe key.
   */
  private *candidates(report: DeriveReport, since: number | null): Generator<NotificationDraft> {
    const recent = (at: number) => since === null || at >= since;
    const allResponses = this.graph.listResponses();
    // Filter BEFORE sorting: an incremental pass sorts only the recent rows.
    const responses = allResponses
      .filter((r) => recent(r.createdAt))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    // ── 1. somebody BACKED / FADED / CHALLENGED your call ──────────────────
    for (const r of responses) {
      const target = this.graph.getCall(r.targetCallId);
      if (!target) continue;
      // A withdrawn call is withdrawn from distribution (§3) — including from
      // its own author's inbox. Notifications already delivered stay: hiding
      // hides, it does not rewrite history.
      if (target.hiddenAt !== null) continue;
      // Never notify someone about their own action. `call_responses` already
      // refuses a self-response; this never relies on that.
      if (r.actorUserId === target.userId) continue;

      if (r.kind === "back" || r.kind === "fade") {
        yield {
          recipientUserId: target.userId,
          kind: r.kind === "back" ? "BACKED" : "FADED",
          actorUserId: r.actorUserId,
          subjectCallId: target.id,
          subjectCallAuthorId: target.userId,
          responseId: r.id,
          rivalCallId: null,
          outcome: null,
          rematchReason: null,
          createdAt: r.createdAt,
        };
        continue;
      }

      // A challenge is a rematch offer aimed at you. It carries no amount and
      // no escrow — §3 — and neither does the notification about it.
      yield {
        recipientUserId: target.userId,
        kind: "REMATCH",
        actorUserId: r.actorUserId,
        subjectCallId: target.id,
        subjectCallAuthorId: target.userId,
        responseId: r.id,
        rivalCallId: null,
        outcome: null,
        rematchReason: "challenge",
        createdAt: r.createdAt,
      };
    }

    // ── 2. your call RESOLVED ──────────────────────────────────────────────
    const allCalls = this.graph.listCalls();
    const resolvedCalls = allCalls
      .filter((c) => {
        if (c.hiddenAt !== null) return false;
        const result = this.graph.getResult(c.id);
        // PENDING is never announced. A market that closed long ago, or whose
        // status reads RESOLVED while the venue has published nothing, stays
        // silent — absence of evidence is not evidence (§0.2). The trigger is
        // the moment the result was DERIVED, not when the venue says it
        // resolved: a resolution synced late is still news.
        return !!result && result.outcome !== "PENDING" && recent(result.derivedAt);
      })
      .sort((a, b) => a.lockedAt - b.lockedAt || a.id.localeCompare(b.id));

    for (const c of resolvedCalls) {
      const result = this.graph.getResult(c.id);
      if (!result || result.outcome === "PENDING") continue;
      yield {
        recipientUserId: c.userId,
        kind: "RESOLVED",
        // The venue published it, and the venue is not a person.
        actorUserId: null,
        subjectCallId: c.id,
        subjectCallAuthorId: c.userId,
        responseId: null,
        rivalCallId: null,
        outcome: result.outcome,
        rematchReason: null,
        createdAt: result.resolvedAt ?? result.derivedAt,
      };
    }

    // ── 3. the person you FADED has gone on record again ───────────────────
    // Triggered by the rival's NEW call, so an incremental pass only looks at
    // fades of people who have called since the cursor — across every fade,
    // however old, because "again" can come months later.
    const recentAuthors =
      since === null ? null : new Set(allCalls.filter((c) => recent(c.lockedAt)).map((c) => c.userId));
    const fades = allResponses
      .filter((f) => f.kind === "fade")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const f of fades) {
      const target = this.graph.getCall(f.targetCallId);
      if (!target) continue;
      const rivalId = target.userId;
      const faderId = f.actorUserId;
      if (rivalId === faderId) continue;
      if (recentAuthors && !recentAuthors.has(rivalId)) continue;

      // §3: a fade ALWAYS creates the actor's own call, and that call is the
      // recipient's own subject for this notification — which is what keeps
      // "every row is about your own call" true for this kind too.
      const ownCall = f.resultingCallId ? this.graph.getCall(f.resultingCallId) : undefined;
      if (!ownCall || ownCall.userId !== faderId || ownCall.hiddenAt !== null) continue;

      for (const rivalCall of this.graph
        .callsByAuthor(rivalId)
        .slice()
        .sort((a, b) => a.lockedAt - b.lockedAt || a.id.localeCompare(b.id))) {
        if (rivalCall.id === target.id) continue;
        if (rivalCall.hiddenAt !== null) continue;
        // "Called AGAIN" means after the fade. A call they had already made is
        // not news.
        if (rivalCall.lockedAt <= f.createdAt) continue;
        if (!recent(rivalCall.lockedAt)) continue;
        // A notification must never reveal a call the recipient may not read —
        // that would hand over exactly what `calls_followers_select` withholds.
        if (!this.canRecipientSee(rivalCall, faderId)) {
          report.withheld++;
          continue;
        }
        yield {
          recipientUserId: faderId,
          kind: "REMATCH",
          actorUserId: rivalId,
          subjectCallId: ownCall.id,
          subjectCallAuthorId: ownCall.userId,
          responseId: null,
          rivalCallId: rivalCall.id,
          outcome: null,
          rematchReason: "rival_called_again",
          createdAt: rivalCall.lockedAt,
        };
      }
    }
  }

  private canRecipientSee(call: CallRecord, viewerUserId: string): boolean {
    return canSee(this.graph, call, viewerUserId);
  }

  // ── records ───────────────────────────────────────────────────────────────

  /**
   * Materialise `public.call_category_records` from Packet D's calls and
   * results. One pass per person, grouped by (category, funding class) —
   * exactly the single `GROUP BY` in `public.call_category_record_rebuild`, so
   * correct and incorrect always come out of the same loop and neither can be
   * produced without the other.
   *
   * Counts EVERY call the person made, hidden and followers-only included. §3:
   * hiding a call does not rewrite accuracy history, and a record that could be
   * laundered by withdrawing the losses would be worth nothing.
   *
   * Returns the number of rows written.
   */
  rebuildRecords(): number {
    const at = this.clock.now();
    type Cell = {
      correct: number;
      incorrect: number;
      voided: number;
      pending: number;
      lastResolvedAt: number | null;
    };
    const cells = new Map<string, { userId: string; category: string; fundingClass: FundingClass; cell: Cell }>();

    for (const call of this.graph.listCalls()) {
      const category = this.markets.getMarket(call.marketId)?.category || "uncategorised";
      const fundingClass = fundingClassOf(call.fundingState);
      const key = JSON.stringify([call.userId, category, fundingClass]);
      const entry =
        cells.get(key) ??
        {
          userId: call.userId,
          category,
          fundingClass,
          cell: { correct: 0, incorrect: 0, voided: 0, pending: 0, lastResolvedAt: null },
        };
      // No result row at all is PENDING, which is the only thing the absence of
      // venue evidence ever means (§0.2).
      const result = this.graph.getResult(call.id);
      tally(entry.cell, result?.outcome ?? "PENDING");
      if (result && result.outcome !== "PENDING" && result.resolvedAt !== null) {
        entry.cell.lastResolvedAt = Math.max(entry.cell.lastResolvedAt ?? 0, result.resolvedAt);
      }
      cells.set(key, entry);
    }

    let written = 0;
    for (const { userId, category, fundingClass, cell } of cells.values()) {
      // Only the four tallies: `buildCounts` validates every key it is given,
      // and a cell's lastResolvedAt is legitimately null while nothing in it
      // has resolved. Passing the whole cell made every pass (and so every
      // inbox read) throw RECORD_INCOMPLETE as soon as anyone had a call
      // still pending in a category.
      const counts = buildCounts({
        correct: cell.correct,
        incorrect: cell.incorrect,
        voided: cell.voided,
        pending: cell.pending,
      });
      try {
        this.store.writeRecordRow(
          {
            userId,
            category,
            fundingClass,
            correct: counts.correct,
            incorrect: counts.incorrect,
            voided: counts.voided,
            resolved: counts.resolved,
            pending: counts.pending,
            lastResolvedAt: cell.lastResolvedAt,
          },
          at,
          { actor: "service" },
        );
        written++;
      } catch (e) {
        // A monotonicity refusal means the stored record already knows about
        // more resolved calls than this pass can see — which is a real signal
        // (a partial read, a lost row) and never a reason to lower a record.
        // It is left alone and the pass continues.
        if (!isNotificationsError(e)) throw e;
      }
    }
    return written;
  }
}
