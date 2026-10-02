/**
 * Opt-in real PostgreSQL 15 verification of 20261002130000_market_proposals.sql.
 * Run: bun --no-env-file scripts/verify-market-proposals-local.ts --run
 * The verifier owns a fresh loopback cluster; normal `bun test` never connects.
 *
 * It applies the migration, drives the REAL MarketCreationService lifecycle
 * through a SQL store acting as service_role (so the triggers judge the
 * service's actual write order), and probes every guard directly.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { MarketCreationService } from "../src/marketCreation/MarketCreationService.ts";
import { PantaMarketCreator } from "../src/marketCreation/PantaMarketCreator.ts";
import type { MarketProposalStore, NewProposal, NewSession, ProposalRow, ProposalStatus, SessionRow, SessionState } from "../src/marketCreation/store.ts";
import { eventPda, FakePanta, program, sign, wallet } from "./marketCreationFixtures.ts";

const url = process.env.MARKET_PROPOSALS_TEST_DATABASE_URL;
const local = url ? describe : describe.skip;
if (!url) console.info("SKIP market proposals PostgreSQL: MARKET_PROPOSALS_TEST_DATABASE_URL unset; run bun --no-env-file scripts/verify-market-proposals-local.ts --run");
const MIGRATION = "20261002130000_market_proposals.sql";
const migrationPath = [
  process.env.MARKET_PROPOSALS_MIGRATION,
  join(import.meta.dir, "../../mobile/supabase/migrations", MIGRATION),
  join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations", MIGRATION),
].find((path): path is string => !!path && existsSync(path));
let db: SQL | undefined;
const sql = () => { if (!db) throw new Error("database not initialised"); return db; };

async function asService<T>(action: (tx: SQL) => Promise<T>): Promise<T> {
  return sql().begin(async tx => { await tx.unsafe("SET LOCAL ROLE service_role"); return action(tx); });
}
/** Run a mutation that must be refused; always rolled back. `owner` skips SET ROLE
 *  so a trigger is probed directly, beneath the column grants. */
async function refused(action: (tx: SQL) => Promise<unknown>, pattern: RegExp, role: "service_role" | "anon" | "authenticated" | "owner" = "service_role") {
  let accepted = false;
  try {
    await sql().begin(async tx => {
      if (role !== "owner") await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await action(tx);
      accepted = true;
      throw new Error("rollback");
    });
  } catch (error) {
    if (accepted) throw new Error(`GUARD GAP: accepted a mutation expected to match ${pattern}`);
    expect((error as Error).message).toMatch(pattern);
  }
}

