/**
 * The BFF-side store for notifications and records. Mirrors, one for one, the
 * two tables added by the Packet F migrations — `public.social_notifications`
 * and `public.call_category_records` — so the in-memory implementation and the
 * SQL enforce the SAME invariants:
 *
 *   - DEDUPE IS BY (recipient, dedupe_key), and the key is composed HERE, from
 *     fields that are non-null for that kind. The same person backing the same
 *     call twice is one notification. §8 finding 6 is the mistake this is
 *     written not to repeat: `prediction_activity` dedupes on
 *     `UNIQUE(network, tx_signature, type)` with `tx_signature` NULLABLE, and
 *     PostgreSQL treats NULLs as distinct, so those rows duplicate without
 *     bound. `dedupeKeyFor` throws rather than return a key containing a
 *     placeholder for a missing id, so there is no "null-ish" key here either.
 *   - NOBODY IS NOTIFIED ABOUT THEIR OWN ACTION. `insertIfAbsent` refuses
 *     actor === recipient outright.
 *   - A NOTIFICATION IS ABOUT THE RECIPIENT'S OWN CALL. The caller supplies the
 *     subject call's author and it must be the recipient — the same rule the
 *     SQL guard trigger enforces against `public.calls`.
 *   - A DELIVERED NOTIFICATION IS IMMUTABLE except for `readAt`.
 *   - NOTIFICATIONS AND RECORDS ARE SERVICE-DERIVED. Both write paths take an
 *     actor and refuse `"client"`, which is the BFF-layer twin of the SQL side
 *     simply having no write policy for anon or authenticated.
 *   - A RECORD'S COUNTERS ARE MONOTONE. correct, incorrect, void and resolved
 *     may only go up; a record row is never deleted. A miss, once counted,
 *     cannot be un-counted.
 */

import { NotificationsError } from "./errors.ts";
import { assertRecordComplete, MIN_DECIDED_FOR_ACCURACY } from "./record.ts";
import type {
  CallRecordCounts,
  FundingClass,
  NotificationKind,
  RematchReason,
  SocialNotification,
} from "./types.ts";

/**
 * Who is attempting a write. The SQL side has no INSERT/UPDATE policy for anon
 * or authenticated on either table; this is the same rule one layer up, so a
 * route that forgot could not slip a client write through either.
 */
export type NotificationWriteActor = "service" | "client";

/** The fields a notification is built from, before an id and a key exist. */
export interface NotificationDraft {
  recipientUserId: string;
  kind: NotificationKind;
  actorUserId: string | null;
  subjectCallId: string;
  /** The author of `subjectCallId` — must be the recipient. */
  subjectCallAuthorId: string;
  responseId: string | null;
  rivalCallId: string | null;
  outcome: SocialNotification["outcome"];
  rematchReason: RematchReason | null;
  createdAt: number;
}

/**
 * The dedupe key, composed exactly as `public.social_notification_dedupe_key`
 * composes it.
 *
 * Per kind it quotes the ONE field that kind's shape rule makes non-null, so
 * the key can never contain a placeholder for something missing. It throws
 * instead of substituting — a key with a hole in it is how §8 finding 6
 * happened.
 */
export function dedupeKeyFor(
  d: Pick<NotificationDraft, "kind" | "rematchReason" | "subjectCallId" | "responseId" | "rivalCallId">,
): string {
  const need = (v: string | null, what: string): string => {
    if (!v) {
      throw new NotificationsError(
        "NOTIFICATION_SHAPE_INVALID",
        `a ${d.kind} notification needs ${what} to dedupe on; a dedupe key may never quote a nullable field (contracts §8 finding 6)`,
        { details: { kind: d.kind, missing: what } },
      );
    }
    return v;
  };

  switch (d.kind) {
    case "BACKED":
    case "FADED":
      return `${d.kind}:${need(d.responseId, "the response it came from")}`;
    case "RESOLVED":
      return `RESOLVED:${need(d.subjectCallId, "the call it is about")}`;
    case "REMATCH":
      return d.rematchReason === "rival_called_again"
        ? `REMATCH:rival:${need(d.rivalCallId, "the rival's new call")}`
        : `REMATCH:challenge:${need(d.responseId, "the challenge response it came from")}`;
  }
}

// ── the record row, mirroring public.call_category_records ───────────────────

