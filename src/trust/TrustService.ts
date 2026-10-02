/**
 * TrustService — report, block, mute, the funded-trading attestation, account
 * deletion and data export.
 *
 * The rule every method keeps, same as CallsService: the ACTING person is a
 * canonical public.users.id the router derived from the verified session.
 * Nothing here takes an actor from request data. Subjects (the call or person
 * being reported, blocked or muted) are named the way people.get names them:
 * a canonical id or a handle, never a wallet.
 */

import type { CallsRuntime } from "../calls/runtime.ts";
import type { CallRecord, Person } from "../calls/types.ts";
import { toCall } from "../calls/types.ts";
import type { InMemoryCallsStore } from "../calls/store.ts";
import type { TrustConfig } from "./config.ts";
import { assertCleanText } from "./contentFilter.ts";
import { TrustError } from "./errors.ts";
import type { WriteRateLimiter } from "./rateLimit.ts";
import type {
  AuthUserAdmin,
  ContentReport,
  LegalAcceptance,
  Relations,
  ReportReason,
  ReportStatus,
  ReportSubjectKind,
  TrustStore,
} from "./store.ts";

export interface PersonSummary {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ReportInput {
  subject: ReportSubjectKind;
  callId?: string | null;
  personRef?: string | null;
  reason: ReportReason;
  details?: string | null;
}

export interface LegalStatus {
  termsVersion: string;
  termsUrl: string;
  privacyUrl: string;
  deletionUrl: string;
  venueTermsUrl: string;
  fundedTrading: { accepted: boolean; acceptedAt: number | null };
}

export interface DeletionResult {
  status: "deleted";
  /** The canonical account that was anonymised, or null for a sign-in with no profile. */
  userId: string | null;
  alreadyDeleted: boolean;
  completedAt: number;
}

export interface TrustServiceDeps {
  config: TrustConfig;
  store: TrustStore;
  authAdmin: AuthUserAdmin;
  limiter: WriteRateLimiter;
  calls: () => CallsRuntime;
  now?: () => number;
  /** How long a person's block/mute lists are reused before re-reading. */
  relationsTtlMs?: number;
}

const DELETED_NAME = "Deleted account";
const deletedHandle = (userId: string) => `deleted_${userId.replace(/-/g, "").slice(0, 12)}`;

export class TrustService {
  private readonly cache = new Map<string, { at: number; relations: Relations }>();
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly deps: TrustServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.ttl = deps.relationsTtlMs ?? 30_000;
  }

  get config(): TrustConfig {
    return this.deps.config;
  }

  get limiter(): WriteRateLimiter {
    return this.deps.limiter;
  }

  // ── people ────────────────────────────────────────────────────────────────

  private async person(ref: string): Promise<Person> {
    const rt = this.deps.calls();
    await rt.ready;
    const ref2 = ref.trim().replace(/^@/, "");
    let person = rt.store.getPerson(ref2) ?? rt.store.getPersonByHandle(ref2);
    if (!person && rt.durable && /^[0-9a-f-]{36}$/i.test(ref2)) person = await rt.durable.refreshPerson(ref2);
    if (!person) throw new TrustError("TRUST_PERSON_NOT_FOUND", "We couldn't find that person.");
    return person;
  }

  private summary(userId: string): PersonSummary {
    const p = this.deps.calls().store.getPerson(userId);
    return {
      userId,
      handle: p?.handle ?? userId,
      displayName: p?.displayName ?? userId,
      avatarUrl: p?.avatarUrl ?? null,
    };
  }

  // ── relations ─────────────────────────────────────────────────────────────

  async relations(userId: string): Promise<Relations> {
    const hit = this.cache.get(userId);
    if (hit && this.now() - hit.at < this.ttl) return hit.relations;
    const relations = await this.deps.store.relationsOf(userId);
    this.cache.set(userId, { at: this.now(), relations });
    if (this.cache.size > 20_000) this.cache.clear();
    return relations;
  }

  /**
   * Whose calls and notifications this person should not see: people they
   * blocked or muted, and people who blocked them. Reads never fail because
   * of this: if the lists cannot be read, nothing is hidden and it is logged.
   */
  async hiddenAuthorsFor(viewer: string | null): Promise<ReadonlySet<string>> {
    if (!viewer) return new Set();
    try {
      const r = await this.relations(viewer);
      return new Set([...r.blocked, ...r.blockedBy, ...r.muted]);
    } catch {
      console.warn("[trust] block/mute lists unavailable; showing unfiltered content");
      return new Set();
    }
  }

