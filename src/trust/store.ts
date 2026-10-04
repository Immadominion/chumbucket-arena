/**
 * TrustStore — reports, blocks, mutes, legal acceptances, account deletion
 * and the web deletion requests. Async (unlike the calls mirror): every one of
 * these is a low-volume write that must be durable before it is acknowledged,
 * so there is no write-behind queue here.
 *
 * `InMemoryTrustStore` is the honest default for a server with no database
 * (tests, local dev). It never pretends to be durable: `durable` is false and
 * the runtime says so at boot.
 */

export type ReportSubjectKind = "call" | "thesis" | "person";
export type ReportReason =
  | "spam"
  | "harassment"
  | "hate"
  | "sexual"
  | "violence"
  | "self_harm"
  | "scam"
  | "impersonation"
  | "illegal"
  | "other";
export type ReportStatus = "open" | "actioned" | "dismissed";

export const REPORT_REASONS: readonly ReportReason[] = [
  "spam", "harassment", "hate", "sexual", "violence", "self_harm", "scam", "impersonation", "illegal", "other",
] as const;

export interface ContentReport {
  id: string;
  reporterUserId: string;
  subjectKind: ReportSubjectKind;
  subjectCallId: string | null;
  subjectUserId: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolvedByUserId: string | null;
  resolutionNote: string | null;
}

export type NewReport = Pick<
  ContentReport,
  "reporterUserId" | "subjectKind" | "subjectCallId" | "subjectUserId" | "reason" | "details"
>;

export interface Relations {
  /** People this person blocked. */
  blocked: string[];
  /** People who blocked this person. */
  blockedBy: string[];
  /** People this person muted. */
  muted: string[];
}

export interface LegalAcceptance {
  id: string;
  userId: string;
  scope: "funded_trading";
  termsVersion: string;
  is18Plus: true;
  jurisdictionEligible: true;
  venueTermsAccepted: true;
  acceptedAt: number;
}

export interface AccountDeletion {
  userId: string | null;
  authUserId: string;
  requestedAt: number;
  anonymisedAt: number | null;
  authDeletedAt: number | null;
}

export type DeleteAccountOutcome =
  | {
      ok: true;
      outcome: "deleted" | "already_deleted" | "no_profile";
      userId: string | null;
      /** Every Supabase sign-in of the person, to delete from Supabase Auth. */
      authUserIds?: string[];
      /** Accounts folded into this one, anonymised with it. */
      foldedUserIds?: string[];
    }
  | { ok: false; reason: "session_mismatch" | "unknown_user" | "missing_auth_user" };

export interface DeletionRequest {
  contact: string;
  handle: string | null;
  walletAddress: string | null;
  details: string | null;
}

/** What the person gets back when they export. Rows are their own. */
export interface AccountRecords {
  profile: Record<string, unknown> | null;
  linkedWallets: Record<string, unknown>[];
  linkedIdentities: Record<string, unknown>[];
  fundedOrders: Record<string, unknown>[];
}

export interface TrustStore {
  readonly durable: boolean;

  insertReport(report: NewReport, at: number): Promise<{ report: ContentReport; duplicate: boolean }>;
  listReports(opts: { status: ReportStatus | "all"; limit: number }): Promise<ContentReport[]>;
  getReport(id: string): Promise<ContentReport | null>;
  resolveReport(
    id: string,
    patch: { status: Exclude<ReportStatus, "open">; byUserId: string; note: string | null },
    at: number,
  ): Promise<ContentReport | null>;
  reportsBy(userId: string): Promise<ContentReport[]>;

  setBlock(blocker: string, blocked: string, on: boolean): Promise<void>;
  setMute(muter: string, muted: string, on: boolean): Promise<void>;
  relationsOf(userId: string): Promise<Relations>;

  insertAcceptance(a: Omit<LegalAcceptance, "id" | "acceptedAt">, at: number): Promise<LegalAcceptance>;
  acceptance(userId: string, scope: "funded_trading", termsVersion: string): Promise<LegalAcceptance | null>;
  acceptancesOf(userId: string): Promise<LegalAcceptance[]>;