export interface CategoryRecordRow {
  userId: string;
  category: string;
  fundingClass: FundingClass;
  correct: number;
  incorrect: number;
  voided: number;
  resolved: number;
  pending: number;
  /** GENERATED in SQL: correct + incorrect. VOID and PENDING excluded. */
  decided: number;
  /** GENERATED in SQL: decided >= MIN_DECIDED_FOR_ACCURACY. */
  accuracyReportable: boolean;
  lastResolvedAt: number | null;
  updatedAt: number;
}

export interface ListNotificationsOptions {
  limit?: number;
  /** Opaque cursor from a previous page. */
  cursor?: string | null;
  unreadOnly?: boolean;
}

export interface NotificationsStore {
  // ── notifications ─────────────────────────────────────────────────────────
  /** Insert unless (recipient, dedupeKey) already exists. Idempotent by design. */
  insertIfAbsent(
    draft: NotificationDraft,
    id: string,
    opts: { actor: NotificationWriteActor },
  ): { notification: SocialNotification; created: boolean };
  get(id: string): SocialNotification | undefined;
  listForRecipient(recipientUserId: string, opts?: ListNotificationsOptions): SocialNotification[];
  unreadCount(recipientUserId: string): number;
  /** Mark the caller's OWN notifications read. `ids === null` means all. */
  markRead(recipientUserId: string, ids: readonly string[] | null, at: number): number;
  listAll(): SocialNotification[];

  // ── records ───────────────────────────────────────────────────────────────
  /** Upsert one record row. Counters are monotone; a decrease is refused. */
  writeRecordRow(
    row: Omit<CategoryRecordRow, "decided" | "accuracyReportable" | "updatedAt">,
    at: number,
    opts: { actor: NotificationWriteActor },
  ): CategoryRecordRow;
  recordRowsFor(userId: string): CategoryRecordRow[];
  listRecordRows(): CategoryRecordRow[];
  /** Exists only to refuse: §3, accuracy history survives everything. */
  deleteRecordRow(userId: string, category: string, fundingClass: FundingClass): never;
}

const recordKey = (userId: string, category: string, fundingClass: FundingClass): string =>
  JSON.stringify([userId, category, fundingClass]);

export class InMemoryNotificationsStore implements NotificationsStore {
  private readonly byId = new Map<string, SocialNotification>();
  /** JSON.stringify([recipientUserId, dedupeKey]) -> notification id. Both halves
   *  always present: `dedupeKeyFor` throws rather than produce a partial key. */
  private readonly byDedupe = new Map<string, string>();
  private readonly records = new Map<string, CategoryRecordRow>();

  // ── notifications ─────────────────────────────────────────────────────────

  insertIfAbsent(
    draft: NotificationDraft,
    id: string,
    opts: { actor: NotificationWriteActor },
  ): { notification: SocialNotification; created: boolean } {
    if (opts.actor !== "service") {
      throw new NotificationsError(
        "SERVICE_WRITE_ONLY",
        "a notification is derived, never posted: nobody may write into another person's inbox (contracts §5)",
        { details: { recipientUserId: draft.recipientUserId } },
      );
    }

    // ★ Never notify someone about their own action.
    if (draft.actorUserId !== null && draft.actorUserId === draft.recipientUserId) {
      throw new NotificationsError(
        "NOTIFICATION_SELF",
        "nobody is notified about their own action",
        { details: { recipientUserId: draft.recipientUserId, kind: draft.kind } },
      );
    }

    // ★ An inbox is about YOUR OWN calls, for every kind.
    if (draft.subjectCallAuthorId !== draft.recipientUserId) {
      throw new NotificationsError(
        "NOTIFICATION_NOT_ABOUT_OWN_CALL",
        `call ${draft.subjectCallId} belongs to ${draft.subjectCallAuthorId}, not to recipient ${draft.recipientUserId} — this inbox carries notifications about the recipient's OWN calls, never a broadcast about someone else's activity`,
        { details: { subjectCallId: draft.subjectCallId } },
      );
    }

    assertShape(draft);

    const dedupeKey = dedupeKeyFor(draft);
    const lookup = JSON.stringify([draft.recipientUserId, dedupeKey]);
    const existingId = this.byDedupe.get(lookup);
    if (existingId) {
      // ★ The replay case. Not an error, not a second row: the same fact.
      return { notification: this.byId.get(existingId)!, created: false };
    }

    const notification: SocialNotification = {
      id,
      recipientUserId: draft.recipientUserId,
      kind: draft.kind,
      actorUserId: draft.actorUserId,
      subjectCallId: draft.subjectCallId,
      responseId: draft.responseId,
      rivalCallId: draft.rivalCallId,
      outcome: draft.outcome,
      rematchReason: draft.rematchReason,
      dedupeKey,
      createdAt: draft.createdAt,
      readAt: null,
    };
    this.byId.set(id, notification);
    this.byDedupe.set(lookup, id);
    return { notification, created: true };
  }

