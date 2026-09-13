/**
 * Database-side assertions for the `*_auth_identity_*` migrations.
 *
 * This file is split in two on purpose, because the two halves can and cannot
 * run in different circumstances and MUST NOT be confused with each other:
 *
 *   A. STATIC — reads the migration SQL itself and asserts the shape contract
 *      §5 requires (default-deny template on every new table, a pinned
 *      search_path and a REVOKE/GRANT pair on every new function, no
 *      CREATE OR REPLACE of an existing function, no `USING (true)`). This runs
 *      whenever the sibling mobile worktree is present, which is the normal
 *      layout. If it is not, the tests are SKIPPED and say so — they never pass
 *      vacuously.
 *
 *   B. LIVE — actually connects to a PostgreSQL database that has the
 *      migrations applied, switches to the `anon` and `authenticated` roles,
 *      and proves that the tables are unreachable and that one user's rows are
 *      invisible to another. This is the half that tests RLS *itself*, which
 *      the in-process tests structurally cannot: `SupabaseIdentityStore` uses
 *      the service-role key and bypasses RLS by construction (contract §2).
 *
 *      It is SKIPPED unless AUTH_IDENTITY_TEST_DATABASE_URL is set. A skipped
 *      test is reported by `bun test` as skipped — it is not a pass, and this
 *      file deliberately contains no fallback that would make it look like one.
 *
 *      To run it:
 *        AUTH_IDENTITY_TEST_DATABASE_URL=postgres://... bun test authIdentityRls
 *      Point it at a scratch database, never at production. Nothing in this
 *      repository applies migrations or connects to a database on its own.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ── locating the migrations (they live in the MOBILE worktree) ──────────────

const MIGRATION_DIR =
  process.env.AUTH_IDENTITY_MIGRATIONS_DIR ??
  join(import.meta.dir, "..", "..", "chumbucket-social-calls", "supabase", "migrations");

const MIGRATIONS_PRESENT = existsSync(MIGRATION_DIR);

function packetFiles(): { name: string; sql: string }[] {
  if (!MIGRATIONS_PRESENT) return [];
  return readdirSync(MIGRATION_DIR)
    .filter((f) => /_auth_identity_.*\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATION_DIR, name), "utf8") }));
}

/** Tables this packet creates. Every one must carry the §5 default-deny template. */
const NEW_TABLES = ["wallet_nonces", "legacy_identity_claims", "wallet_link_audit"] as const;

/** Functions this packet creates. Every one must pin search_path and revoke EXECUTE. */
const NEW_FUNCTIONS = [
  "current_app_user_id",
  "issue_wallet_nonce_v1",
  "consume_wallet_nonce_v1",
  "purge_wallet_nonces_v1",
  "claim_legacy_identity_v1",
  "advance_legacy_claim_v1",
  "attach_verified_wallet_v1",
  "revoke_verified_wallet_v1",
  "transfer_verified_wallet_v1",
] as const;

const describeStatic = MIGRATIONS_PRESENT ? describe : describe.skip;

