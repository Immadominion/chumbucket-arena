/**
 * NotificationsService — the read side of Packet F.
 *
 * The rule that governs every method here is the same one Packet D's
 * `CallsService` holds: THE VIEWER IS A CANONICAL `public.users.id` THAT THE
 * ROUTER DERIVED FROM THE VERIFIED SESSION. No method below takes a viewer, a
 * user id or a wallet as data from the caller of the API. §8 finding 4 — "several
 * tRPC read procedures take `wallet: z.string()` on `publicProcedure` with no
 * proof at all, notifications included" — is a live production defect about
 * exactly this surface, and finding 3 is the same defect in SQL
 * (`get_notifications(p_network, p_wallet)`, anon-executable, wallet as an
 * argument). An inbox is the one thing in this product that is nobody else's
 * business, so `recipientUserId` is never an input.
 *
 * `recordFor` is the one method that names somebody else, and it names them the
 * way Packet D's `people.get` does — by handle or canonical id, as a PUBLIC
 * SUBJECT. It makes no authorisation decision from that reference: the viewer is
 * still session-derived, and the record returned is the same for every caller.
 *
 * And one thing this service cannot do, by construction: write. There is no
 * method here that creates a notification or states a record. Both are derived
 * by `NotificationDeriver` from rows Packet D owns, which are themselves derived
 * from venue evidence (§0.2).
 */

import { systemClock, type Clock } from "../prediction/clock.ts";
import type { VenueMarketReader } from "../calls/markets.ts";
import { renderCopy } from "./copy.ts";
import { NotificationsError } from "./errors.ts";
import { buildPersonRecord, type RecordInput } from "./record.ts";
import { assertNotificationSafe } from "./safety.ts";
import type { SocialGraphReader } from "./sources.ts";
import { encodeNotificationCursor, type NotificationsStore } from "./store.ts";
import type {
  NotificationActor,
  NotificationPage,
  NotificationView,
  PersonRecord,
  SocialNotification,
} from "./types.ts";

export interface NotificationsServiceDeps {
  store: NotificationsStore;
  graph: SocialGraphReader;
  markets: VenueMarketReader;
  clock?: Clock;
  maxPageSize?: number;
}

export interface InboxArgs {
  limit?: number;
  cursor?: string | null;
  unreadOnly?: boolean;
}

export class NotificationsService {
  private readonly store: NotificationsStore;
  private readonly graph: SocialGraphReader;
  private readonly markets: VenueMarketReader;
  private readonly clock: Clock;
  private readonly maxPageSize: number;

  constructor(deps: NotificationsServiceDeps) {
    this.store = deps.store;
    this.graph = deps.graph;
    this.markets = deps.markets;
    this.clock = deps.clock ?? systemClock;
    this.maxPageSize = deps.maxPageSize ?? 50;
  }

  // ── notifications.list ────────────────────────────────────────────────────

  /** `viewerUserId` comes from the session. It is never a parameter of the API. */
  inbox(args: InboxArgs, viewerUserId: string): NotificationPage {
    const limit = clamp(args.limit ?? 20, 1, this.maxPageSize);
    const rows = this.store.listForRecipient(viewerUserId, {
      limit: limit + 1,
      cursor: args.cursor ?? null,
      ...(args.unreadOnly === undefined ? {} : { unreadOnly: args.unreadOnly }),
    });
    const page = rows.slice(0, limit);
    const more = rows.length > limit;
    const last = page[page.length - 1];

    const items = page.map((n) => this.viewOf(n));
    // ★ Every payload is walked before it leaves: no money, no credential, no
    //   thesis, no note. Checked, not promised.
    assertNotificationSafe(items, "a notification page", {
      forbiddenText: this.thesesOf(page),
    });

    return {
      items,
      nextCursor: more && last ? encodeNotificationCursor(last) : null,
      unread: this.store.unreadCount(viewerUserId),
      servedAt: this.clock.now(),
    };
  }

  // ── notifications.unreadCount ─────────────────────────────────────────────

  unreadCount(viewerUserId: string): { unread: number; servedAt: number } {
    return { unread: this.store.unreadCount(viewerUserId), servedAt: this.clock.now() };
  }

  // ── notifications.markRead ────────────────────────────────────────────────

  /**
   * Mark the caller's OWN notifications read. `ids === null` marks all of them.
   *
   * A named id that belongs to somebody else is refused rather than silently
   * ignored: silently ignoring it would make the API a membership oracle for
   * other people's inboxes ("did this id exist?"), and refusing loudly on an id
   * the caller invented costs them nothing.
   */
  markRead(ids: readonly string[] | null, viewerUserId: string): { marked: number; unread: number } {
    if (ids) {
      for (const id of ids) {
        const n = this.store.get(id);
        if (!n) {
          throw new NotificationsError("NOTIFICATION_NOT_FOUND", "We couldn't find that notification.", {
            details: { id },
          });
        }
        if (n.recipientUserId !== viewerUserId) {
          // Deliberately the same message as "not found": a distinguishable
          // refusal would confirm the row exists and that it is someone else's.
          throw new NotificationsError("NOTIFICATION_NOT_FOUND", "We couldn't find that notification.", {
            details: { id },
          });
        }
      }
    }
    const marked = this.store.markRead(viewerUserId, ids, this.clock.now());
    return { marked, unread: this.store.unreadCount(viewerUserId) };
  }

