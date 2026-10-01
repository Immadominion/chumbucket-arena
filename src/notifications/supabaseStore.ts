/**
 * `SupabaseNotificationsStore` — Packet F's two tables, for real.
 *
 * The same shape as `SupabaseCallsStore` (read its header first): an
 * `InMemoryNotificationsStore` MIRROR serves every read and enforces every
 * rule, every change is ALSO written to Postgres behind it, and `hydrate()`
 * rebuilds the mirror at boot so a redeploy no longer turns every notification
 * back to unread.
 *
 *   public.social_notifications   insert (dedupe on recipient + key, the key
 *                                 computed by the guard trigger) and read_at
 *   public.call_category_records  upsert, only when a row's counts changed
 *
 * ── ITS OWN QUEUE, ON PURPOSE ───────────────────────────────────────────────
 *
 * The calls/prediction stores share one FIFO writer, and a single recorded
 * failure on it quarantines every social request and restarts the process to
 * rehydrate (`socialProcedure`, `index.ts`). A notification is derived from
 * calls, never the other way round, so a refused notification must not be
 * able to take calls down — and because derivation re-runs after a restart, a
 * refusal there would become a restart loop. Notifications therefore get their
 * own queue. Every job first drains the calls queue, so the rows a
 * notification cites (its call, response or result) are written before it,
 * which the guard trigger requires. A failure here is recorded, logged and
 * surfaced through `failures` / `flush()`, exactly as the other stores do; it
 * just does not quarantine the social service.
 *
 * ── IDS ─────────────────────────────────────────────────────────────────────
 *
 * `social_notifications.id` is a UUID column. The deriver supplies readable
 * ids for the in-memory store; this store mints `crypto.randomUUID()` instead,
 * the same "fix the write" answer `buildCallsRuntime` gives for calls.
 */

import { systemClock, type Clock } from "../prediction/clock.ts";
import {
  fromTimestamptz,
  isUuid,
  parseTimestamptz,
  Pgrest,
  toTimestamptz,
  toTimestamptzOrNull,
  WriteQueue,
  writeFailureError,
  type FetchImpl,
  type PgrestConfig,
  type WriteFailure,
} from "../prediction/pgrest.ts";
import {
  InMemoryNotificationsStore,
  type CategoryRecordRow,
  type ListNotificationsOptions,
  type NotificationDraft,
  type NotificationsStore,
  type NotificationWriteActor,
} from "./store.ts";
import { MIN_DECIDED_FOR_ACCURACY } from "./record.ts";
import type { FundingClass, NotificationKind, RematchReason, SocialNotification } from "./types.ts";

const NOTIFICATIONS_TABLE = "social_notifications";
const RECORDS_TABLE = "call_category_records";

const NOTIFICATION_COLUMNS =
  "id,recipient_user_id,kind,actor_user_id,subject_call_id,response_id,rival_call_id,call_result_outcome,rematch_reason,created_at,read_at";
const RECORD_COLUMNS =
  "user_id,category,funding_class,correct_count,incorrect_count,void_count,resolved_count,pending_count,last_resolved_at,updated_at";

export interface SupabaseNotificationsStoreOptions {
  config: PgrestConfig;
  fetchImpl?: FetchImpl;
  clock?: Clock;
  /** The calls/prediction writer. Drained before every write here, never written to. */
  parentQueue?: Pick<WriteQueue, "drain">;
  queue?: WriteQueue;
  mirror?: InMemoryNotificationsStore;
  newId?: () => string;
  maxRowsPerTable?: number;
}

export interface NotificationsHydrationReport {
  notifications: number;
  records: number;
  /** Rows Postgres holds that the mirror could not adopt. Zero unless the two disagree. */
  skipped: { notifications: number; records: number };
  hydratedAt: number;
}

export class SupabaseNotificationsStore implements NotificationsStore {
  readonly persistent = true;
  readonly mirror: InMemoryNotificationsStore;
  readonly queue: WriteQueue;

  private readonly pg: Pgrest;
  private readonly clock: Clock;
  private readonly parentQueue: Pick<WriteQueue, "drain"> | null;
  private readonly newId: () => string;
  private readonly maxRowsPerTable: number;
  private hydration: NotificationsHydrationReport | null = null;