  deleteAccount(input: { userId: string | null; authUserId: string }, at: number): Promise<DeleteAccountOutcome>;
  /**
   * The account the database would delete for this sign-in, when the session
   * resolver found none (an additional sign-in with ACCOUNT_LINKING_ENABLED
   * off), so the deletion guards still run on it. Throws when unreadable.
   */
  accountForAuthUser?(authUserId: string): Promise<string | null>;
  deletionFor(authUserId: string): Promise<AccountDeletion | null>;
  /**
   * The account the database will delete for this sign-in (its primary, or
   * an additional sign-in's account), whatever the BFF's switches say — so
   * the deletion guards always run on it. Null: none.
   */
  deletionTarget(authUserId: string): Promise<string | null>;
  markAuthDeleted(authUserId: string, at: number): Promise<void>;

  accountRecords(userId: string): Promise<AccountRecords>;

  insertDeletionRequest(r: DeletionRequest, at: number): Promise<{ id: string }>;
}

/** Removes a Supabase Auth user. The GoTrue admin API in production. */
export interface AuthUserAdmin {
  readonly enabled: boolean;
  deleteUser(authUserId: string): Promise<"deleted" | "not_found">;
}

const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

export class InMemoryTrustStore implements TrustStore {
  readonly durable = false;
  private readonly reports = new Map<string, ContentReport>();
  private readonly blocks = new Set<string>();
  private readonly mutes = new Set<string>();
  private readonly acceptances: LegalAcceptance[] = [];
  private readonly deletions = new Map<string, AccountDeletion>();
  readonly deletionRequests: (DeletionRequest & { id: string; at: number })[] = [];
  /** Profile rows the export can return; tests seed this. */
  readonly profiles = new Map<string, Record<string, unknown>>();
  private seq = 0;

  private id(prefix: string): string {
    return `${prefix}-${String(++this.seq).padStart(4, "0")}`;
  }

  async insertReport(r: NewReport, at: number): Promise<{ report: ContentReport; duplicate: boolean }> {
    const subject = r.subjectCallId ?? r.subjectUserId;
    for (const existing of this.reports.values()) {
      if (
        existing.status === "open" &&
        existing.reporterUserId === r.reporterUserId &&
        existing.subjectKind === r.subjectKind &&
        (existing.subjectCallId ?? existing.subjectUserId) === subject
      ) {
        return { report: existing, duplicate: true };
      }
    }
    const report: ContentReport = {
      ...r,
      id: this.id("report"),
      status: "open",
      createdAt: at,
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionNote: null,
    };
    this.reports.set(report.id, report);
    return { report, duplicate: false };
  }