  /**
   * Adopt a row read back from Postgres, as it was stored: its own id, its own
   * read state. Hydration only — the database already applied every rule when
   * the row was first written. Indexed by the same dedupe key a fresh draft
   * would get, so re-deriving after a restart finds it rather than adding a
   * second, unread copy. Returns false when that key is already present.
   */
  restore(n: SocialNotification): boolean {
    const lookup = JSON.stringify([n.recipientUserId, dedupeKeyFor(n)]);
    if (this.byDedupe.has(lookup) || this.byId.has(n.id)) return false;
    this.byId.set(n.id, { ...n, dedupeKey: dedupeKeyFor(n) });
    this.byDedupe.set(lookup, n.id);
    return true;
  }

  get(id: string): SocialNotification | undefined {
    return this.byId.get(id);
  }

  listForRecipient(recipientUserId: string, opts: ListNotificationsOptions = {}): SocialNotification[] {
    const rows = [...this.byId.values()]
      .filter((n) => n.recipientUserId === recipientUserId)
      .filter((n) => (opts.unreadOnly ? n.readAt === null : true))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));

    const after = decodeCursor(opts.cursor ?? null);
    const start = after
      ? rows.findIndex((n) => n.createdAt === after.createdAt && n.id === after.id) + 1
      : 0;
    const limit = opts.limit ?? rows.length;
    return rows.slice(start, start + limit);
  }

  unreadCount(recipientUserId: string): number {
    let n = 0;
    for (const row of this.byId.values()) {
      if (row.recipientUserId === recipientUserId && row.readAt === null) n++;
    }
    return n;
  }

  markRead(recipientUserId: string, ids: readonly string[] | null, at: number): number {
    const wanted = ids ? new Set(ids) : null;
    let changed = 0;
    for (const [id, row] of this.byId) {
      if (row.recipientUserId !== recipientUserId) continue; // never someone else's
      if (wanted && !wanted.has(id)) continue;
      if (row.readAt !== null) continue;
      // readAt is the ONLY field that may move after delivery — the same rule
      // the SQL guard trigger enforces for every writer.
      this.byId.set(id, { ...row, readAt: at });
      changed++;
    }
    return changed;
  }

  listAll(): SocialNotification[] {
    return [...this.byId.values()];
  }

  // ── records ───────────────────────────────────────────────────────────────

  writeRecordRow(
    row: Omit<CategoryRecordRow, "decided" | "accuracyReportable" | "updatedAt">,
    at: number,
    opts: { actor: NotificationWriteActor },
  ): CategoryRecordRow {
    if (opts.actor !== "service") {
      throw new NotificationsError(
        "SERVICE_WRITE_ONLY",
        "a record is derived from venue-settled results; nobody states their own record (contracts §0.2/§5)",
        { details: { userId: row.userId } },
      );
    }

    const counts: CallRecordCounts = {
      correct: row.correct,
      incorrect: row.incorrect,
      voided: row.voided,
      resolved: row.resolved,
      decided: row.correct + row.incorrect,
      pending: row.pending,
    };
    // The CHECK `resolved_count = correct + incorrect + void`, one layer up.
    assertRecordComplete(counts);

    const key = recordKey(row.userId, row.category, row.fundingClass);
    const prev = this.records.get(key);
    if (prev) {
      // ★ Monotonicity. The SQL trigger says the same thing for every writer,
      //   service_role included.
      guardMonotone("incorrect", prev.incorrect, row.incorrect, row);
      guardMonotone("correct", prev.correct, row.correct, row);
      guardMonotone("voided", prev.voided, row.voided, row);
      guardMonotone("resolved", prev.resolved, row.resolved, row);
      if (
        prev.lastResolvedAt !== null &&
        row.lastResolvedAt !== null &&
        row.lastResolvedAt < prev.lastResolvedAt
      ) {
        throw new NotificationsError(
          "RECORD_INCOMPLETE",
          `a record's lastResolvedAt only moves forward (${row.userId} / ${row.category} / ${row.fundingClass})`,
          { details: { userId: row.userId } },
        );
      }
    }

    const next: CategoryRecordRow = {
      ...row,
      decided: counts.decided,
      accuracyReportable: counts.decided >= MIN_DECIDED_FOR_ACCURACY,
      updatedAt: at,
    };
    this.records.set(key, next);
    return next;
  }

  /** Adopt a record row read back from Postgres. Hydration only. */
  restoreRecordRow(row: CategoryRecordRow): void {
    this.records.set(recordKey(row.userId, row.category, row.fundingClass), row);
  }

  recordRowsFor(userId: string): CategoryRecordRow[] {
    return [...this.records.values()].filter((r) => r.userId === userId);
  }

  listRecordRows(): CategoryRecordRow[] {
    return [...this.records.values()];
  }

  deleteRecordRow(userId: string, category: string, fundingClass: FundingClass): never {
    throw new NotificationsError(
      "RECORD_INCOMPLETE",
      `a record is never deleted (${userId} / ${category} / ${fundingClass}). §3 — hiding a call does not rewrite accuracy history, and neither does anything else.`,
      { details: { userId, category, fundingClass } },
    );
  }
}