  /** Refuse an interaction between two people when either blocked the other. */
  async assertNotBlocked(actor: string, other: string, action: "respond" | "follow"): Promise<void> {
    let r: Relations;
    try {
      r = await this.relations(actor);
    } catch {
      return; // see hiddenAuthorsFor
    }
    if (r.blocked.includes(other)) {
      throw new TrustError(
        "TRUST_BLOCKED",
        action === "follow"
          ? "You've blocked this person. Unblock them in Settings to follow them."
          : "You've blocked this person. Unblock them in Settings to respond to their calls.",
      );
    }
    if (r.blockedBy.includes(other)) {
      throw new TrustError(
        "TRUST_BLOCKED",
        action === "follow" ? "You can't follow this person." : "You can't respond to this person's calls.",
      );
    }
  }

  async setRelation(
    actor: string,
    kind: "block" | "mute",
    personRef: string,
    on: boolean,
  ): Promise<{ personId: string; blocked?: boolean; muted?: boolean }> {
    const person = await this.person(personRef);
    if (person.id === actor) {
      throw new TrustError("TRUST_SELF", kind === "block" ? "You can't block yourself." : "You can't mute yourself.");
    }
    this.deps.limiter.charge("trust.relation", actor);
    if (kind === "block") await this.deps.store.setBlock(actor, person.id, on);
    else await this.deps.store.setMute(actor, person.id, on);
    this.cache.delete(actor);
    this.cache.delete(person.id);

    if (kind === "block" && on) {
      // A block ends following in both directions, as people expect.
      const rt = this.deps.calls();
      rt.store.unfollow(actor, person.id);
      rt.store.unfollow(person.id, actor);
      await rt.durable?.flush();
    }
    return kind === "block" ? { personId: person.id, blocked: on } : { personId: person.id, muted: on };
  }

  async lists(viewer: string): Promise<{ blocked: PersonSummary[]; muted: PersonSummary[] }> {
    this.cache.delete(viewer);
    const r = await this.relations(viewer);
    return { blocked: r.blocked.map((id) => this.summary(id)), muted: r.muted.map((id) => this.summary(id)) };
  }

  // ── reports ───────────────────────────────────────────────────────────────

  async report(reporter: string, input: ReportInput): Promise<{ reportId: string; status: "received" | "already_reported" }> {
    let subjectUserId: string;
    let subjectCallId: string | null = null;
    if (input.subject === "person") {
      if (!input.personRef) throw new TrustError("TRUST_PERSON_NOT_FOUND", "Choose who you're reporting.");
      subjectUserId = (await this.person(input.personRef)).id;
    } else {
      const rt = this.deps.calls();
      await rt.ready;
      const call = input.callId ? rt.store.getCall(input.callId) : undefined;
      if (!call || !rt.service.canSee(call, reporter)) {
        throw new TrustError("TRUST_CALL_NOT_FOUND", "We couldn't find that call.");
      }
      if (input.subject === "thesis" && !call.thesis) {
        throw new TrustError("TRUST_CALL_NOT_FOUND", "That call has no thesis to report.");
      }
      subjectCallId = call.id;
      subjectUserId = call.userId;
    }
    if (subjectUserId === reporter) {
      throw new TrustError("TRUST_SELF", "You can't report yourself.");
    }
    const details = input.details?.trim() ? input.details.trim().slice(0, 500) : null;
    this.deps.limiter.charge("trust.report", reporter);
    const { report, duplicate } = await this.deps.store.insertReport(
      { reporterUserId: reporter, subjectKind: input.subject, subjectCallId, subjectUserId, reason: input.reason, details },
      this.now(),
    );
    return { reportId: report.id, status: duplicate ? "already_reported" : "received" };
  }

  // ── admin ─────────────────────────────────────────────────────────────────

  isAdmin(userId: string | null): boolean {
    return !!userId && this.deps.config.adminUserIds.has(userId.toLowerCase());
  }

  assertAdmin(userId: string): void {
    if (!this.isAdmin(userId)) throw new TrustError("TRUST_NOT_ADMIN", "You don't have access to moderation.");
  }

  async adminReports(admin: string, status: ReportStatus | "all", limit: number) {
    this.assertAdmin(admin);
    const rt = this.deps.calls();
    await rt.ready;
    const reports = await this.deps.store.listReports({ status, limit });
    return reports.map((r) => {
      const call = r.subjectCallId ? rt.store.getCall(r.subjectCallId) : undefined;
      return {
        ...r,
        subject: this.summary(r.subjectUserId),
        reporter: this.summary(r.reporterUserId),
        call: call
          ? { id: call.id, marketId: call.marketId, thesis: call.thesis, hidden: call.hiddenAt !== null }
          : null,
      };
    });
  }

