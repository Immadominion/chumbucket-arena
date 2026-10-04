/**
 * The durable TrustStore, over PostgREST as the service role, plus the GoTrue
 * admin client that removes a Supabase Auth user.
 *
 * Tables and the deletion function come from
 * supabase/migrations/20261002180000_trust_safety_and_account.sql in the
 * mobile repo. All are RLS-on with no client grant, so this server is their
 * only reader and writer.
 *
 * The service-role key travels in headers only (Pgrest registers it for
 * redaction). No method logs its arguments.
 */

import { Pgrest, PgrestError, isPgrestError, parseTimestamptz, toTimestamptz, type FetchImpl, type PgrestConfig } from "../prediction/pgrest.ts";
import type {
  AccountDeletion,
  AccountRecords,
  AuthUserAdmin,
  ContentReport,
  DeleteAccountOutcome,
  DeletionRequest,
  LegalAcceptance,
  NewReport,
  Relations,
  ReportStatus,
  TrustStore,
} from "./store.ts";

/** Every request: no redirects, a hard timeout. */
function boundedFetch(base: FetchImpl): FetchImpl {
  return Object.assign(
    (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      base(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) }),
    { preconnect: fetch.preconnect },
  ) as FetchImpl;
}

const REPORT_COLUMNS =
  "id,reporter_user_id,subject_kind,subject_call_id,subject_user_id,reason,details,status,created_at,resolved_at,resolved_by_user_id,resolution_note";

interface ReportRow {
  id: string;
  reporter_user_id: string;
  subject_kind: ContentReport["subjectKind"];
  subject_call_id: string | null;
  subject_user_id: string;
  reason: ContentReport["reason"];
  details: string | null;
  status: ReportStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  resolution_note: string | null;
}

const reportFromRow = (r: ReportRow): ContentReport => ({
  id: r.id,
  reporterUserId: r.reporter_user_id,
  subjectKind: r.subject_kind,
  subjectCallId: r.subject_call_id,
  subjectUserId: r.subject_user_id,
  reason: r.reason,
  details: r.details,
  status: r.status,
  createdAt: parseTimestamptz(r.created_at) ?? 0,
  resolvedAt: parseTimestamptz(r.resolved_at),
  resolvedByUserId: r.resolved_by_user_id,
  resolutionNote: r.resolution_note,
});

const ACCEPTANCE_COLUMNS = "id,user_id,scope,terms_version,is_18_plus,jurisdiction_eligible,venue_terms_accepted,accepted_at";

interface AcceptanceRow {
  id: string;
  user_id: string;
  scope: "funded_trading";
  terms_version: string;
  accepted_at: string;
}

const acceptanceFromRow = (r: AcceptanceRow): LegalAcceptance => ({
  id: r.id,
  userId: r.user_id,
  scope: r.scope,
  termsVersion: r.terms_version,
  // The table's CHECK makes any stored row an all-yes row.
  is18Plus: true,
  jurisdictionEligible: true,
  venueTermsAccepted: true,
  acceptedAt: parseTimestamptz(r.accepted_at) ?? 0,
});

export class SupabaseTrustStore implements TrustStore {
  readonly durable = true;
  private readonly pg: Pgrest;

  constructor(config: PgrestConfig, fetchImpl: FetchImpl = fetch) {
    this.pg = new Pgrest(config, boundedFetch(fetchImpl));
  }

  // ── reports ───────────────────────────────────────────────────────────────