  // ── record.mine ───────────────────────────────────────────────────────────

  myRecord(viewerUserId: string): PersonRecord {
    return this.recordOf(viewerUserId);
  }

  // ── record.get ────────────────────────────────────────────────────────────

  /** `personRef` is a canonical user id or a handle — never a wallet (§0.3),
   *  and never an authorisation input. */
  recordFor(personRef: string): PersonRecord {
    const person = this.graph.getPerson(personRef) ?? this.graph.getPersonByHandle(personRef);
    if (!person) {
      throw new NotificationsError("PERSON_NOT_FOUND", "We couldn't find that person.", {
        details: { ref: personRef },
      });
    }
    return this.recordOf(person.id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * A person's record, computed live from Packet D's calls and results in one
   * pass.
   *
   * Every call the person made is counted, INCLUDING hidden and followers-only
   * ones. §3: "Deleting a public call hides it from distribution; it does not
   * rewrite CallResult or accuracy history." Excluding hidden calls would make
   * a record launderable by withdrawing the losses, which is the single thing a
   * record must not be.
   *
   * `NotificationDeriver.rebuildRecords()` materialises the same numbers into
   * the store so `public.call_category_records` has a writer;
   * tests/socialNotificationsRecord.test.ts asserts the two agree, so the
   * materialised table can never quietly disagree with what is served.
   */
  private recordOf(userId: string): PersonRecord {
    const person = this.graph.getPerson(userId);
    const inputs: RecordInput[] = this.graph.callsByAuthor(userId).map((call) => {
      const result = this.graph.getResult(call.id);
      return {
        category: this.markets.getMarket(call.marketId)?.category || "uncategorised",
        fundingState: call.fundingState,
        // No result row at all is PENDING, and PENDING counts towards nothing.
        outcome: result?.outcome ?? "PENDING",
        resolvedAt: result?.resolvedAt ?? null,
      };
    });

    const record = buildPersonRecord(
      {
        userId,
        handle: person?.handle ?? userId,
        displayName: person?.displayName ?? userId,
      },
      inputs,
      this.clock.now(),
    );
    // A record carries counts and a ratio. It never carries money, and the
    // funded band never carries a P&L — that lives with venue positions.
    assertNotificationSafe(record, "a person's record");
    return record;
  }

  private viewOf(n: SocialNotification): NotificationView {
    const subject = this.graph.getCall(n.subjectCallId);
    const actorPerson = n.actorUserId ? this.graph.getPerson(n.actorUserId) : undefined;
    const actor: NotificationActor | null = n.actorUserId
      ? {
          userId: n.actorUserId,
          handle: actorPerson?.handle ?? n.actorUserId,
          displayName: actorPerson?.displayName ?? n.actorUserId,
          avatarUrl: actorPerson?.avatarUrl ?? null,
          avatarId: actorPerson?.avatarId ?? null,
        }
      : null;

    const market = subject ? this.markets.getMarket(subject.marketId) : undefined;
    const copy = renderCopy(n, actor?.displayName ?? null);

    return {
      id: n.id,
      kind: n.kind,
      rematchReason: n.rematchReason,
      actor,
      subjectCallId: n.subjectCallId,
      rivalCallId: n.rivalCallId,
      marketId: subject?.marketId ?? "",
      // The venue's own question, verbatim and never paraphrased (§4). A
      // structured field, never spliced into a sentence.
      marketQuestion: market?.question ?? null,
      category: market?.category ?? null,
      side: subject?.side ?? "YES",
      outcome: n.outcome,
      title: copy.title,
      body: copy.body,
      createdAt: n.createdAt,
      readAt: n.readAt,
    };
  }

  /**
   * The theses attached to the calls on this page — passed to the safety check
   * as text that must NOT appear anywhere in the payload. A notification links
   * to the call; the call is where the words live.
   */
  private thesesOf(rows: readonly SocialNotification[]): string[] {
    const out: string[] = [];
    for (const n of rows) {
      const subject = this.graph.getCall(n.subjectCallId);
      if (subject?.thesis) out.push(subject.thesis);
      const rival = n.rivalCallId ? this.graph.getCall(n.rivalCallId) : undefined;
      if (rival?.thesis) out.push(rival.thesis);
    }
    return out;
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.trunc(n)));