  constructor(opts: SupabaseNotificationsStoreOptions) {
    this.pg = new Pgrest(opts.config, opts.fetchImpl);
    this.clock = opts.clock ?? systemClock;
    this.mirror = opts.mirror ?? new InMemoryNotificationsStore();
    this.queue = opts.queue ?? new WriteQueue({ clock: this.clock });
    this.parentQueue = opts.parentQueue ?? null;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.maxRowsPerTable = opts.maxRowsPerTable ?? 50_000;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  get hydrated(): boolean {
    return this.hydration !== null;
  }

  get hydrationReport(): NotificationsHydrationReport | null {
    return this.hydration;
  }

  get failures(): readonly WriteFailure[] {
    return this.queue.failures;
  }

  /** Every durable write queued so far; throws if any was rejected. */
  async flush(): Promise<void> {
    await this.queue.drain();
    if (this.queue.failures.length > 0) throw writeFailureError(this.queue.failures);
  }

  /**
   * Rebuild the mirror from Postgres. Writes go to `this.mirror` directly, so
   * reading the database enqueues nothing.
   */
  async hydrate(): Promise<NotificationsHydrationReport> {
    const report: NotificationsHydrationReport = {
      notifications: 0,
      records: 0,
      skipped: { notifications: 0, records: 0 },
      hydratedAt: this.clock.now(),
    };

    for (const row of await this.page<NotificationRow>(NOTIFICATIONS_TABLE, NOTIFICATION_COLUMNS, "created_at.asc,id.asc")) {
      try {
        if (this.mirror.restore(notificationFromRow(row))) report.notifications++;
        else report.skipped.notifications++;
      } catch (err) {
        report.skipped.notifications++;
        console.error(`[persist] hydrate: ${NOTIFICATIONS_TABLE}/${row.id} could not be mirrored: ${message(err)}`);
      }
    }

    for (const row of await this.page<RecordRow>(RECORDS_TABLE, RECORD_COLUMNS, "user_id.asc,category.asc,funding_class.asc")) {
      try {
        this.mirror.restoreRecordRow(recordFromRow(row));
        report.records++;
      } catch (err) {
        report.skipped.records++;
        console.error(`[persist] hydrate: ${RECORDS_TABLE}/${row.user_id} could not be mirrored: ${message(err)}`);
      }
    }

    this.hydration = report;
    return report;
  }

  // ── notifications ─────────────────────────────────────────────────────────

  insertIfAbsent(
    draft: NotificationDraft,
    _id: string,
    opts: { actor: NotificationWriteActor },
  ): { notification: SocialNotification; created: boolean } {
    // The mirror enforces service-only writes, never-self, own-call-only, the
    // shape rule and the dedupe — the same list the guard trigger checks.
    const result = this.mirror.insertIfAbsent(draft, this.newId(), opts);
    if (!result.created) return result;

    const n = result.notification;
    this.write(`insert ${NOTIFICATIONS_TABLE}/${n.id}`, async () => {
      await this.pg.insert(
        NOTIFICATIONS_TABLE,
        [
          {
            id: n.id,
            recipient_user_id: n.recipientUserId,
            kind: n.kind,
            actor_user_id: n.actorUserId,
            subject_call_id: n.subjectCallId,
            response_id: n.responseId,
            rival_call_id: n.rivalCallId,
            call_result_outcome: n.outcome,
            rematch_reason: n.rematchReason,
            created_at: toTimestamptz(n.createdAt),
            read_at: null,
            // dedupe_key is computed by trg_social_notifications_guard.
          },
        ],
        // The same fact delivered twice (another replica, a replay) is one row.
        { onConflict: "recipient_user_id,dedupe_key", ignoreDuplicates: true },
      );
    });
    return result;
  }

  get(id: string): SocialNotification | undefined {
    return this.mirror.get(id);
  }

  listForRecipient(recipientUserId: string, opts?: ListNotificationsOptions): SocialNotification[] {
    return this.mirror.listForRecipient(recipientUserId, opts);
  }

  unreadCount(recipientUserId: string): number {
    return this.mirror.unreadCount(recipientUserId);
  }

  markRead(recipientUserId: string, ids: readonly string[] | null, at: number): number {
    const changed = this.mirror.markRead(recipientUserId, ids, at);
    if (changed === 0) return 0;

    // Only rows that are this person's AND still unread move — read_at is set
    // once, and never on someone else's row, whatever the client sent.
    const params = new URLSearchParams({
      recipient_user_id: `eq.${recipientUserId}`,
      read_at: "is.null",
    });
    if (ids) {
      const uuids = ids.filter(isUuid);
      if (uuids.length === 0) return changed;
      params.set("id", `in.(${uuids.join(",")})`);
    }
    this.write(`mark read ${NOTIFICATIONS_TABLE} for ${recipientUserId}`, async () => {
      await this.pg.patch(NOTIFICATIONS_TABLE, params, { read_at: toTimestamptz(at) });
    });
    return changed;
  }

  listAll(): SocialNotification[] {
    return this.mirror.listAll();
  }

  // ── records ───────────────────────────────────────────────────────────────

  writeRecordRow(
    row: Omit<CategoryRecordRow, "decided" | "accuracyReportable" | "updatedAt">,
    at: number,
    opts: { actor: NotificationWriteActor },
  ): CategoryRecordRow {
    const before = this.mirror
      .recordRowsFor(row.userId)
      .find((r) => r.category === row.category && r.fundingClass === row.fundingClass);
    // Monotonicity and completeness are the mirror's to refuse, as before.
    const next = this.mirror.writeRecordRow(row, at, opts);

    // The deriver rebuilds every record on every pass. Only a real change is
    // written, so reading an inbox does not become a write per person.
    if (before && sameCounts(before, next)) return next;

    this.write(`upsert ${RECORDS_TABLE}/${next.userId}/${next.category}/${next.fundingClass}`, async () => {
      await this.pg.insert(
        RECORDS_TABLE,
        [
          {
            user_id: next.userId,
            category: next.category,
            funding_class: next.fundingClass,
            correct_count: next.correct,
            incorrect_count: next.incorrect,
            void_count: next.voided,
            resolved_count: next.resolved,
            pending_count: next.pending,
            last_resolved_at: toTimestamptzOrNull(next.lastResolvedAt),
            updated_at: toTimestamptz(next.updatedAt),
            // decided_count and accuracy_reportable are GENERATED columns.
          },
        ],
        { onConflict: "user_id,category,funding_class" },
      );
    });
    return next;
  }

  recordRowsFor(userId: string): CategoryRecordRow[] {
    return this.mirror.recordRowsFor(userId);
  }

  listRecordRows(): CategoryRecordRow[] {
    return this.mirror.listRecordRows();
  }

  deleteRecordRow(userId: string, category: string, fundingClass: FundingClass): never {
    return this.mirror.deleteRecordRow(userId, category, fundingClass);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Parent rows first: drain the calls writer, then write. */
  private write(label: string, fn: () => Promise<void>): void {
    this.queue.push(label, async () => {
      await this.parentQueue?.drain();
      await fn();
    });
  }

  private async page<T>(table: string, select: string, order: string): Promise<T[]> {
    const out: T[] = [];
    const size = 1000;
    for (let offset = 0; offset <= this.maxRowsPerTable; offset += size) {
      const rows = await this.pg.select<T>(
        table,
        new URLSearchParams({ select, order, limit: String(size), offset: String(offset) }),
      );
      out.push(...rows);
      if (rows.length < size) return out;
    }
    throw new Error(
      `[persist] ${table} has more than ${this.maxRowsPerTable} rows; refusing to hydrate a partial mirror (a partial mirror would re-deliver read notifications as unread).`,
    );
  }
}

// ── row shapes and mappers ───────────────────────────────────────────────────

interface NotificationRow {
  id: string;
  recipient_user_id: string;
  kind: NotificationKind;
  actor_user_id: string | null;
  subject_call_id: string;
  response_id: string | null;
  rival_call_id: string | null;
  call_result_outcome: SocialNotification["outcome"];
  rematch_reason: RematchReason | null;
  created_at: string;
  read_at: string | null;
}

interface RecordRow {
  user_id: string;
  category: string;
  funding_class: FundingClass;
  correct_count: number;
  incorrect_count: number;
  void_count: number;
  resolved_count: number;
  pending_count: number;
  last_resolved_at: string | null;
  updated_at: string;
}

function notificationFromRow(row: NotificationRow): SocialNotification {
  return {
    id: row.id,
    recipientUserId: row.recipient_user_id,
    kind: row.kind,
    actorUserId: row.actor_user_id,
    subjectCallId: row.subject_call_id,
    responseId: row.response_id,
    rivalCallId: row.rival_call_id,
    outcome: row.call_result_outcome,
    rematchReason: row.rematch_reason,
    // Recomputed by the mirror from the fields, exactly as the trigger did.
    dedupeKey: "",
    createdAt: fromTimestamptz(row.created_at, `${NOTIFICATIONS_TABLE}.created_at`),
    readAt: parseTimestamptz(row.read_at),
  };
}

function recordFromRow(row: RecordRow): CategoryRecordRow {
  const decided = row.correct_count + row.incorrect_count;
  return {
    userId: row.user_id,
    category: row.category,
    fundingClass: row.funding_class,
    correct: row.correct_count,
    incorrect: row.incorrect_count,
    voided: row.void_count,
    resolved: row.resolved_count,
    pending: row.pending_count,
    decided,
    // Mirrors the GENERATED column.
    accuracyReportable: decided >= MIN_DECIDED_FOR_ACCURACY,
    lastResolvedAt: parseTimestamptz(row.last_resolved_at),
    updatedAt: fromTimestamptz(row.updated_at, `${RECORDS_TABLE}.updated_at`),
  };
}

function sameCounts(a: CategoryRecordRow, b: CategoryRecordRow): boolean {
  return (
    a.correct === b.correct &&
    a.incorrect === b.incorrect &&
    a.voided === b.voided &&
    a.resolved === b.resolved &&
    a.pending === b.pending &&
    a.lastResolvedAt === b.lastResolvedAt
  );
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
