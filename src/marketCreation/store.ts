/**
 * Market proposals and their Panta create sessions, in their database shape
 * (supabase/migrations/20261002130000_market_proposals.sql in the mobile repo).
 *
 * Every state change is a compare-and-set on the previous state, so two
 * replicas (or a double tap) can never both approve, both publish, or both
 * broadcast. Postgres additionally enforces the transitions with a trigger and
 * at most one SUBMITTED/REGISTERED session per proposal with a partial index.
 */
import { Pgrest, type FetchImpl, type PgrestConfig } from "../prediction/pgrest.ts";
import type { CreateBinding } from "./PantaMarketCreator.ts";

export type ProposalStatus = "pending_review" | "approved" | "rejected" | "withdrawn" | "publishing" | "live";
export type ReviewReason = "unclear" | "unverifiable" | "duplicate" | "not_allowed" | "other";
export type SessionState = "QUOTED" | "SUBMITTED" | "REGISTERED" | "FAILED";

export interface ProposalRow {
  id: string;
  proposer_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  question: string;
  category: string;
  closes_at: string;
  resolves_at: string;
  rules: string;
  sources: string[];
  description: string | null;
  status: ProposalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: ReviewReason | null;
  review_note: string | null;
  cover_image_url: string | null;
  venue_market_id: string | null;
  creator_wallet: string | null;
  published_by: string | null;
  live_at: string | null;
  created_at: string;
  updated_at: string;
}
export type NewProposal = Pick<ProposalRow, "id" | "proposer_id" | "idempotency_key" | "request_fingerprint" | "question" |
  "category" | "closes_at" | "resolves_at" | "rules" | "sources" | "description">;

export interface SessionRow {
  id: string;
  proposal_id: string;
  publisher_id: string;
  wallet_address: string;
  state: SessionState;
  create_id: string;
  event_pda: string;
  payment_base_units: string;
  prepared: CreateBinding;
  signed_transaction: string | null;
  signature: string | null;
  registered_market_id: string | null;
  created_at: string;
  updated_at: string;
}
export type NewSession = Pick<SessionRow, "id" | "proposal_id" | "publisher_id" | "wallet_address" | "create_id" |
  "event_pda" | "payment_base_units" | "prepared">;

export interface MarketProposalStore {
  insertProposal(row: NewProposal): Promise<ProposalRow | null>;
  findByKey(proposerId: string, idempotencyKey: string): Promise<ProposalRow | null>;
  proposal(id: string): Promise<ProposalRow | null>;
  byProposer(proposerId: string, limit: number): Promise<ProposalRow[]>;
  byStatus(statuses: ProposalStatus[], limit: number): Promise<ProposalRow[]>;
  byVenueMarket(venueMarketId: string): Promise<ProposalRow | null>;
  countPending(proposerId: string): Promise<number>;
  countSince(proposerId: string, sinceIso: string): Promise<number>;
  updateProposal(id: string, from: ProposalStatus, patch: Partial<ProposalRow>): Promise<ProposalRow | null>;
  insertSession(row: NewSession): Promise<SessionRow>;
  session(id: string): Promise<SessionRow | null>;
  activeSession(proposalId: string): Promise<SessionRow | null>;
  updateSession(id: string, from: SessionState, patch: Partial<SessionRow>): Promise<SessionRow | null>;
}

const proposalColumns = "id,proposer_id,idempotency_key,request_fingerprint,question,category,closes_at,resolves_at,rules,sources,description,status,reviewed_by,reviewed_at,review_reason,review_note,cover_image_url,venue_market_id,creator_wallet,published_by,live_at,created_at,updated_at";
const sessionColumns = "id,proposal_id,publisher_id,wallet_address,state,create_id,event_pda,payment_base_units::text,prepared,signed_transaction,signature,registered_market_id,created_at,updated_at";

