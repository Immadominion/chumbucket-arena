import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15. No DATABASE_URL, linked project or existing
// cluster is ever read. Run: VERIFY_LOCAL_PG=true bun test tests/canonicalFollows.postgres.test.ts
test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")("canonical follows RLS isolates two people and preserves legacy schema", () => {
  const root = mkdtempSync(join(tmpdir(), "chum-person-follows-"));
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
    run("psql", args, String.raw`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.users(id uuid PRIMARY KEY);
      INSERT INTO public.users VALUES
        ('11111111-1111-4111-8111-111111111111'),
        ('22222222-2222-4222-8222-222222222222'),
        ('33333333-3333-4333-8333-333333333333');
      CREATE FUNCTION public.current_app_user_id() RETURNS uuid
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $$ SELECT nullif(current_setting('app.test_user_id', true), '')::uuid $$;
      REVOKE ALL ON FUNCTION public.current_app_user_id() FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO authenticated, service_role;
      CREATE TABLE public.calls(id uuid PRIMARY KEY, user_id uuid REFERENCES public.users(id),
        visibility text NOT NULL, hidden_at timestamptz);
      ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.calls TO anon, authenticated;
      CREATE POLICY calls_public_select ON public.calls FOR SELECT TO anon, authenticated
        USING (hidden_at IS NULL AND visibility = 'public');
      CREATE TABLE public.follows(network text NOT NULL, follower_wallet text NOT NULL,
        followee_wallet text NOT NULL, follower_user_id uuid, followee_user_id uuid,
        PRIMARY KEY(network,follower_wallet,followee_wallet));
      INSERT INTO public.follows VALUES('devnet','legacy-a','legacy-b',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
      INSERT INTO public.calls VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','followers',NULL),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','33333333-3333-4333-8333-333333333333','followers',NULL),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','33333333-3333-4333-8333-333333333333','public',NULL);
    `);
    const migration = join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations/20260929220000_canonical_person_follows.sql");
    run("psql", [...args, "-f", migration]);
    const checked = run("psql", args, String.raw`
      SELECT NOT has_table_privilege('anon','public.person_follows','SELECT');
      SELECT NOT has_table_privilege('authenticated','public.person_follows','INSERT');
      SELECT NOT has_table_privilege('authenticated','public.person_follows','DELETE');
      SELECT has_table_privilege('authenticated','public.person_follows','SELECT');
      SELECT has_table_privilege('service_role','public.person_follows','INSERT');
      SELECT count(*)=0 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='person_follows' AND column_name LIKE '%wallet%';
      SELECT count(*)=1 FROM public.follows;
      SELECT is_nullable='NO' FROM information_schema.columns
        WHERE table_schema='public' AND table_name='follows' AND column_name='follower_wallet';
      SET ROLE anon;
      SELECT count(*)=1 FROM public.calls;
      RESET ROLE;
      SET ROLE authenticated;
      SET app.test_user_id='11111111-1111-4111-8111-111111111111';
      SELECT count(*)=1 FROM public.calls;
      RESET ROLE;
      SET ROLE service_role;
      INSERT INTO public.person_follows(follower_user_id,followee_user_id)
        VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
      RESET ROLE;
      SET ROLE authenticated;
      SET app.test_user_id='11111111-1111-4111-8111-111111111111';
      SELECT count(*)=2 FROM public.calls;
      SELECT count(*)=1 FROM public.person_follows;
      SET app.test_user_id='33333333-3333-4333-8333-333333333333';
      SELECT count(*)=1 FROM public.calls;
      SELECT count(*)=0 FROM public.person_follows;
      RESET ROLE;
      DO $$ BEGIN
        BEGIN
          INSERT INTO public.person_follows VALUES
            ('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',now());
          RAISE EXCEPTION 'accepted self follow';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $$;
      SELECT count(*)=1 FROM public.person_follows;
      SET ROLE service_role;
      DELETE FROM public.person_follows WHERE follower_user_id='11111111-1111-4111-8111-111111111111';
      RESET ROLE;
      SET ROLE authenticated;
      SET app.test_user_id='11111111-1111-4111-8111-111111111111';
      SELECT count(*)=1 FROM public.calls;
      RESET ROLE;
    `);
    const booleans = checked.split("\n").filter(x => x === "t" || x === "f");
    expect(booleans).toHaveLength(16);
    expect(booleans.every(x => x === "t")).toBe(true);
  } finally {
    if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
