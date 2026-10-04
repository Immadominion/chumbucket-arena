/**
 * The viewer's friends from the old app, for people.suggested's friends
 * variant (onboarding spec §13.3).
 *
 * Legacy `public.friends` rows are keyed by `public.users.id` — the same
 * canonical id the calls store uses — as `(user_id, friend_id, status)`.
 * This is a READ, as the service role, of the viewer's OWN accepted rows:
 * the viewer comes from the verified session, never from a request field,
 * and nothing here writes or exposes another person's list.
 *
 * Those rows were written by the old client and are not proof of anything a
 * person agreed to now, so onboarding shows them as suggestions only and
 * never follows anyone on their behalf.
 */

import { Pgrest, type FetchImpl, type PgrestConfig } from "../prediction/pgrest.ts";

export interface FriendsReader {
  /** Canonical ids of `userId`'s accepted friends. Empty when unknown. */
  friendsOf(userId: string): Promise<string[]>;
}

/** No legacy friends table (tests, an in-memory runtime). */
export const noFriendsReader: FriendsReader = {
  async friendsOf() {
    return [];
  },
};

/** A canonical id: a UUID. Anything else is never put in a query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_FRIENDS_READ = 200;

export class SupabaseFriendsReader implements FriendsReader {
  private readonly pg: Pgrest;

  constructor(cfg: PgrestConfig, fetchImpl?: FetchImpl) {
    this.pg = new Pgrest(cfg, fetchImpl);
  }

  async friendsOf(userId: string): Promise<string[]> {
    if (!UUID.test(userId)) return [];
    const params = new URLSearchParams({
      select: "friend_id",
      user_id: `eq.${userId}`,
      status: "eq.accepted",
      order: "created_at.desc",
      limit: String(MAX_FRIENDS_READ),
    });
    try {
      const rows = await this.pg.select<{ friend_id: unknown }>("friends", params);
      const out: string[] = [];
      for (const row of rows) {
        const id = row.friend_id;
        if (typeof id === "string" && UUID.test(id) && id !== userId && !out.includes(id)) out.push(id);
      }
      return out;
    } catch {
      // A friends read that fails is "no friends here", never an error on a
      // suggestion screen.
      return [];
    }
  }
}
