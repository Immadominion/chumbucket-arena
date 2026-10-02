import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: the real identity migrations, then
// 20261002090000_wallet_sign_in_and_usernames.sql and
// 20261002150000_claim_own_handle.sql, judged on every outcome. No
// DATABASE_URL, linked project or existing cluster is ever read.
// Run: VERIFY_LOCAL_PG=true bun test tests/claimOwnHandle.postgres.test.ts
test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "claim_own_handle_v1: own account only, only while NULL, unique, service-role only",
  () => {
    const root = mkdtempSync(join(tmpdir(), "chum-claim-handle-"));
    const data = join(root, "isolated-db");
    const bin = process.env.POSTGRES_BIN_DIR ?? "/opt/homebrew/opt/postgresql@15/bin";
    const port = String(randomInt(54000, 59000));
    const run = (exe: string, args: string[], input?: string) => {
      const r = spawnSync(join(bin, exe), args, { encoding: "utf8", input, timeout: 30_000 });
      return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: r.stderr ?? "" };
    };
    const must = (exe: string, args: string[], input?: string): string => {
      const r = run(exe, args, input);
      if (!r.ok) throw new Error(`${exe} failed: ${r.err}`);
      return r.out;
    };
    let started = false;
    try {
      must("initdb", ["-D", data, "-U", "test_admin", "-A", "trust", "--no-locale"]);
      must("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-o", `-k ${root} -p ${port} -c listen_addresses=''`, "-w", "start"]);
      started = true;
      const args = ["-h", root, "-p", port, "-U", "test_admin", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-At"];
      const sql = (text: string) => must("psql", args, text).split("\n").pop() ?? "";
      const migrations = join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations");
      const apply = (file: string) => must("psql", [...args, "-f", join(migrations, file)]);

      // The pre-pivot shape the identity migrations were written against.
      sql(String.raw`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
        CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet_address text UNIQUE, privy_id text UNIQUE, email text, full_name text, bio text,
          handle text, sns_domain text, profile_image_id integer,
          created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
        CREATE TABLE public.linked_wallets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          wallet_address TEXT NOT NULL UNIQUE,
          wallet_type TEXT NOT NULL DEFAULT 'mwa',
          is_primary BOOLEAN NOT NULL DEFAULT false,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_signed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      `);
      apply("20260913120000_auth_identity_auth_user_link.sql");
      apply("20260913121500_auth_identity_linked_wallets.sql");
      apply("20260928100000_social_person_onboarding.sql");

      // The function refuses to install without its prerequisites.
      const early = run("psql", [...args, "-f", join(migrations, "20261002150000_claim_own_handle.sql")]);
      expect(early.ok).toBe(false);
      expect(early.err).toContain("requires 20261002090000_wallet_sign_in_and_usernames.sql");

      const CARRIED = "11111111-1111-4111-8111-111111111111"; // old wallet profile, handle NULL
      const NAMED = "22222222-2222-4222-8222-222222222222"; // already has a handle
      const OTHER = "33333333-3333-4333-8333-333333333333"; // another handle-less account
      const UNLINKED = "44444444-4444-4444-8444-444444444444"; // no sign-in reaches it
      const A1 = "a0000000-0000-4000-8000-000000000001";
      const A2 = "a0000000-0000-4000-8000-000000000002";
      const A3 = "a0000000-0000-4000-8000-000000000003";
      const A4 = "a0000000-0000-4000-8000-000000000004"; // a sign-in with no account
      sql(`INSERT INTO auth.users VALUES ('${A1}'),('${A2}'),('${A3}'),('${A4}');
           INSERT INTO public.users(id, auth_user_id, wallet_address, full_name, handle) VALUES
             ('${CARRIED}', '${A1}', 'OldWa11et1111111111111111111111111111111111', 'Dominion', NULL),
             ('${NAMED}',   '${A2}', NULL, 'Named', 'Named_One'),
             ('${OTHER}',   '${A3}', NULL, 'Other', NULL),
             ('${UNLINKED}', NULL,   NULL, 'Nobody', NULL);`);

      apply("20261002090000_wallet_sign_in_and_usernames.sql");
      // Production's column lock: clients can no longer write handle at all,
      // so the definer function must be the one door that still can.
      apply("20261002120000_lock_profile_identity_columns.sql");
      apply("20261002150000_claim_own_handle.sql");
      const svc = (q: string) => sql(`SET ROLE service_role; ${q}`);
      const claim = (auth: string, handle: string) =>
        svc(`SELECT public.claim_own_handle_v1('${auth}', '${handle}')::text`);
      const handleOf = (id: string) => sql(`SELECT coalesce(handle, '<null>') FROM public.users WHERE id = '${id}'`);

      // Refusals by handle_status_v1's rules write nothing.
      expect(claim(A1, "ab")).toContain(`"reason": "handle_invalid"`);
      expect(claim(A1, "has space")).toContain(`"reason": "handle_invalid"`);
      expect(claim(A1, "admin")).toContain(`"reason": "handle_reserved"`);
      expect(claim(A1, "caller_x1")).toContain(`"reason": "handle_reserved"`);
      expect(claim(A1, "NAMED_ONE")).toContain(`"reason": "handle_taken"`); // case-insensitively
      expect(handleOf(CARRIED)).toBe("<null>");

      // The carried-over profile claims its first handle, stored lowercase.
      const won = claim(A1, "  Dominion ");
      expect(won).toContain(`"outcome": "claimed"`);
      expect(won).toContain(`"user_id": "${CARRIED}"`);
      expect(handleOf(CARRIED)).toBe("dominion");
      expect(svc(`SELECT public.handle_status_v1('DOMINION')`)).toBe("taken");

      // Same handle again: a no-op. Any other: never a rename.
      expect(claim(A1, "DOMINION")).toContain(`"outcome": "unchanged"`);
      expect(claim(A1, "someone_else")).toContain(`"reason": "handle_already_set"`);
      expect(claim(A2, "fresh_name")).toContain(`"reason": "handle_already_set"`);
      expect(handleOf(NAMED)).toBe("Named_One");

      // Another account cannot take a claimed handle.
      expect(claim(A3, "dominion")).toContain(`"reason": "handle_taken"`);
      expect(handleOf(OTHER)).toBe("<null>");

      // A sign-in with no account, or no subject, reaches nothing.
      expect(claim(A4, "squatter")).toContain(`"reason": "unknown_user"`);
      expect(svc(`SELECT public.claim_own_handle_v1(NULL, 'squatter')::text`)).toContain(`"reason": "unknown_user"`);
      expect(handleOf(UNLINKED)).toBe("<null>");

      // The unique index is the last word on a lost race: a direct write that
      // got there first turns the function's write into "taken", not a duplicate.
      sql(`UPDATE public.users SET handle = 'raced' WHERE id = '${UNLINKED}'`);
      sql(String.raw`CREATE FUNCTION public.handle_status_v1_race(p TEXT) RETURNS TEXT LANGUAGE sql AS $$ SELECT 'available'::text $$;`);
      // Simulate a stale availability answer: swap the status check for one
      // that says "available", as a concurrent transaction would have seen it.
      sql(String.raw`ALTER FUNCTION public.handle_status_v1(TEXT) RENAME TO handle_status_v1_real;
                     ALTER FUNCTION public.handle_status_v1_race(TEXT) RENAME TO handle_status_v1;`);
      expect(claim(A3, "raced")).toContain(`"reason": "handle_taken"`);
      expect(handleOf(OTHER)).toBe("<null>");
      sql(String.raw`ALTER FUNCTION public.handle_status_v1(TEXT) RENAME TO handle_status_v1_race;
                     ALTER FUNCTION public.handle_status_v1_real(TEXT) RENAME TO handle_status_v1;`);
      expect(claim(A3, "other_one")).toContain(`"outcome": "claimed"`);
      expect(handleOf(OTHER)).toBe("other_one");

      // Only the service role may call it, and a client still cannot write a
      // handle directly around it.
      for (const role of ["anon", "authenticated"]) {
        const r = run("psql", args, `SET ROLE ${role}; SELECT public.claim_own_handle_v1('${A3}', 'x_y_z');`);
        expect(r.ok).toBe(false);
        expect(r.err).toContain("permission denied");
        const direct = run("psql", args, `SET ROLE ${role}; UPDATE public.users SET handle = 'x_y_z' WHERE id = '${CARRIED}';`);
        expect(direct.ok).toBe(false);
        expect(direct.err).toContain("permission denied");
      }
      expect(handleOf(CARRIED)).toBe("dominion");
      expect(sql(`SELECT prosecdef FROM pg_proc WHERE proname = 'claim_own_handle_v1'`)).toBe("t");
      expect(sql(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE proname = 'claim_own_handle_v1'`)).toContain(
        "search_path=pg_catalog, public, pg_temp",
      );
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