describeStatic("auth_identity migrations — static shape (contract §5)", () => {
  test("the packet ships migrations, all correctly named and ordered after the last existing one", () => {
    const files = packetFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.name).toMatch(/^2026\d{10}_auth_identity_[a-z_]+\.sql$/);
      // Contract §5: a timestamp after 20260719170000, the last migration in
      // the chain, so these apply on top of it rather than interleaving.
      expect(f.name.slice(0, 14) > "20260719170000").toBe(true);
    }
  });

  test("every new table gets ENABLE RLS + REVOKE anon/authenticated + GRANT service_role", () => {
    const all = packetFiles()
      .map((f) => f.sql)
      .join("\n");
    for (const t of NEW_TABLES) {
      expect(all).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(all).toContain(`REVOKE ALL ON public.${t} FROM anon, authenticated;`);
      expect(all).toContain(`GRANT ALL ON public.${t} TO service_role;`);
    }
  });

  test("no new table is given a permissive policy", () => {
    for (const f of packetFiles()) {
      // Contract §2: adding a tight policy beside `USING (true)` is a no-op, so
      // a `USING (true)` on a NEW table would quietly undo the default-deny.
      expect(f.sql).not.toMatch(/CREATE\s+POLICY[\s\S]*?USING\s*\(\s*true\s*\)/i);
    }
  });

  test("every new function pins search_path and revokes EXECUTE from PUBLIC", () => {
    const all = packetFiles()
      .map((f) => f.sql)
      .join("\n");
    for (const fn of NEW_FUNCTIONS) {
      expect(all).toContain(`CREATE FUNCTION public.${fn}(`);
      expect(all).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn}(`);
      expect(all).toContain(`GRANT  EXECUTE ON FUNCTION public.${fn}(`);
    }
    // One pin per CREATE FUNCTION, no exceptions.
    const creates = (all.match(/CREATE FUNCTION public\./g) ?? []).length;
    const pins = (all.match(/SET search_path = pg_catalog, public, pg_temp/g) ?? []).length;
    expect(creates).toBe(NEW_FUNCTIONS.length);
    expect(pins).toBeGreaterThanOrEqual(creates);
  });

  test("no existing function is redefined (contract §5: never CREATE OR REPLACE)", () => {
    for (const f of packetFiles()) {
      expect(f.sql).not.toContain("CREATE OR REPLACE FUNCTION");
    }
  });

  test("the nonce store never persists a plaintext nonce", () => {
    const sql = packetFiles().find((f) => f.name.includes("wallet_nonces"))?.sql ?? "";
    expect(sql).toContain("nonce_hash");
    // A column literally named `nonce` (as opposed to `nonce_hash`) would mean
    // the plaintext challenge is at rest.
    expect(sql).not.toMatch(/^\s{2}nonce\s+TEXT/m);
    expect(sql).toContain("wallet_nonces_hash_shape");
  });

  test("nonce consumption is a single atomic UPDATE, not a read-then-write", () => {
    const sql = packetFiles().find((f) => f.name.includes("wallet_nonces"))?.sql ?? "";
    expect(sql).toMatch(/UPDATE public\.wallet_nonces[\s\S]*?AND n\.consumed_at\s+IS NULL[\s\S]*?RETURNING/);
  });

  test("linked_wallets gets the additive columns and the partial unique index", () => {
    const sql = packetFiles().find((f) => f.name.includes("linked_wallets"))?.sql ?? "";
    for (const col of ["siws_proof_version", "verified_at", "revoked_at"]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_linked_wallets_active_address[\s\S]*?WHERE revoked_at IS NULL/,
    );
    // Additive only: no drops, no retypes of what is already there.
    expect(sql).not.toMatch(/ALTER TABLE public\.linked_wallets[\s\S]*?DROP COLUMN/);
    expect(sql).not.toMatch(/DROP (CONSTRAINT|INDEX|POLICY)/);
  });

  test("public.users gains only an additive column, and it is not client-writable", () => {
    const sql = packetFiles().find((f) => f.name.includes("auth_user_link"))?.sql ?? "";
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS auth_user_id UUID");
    expect(sql).toContain("REFERENCES auth.users(id) ON DELETE SET NULL");
    expect(sql).not.toMatch(/ALTER TABLE public\.users[\s\S]*?DROP COLUMN/);
    // A column-level revoke is a no-op under a table-level grant, so the
    // established correction (revoke the table grant, re-grant the rest) must
    // be what is used here.
    expect(sql).toContain("REVOKE INSERT, UPDATE ON public.users FROM anon, authenticated");
    expect(sql).toContain("GRANT INSERT (%s) ON public.users TO anon, authenticated");
  });
});

// ── B. LIVE database assertions ─────────────────────────────────────────────

const LIVE_URL = process.env.AUTH_IDENTITY_TEST_DATABASE_URL;
const describeLive = LIVE_URL ? describe : describe.skip;

/**
 * NOTE ON SKIPPING: when AUTH_IDENTITY_TEST_DATABASE_URL is unset, every test
 * below is reported as SKIPPED by `bun test`. That is the intended, visible
 * outcome — these assertions cannot be satisfied without a database, and a
 * green tick for an RLS test that never talked to Postgres would be a lie.
 */
describeLive("auth_identity migrations — LIVE database RLS [requires AUTH_IDENTITY_TEST_DATABASE_URL]", () => {
  async function sql() {
    const { SQL } = await import("bun");
    return new SQL(LIVE_URL as string);
  }

  test("every new table has RLS enabled and ZERO policies", async () => {
    const db = await sql();
    try {
      for (const t of NEW_TABLES) {
        const [rel] = await db`
          SELECT c.relrowsecurity, c.relforcerowsecurity
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = ${t}`;
        expect(rel?.relrowsecurity).toBe(true);

        const policies = await db`SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=${t}`;
        expect(policies.length).toBe(0);
      }
    } finally {
      await db.end();
    }
  });

  test("anon and authenticated hold no privilege on any new table", async () => {
    const db = await sql();
    try {
      for (const t of NEW_TABLES) {
        const grants = await db`
          SELECT grantee, privilege_type
            FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name=${t}
             AND grantee IN ('anon','authenticated','PUBLIC')`;
        expect(grants.length).toBe(0);
      }
    } finally {
      await db.end();
    }
  });

  test("anon cannot read legacy_identity_claims at all", async () => {
    const db = await sql();
    try {
      await db`INSERT INTO public.users (id, wallet_address) VALUES (gen_random_uuid(), 'rls-probe-user')
               ON CONFLICT (wallet_address) DO NOTHING`;
      let denied = false;
      try {
        await db.begin(async (tx) => {
          await tx`SET LOCAL ROLE anon`;
          await tx`SELECT count(*) FROM public.legacy_identity_claims`;
        });
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
    } finally {
      await db.end();
    }
  });

  test("authenticated cannot read wallet_nonces or wallet_link_audit", async () => {
    const db = await sql();
    try {
      for (const t of ["wallet_nonces", "wallet_link_audit"]) {
        let denied = false;
        try {
          await db.begin(async (tx) => {
            await tx`SET LOCAL ROLE authenticated`;
            await tx.unsafe(`SELECT count(*) FROM public.${t}`);
          });
        } catch {
          denied = true;
        }
        expect(denied).toBe(true);
      }
    } finally {
      await db.end();
    }
  });

  test("current_app_user_id is SECURITY DEFINER, search_path-pinned, and not anon-executable", async () => {
    const db = await sql();
    try {
      const [fn] = await db`
        SELECT p.prosecdef, p.proconfig, p.provolatile
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname='public' AND p.proname='current_app_user_id'`;
      expect(fn?.prosecdef).toBe(true);
      expect(String(fn?.proconfig)).toContain("search_path=pg_catalog, public, pg_temp");
      // 's' = STABLE
      expect(fn?.provolatile).toBe("s");

      const [anonPriv] = await db`
        SELECT has_function_privilege('anon', 'public.current_app_user_id()', 'EXECUTE') AS ok`;
      expect(anonPriv?.ok).toBe(false);

      // authenticated MUST hold EXECUTE, or every policy that reads it errors
      // instead of denying. See the migration's grant comment.
      const [authedPriv] = await db`
        SELECT has_function_privilege('authenticated', 'public.current_app_user_id()', 'EXECUTE') AS ok`;
      expect(authedPriv?.ok).toBe(true);
    } finally {
      await db.end();
    }
  });

  test("every other new function is service_role-only and search_path-pinned", async () => {
    const db = await sql();
    try {
      for (const fn of NEW_FUNCTIONS.filter((f) => f !== "current_app_user_id")) {
        const [row] = await db`
          SELECT p.prosecdef, p.proconfig
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public' AND p.proname=${fn}`;
        expect(row?.prosecdef).toBe(true);
        expect(String(row?.proconfig)).toContain("search_path=pg_catalog, public, pg_temp");
      }
    } finally {
      await db.end();
    }
  });

  test("public.users.auth_user_id cannot be written by anon", async () => {
    const db = await sql();
    try {
      let denied = false;
      try {
        await db.begin(async (tx) => {
          await tx`SET LOCAL ROLE anon`;
          await tx`UPDATE public.users SET auth_user_id = gen_random_uuid() WHERE wallet_address = 'rls-probe-user'`;
        });
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
    } finally {
      await db.end();
    }
  });

  test("current_app_user_id resolves each session to its OWN canonical user, and NULL with no session", async () => {
    const db = await sql();
    try {
      const ids = await db`
        WITH a AS (INSERT INTO auth.users (id) VALUES (gen_random_uuid()), (gen_random_uuid()) RETURNING id)
        SELECT id FROM a`;
      const authA = ids[0]?.id as string;
      const authB = ids[1]?.id as string;

      const [ua] = await db`INSERT INTO public.users (wallet_address, auth_user_id)
                            VALUES (${`rls-a-${authA}`}, ${authA}::uuid) RETURNING id`;
      const [ub] = await db`INSERT INTO public.users (wallet_address, auth_user_id)
                            VALUES (${`rls-b-${authB}`}, ${authB}::uuid) RETURNING id`;

      for (const [authId, expected] of [
        [authA, ua?.id as string],
        [authB, ub?.id as string],
      ] as const) {
        await db.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL request.jwt.claim.sub = '${authId}'`);
          const [row] = await tx`SELECT public.current_app_user_id() AS id`;
          expect(row?.id).toBe(expected);
        });
      }

      // No session -> NULL. This is the value that makes an
      // `id = public.current_app_user_id()` policy deny rather than match.
      const [none] = await db`SELECT public.current_app_user_id() AS id`;
      expect(none?.id).toBeNull();
    } finally {
      await db.end();
    }
  });

  test("the contract §5 policy shape actually isolates two users at the SQL level", async () => {
    const db = await sql();
    const ROLLBACK = new Error("rollback-probe");
    try {
      await db.begin(async (tx) => {
        const ids = await tx`
          WITH a AS (INSERT INTO auth.users (id) VALUES (gen_random_uuid()), (gen_random_uuid()) RETURNING id)
          SELECT id FROM a`;
        const authA = ids[0]?.id as string;
        const authB = ids[1]?.id as string;
        const [ua] = await tx`INSERT INTO public.users (wallet_address, auth_user_id)
                              VALUES (${`iso-a-${authA}`}, ${authA}::uuid) RETURNING id`;
        const [ub] = await tx`INSERT INTO public.users (wallet_address, auth_user_id)
                              VALUES (${`iso-b-${authB}`}, ${authB}::uuid) RETURNING id`;

        // A table built to the exact §5 template, standing in for the
        // owner-scoped tables Packets B and C will add. Rolled back at the end.
        await tx`CREATE TABLE public.rls_probe (
                   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                   user_id UUID NOT NULL REFERENCES public.users(id),
                   secret TEXT NOT NULL)`;
        await tx`ALTER TABLE public.rls_probe ENABLE ROW LEVEL SECURITY`;
        await tx`REVOKE ALL ON public.rls_probe FROM anon, authenticated`;
        await tx`GRANT ALL ON public.rls_probe TO service_role`;
        await tx`GRANT SELECT, INSERT ON public.rls_probe TO authenticated`;
        await tx`CREATE POLICY rls_probe_own_select ON public.rls_probe
                   FOR SELECT TO authenticated USING (user_id = public.current_app_user_id())`;
        await tx`CREATE POLICY rls_probe_own_insert ON public.rls_probe
                   FOR INSERT TO authenticated WITH CHECK (user_id = public.current_app_user_id())`;

        await tx`INSERT INTO public.rls_probe (user_id, secret) VALUES (${ua?.id as string}::uuid, 'alice-only')`;
        await tx`INSERT INTO public.rls_probe (user_id, secret) VALUES (${ub?.id as string}::uuid, 'bob-only')`;

        // ── as user A ────────────────────────────────────────────────────────
        await tx.unsafe(`SET LOCAL request.jwt.claim.sub = '${authA}'`);
        await tx`SET LOCAL ROLE authenticated`;

        const visible = await tx`SELECT secret FROM public.rls_probe`;
        expect(visible.map((r: { secret: string }) => r.secret)).toEqual(["alice-only"]);

        // A cannot write a row attributed to B.
        let insertDenied = false;
        try {
          await tx`INSERT INTO public.rls_probe (user_id, secret) VALUES (${ub?.id as string}::uuid, 'forged')`;
        } catch {
          insertDenied = true;
        }
        expect(insertDenied).toBe(true);

        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await db.end();
    }
  });

  test("a nonce can be consumed exactly once, atomically", async () => {
    const db = await sql();
    try {
      const [user] = await db`
        INSERT INTO public.users (id, wallet_address) VALUES (gen_random_uuid(), 'rls-nonce-user')
        ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
        RETURNING id`;
      const userId = user?.id as string;
      const hash = "c".repeat(64);
      await db`DELETE FROM public.wallet_nonces WHERE nonce_hash = ${hash}`;
      await db`SELECT public.issue_wallet_nonce_v1(${hash}, ${userId}::uuid, 'ProbeAddress', 'link_wallet',
                'chumbucket.app', 'https://chumbucket.app', 'devnet', 300)`;

      const args = [hash, userId, "ProbeAddress", "link_wallet", "chumbucket.app", "https://chumbucket.app", "devnet"];
      const [first] = await db`SELECT public.consume_wallet_nonce_v1(${args[0]}, ${args[1]}::uuid, ${args[2]},
                ${args[3]}, ${args[4]}, ${args[5]}, ${args[6]}) AS r`;
      const [second] = await db`SELECT public.consume_wallet_nonce_v1(${args[0]}, ${args[1]}::uuid, ${args[2]},
                ${args[3]}, ${args[4]}, ${args[5]}, ${args[6]}) AS r`;

      expect((first?.r as { ok: boolean }).ok).toBe(true);
      expect(second?.r).toMatchObject({ ok: false, reason: "nonce_reused" });
    } finally {
      await db.end();
    }
  });
});