  async insertReport(r: NewReport, at: number): Promise<{ report: ContentReport; duplicate: boolean }> {
    try {
      const rows = await this.pg.insert<ReportRow>(
        "content_reports",
        [
          {
            reporter_user_id: r.reporterUserId,
            subject_kind: r.subjectKind,
            subject_call_id: r.subjectCallId,
            subject_user_id: r.subjectUserId,
            reason: r.reason,
            details: r.details,
            created_at: toTimestamptz(at),
          },
        ],
        { returning: true },
      );
      const row = rows[0];
      if (!row) throw new PgrestError("[trust] report insert returned no row");
      return { report: reportFromRow(row), duplicate: false };
    } catch (err) {
      if (!(isPgrestError(err) && err.duplicate)) throw err;
      // uq_content_reports_open_subject: already reported and still open.
      const params = new URLSearchParams({
        reporter_user_id: `eq.${r.reporterUserId}`,
        subject_kind: `eq.${r.subjectKind}`,
        status: "eq.open",
        select: REPORT_COLUMNS,
        limit: "1",
      });
      if (r.subjectCallId) params.set("subject_call_id", `eq.${r.subjectCallId}`);
      else params.set("subject_user_id", `eq.${r.subjectUserId}`);
      const existing = (await this.pg.select<ReportRow>("content_reports", params))[0];
      if (!existing) throw err;
      return { report: reportFromRow(existing), duplicate: true };
    }
  }

  async listReports(opts: { status: ReportStatus | "all"; limit: number }): Promise<ContentReport[]> {
    const params = new URLSearchParams({ select: REPORT_COLUMNS, order: "created_at.desc", limit: String(opts.limit) });
    if (opts.status !== "all") params.set("status", `eq.${opts.status}`);
    return (await this.pg.select<ReportRow>("content_reports", params)).map(reportFromRow);
  }

  async getReport(id: string): Promise<ContentReport | null> {
    const rows = await this.pg.select<ReportRow>(
      "content_reports",
      new URLSearchParams({ id: `eq.${id}`, select: REPORT_COLUMNS, limit: "1" }),
    );
    return rows[0] ? reportFromRow(rows[0]) : null;
  }

  async resolveReport(
    id: string,
    patch: { status: Exclude<ReportStatus, "open">; byUserId: string; note: string | null },
    at: number,
  ): Promise<ContentReport | null> {
    await this.pg.patch(
      "content_reports",
      new URLSearchParams({ id: `eq.${id}`, status: "eq.open" }),
      {
        status: patch.status,
        resolved_at: toTimestamptz(at),
        resolved_by_user_id: patch.byUserId,
        resolution_note: patch.note,
      },
    );
    return this.getReport(id);
  }

  async reportsBy(userId: string): Promise<ContentReport[]> {
    return (
      await this.pg.select<ReportRow>(
        "content_reports",
        new URLSearchParams({ reporter_user_id: `eq.${userId}`, select: REPORT_COLUMNS, order: "created_at.desc" }),
      )
    ).map(reportFromRow);
  }

  // ── blocks / mutes ────────────────────────────────────────────────────────

  async setBlock(blocker: string, blocked: string, on: boolean): Promise<void> {
    if (on) {
      await this.pg.insert("user_blocks", [{ blocker_user_id: blocker, blocked_user_id: blocked }], {
        onConflict: "blocker_user_id,blocked_user_id",
        ignoreDuplicates: true,
      });
    } else {
      await this.pg.remove(
        "user_blocks",
        new URLSearchParams({ blocker_user_id: `eq.${blocker}`, blocked_user_id: `eq.${blocked}` }),
      );
    }
  }

  async setMute(muter: string, muted: string, on: boolean): Promise<void> {
    if (on) {
      await this.pg.insert("user_mutes", [{ muter_user_id: muter, muted_user_id: muted }], {
        onConflict: "muter_user_id,muted_user_id",
        ignoreDuplicates: true,
      });
    } else {
      await this.pg.remove(
        "user_mutes",
        new URLSearchParams({ muter_user_id: `eq.${muter}`, muted_user_id: `eq.${muted}` }),
      );
    }
  }

  async relationsOf(userId: string): Promise<Relations> {
    const [blocks, mutes] = await Promise.all([
      this.pg.select<{ blocker_user_id: string; blocked_user_id: string }>(
        "user_blocks",
        new URLSearchParams({
          or: `(blocker_user_id.eq.${userId},blocked_user_id.eq.${userId})`,
          select: "blocker_user_id,blocked_user_id",
        }),
      ),
      this.pg.select<{ muted_user_id: string }>(
        "user_mutes",
        new URLSearchParams({ muter_user_id: `eq.${userId}`, select: "muted_user_id" }),
      ),
    ]);
    return {
      blocked: blocks.filter((b) => b.blocker_user_id === userId).map((b) => b.blocked_user_id),
      blockedBy: blocks.filter((b) => b.blocked_user_id === userId).map((b) => b.blocker_user_id),
      muted: mutes.map((m) => m.muted_user_id),
    };
  }