const iso = (v: unknown) => v instanceof Date ? v.toISOString() : String(v);
function proposalOf(row: Record<string, unknown>): ProposalRow {
  return { ...row, closes_at: iso(row.closes_at), resolves_at: iso(row.resolves_at), created_at: iso(row.created_at),
    updated_at: iso(row.updated_at), reviewed_at: row.reviewed_at ? iso(row.reviewed_at) : null, live_at: row.live_at ? iso(row.live_at) : null,
  } as ProposalRow;
}
function sessionOf(row: Record<string, unknown>): SessionRow {
  return { ...row, payment_base_units: String(row.payment_base_units), created_at: iso(row.created_at), updated_at: iso(row.updated_at) } as SessionRow;
}
/** The store contract over real SQL, as service_role, with the PostgREST store's CAS semantics. */
class SqlStore implements MarketProposalStore {
  async insertProposal(r: NewProposal) {
    const rows = await asService(tx => tx`INSERT INTO public.market_proposals(id,proposer_id,idempotency_key,request_fingerprint,question,category,closes_at,resolves_at,rules,sources,description)
      VALUES (${r.id},${r.proposer_id},${r.idempotency_key},${r.request_fingerprint},${r.question},${r.category},${r.closes_at},${r.resolves_at},${r.rules},${tx.array(r.sources, "TEXT")},${r.description})
      ON CONFLICT (proposer_id,idempotency_key) DO NOTHING RETURNING *`);
    return rows[0] ? proposalOf(rows[0]) : null;
  }
  async findByKey(p: string, k: string) { const [r] = await asService(tx => tx`SELECT * FROM public.market_proposals WHERE proposer_id=${p} AND idempotency_key=${k}`); return r ? proposalOf(r) : null; }
  async proposal(id: string) { const [r] = await asService(tx => tx`SELECT * FROM public.market_proposals WHERE id=${id}`); return r ? proposalOf(r) : null; }
  async byProposer(p: string, limit: number) { return (await asService(tx => tx`SELECT * FROM public.market_proposals WHERE proposer_id=${p} ORDER BY created_at DESC LIMIT ${limit}`)).map(proposalOf); }
  async byStatus(s: ProposalStatus[], limit: number) { return (await asService(tx => tx`SELECT * FROM public.market_proposals WHERE status = ANY(${tx.array(s, "TEXT")}) ORDER BY created_at LIMIT ${limit}`)).map(proposalOf); }
  async byVenueMarket(v: string) { const [r] = await asService(tx => tx`SELECT * FROM public.market_proposals WHERE venue_market_id=${v} AND status='live'`); return r ? proposalOf(r) : null; }
  async countPending(p: string) { const [r] = await asService(tx => tx`SELECT count(*)::int AS n FROM public.market_proposals WHERE proposer_id=${p} AND status='pending_review'`); return r.n; }
  async countSince(p: string, since: string) { const [r] = await asService(tx => tx`SELECT count(*)::int AS n FROM public.market_proposals WHERE proposer_id=${p} AND created_at >= ${since}`); return r.n; }
  async updateProposal(id: string, from: ProposalStatus, patch: Partial<ProposalRow>) {
    const keys = Object.keys(patch) as (keyof ProposalRow)[];
    const rows = await asService(tx => tx`UPDATE public.market_proposals SET ${tx({ ...patch, updated_at: new Date().toISOString() }, ...keys, "updated_at")}
      WHERE id=${id} AND status=${from} RETURNING *`);
    return rows[0] ? proposalOf(rows[0]) : null;
  }
  async insertSession(r: NewSession) {
    const [row] = await asService(tx => tx`INSERT INTO public.market_creation_sessions(id,proposal_id,publisher_id,wallet_address,create_id,event_pda,payment_base_units,prepared)
      VALUES (${r.id},${r.proposal_id},${r.publisher_id},${r.wallet_address},${r.create_id},${r.event_pda},${r.payment_base_units},${r.prepared}::jsonb) RETURNING *`);
    return sessionOf(row);
  }
  async session(id: string) { const [r] = await asService(tx => tx`SELECT * FROM public.market_creation_sessions WHERE id=${id}`); return r ? sessionOf(r) : null; }
  async activeSession(p: string) { const [r] = await asService(tx => tx`SELECT * FROM public.market_creation_sessions WHERE proposal_id=${p} AND state IN ('SUBMITTED','REGISTERED')`); return r ? sessionOf(r) : null; }
  async updateSession(id: string, from: SessionState, patch: Partial<SessionRow>) {
    const keys = Object.keys(patch) as (keyof SessionRow)[];
    const rows = await asService(tx => tx`UPDATE public.market_creation_sessions SET ${tx({ ...patch, updated_at: new Date().toISOString() }, ...keys, "updated_at")}
      WHERE id=${id} AND state=${from} RETURNING *`);
    return rows[0] ? sessionOf(rows[0]) : null;
  }
}