export class SupabaseMarketProposalStore implements MarketProposalStore {
  private readonly pg: Pgrest;
  constructor(config: PgrestConfig, fetchImpl: FetchImpl = fetch) { this.pg = new Pgrest(config, fetchImpl); }
  private async one<T>(table: string, params: Record<string, string>, columns: string): Promise<T | null> {
    return (await this.pg.select<T>(table, new URLSearchParams({ ...params, select: columns, limit: "1" })))[0] ?? null;
  }
  async insertProposal(row: NewProposal) {
    const rows = await this.pg.insert<ProposalRow>("market_proposals", [row], { onConflict: "proposer_id,idempotency_key", ignoreDuplicates: true, returning: true });
    return rows[0] ?? null;
  }
  findByKey(proposerId: string, idempotencyKey: string) {
    return this.one<ProposalRow>("market_proposals", { proposer_id: `eq.${proposerId}`, idempotency_key: `eq.${idempotencyKey}` }, proposalColumns);
  }
  proposal(id: string) { return this.one<ProposalRow>("market_proposals", { id: `eq.${id}` }, proposalColumns); }
  byProposer(proposerId: string, limit: number) {
    return this.pg.select<ProposalRow>("market_proposals", new URLSearchParams({ proposer_id: `eq.${proposerId}`, select: proposalColumns, order: "created_at.desc", limit: String(limit) }));
  }
  byStatus(statuses: ProposalStatus[], limit: number) {
    return this.pg.select<ProposalRow>("market_proposals", new URLSearchParams({ status: `in.(${statuses.join(",")})`, select: proposalColumns, order: "created_at.asc", limit: String(limit) }));
  }
  byVenueMarket(venueMarketId: string) {
    return this.one<ProposalRow>("market_proposals", { venue_market_id: `eq.${venueMarketId}`, status: "eq.live" }, proposalColumns);
  }
  async countPending(proposerId: string) {
    return (await this.pg.select<{ id: string }>("market_proposals", new URLSearchParams({ proposer_id: `eq.${proposerId}`, status: "eq.pending_review", select: "id", limit: "100" }))).length;
  }
  async countSince(proposerId: string, sinceIso: string) {
    return (await this.pg.select<{ id: string }>("market_proposals", new URLSearchParams({ proposer_id: `eq.${proposerId}`, created_at: `gte.${sinceIso}`, select: "id", limit: "100" }))).length;
  }
  async updateProposal(id: string, from: ProposalStatus, patch: Partial<ProposalRow>) {
    const rows = await this.pg.patch<ProposalRow>("market_proposals", new URLSearchParams({ id: `eq.${id}`, status: `eq.${from}`, select: proposalColumns }),
      { ...patch, updated_at: new Date().toISOString() }, { returning: true });
    return rows[0] ?? null;
  }
  async insertSession(row: NewSession) {
    const rows = await this.pg.insert<SessionRow>("market_creation_sessions", [{ ...row, state: "QUOTED" }], { returning: true });
    if (!rows[0]) throw new Error("market creation session was not stored");
    return rows[0];
  }
  session(id: string) { return this.one<SessionRow>("market_creation_sessions", { id: `eq.${id}` }, sessionColumns); }
  activeSession(proposalId: string) {
    return this.one<SessionRow>("market_creation_sessions", { proposal_id: `eq.${proposalId}`, state: "in.(SUBMITTED,REGISTERED)" }, sessionColumns);
  }
  async updateSession(id: string, from: SessionState, patch: Partial<SessionRow>) {
    const rows = await this.pg.patch<SessionRow>("market_creation_sessions", new URLSearchParams({ id: `eq.${id}`, state: `eq.${from}`, select: sessionColumns }),
      { ...patch, updated_at: new Date().toISOString() }, { returning: true });
    return rows[0] ?? null;
  }
}