  /** Hide a call from every distribution surface. Results and records stay (§3). */
  async adminHideCall(admin: string, input: { callId: string; reportId?: string | null; note?: string | null }) {
    this.assertAdmin(admin);
    const rt = this.deps.calls();
    await rt.ready;
    const call = rt.store.getCall(input.callId);
    if (!call) throw new TrustError("TRUST_CALL_NOT_FOUND", "We couldn't find that call.");
    const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
    const hidden = rt.store.hideCall(call.id, note ? `moderation: ${note}` : "moderation");
    await rt.durable?.flush();
    let report: ContentReport | null = null;
    if (input.reportId) {
      report = await this.deps.store.resolveReport(
        input.reportId,
        { status: "actioned", byUserId: admin, note },
        this.now(),
      );
    }
    return { callId: hidden.id, hiddenAt: hidden.hiddenAt, report };
  }

  async adminResolveReport(
    admin: string,
    input: { reportId: string; status: "actioned" | "dismissed"; note?: string | null },
  ): Promise<ContentReport> {
    this.assertAdmin(admin);
    const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
    const report = await this.deps.store.resolveReport(input.reportId, { status: input.status, byUserId: admin, note }, this.now());
    if (!report) throw new TrustError("TRUST_REPORT_NOT_FOUND", "We couldn't find that report.");
    return report;
  }

  // ── legal ─────────────────────────────────────────────────────────────────

  async legalStatus(viewer: string | null): Promise<LegalStatus> {
    const c = this.deps.config;
    const accepted = viewer ? await this.deps.store.acceptance(viewer, "funded_trading", c.termsVersion) : null;
    return {
      termsVersion: c.termsVersion,
      termsUrl: `${c.legalSiteUrl}/terms`,
      privacyUrl: `${c.legalSiteUrl}/privacy`,
      deletionUrl: `${c.legalSiteUrl}/delete-account`,
      venueTermsUrl: c.pantaTermsUrl,
      fundedTrading: { accepted: accepted !== null, acceptedAt: accepted?.acceptedAt ?? null },
    };
  }

  async acceptFundedTrading(viewer: string, termsVersion: string): Promise<LegalAcceptance> {
    if (termsVersion !== this.deps.config.termsVersion) {
      throw new TrustError(
        "TRUST_TERMS_CHANGED",
        "Our terms changed since you opened this. Review the latest version and confirm again.",
      );
    }
    return this.deps.store.insertAcceptance(
      {
        userId: viewer,
        scope: "funded_trading",
        termsVersion,
        is18Plus: true,
        jurisdictionEligible: true,
        venueTermsAccepted: true,
      },
      this.now(),
    );
  }

  /** The gate in front of every funded trade. */
  async assertFundedTradingAccepted(userId: string): Promise<void> {
    const accepted = await this.deps.store.acceptance(userId, "funded_trading", this.deps.config.termsVersion);
    if (!accepted) {
      throw new TrustError(
        "TRUST_ATTESTATION_REQUIRED",
        "Before your first funded trade, confirm you're 18 or older, allowed to trade where you live, and agree to the venue's terms.",
      );
    }
  }

  // ── content ───────────────────────────────────────────────────────────────

  assertClean(text: string | null | undefined, field: Parameters<typeof assertCleanText>[1]): void {
    assertCleanText(text, field);
  }

  // ── deletion ──────────────────────────────────────────────────────────────

  /**
   * Delete the account behind a verified sign-in. Idempotent: a retry after a
   * partial failure finishes the job, and a retry after success says so.
   */
  async deleteAccount(input: { authUserId: string; userId: string | null }): Promise<DeletionResult> {
    if (!this.deps.authAdmin.enabled) {
      throw new TrustError(
        "TRUST_NOT_CONFIGURED",
        "Account deletion isn't available on this server yet. Use the deletion request page and we'll do it for you.",
      );
    }
    const prior = await this.deps.store.deletionFor(input.authUserId);
    if (prior?.authDeletedAt) {
      return { status: "deleted", userId: prior.userId, alreadyDeleted: true, completedAt: prior.authDeletedAt };
    }
    const outcome = await this.deps.store.deleteAccount(
      { userId: input.userId ?? prior?.userId ?? null, authUserId: input.authUserId },
      this.now(),
    );
    if (!outcome.ok) {
      throw new TrustError(
        "TRUST_DELETION_FAILED",
        outcome.reason === "session_mismatch"
          ? "This sign-in doesn't own that account, so nothing was deleted."
          : "We couldn't find your account to delete. Nothing was changed.",
      );
    }
    if (outcome.userId) await this.forget(outcome.userId);

    try {
      await this.deps.authAdmin.deleteUser(input.authUserId);
    } catch {
      throw new TrustError(
        "TRUST_DELETION_RETRY",
        "Your profile has been removed, but we couldn't finish removing your sign-in. Try again in a moment. It's safe to retry.",
      );
    }
    const at = this.now();
    await this.deps.store.markAuthDeleted(input.authUserId, at);
    return { status: "deleted", userId: outcome.userId, alreadyDeleted: outcome.outcome === "already_deleted", completedAt: at };
  }

