import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: applies 20261002130000_call_thesis_updates.sql
// to a stub schema and proves the guard, the grants and the inherited RLS on a
// real database. No DATABASE_URL, linked project or existing cluster is read.
// Run: VERIFY_LOCAL_PG=true bun test tests/thesisUpdates.postgres.test.ts

const MIGRATION_NAME = "20261002130000_call_thesis_updates.sql";
const migrationPath = (): string => {
  // The migrations live in the mobile checkout, a sibling of this one. Fleet
  // worktrees name it differently, so accept either layout.
  for (const sibling of ["chumbucket-social-calls", "mobile"]) {
    const candidate = join(import.meta.dir, "..", "..", sibling, "supabase", "migrations", MIGRATION_NAME);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${MIGRATION_NAME} not found next to this checkout`);
};

test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "thesis updates: author-only, append-only, capped, and exactly as visible as the call",
  () => {
    const root = mkdtempSync(join(tmpdir(), "chum-thesis-updates-"));
    const data = join(root, "isolated-db");
    const bin = process.env.POSTGRES_BIN_DIR ?? "/opt/homebrew/opt/postgresql@15/bin";
    const port = String(randomInt(54000, 59000));
    function run(exe: string, args: string[], input?: string): string {
      const r = spawnSync(join(bin, exe), args, { encoding: "utf8", input, timeout: 30_000 });
      if (r.status !== 0) throw new Error(`${exe} failed: ${r.stderr}`);
      return r.stdout.trim();
    }
    let started = false;
    try {
      run("initdb", ["-D", data, "-U", "test_admin", "-A", "trust", "--no-locale"]);
      run("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-o", `-k ${root} -p ${port} -c listen_addresses=''`, "-w", "start"]);
      started = true;
      const args = ["-h", root, "-p", port, "-U", "test_admin", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-At"];
      // A stub of exactly what the migration depends on: users, and calls with
      // its public/author read policies.
      run("psql", args, String.raw`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE TABLE public.users(id uuid PRIMARY KEY);
        INSERT INTO public.users VALUES
          ('11111111-1111-4111-8111-111111111111'),
          ('22222222-2222-4222-8222-222222222222');
        CREATE FUNCTION public.current_app_user_id() RETURNS uuid
          LANGUAGE sql STABLE SECURITY DEFINER
          SET search_path = pg_catalog, public, pg_temp
          AS $$ SELECT nullif(current_setting('app.test_user_id', true), '')::uuid $$;
        GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO anon, authenticated, service_role;
        CREATE TABLE public.calls(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.users(id),
          visibility text NOT NULL, locked_at timestamptz NOT NULL, hidden_at timestamptz);
        ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
        GRANT SELECT ON public.calls TO anon, authenticated;
        GRANT ALL ON public.calls TO service_role;
        CREATE POLICY calls_public_select ON public.calls FOR SELECT TO anon, authenticated
          USING (hidden_at IS NULL AND visibility = 'public');
        CREATE POLICY calls_author_select ON public.calls FOR SELECT TO authenticated
          USING (user_id = public.current_app_user_id());
        INSERT INTO public.calls VALUES
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','public',  now() - interval '1 hour', NULL),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','followers',now() - interval '1 hour', NULL),
          ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','public',  now() - interval '1 hour', now());
      `);
      run("psql", [...args, "-f", migrationPath()]);

      // Each statement prints one boolean; every one must be true.
      const checked = run("psql", args, String.raw`
        SELECT NOT has_table_privilege('anon','public.call_thesis_updates','INSERT');
        SELECT NOT has_table_privilege('authenticated','public.call_thesis_updates','INSERT');
        SELECT NOT has_table_privilege('authenticated','public.call_thesis_updates','UPDATE');
        SELECT NOT has_table_privilege('authenticated','public.call_thesis_updates','DELETE');
        SELECT has_table_privilege('anon','public.call_thesis_updates','SELECT');
        SELECT has_table_privilege('service_role','public.call_thesis_updates','INSERT');

        SET ROLE service_role;
        INSERT INTO public.call_thesis_updates(call_id, author_user_id, body) VALUES
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','  public update  '),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','followers update');
        RESET ROLE;
        SELECT body = 'public update' FROM public.call_thesis_updates
          WHERE call_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

        -- anon sees the public call's thread only
        SET ROLE anon;
        SELECT count(*) = 1 FROM public.call_thesis_updates;
        RESET ROLE;
        -- the author sees both
        SET ROLE authenticated;
        SET app.test_user_id = '11111111-1111-4111-8111-111111111111';
        SELECT count(*) = 2 FROM public.call_thesis_updates;
        -- a stranger sees the public one only
        SET app.test_user_id = '22222222-2222-4222-8222-222222222222';
        SELECT count(*) = 1 FROM public.call_thesis_updates;
        RESET ROLE;

        -- the guard, for the role RLS does not bind
        DO $$ BEGIN
          BEGIN
            INSERT INTO public.call_thesis_updates(call_id, author_user_id, body)
              VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','not mine');
            RAISE EXCEPTION 'accepted a non-author update';
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM LIKE 'accepted%' THEN RAISE; END IF;
          END;
          BEGIN
            INSERT INTO public.call_thesis_updates(call_id, author_user_id, body)
              VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','after withdrawing');
            RAISE EXCEPTION 'accepted an update on a withdrawn call';
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM LIKE 'accepted%' THEN RAISE; END IF;
          END;
          BEGIN
            INSERT INTO public.call_thesis_updates(call_id, author_user_id, body, created_at)
              VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','backdated', now() - interval '1 day');
            RAISE EXCEPTION 'accepted an update dated before the lock';
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM LIKE 'accepted%' THEN RAISE; END IF;
          END;
          BEGIN
            INSERT INTO public.call_thesis_updates(call_id, author_user_id, body)
              VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','   ');
            RAISE EXCEPTION 'accepted an empty update';
          EXCEPTION WHEN check_violation THEN NULL;
          END;
          BEGIN
            UPDATE public.call_thesis_updates SET body = 'rewritten';
            RAISE EXCEPTION 'accepted an edit';
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM LIKE 'accepted%' THEN RAISE; END IF;
          END;
          BEGIN
            DELETE FROM public.call_thesis_updates;
            RAISE EXCEPTION 'accepted a delete';
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM LIKE 'accepted%' THEN RAISE; END IF;
          END;
        END $$;
        SELECT count(*) = 2 FROM public.call_thesis_updates;

        -- the cap: 19 more on the public call reaches 20, the 21st is refused
        INSERT INTO public.call_thesis_updates(call_id, author_user_id, body)
          SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','update ' || g
          FROM generate_series(1, 19) g;
        DO $$ BEGIN
          BEGIN
            INSERT INTO public.call_thesis_updates(call_id, author_user_id, body)
              VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','one too many');
            RAISE EXCEPTION 'accepted a 21st update';
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM LIKE 'accepted%' THEN RAISE; END IF;
          END;
        END $$;
        SELECT count(*) = 20 FROM public.call_thesis_updates
          WHERE call_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      `);
      const booleans = checked.split("\n").filter((x) => x === "t" || x === "f");
      expect(booleans).toHaveLength(12);
      expect(booleans.every((x) => x === "t")).toBe(true);
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