/** Test/local store with the same compare-and-set and uniqueness semantics. */
export class InMemoryMarketProposalStore implements MarketProposalStore {
  readonly proposals = new Map<string, ProposalRow>();
  readonly sessions = new Map<string, SessionRow>();
  constructor(private readonly now: () => number = Date.now) {}
  private stamp() { return new Date(this.now()).toISOString(); }
  async insertProposal(row: NewProposal) {
    if (await this.findByKey(row.proposer_id, row.idempotency_key)) return null;
    const stored: ProposalRow = { ...row, sources: [...row.sources], status: "pending_review", reviewed_by: null, reviewed_at: null,
      review_reason: null, review_note: null, cover_image_url: null, venue_market_id: null, creator_wallet: null,
      published_by: null, live_at: null, created_at: this.stamp(), updated_at: this.stamp() };
    this.proposals.set(row.id, stored);
    return structuredClone(stored);
  }
  async findByKey(proposerId: string, key: string) {
    const row = [...this.proposals.values()].find(p => p.proposer_id === proposerId && p.idempotency_key === key);
    return row ? structuredClone(row) : null;
  }
  async proposal(id: string) { const row = this.proposals.get(id); return row ? structuredClone(row) : null; }
  async byProposer(proposerId: string, limit: number) {
    return [...this.proposals.values()].filter(p => p.proposer_id === proposerId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(p => structuredClone(p));
  }
  async byStatus(statuses: ProposalStatus[], limit: number) {
    return [...this.proposals.values()].filter(p => statuses.includes(p.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit).map(p => structuredClone(p));
  }
  async byVenueMarket(venueMarketId: string) {
    const row = [...this.proposals.values()].find(p => p.venue_market_id === venueMarketId && p.status === "live");
    return row ? structuredClone(row) : null;
  }
  async countPending(proposerId: string) { return [...this.proposals.values()].filter(p => p.proposer_id === proposerId && p.status === "pending_review").length; }
  async countSince(proposerId: string, sinceIso: string) {
    return [...this.proposals.values()].filter(p => p.proposer_id === proposerId && p.created_at >= sinceIso).length;
  }
  async updateProposal(id: string, from: ProposalStatus, patch: Partial<ProposalRow>) {
    const row = this.proposals.get(id);
    if (!row || row.status !== from) return null;
    if (patch.venue_market_id && [...this.proposals.values()].some(p => p.id !== id && p.venue_market_id === patch.venue_market_id)) {
      throw new Error("duplicate venue market");
    }
    const next = { ...row, ...patch, updated_at: this.stamp() };
    this.proposals.set(id, next);
    return structuredClone(next);
  }
  async insertSession(row: NewSession) {
    if ([...this.sessions.values()].some(s => s.create_id === row.create_id)) throw new Error("duplicate create id");
    const stored: SessionRow = { ...row, prepared: structuredClone(row.prepared), state: "QUOTED", signed_transaction: null,
      signature: null, registered_market_id: null, created_at: this.stamp(), updated_at: this.stamp() };
    this.sessions.set(row.id, stored);
    return structuredClone(stored);
  }
  async session(id: string) { const row = this.sessions.get(id); return row ? structuredClone(row) : null; }
  async activeSession(proposalId: string) {
    const row = [...this.sessions.values()].find(s => s.proposal_id === proposalId && (s.state === "SUBMITTED" || s.state === "REGISTERED"));
    return row ? structuredClone(row) : null;
  }
  async updateSession(id: string, from: SessionState, patch: Partial<SessionRow>) {
    const row = this.sessions.get(id);
    if (!row || row.state !== from) return null;
    const nextState = patch.state ?? row.state;
    if ((nextState === "SUBMITTED" || nextState === "REGISTERED") &&
        [...this.sessions.values()].some(s => s.id !== id && s.proposal_id === row.proposal_id && (s.state === "SUBMITTED" || s.state === "REGISTERED"))) {
      throw new Error("another create is already submitted for this proposal");
    }
    const next = { ...row, ...patch, updated_at: this.stamp() };
    this.sessions.set(id, next);
    return structuredClone(next);
  }
}