  // ── legal ─────────────────────────────────────────────────────────────────

  async insertAcceptance(a: Omit<LegalAcceptance, "id" | "acceptedAt">, at: number): Promise<LegalAcceptance> {
    // Append-only table: a repeat is DO NOTHING (never an UPDATE), then read.
    await this.pg.insert(
      "legal_acceptances",
      [
        {
          user_id: a.userId,
          scope: a.scope,
          terms_version: a.termsVersion,
          is_18_plus: a.is18Plus,
          jurisdiction_eligible: a.jurisdictionEligible,
          venue_terms_accepted: a.venueTermsAccepted,
          accepted_at: toTimestamptz(at),
        },
      ],
      { onConflict: "user_id,scope,terms_version", ignoreDuplicates: true },
    );
    const stored = await this.acceptance(a.userId, a.scope, a.termsVersion);
    if (!stored) throw new PgrestError("[trust] acceptance was not stored");
    return stored;
  }

  async acceptance(userId: string, scope: "funded_trading", termsVersion: string): Promise<LegalAcceptance | null> {
    const rows = await this.pg.select<AcceptanceRow>(
      "legal_acceptances",
      new URLSearchParams({
        user_id: `eq.${userId}`,
        scope: `eq.${scope}`,
        terms_version: `eq.${termsVersion}`,
        select: ACCEPTANCE_COLUMNS,
        limit: "1",
      }),
    );
    return rows[0] ? acceptanceFromRow(rows[0]) : null;
  }

  async acceptancesOf(userId: string): Promise<LegalAcceptance[]> {
    return (
      await this.pg.select<AcceptanceRow>(
        "legal_acceptances",
        new URLSearchParams({ user_id: `eq.${userId}`, select: ACCEPTANCE_COLUMNS, order: "accepted_at.asc" }),
      )
    ).map(acceptanceFromRow);
  }

  // ── deletion ──────────────────────────────────────────────────────────────