function guardMonotone(
  field: string,
  before: number,
  after: number,
  row: { userId: string; category: string; fundingClass: FundingClass },
): void {
  if (after >= before) return;
  throw new NotificationsError(
    "RECORD_INCOMPLETE",
    `a record's ${field} never goes down (${row.userId} / ${row.category} / ${row.fundingClass}: ${before} -> ${after}). A record that can shed its misses is not a record (contracts §3).`,
    { details: { userId: row.userId, field, before, after } },
  );
}

/**
 * The shape rule, mirroring `social_notifications_shape`. Exactly one branch
 * matches, and each branch names every field the kind requires and forbids
 * every field it does not — which is what guarantees the dedupe key is built
 * out of something that is actually there.
 */
function assertShape(d: NotificationDraft): void {
  const refuse = (why: string): never => {
    throw new NotificationsError("NOTIFICATION_SHAPE_INVALID", `a ${d.kind} notification ${why}`, {
      details: { kind: d.kind, rematchReason: d.rematchReason },
    });
  };

  switch (d.kind) {
    case "BACKED":
    case "FADED":
      if (!d.actorUserId) refuse("names the person who acted");
      if (!d.responseId) refuse("cites the response it came from");
      if (d.rivalCallId) refuse("carries no rival call");
      if (d.outcome) refuse("carries no outcome");
      if (d.rematchReason) refuse("carries no rematch reason");
      return;
    case "RESOLVED":
      if (d.actorUserId) refuse("has no actor: the venue published the result, and the venue is not a person");
      if (d.responseId) refuse("cites no response");
      if (d.rivalCallId) refuse("carries no rival call");
      if (d.rematchReason) refuse("carries no rematch reason");
      if (!d.outcome) refuse("quotes the derived outcome");
      // PENDING is never announced (§0.2). The type already excludes it; this
      // is the runtime half, for a value that came in as data.
      if ((d.outcome as string) === "PENDING") {
        refuse("is never sent for a PENDING call: the venue has published nothing (contracts §0.2)");
      }
      return;
    case "REMATCH":
      if (!d.actorUserId) refuse("names the person offering the rematch");
      if (d.outcome) refuse("carries no outcome");
      if (d.rematchReason === "challenge") {
        if (!d.responseId) refuse("cites the challenge response it came from");
        if (d.rivalCallId) refuse("carries no rival call");
        return;
      }
      if (d.rematchReason === "rival_called_again") {
        if (!d.rivalCallId) refuse("cites the rival's new call");
        if (d.responseId) refuse("cites no response");
        return;
      }
      refuse("needs a rematch reason");
      return;
  }
}

const encodeCursor = (n: SocialNotification): string =>
  Buffer.from(`${n.createdAt}:${n.id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string | null): { createdAt: number; id: string } | null => {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const at = raw.indexOf(":");
    if (at <= 0) return null;
    const createdAt = Number(raw.slice(0, at));
    if (!Number.isFinite(createdAt)) return null;
    return { createdAt, id: raw.slice(at + 1) };
  } catch {
    return null;
  }
};

export { encodeCursor as encodeNotificationCursor };