  async listReports(opts: { status: ReportStatus | "all"; limit: number }): Promise<ContentReport[]> {
    return [...this.reports.values()]
      .filter((r) => opts.status === "all" || r.status === opts.status)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, opts.limit);
  }

  async getReport(id: string): Promise<ContentReport | null> {
    return this.reports.get(id) ?? null;
  }

  async resolveReport(
    id: string,
    patch: { status: Exclude<ReportStatus, "open">; byUserId: string; note: string | null },
    at: number,
  ): Promise<ContentReport | null> {
    const current = this.reports.get(id);
    if (!current) return null;
    const next: ContentReport = {
      ...current,
      status: patch.status,
      resolvedAt: at,
      resolvedByUserId: patch.byUserId,
      resolutionNote: patch.note,
    };
    this.reports.set(id, next);
    return next;
  }

  async reportsBy(userId: string): Promise<ContentReport[]> {
    return [...this.reports.values()].filter((r) => r.reporterUserId === userId);
  }

  async setBlock(blocker: string, blocked: string, on: boolean): Promise<void> {
    if (on) this.blocks.add(pairKey(blocker, blocked));
    else this.blocks.delete(pairKey(blocker, blocked));
  }

  async setMute(muter: string, muted: string, on: boolean): Promise<void> {
    if (on) this.mutes.add(pairKey(muter, muted));
    else this.mutes.delete(pairKey(muter, muted));
  }

  async relationsOf(userId: string): Promise<Relations> {
    const out: Relations = { blocked: [], blockedBy: [], muted: [] };
    for (const k of this.blocks) {
      const [a, b] = k.split("\u0000") as [string, string];
      if (a === userId) out.blocked.push(b);
      if (b === userId) out.blockedBy.push(a);
    }
    for (const k of this.mutes) {
      const [a, b] = k.split("\u0000") as [string, string];
      if (a === userId) out.muted.push(b);
    }
    return out;
  }

  async insertAcceptance(a: Omit<LegalAcceptance, "id" | "acceptedAt">, at: number): Promise<LegalAcceptance> {
    const existing = await this.acceptance(a.userId, a.scope, a.termsVersion);
    if (existing) return existing;
    const row: LegalAcceptance = { ...a, id: this.id("acceptance"), acceptedAt: at };
    this.acceptances.push(row);
    return row;
  }

  async acceptance(userId: string, scope: "funded_trading", termsVersion: string): Promise<LegalAcceptance | null> {
    return (
      this.acceptances.find((a) => a.userId === userId && a.scope === scope && a.termsVersion === termsVersion) ??
      null
    );
  }

  async acceptancesOf(userId: string): Promise<LegalAcceptance[]> {
    return this.acceptances.filter((a) => a.userId === userId);
  }

  async deleteAccount(input: { userId: string | null; authUserId: string }, at: number): Promise<DeleteAccountOutcome> {
    const existing = this.deletions.get(input.authUserId);
    if (existing?.anonymisedAt) return { ok: true, outcome: "already_deleted", userId: existing.userId };
    this.deletions.set(input.authUserId, {
      userId: input.userId,
      authUserId: input.authUserId,
      requestedAt: at,
      anonymisedAt: at,
      authDeletedAt: null,
    });
    if (input.userId) {
      for (const k of [...this.blocks]) if (k.split("\u0000").includes(input.userId)) this.blocks.delete(k);
      for (const k of [...this.mutes]) if (k.split("\u0000").includes(input.userId)) this.mutes.delete(k);
      this.profiles.set(input.userId, { id: input.userId, full_name: "Deleted account", deleted_at: at });
    }
    return { ok: true, outcome: input.userId ? "deleted" : "no_profile", userId: input.userId };
  }

  async deletionFor(authUserId: string): Promise<AccountDeletion | null> {
    return this.deletions.get(authUserId) ?? null;
  }

  async deletionTarget(_authUserId: string): Promise<string | null> {
    return null;
  }

  async markAuthDeleted(authUserId: string, at: number): Promise<void> {
    const d = this.deletions.get(authUserId);
    if (d) this.deletions.set(authUserId, { ...d, authDeletedAt: d.authDeletedAt ?? at });
  }

  async accountRecords(userId: string): Promise<AccountRecords> {
    return { profile: this.profiles.get(userId) ?? null, linkedWallets: [], linkedIdentities: [], fundedOrders: [] };
  }

  async insertDeletionRequest(r: DeletionRequest, at: number): Promise<{ id: string }> {
    const id = this.id("deletion-request");
    this.deletionRequests.push({ ...r, id, at });
    return { id };
  }
}

/** No auth project configured: deletion of the sign-in itself is impossible, and says so. */
export class UnconfiguredAuthUserAdmin implements AuthUserAdmin {
  readonly enabled = false;
  async deleteUser(): Promise<"deleted" | "not_found"> {
    throw new Error("auth admin is not configured");
  }
}

/** Records what it was asked to remove. For tests. */
export class RecordingAuthUserAdmin implements AuthUserAdmin {
  readonly enabled = true;
  readonly deleted: string[] = [];
  failNext = false;
  async deleteUser(authUserId: string): Promise<"deleted" | "not_found"> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("auth admin unavailable");
    }
    if (this.deleted.includes(authUserId)) return "not_found";
    this.deleted.push(authUserId);
    return "deleted";
  }
}
