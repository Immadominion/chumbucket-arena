import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeWallet } from "./authIdentityFixtures.ts";

const url = process.env.ACCOUNT_CLAIM_TEST_DATABASE_URL;
const local = url ? describe : describe.skip;
let db: SQL;
const migrationDir = join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

local("existing-profile claims — disposable PostgreSQL only", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== "127.0.0.1" || parsed.port !== "56479" || parsed.pathname !== "/chumbucket_account_claim_test") {
      throw new Error("Refusing anything except the explicit disposable test database");
    }
    db = new SQL(url!);
    const [server] = await db`SELECT current_setting('data_directory') AS dir`;
    if (!String(server.dir).startsWith("/private/tmp/chumbucket-account-claim.")) {
      throw new Error("Refusing a non-disposable PostgreSQL cluster");
    }
    const [existing] = await db`SELECT to_regclass('public.users') AS users`;
    if (existing.users) throw new Error("Tests require an empty disposable database; no existing tables will be overwritten");
    await db.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id UUID PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE public.users (id UUID PRIMARY KEY, wallet_address TEXT, display_name TEXT, history JSONB DEFAULT '[]');
      CREATE TABLE public.linked_wallets (user_id UUID REFERENCES public.users(id), wallet_address TEXT UNIQUE);
      CREATE TABLE public.old_receipts (id UUID PRIMARY KEY, user_id UUID REFERENCES public.users(id), body TEXT);
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    `);
    // Real prior auth-column migration, including the old broad-grant defense.
    await db.unsafe(readFileSync(join(migrationDir, "20260913120000_auth_identity_auth_user_link.sql"), "utf8"));
    await db.unsafe(readFileSync(join(migrationDir, "20260928120000_existing_account_claims.sql"), "utf8"));
  });
  afterAll(async () => { if (db) await db.end(); });

  async function fixture(approved = true) {
    const auth = randomUUID(), otherAuth = randomUUID(), user = randomUUID(), otherUser = randomUUID();
    const wallet = makeWallet().address;
    await db`INSERT INTO auth.users(id) VALUES (${auth}), (${otherAuth})`;
    await db`INSERT INTO public.users(id, wallet_address, display_name, history)
      VALUES (${user}, ${wallet}, 'Existing fixture name', '["old-history"]'), (${otherUser}, 'other-wallet', 'Other fixture', '[]')`;
    await db`INSERT INTO public.old_receipts(id, user_id, body) VALUES (${randomUUID()}, ${user}, 'Original receipt')`;
    if (approved) await approve(wallet, user);
    return { auth, otherAuth, user, otherUser, wallet };
  }
  async function approve(wallet: string, user: string) {
    await db`INSERT INTO public.existing_account_anchors(user_id, wallet_address, network, evidence_sha256, review_ref, reviewed_by)
      VALUES (${user}, ${wallet}, 'devnet', ${sha('synthetic-evidence')}, 'synthetic-review', 'test-operator')`;
  }
  async function issue(auth: string, wallet: string) {
    const nonce = sha(randomUUID()), message = sha(randomUUID());
    const [result] = await db.begin(async tx => {
      await tx`SET LOCAL ROLE service_role`;
      return await tx`SELECT public.issue_existing_account_proof_v1(
        ${auth}::uuid, ${wallet}, 'devnet', ${nonce}, ${message}, date_trunc('milliseconds', clock_timestamp()),
        date_trunc('milliseconds', clock_timestamp()) + interval '5 minutes') AS value`;
    });
    expect(result.value.ok).toBe(true);
    return { auth, wallet, nonce, message };
  }
  async function claim(p: Awaited<ReturnType<typeof issue>>) {
    const [result] = await db.begin(async tx => {
      await tx`SET LOCAL ROLE service_role`;
      return await tx`SELECT public.claim_existing_account_v1(${p.auth}::uuid, ${p.wallet}, 'devnet', ${p.nonce}, ${p.message}) AS value`;
    });
    return result.value;
  }

  test("new tables deny all client reads/writes even with broad default grants", async () => {
    for (const table of ["existing_account_anchors", "existing_account_proofs", "existing_account_claims"]) {
      const [row] = await db`SELECT relrowsecurity FROM pg_class WHERE oid = ${'public.' + table}::regclass`;
      expect(row.relrowsecurity).toBe(true);
      expect((await db`SELECT * FROM pg_policies WHERE schemaname='public' AND tablename=${table}`).length).toBe(0);
      for (const role of ["anon", "authenticated"]) {
        const [rights] = await db`SELECT has_table_privilege(${role}, ${'public.' + table}, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed`;
        expect(rights.allowed).toBe(false);
        await expect(db.begin(async tx => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          await tx.unsafe(`SELECT * FROM public.${table}`);
        })).rejects.toThrow(/permission denied/);
      }
    }
  });

  test("client roles cannot execute either service-only claim RPC", async () => {
    const f = await fixture();
    for (const role of ["anon", "authenticated"]) {
      await expect(db.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT public.claim_existing_account_v1(${f.auth}::uuid, ${f.wallet}, 'devnet', ${sha('x')}, ${sha('y')})`;
      })).rejects.toThrow(/permission denied/);
      await expect(db.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT public.issue_existing_account_proof_v1(${f.auth}::uuid, ${f.wallet}, 'devnet', ${sha('x')}, ${sha('y')}, now(), now() + interval '5 minutes')`;
      })).rejects.toThrow(/permission denied/);
      await expect(db.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`UPDATE public.users SET auth_user_id = ${f.auth} WHERE id = ${f.user}`;
      })).rejects.toThrow(/permission denied/);
    }
  });

  test("claim preserves the person and old history, and retries only read the result", async () => {
    const f = await fixture(); const p = await issue(f.auth, f.wallet);
    expect(await claim(p)).toMatchObject({ ok: true, user_id: f.user, outcome: "claimed" });
    expect(await claim(p)).toMatchObject({ ok: true, user_id: f.user, outcome: "already_claimed" });
    const [user] = await db`SELECT * FROM public.users WHERE id = ${f.user}`;
    expect(user.auth_user_id).toBe(f.auth); expect(user.display_name).toBe('Existing fixture name');
    expect(user.history).toEqual(["old-history"]); expect(user.wallet_address).toBe(f.wallet);
    expect((await db`SELECT body FROM public.old_receipts WHERE user_id = ${f.user}`)[0].body).toBe('Original receipt');
    expect((await db`SELECT * FROM public.existing_account_claims WHERE auth_user_id = ${f.auth}`).length).toBe(1);
  });

  test("a forged old wallet mapping never becomes an approved anchor", async () => {
    const f = await fixture(false);
    await db.begin(async tx => {
      await tx`SET LOCAL ROLE anon`;
      await tx`UPDATE public.users SET wallet_address = ${f.wallet} WHERE id = ${f.otherUser}`;
      await tx`INSERT INTO public.linked_wallets(user_id, wallet_address) VALUES (${f.otherUser}, ${f.wallet})`;
    });
    expect(await claim(await issue(f.auth, f.wallet))).toMatchObject({ ok: false, reason: 'claim_unavailable' });
    expect((await db`SELECT * FROM public.existing_account_claims WHERE auth_user_id = ${f.auth}`).length).toBe(0);
  });

  test("borrowed, superseded and altered proofs do not mutate the account", async () => {
    const f = await fixture(); const first = await issue(f.auth, f.wallet);
    expect(await claim({ ...first, auth: f.otherAuth })).toMatchObject({ reason: 'nonce_user_mismatch' });
    expect(await claim({ ...first, message: sha('altered-time') })).toMatchObject({ reason: 'nonce_unknown' });
    const second = await issue(f.auth, f.wallet);
    expect(await claim(first)).toMatchObject({ reason: 'nonce_reused' });
    expect(await claim(second)).toMatchObject({ ok: true, user_id: f.user });
  });

  test("expiry is enforced by Postgres independently of the BFF clock", async () => {
    const f = await fixture(); const p = await issue(f.auth, f.wallet);
    // Owner-only test time travel; the service role has no UPDATE grant here.
    await db`UPDATE public.existing_account_proofs SET issued_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE nonce_hash = ${p.nonce}`;
    expect(await claim(p)).toMatchObject({ reason: 'nonce_expired' });
  });

  test("different linked auth/profile conflicts never merge either person", async () => {
    for (const where of ['target', 'subject']) {
      const f = await fixture();
      await db`UPDATE public.users SET auth_user_id = ${where === 'target' ? f.otherAuth : f.auth}
        WHERE id = ${where === 'target' ? f.user : f.otherUser}`;
      const p = await issue(f.auth, f.wallet);
      expect(await claim(p)).toMatchObject({ reason: 'claim_conflict' });
      expect((await db`SELECT consumed_at FROM public.existing_account_proofs WHERE nonce_hash = ${p.nonce}`)[0].consumed_at).toBeNull();
    }
  });

  test("a proof that expires while waiting on the person lock cannot bind the account", async () => {
    const f = await fixture(); const p = await issue(f.auth, f.wallet);
    await db`UPDATE public.existing_account_proofs SET issued_at = clock_timestamp() - interval '31 seconds',
      expires_at = clock_timestamp() + interval '2 seconds' WHERE nonce_hash = ${p.nonce}`;
    let locked!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.begin(async tx => {
      await tx`SELECT id FROM public.users WHERE id = ${f.user} FOR UPDATE`;
      locked(); await gate;
    });
    await ready;
    const pending = claim(p);
    try {
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [row] = await db`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE 'SELECT public.claim_existing_account_v1%') AS waiting`;
        waiting = row.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await db`SELECT pg_sleep(2.1)`;
    } finally { release(); await holder; }
    expect(await pending).toMatchObject({ ok: false, reason: 'nonce_expired' });
    expect((await db`SELECT auth_user_id FROM public.users WHERE id = ${f.user}`)[0].auth_user_id).toBeNull();
    expect((await db`SELECT consumed_at FROM public.existing_account_proofs WHERE nonce_hash = ${p.nonce}`)[0].consumed_at).toBeNull();
  });

  test("concurrent claims for one profile serialize on the actual database row", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([issue(f.auth, f.wallet), issue(f.otherAuth, f.wallet)]);
    const results = await Promise.all([claim(a), claim(b)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.reason === 'claim_conflict')).toHaveLength(1);
    expect((await db`SELECT * FROM public.existing_account_claims WHERE user_id = ${f.user}`).length).toBe(1);
  });

  test("concurrent retries consume once and return the same profile", async () => {
    const f = await fixture(); const p = await issue(f.auth, f.wallet);
    const results = await Promise.all([claim(p), claim(p)]);
    expect(results.every(r => r.ok && r.user_id === f.user)).toBe(true);
    expect(results.map(r => r.outcome).sort()).toEqual(['already_claimed', 'claimed']);
    expect((await db`SELECT * FROM public.existing_account_claims WHERE user_id = ${f.user}`).length).toBe(1);
  });

  test("revoked anchors stay revoked and cannot be rewritten or deleted", async () => {
    const f = await fixture(); const p = await issue(f.auth, f.wallet);
    await db`UPDATE public.existing_account_anchors SET revoked_at = now() WHERE user_id = ${f.user}`;
    expect(await claim(p)).toMatchObject({ reason: 'claim_unavailable' });
    // SQL queries are lazy: explicitly execute before passing them to a matcher.
    await expect(db`UPDATE public.existing_account_anchors SET revoked_at = NULL WHERE user_id = ${f.user}`.execute()).rejects.toThrow(/revoked once/);
    await expect(db`UPDATE public.existing_account_anchors SET user_id = ${f.otherUser} WHERE user_id = ${f.user}`.execute()).rejects.toThrow(/revoked once/);
    await expect(db`DELETE FROM public.existing_account_anchors WHERE user_id = ${f.user}`.execute()).rejects.toThrow(/immutable/);
  });

  test("a failed audit insert rolls back both identity binding and proof consumption", async () => {
    const f = await fixture(); const p = await issue(f.auth, f.wallet);
    // Deliberate owner-only fault injection with a reserved transaction/trigger.
    await expect(db.begin(async tx => {
      await tx.unsafe(`CREATE FUNCTION public.test_reject_claim_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
        CREATE TRIGGER test_reject_claim_audit BEFORE INSERT ON public.existing_account_claims FOR EACH ROW EXECUTE FUNCTION public.test_reject_claim_audit();`);
      await tx`SELECT public.claim_existing_account_v1(${p.auth}::uuid, ${p.wallet}, 'devnet', ${p.nonce}, ${p.message})`;
    })).rejects.toThrow(/synthetic audit failure/);
    expect((await db`SELECT auth_user_id FROM public.users WHERE id = ${f.user}`)[0].auth_user_id).toBeNull();
    expect((await db`SELECT consumed_at FROM public.existing_account_proofs WHERE nonce_hash = ${p.nonce}`)[0].consumed_at).toBeNull();
    expect((await claim(p)).ok).toBe(true);
  });

  test("claim history is append-only, including owner TRUNCATE", async () => {
    const f = await fixture(); await claim(await issue(f.auth, f.wallet));
    await expect(db`DELETE FROM public.existing_account_claims WHERE user_id = ${f.user}`.execute()).rejects.toThrow(/immutable/);
    await expect(db`UPDATE public.existing_account_claims SET claimed_at = now() WHERE user_id = ${f.user}`.execute()).rejects.toThrow(/immutable/);
    await expect(db`TRUNCATE public.existing_account_claims`.execute()).rejects.toThrow(/immutable/);
  });

  test("nonce issuance is rate-limited per verified auth subject in the database", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) await issue(f.auth, f.wallet);
    const [result] = await db`SELECT public.issue_existing_account_proof_v1(${f.auth}::uuid, ${f.wallet}, 'devnet', ${sha(randomUUID())}, ${sha(randomUUID())}, now(), now() + interval '5 minutes') AS value`;
    expect(result.value).toMatchObject({ ok: false, reason: 'rate_limited' });
  });
});