  async deleteAccount(input: { userId: string | null; authUserId: string }): Promise<DeleteAccountOutcome> {
    type Answer = {
      ok?: unknown; outcome?: unknown; reason?: unknown; user_id?: unknown;
      auth_user_ids?: unknown; folded_user_ids?: unknown;
    };
    const args = { p_user_id: input.userId, p_auth_user_id: input.authUserId };
    // v2 (20261004120000) deletes the whole person from any sign-in; before
    // that migration, v1 (the primary sign-in only) is the whole story.
    let res: Answer | null | undefined;
    try {
      res = await this.pg.rpc<Answer>("delete_account_v2", args);
    } catch (err) {
      if (!(isPgrestError(err) && err.status === 404)) throw err;
      res = await this.pg.rpc<Answer>("delete_account_v1", args);
    }
    const uuids = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)) : [];
    if (res && res.ok === true && (res.outcome === "deleted" || res.outcome === "already_deleted" || res.outcome === "no_profile")) {
      return {
        ok: true,
        outcome: res.outcome,
        userId: typeof res.user_id === "string" ? res.user_id : null,
        authUserIds: uuids(res.auth_user_ids),
        foldedUserIds: uuids(res.folded_user_ids),
      };
    }
    if (res && res.ok === false && (res.reason === "session_mismatch" || res.reason === "unknown_user" || res.reason === "missing_auth_user")) {
      return { ok: false, reason: res.reason };
    }
    throw new PgrestError("[trust] delete_account_v1 returned an unexpected shape");
  }

  async deletionFor(authUserId: string): Promise<AccountDeletion | null> {
    const rows = await this.pg.select<{
      user_id: string | null;
      auth_user_id: string;
      requested_at: string;
      anonymised_at: string | null;
      auth_deleted_at: string | null;
    }>(
      "account_deletions",
      new URLSearchParams({
        auth_user_id: `eq.${authUserId}`,
        select: "user_id,auth_user_id,requested_at,anonymised_at,auth_deleted_at",
        limit: "1",
      }),
    );
    const r = rows[0];
    return r
      ? {
          userId: r.user_id,
          authUserId: r.auth_user_id,
          requestedAt: parseTimestamptz(r.requested_at) ?? 0,
          anonymisedAt: parseTimestamptz(r.anonymised_at),
          authDeletedAt: parseTimestamptz(r.auth_deleted_at),
        }
      : null;
  }

  async deletionTarget(authUserId: string): Promise<string | null> {
    try {
      const res = await this.pg.rpc<{ ok?: unknown; user_id?: unknown }>("resolve_auth_user_v1", { p_auth_user_id: authUserId });
      return res && res.ok === true && typeof res.user_id === "string" ? res.user_id : null;
    } catch (err) {
      // Before 20261004120000 there are no additional sign-ins to find.
      if (isPgrestError(err) && err.status === 404) return null;
      throw err;
    }
  }

  async markAuthDeleted(authUserId: string, at: number): Promise<void> {
    await this.pg.patch(
      "account_deletions",
      new URLSearchParams({ auth_user_id: `eq.${authUserId}`, auth_deleted_at: "is.null" }),
      { auth_deleted_at: toTimestamptz(at) },
    );
  }

  // ── export ────────────────────────────────────────────────────────────────

  async accountRecords(userId: string): Promise<AccountRecords> {
    const read = async (table: string, select: string, order?: string): Promise<Record<string, unknown>[]> => {
      const params = new URLSearchParams({ user_id: `eq.${userId}`, select });
      if (order) params.set("order", order);
      return this.pg.select<Record<string, unknown>>(table, params);
    };
    const [profile, linkedWallets, linkedIdentities, fundedOrders] = await Promise.all([
      this.pg
        .select<Record<string, unknown>>("users", new URLSearchParams({ id: `eq.${userId}`, select: "*", limit: "1" }))
        .then((rows) => rows[0] ?? null),
      read("linked_wallets", "wallet_address,wallet_type,is_primary,first_seen_at,verified_at,revoked_at"),
      read("linked_identities", "provider,provider_username,provider_display_name,provider_email,created_at"),
      read(
        "panta_trade_sessions",
        "id,call_id,market_id,wallet_address,venue_market_id,side,amount_base_units::text,state,provider_order_id,signature,created_at,updated_at",
        "created_at.asc",
      ),
    ]);
    return { profile, linkedWallets, linkedIdentities, fundedOrders };
  }

  async insertDeletionRequest(r: DeletionRequest, at: number): Promise<{ id: string }> {
    const rows = await this.pg.insert<{ id: string }>(
      "account_deletion_requests",
      [
        {
          contact: r.contact,
          handle: r.handle,
          wallet_address: r.walletAddress,
          details: r.details,
          created_at: toTimestamptz(at),
        },
      ],
      { returning: true },
    );
    const id = rows[0]?.id;
    if (!id) throw new PgrestError("[trust] deletion request returned no id");
    return { id };
  }
}

/**
 * `DELETE {supabase}/auth/v1/admin/users/{id}` as the service role. A 404 is
 * "already gone", which is what a retry after success looks like.
 */
export class GoTrueAuthUserAdmin implements AuthUserAdmin {
  readonly enabled = true;
  private readonly base: string;

  constructor(
    private readonly cfg: PgrestConfig,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {
    this.base = `${cfg.supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users`;
  }

  async deleteUser(authUserId: string): Promise<"deleted" | "not_found"> {
    if (!/^[0-9a-f-]{36}$/i.test(authUserId)) throw new Error("not an auth user id");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/${authUserId}`, {
        method: "DELETE",
        headers: { apikey: this.cfg.serviceRoleKey, Authorization: `Bearer ${this.cfg.serviceRoleKey}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Never surface a native error: it can carry request headers.
      throw new Error("auth admin request did not complete");
    }
    if (res.status === 404) return "not_found";
    if (res.ok) return "deleted";
    throw new Error(`auth admin refused the deletion (HTTP ${res.status})`);
  }
}