local("market proposals — fresh owner-only PostgreSQL 15", () => {
  const proposer = randomUUID(), reviewer = randomUUID();
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== "127.0.0.1" || parsed.password || !/^\/chumbucket_market_proposals_test_[0-9a-f]{12}$/.test(parsed.pathname)) {
      throw new Error("Refusing non-disposable database target");
    }
    if (!migrationPath) throw new Error(`Cannot find ${MIGRATION}; set MARKET_PROPOSALS_MIGRATION`);
    db = new SQL(url!, { max: 2 });
    const [existing] = await db`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname = 'public'`;
    if (existing.n !== 0) throw new Error("Require a new empty database; refusing to overwrite existing objects");
    await db.unsafe(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE TABLE public.users(id UUID PRIMARY KEY, handle TEXT);
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      -- Supabase's broad default grants: the migration must revoke them itself.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
      GRANT SELECT ON public.users TO service_role;
    `);
    await db.unsafe(readFileSync(migrationPath, "utf8"));
    await db`INSERT INTO public.users(id, handle) VALUES (${proposer}, 'ada'), (${reviewer}, 'rev')`;
    console.info(`APPLIED ${migrationPath}`);
  }, 30_000);
  afterAll(async () => { await db?.end(); db = undefined; });

  function service(panta: FakePanta, chain: { verified: boolean; failed: boolean }) {
    panta.createIdPrefix = `cr_pg_${randomUUID().slice(0, 8)}`;
    panta.nextBlockhash = () => Keypair.generate().publicKey.toBase58();
    panta.event = Keypair.generate().publicKey.toBase58();
    const creator = new PantaMarketCreator({ request: panta.request, upload: panta.upload, programId: program, maxFeeBaseUnits: "100000000" });
    return new MarketCreationService({ store: new SqlStore(), reviewerIds: new Set([reviewer]), people: { get: () => undefined },
      publishing: { creator, catalog: { ingest: async () => {} }, chain: {
        broadcast: async () => {}, verifyTransaction: async () => chain.verified, failed: async () => chain.failed, neverLanded: async () => false,
      } } });
  }
  const draft = (key: string) => ({ question: `Will synthetic question ${key} resolve YES?`, category: "crypto",
    closesAt: Date.now() + 72 * 3_600_000, resolvesAt: Date.now() + 73 * 3_600_000,
    rules: "Resolves YES if the synthetic source reports YES at close.", sources: ["https://example.com/result"],
    description: null, idempotencyKey: `pg-${key}-${randomUUID().slice(0, 8)}` });

  test("the service lifecycle is accepted by every guard: propose, approve, publish, live", async () => {
    const panta = new FakePanta(() => Date.now()), chain = { verified: false, failed: false };
    const svc = service(panta, chain);
    const input = draft("live");
    const p = await svc.propose(proposer, input);
    expect(await svc.propose(proposer, input)).toMatchObject({ id: p.id }); // ON CONFLICT replay
    await svc.review(reviewer, p.id, { approve: true });
    const review = await svc.preparePublish(proposer, p.id, wallet);
    expect((await svc.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).status).toBe("publishing");
    chain.verified = true;
    const live = await svc.refresh(proposer, p.id);
    expect(live).toMatchObject({ status: "live", live: { venueMarketId: panta.event } });
    const [row] = await sql()`SELECT status, venue_market_id, creator_wallet, published_by FROM public.market_proposals WHERE id=${p.id}`;
    expect(row).toEqual({ status: "live", venue_market_id: panta.event, creator_wallet: wallet, published_by: proposer });
    const [session] = await sql()`SELECT state, registered_market_id FROM public.market_creation_sessions WHERE proposal_id=${p.id}`;
    expect(session).toEqual({ state: "REGISTERED", registered_market_id: panta.event });
  });

  test("a failed create releases the proposal and a second create can be submitted", async () => {
    const panta = new FakePanta(() => Date.now()), chain = { verified: false, failed: false };
    panta.registerError = new (await import("../src/marketCreation/errors.ts")).MarketCreationError("MC_PANTA_REFUSED", "x", { providerCode: "TX_FAILED" });
    const svc = service(panta, chain);
    const p = await svc.propose(proposer, draft("retry"));
    await svc.review(reviewer, p.id, { approve: true });
    const first = await svc.preparePublish(proposer, p.id, wallet);
    await svc.submitPublish(proposer, p.id, first.sessionId, sign(first.transaction));
    chain.failed = true;
    expect((await svc.refresh(proposer, p.id)).status).toBe("approved");
    chain.failed = false; panta.registerError = null; chain.verified = true;
    // A different create (fresh createId); the event address is the same synthetic one, which is fine before live.
    const second = await svc.preparePublish(proposer, p.id, wallet);
    expect((await svc.submitPublish(proposer, p.id, second.sessionId, sign(second.transaction))).status).toBe("live");
  });

  test("clients cannot read or write; history cannot be deleted; content cannot be edited", async () => {
    const [p] = await sql()`SELECT id FROM public.market_proposals LIMIT 1`;
    for (const role of ["anon", "authenticated"] as const) {
      await refused(tx => tx`SELECT * FROM public.market_proposals`, /permission denied/, role);
      await refused(tx => tx`SELECT * FROM public.market_creation_sessions`, /permission denied/, role);
    }
    await refused(tx => tx`DELETE FROM public.market_proposals WHERE id=${p.id}`, /permission denied|permanent/);
    await refused(tx => tx`TRUNCATE public.market_creation_sessions`, /permission denied|permanent/);
    await refused(tx => tx`UPDATE public.market_proposals SET question='Edited after the fact?' WHERE id=${p.id}`, /permission denied/);
    await refused(tx => tx`UPDATE public.market_proposals SET question='Edited after the fact?' WHERE id=${p.id}`, /cannot be edited|final/, "owner");
    await refused(tx => tx`DELETE FROM public.market_proposals WHERE id=${p.id}`, /permanent/, "owner");
  });

  test("guards refuse illegal starts, skipped review, unregistered live and final-state changes", async () => {
    const id = randomUUID();
    const base = { id, proposer_id: proposer, idempotency_key: `guard-${id}`, request_fingerprint: "a".repeat(64),
      question: "Will the guard refuse this?", category: "crypto", closes_at: new Date(Date.now() + 9e7).toISOString(),
      resolves_at: new Date(Date.now() + 9e7).toISOString(), rules: "Resolves YES if the guard refuses it.", sources: '{"https://example.com"}' };
    const insert = (extra: Record<string, unknown>) => (tx: SQL) => tx`INSERT INTO public.market_proposals ${tx({ ...base, ...extra })}`;
    await refused(insert({ status: "approved", reviewed_by: reviewer, reviewed_at: new Date().toISOString() }), /must start pending review/);
    await refused(insert({ category: "gaming" }), /check constraint/);
    await refused(insert({ question: "x".repeat(513) }), /check constraint/);
    await refused(insert({ resolves_at: new Date(Date.now()).toISOString() }), /check constraint/);
    await asService(tx => tx`INSERT INTO public.market_proposals ${tx(base)}`);
    await refused(tx => tx`UPDATE public.market_proposals SET status='publishing', creator_wallet=${wallet}, published_by=${proposer}, cover_image_url='https://x.example/c.png' WHERE id=${id}`, /Invalid market proposal transition/);
    await refused(tx => tx`UPDATE public.market_proposals SET status='rejected' WHERE id=${id}`, /check constraint/);
    await asService(tx => tx`UPDATE public.market_proposals SET status='approved', reviewed_by=${reviewer}, reviewed_at=now() WHERE id=${id}`);
    // Publishing without a submitted create, and live without a registered one.
    await refused(tx => tx`UPDATE public.market_proposals SET status='publishing', creator_wallet=${wallet}, published_by=${proposer}, cover_image_url='https://x.example/c.png' WHERE id=${id}`, /requires a submitted create/);
    await asService(tx => tx`UPDATE public.market_proposals SET status='withdrawn' WHERE id=${id}`);
    await refused(tx => tx`UPDATE public.market_proposals SET status='approved' WHERE id=${id}`, /final/);
    // A session cannot start for a non-approved proposal, or signed.
    await refused(tx => tx`INSERT INTO public.market_creation_sessions(proposal_id,publisher_id,wallet_address,create_id,event_pda,payment_base_units,prepared)
      VALUES (${id},${proposer},${wallet},'cr_guard',${eventPda},50000000,'{}'::jsonb)`, /binding|approved proposal/);
  });

  test("one submitted create per proposal and one signature per create", async () => {
    const [done] = await sql()`SELECT id FROM public.market_creation_sessions WHERE state='REGISTERED' LIMIT 1`;
    await refused(tx => tx`UPDATE public.market_creation_sessions SET state='FAILED' WHERE id=${done.id}`, /final/);
    const [failed] = await sql()`SELECT id FROM public.market_creation_sessions WHERE state='FAILED' LIMIT 1`;
    await refused(tx => tx`UPDATE public.market_creation_sessions SET state='SUBMITTED' WHERE id=${failed.id}`, /final/);
    // Two unsigned reviews for one approved proposal: only one may ever be submitted.
    const panta = new FakePanta(() => Date.now());
    const svc = service(panta, { verified: false, failed: false });
    const p = await svc.propose(proposer, draft("single"));
    await svc.review(reviewer, p.id, { approve: true });
    const a = await svc.preparePublish(proposer, p.id, wallet), b = await svc.preparePublish(proposer, p.id, wallet);
    await asService(tx => tx`UPDATE public.market_creation_sessions SET state='SUBMITTED', signature=${"2".repeat(88)}, signed_transaction='AAAA' WHERE id=${a.sessionId}`);
    await refused(tx => tx`UPDATE public.market_creation_sessions SET state='SUBMITTED', signature=${"3".repeat(88)}, signed_transaction='AAAA' WHERE id=${b.sessionId}`, /market_creation_sessions_one_submitted/);
    await refused(tx => tx`UPDATE public.market_creation_sessions SET signature=${"4".repeat(88)}, signed_transaction='BBBB' WHERE id=${a.sessionId}`, /only one transaction/);
    await refused(tx => tx`UPDATE public.market_creation_sessions SET prepared = prepared || '{"paymentBaseUnits":"1"}'::jsonb WHERE id=${b.sessionId}`, /permission denied/);
    await refused(tx => tx`UPDATE public.market_creation_sessions SET payment_base_units = 1 WHERE id=${b.sessionId}`, /cannot change|binding/, "owner");
  });
});
