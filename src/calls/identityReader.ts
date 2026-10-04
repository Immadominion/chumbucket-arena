/**
 * `PersonIdentityReader` over Postgres: the two read-only, service-role-only
 * functions in 20261003200000_find_person_identities.sql.
 *
 *   person_x_identities_v1(p_x_handle | p_user_ids)
 *       who signed in with an X account (auth.identities, which PostgREST
 *       cannot reach), or which X account given people have
 *   person_for_wallet_v1(p_wallet)
 *       the real person holding a wallet — never a placeholder
 *
 * Both functions already leave out placeholders and deleted accounts; this
 * side re-checks the shapes it is handed (a canonical id, an X username, a
 * picture on X's CDN) and drops anything else. Failures are thrown, never
 * turned into "nobody", so people.find can say it could not look rather than
 * that no one exists.
 */

import { Pgrest, type FetchImpl, type PgrestConfig } from "../prediction/pgrest.ts";
import type { PersonIdentityReader, XIdentity } from "./personFinder.ts";
import { safeXAvatarUrl, X_HANDLE } from "./xAvatars.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_IDENTITY_IDS = 50;

interface XIdentityRow {
  user_id?: unknown;
  x_username?: unknown;
  x_avatar_url?: unknown;
  seen_at?: unknown;
}

function identityOf(row: XIdentityRow): XIdentity | null {
  if (typeof row.user_id !== "string" || !UUID.test(row.user_id)) return null;
  const handle = typeof row.x_username === "string" ? row.x_username.trim().replace(/^@/, "") : "";
  if (!X_HANDLE.test(handle)) return null;
  const seen = typeof row.seen_at === "string" ? Date.parse(row.seen_at) : NaN;
  return {
    userId: row.user_id.toLowerCase(),
    xHandle: handle,
    xAvatarUrl: safeXAvatarUrl(row.x_avatar_url),
    seenAt: Number.isFinite(seen) ? seen : null,
  };
}

export class SupabasePersonIdentityReader implements PersonIdentityReader {
  private readonly pg: Pgrest;

  constructor(cfg: PgrestConfig, fetchImpl?: FetchImpl) {
    this.pg = new Pgrest(cfg, fetchImpl);
  }

  async byXHandle(handle: string): Promise<XIdentity[]> {
    if (!X_HANDLE.test(handle)) return [];
    return this.identities({ p_x_handle: handle.toLowerCase(), p_user_ids: null });
  }

  async xIdentitiesOf(userIds: readonly string[]): Promise<XIdentity[]> {
    const ids = [...new Set(userIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))].slice(
      0,
      MAX_IDENTITY_IDS,
    );
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    return (await this.identities({ p_x_handle: null, p_user_ids: ids })).filter((x) => wanted.has(x.userId));
  }

  async personForWallet(wallet: string): Promise<string | null> {
    const id = await this.pg.rpc<unknown>("person_for_wallet_v1", { p_wallet: wallet });
    return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
  }

  private async identities(body: Record<string, unknown>): Promise<XIdentity[]> {
    const rows = await this.pg.rpc<unknown>("person_x_identities_v1", body);
    if (!Array.isArray(rows)) return [];
    const out: XIdentity[] = [];
    for (const row of rows) {
      const identity = row && typeof row === "object" ? identityOf(row as XIdentityRow) : null;
      if (identity && !out.some((x) => x.userId === identity.userId)) out.push(identity);
    }
    return out.sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
  }
}
