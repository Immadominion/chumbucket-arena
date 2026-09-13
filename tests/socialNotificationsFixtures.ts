/**
 * Shared helpers for the Packet F tests.
 *
 * Everything here is built on Packet D's own fixtures, so a notification in a
 * test is derived from the SAME rows the real BFF derives from: a call written
 * by `CallsService`, a response written by `CallsService`, and a `CallResult`
 * written by `ResolutionSync` from hand-built venue evidence. No notification is
 * ever hand-inserted into the store by a scenario helper, because in production
 * nothing can hand-insert one either.
 *
 * No venue is called and nothing in this repo holds a venue API key.
 */

import { buildNotificationsRuntime, type NotificationsRuntime } from "../src/notifications/runtime.ts";
import type { CallFeedEntry, CallResponseResult } from "../src/calls/types.ts";
import type { Side, VenueMarket } from "../src/prediction/types.ts";
import {
  harness as callsHarness,
  market,
  migrationSql,
  person,
  sqlWithoutComments,
  T0,
  testApp,
  type Harness as CallsHarness,
  type TestClock,
} from "./socialCallsFixtures.ts";
import type { Person } from "../src/calls/types.ts";

export { market, migrationSql, person, sqlWithoutComments, T0, testApp };
export type { Person, VenueMarket };

export const INBOX_MIGRATION = "20260913150000_social_notifications_inbox.sql";
export const RECORD_MIGRATION = "20260913150500_social_notifications_category_record.sql";

export const notificationMigrationsAvailable = (): boolean => migrationSql(INBOX_MIGRATION) !== null;

export interface NotificationsHarness {
  calls: CallsHarness;
  rt: NotificationsRuntime;
  clock: TestClock;
  /** Move the clock on, so "called again" is actually later than the fade. */
  tick(ms?: number): void;
  /** Lock a call as `userId`. */
  call(userId: string, marketId: string, side: Side, thesis?: string | null): CallFeedEntry;
  /** Back / fade / challenge, as `actorUserId`. */
  respond(
    actorUserId: string,
    targetCallId: string,
    kind: "back" | "fade" | "challenge",
  ): CallResponseResult;
  /** Publish venue evidence, then let Packet D derive the results from it. */
  settle(marketId: string, resolution: "YES" | "NO" | "VOID"): void;
  /** One notification derivation pass. */
  derive(): ReturnType<NotificationsRuntime["deriver"]["deriveNotifications"]>;
  /** Notifications delivered to one person, newest first. */
  inboxOf(userId: string): ReturnType<NotificationsRuntime["store"]["listForRecipient"]>;
}

/**
 * A Packet D world plus a Packet F runtime reading it — the same wiring
 * `buildNotificationsRuntime` produces in production, with the calls runtime
 * passed in instead of looked up by AppConfig.
 */
export function harness(
  opts: { people?: Person[]; markets?: VenueMarket[] } = {},
): NotificationsHarness {
  const calls = callsHarness(opts);
  let seq = 0;

  const rt = buildNotificationsRuntime(undefined, {
    calls: calls.rt,
    clock: calls.clock,
    newId: () => `notif-${String(++seq).padStart(3, "0")}`,
  });

  return {
    calls,
    rt,
    clock: calls.clock,
    tick(ms = 1000) {
      calls.clock.advance(ms);
    },
    call(userId, marketId, side, thesis = null) {
      return calls.rt.service.createCall({ marketId, side, thesis }, userId);
    },
    respond(actorUserId, targetCallId, kind) {
      return calls.rt.service.respond({ targetCallId, kind }, actorUserId);
    },
    settle(marketId, resolution) {
      calls.resolve(marketId, resolution);
      // §0.2: the venue is the only source of a result, and Packet D's
      // synchroniser is the only thing that turns evidence into a CallResult.
      calls.rt.sync.runOnce();
    },
    derive() {
      return rt.deriver.deriveNotifications();
    },
    inboxOf(userId) {
      return rt.store.listForRecipient(userId);
    },
  };
}

/** Every notification of one kind in one person's inbox. */
export const ofKind = <T extends { kind: string }>(rows: readonly T[], kind: string): T[] =>
  rows.filter((r) => r.kind === kind);