  /** A sign-in we already removed can only ask "is it done?". */
  async completedDeletion(authUserId: string): Promise<DeletionResult | null> {
    const d = await this.deps.store.deletionFor(authUserId);
    return d?.authDeletedAt
      ? { status: "deleted", userId: d.userId, alreadyDeleted: true, completedAt: d.authDeletedAt }
      : null;
  }

  /** Make the in-process mirrors agree with the anonymised row. */
  private async forget(userId: string): Promise<void> {
    const rt = this.deps.calls();
    const mirror: Pick<InMemoryCallsStore, "followingOf" | "unfollow" | "listPeople" | "isFollowing" | "upsertPerson"> =
      rt.durable ? rt.durable.mirror : rt.store;
    for (const followee of mirror.followingOf(userId)) mirror.unfollow(userId, followee);
    for (const p of mirror.listPeople()) if (mirror.isFollowing(p.id, userId)) mirror.unfollow(p.id, userId);

    let refreshed = false;
    if (rt.durable) {
      try {
        refreshed = (await rt.durable.refreshPerson(userId)) !== undefined;
      } catch {
        refreshed = false;
      }
    }
    if (!refreshed) {
      mirror.upsertPerson({
        id: userId,
        handle: deletedHandle(userId),
        displayName: DELETED_NAME,
        avatarUrl: null,
        walletAddress: null,
        settledCalls: 0,
        correctCalls: 0,
      });
    }
    this.cache.clear();
  }

  // ── export ────────────────────────────────────────────────────────────────

  async exportData(viewer: string): Promise<Record<string, unknown>> {
    this.deps.limiter.charge("account.export", viewer);
    const rt = this.deps.calls();
    await rt.ready;
    const [records, relations, reports, acceptances] = await Promise.all([
      this.deps.store.accountRecords(viewer),
      this.deps.store.relationsOf(viewer),
      this.deps.store.reportsBy(viewer),
      this.deps.store.acceptancesOf(viewer),
    ]);
    const person = rt.store.getPerson(viewer);
    const callOut = (c: CallRecord) => ({
      ...toCall(c),
      hidden: c.hiddenAt !== null,
      hiddenAt: c.hiddenAt,
      result: rt.store.getResult(c.id) ?? null,
      market: rt.markets.getMarket(c.marketId)?.question ?? null,
    });
    const followers = rt.store
      .listPeople()
      .filter((p) => p.id !== viewer && rt.store.isFollowing(p.id, viewer))
      .map((p) => p.id);
    return {
      format: "chumbucket-account-export/v1",
      exportedAt: new Date(this.now()).toISOString(),
      account: {
        userId: viewer,
        handle: person?.handle ?? null,
        displayName: person?.displayName ?? null,
        profile: records.profile,
      },
      linkedWallets: records.linkedWallets,
      linkedIdentities: records.linkedIdentities,
      calls: rt.store.callsByAuthor(viewer).map(callOut),
      responses: rt.store.responsesByActor(viewer).map((r) => ({
        id: r.id,
        kind: r.kind,
        targetCallId: r.targetCallId,
        resultingCallId: r.resultingCallId,
        note: r.note,
        createdAt: r.createdAt,
      })),
      following: rt.store.followingOf(viewer).map((id) => this.summary(id)),
      followers: followers.map((id) => this.summary(id)),
      blocked: relations.blocked.map((id) => this.summary(id)),
      muted: relations.muted.map((id) => this.summary(id)),
      reportsFiled: reports.map((r) => ({
        id: r.id,
        subjectKind: r.subjectKind,
        subjectCallId: r.subjectCallId,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
      })),
      legalAcceptances: acceptances,
      fundedOrders: records.fundedOrders,
      notes: [
        "Calls, responses and results are permanent public records. Deleting your account removes your name, photo, wallet and sign-ins from them; they then show as \"Deleted account\".",
        "Funded orders were executed on Panta. Their on-chain transactions are public on Solana and cannot be deleted by anyone.",
      ],
    };
  }

  // ── web deletion request ──────────────────────────────────────────────────

  async requestDeletion(input: {
    contact: string;
    handle?: string | null;
    walletAddress?: string | null;
    details?: string | null;
  }): Promise<{ received: true }> {
    const contact = input.contact.trim().toLowerCase();
    this.deps.limiter.charge("deletion.request", `contact:${contact}`);
    this.deps.limiter.charge("deletion.global", "all");
    await this.deps.store.insertDeletionRequest(
      {
        contact,
        handle: input.handle?.trim().replace(/^@/, "") || null,
        walletAddress: input.walletAddress?.trim() || null,
        details: input.details?.trim() || null,
      },
      this.now(),
    );
    return { received: true };
  }
}
