import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Opt-in, local throwaway cluster ONLY. Never consumes DATABASE_URL or reads a
// production credential. Run: VERIFY_LOCAL_PG=true bun test tests/socialProfilePostgres.test.ts
test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")("profile RPC privileges, two users, replay and legacy preservation on PostgreSQL", () => {
  const root = mkdtempSync(join(tmpdir(), "chum-profile-test-"));
  const bin = process.env.POSTGRES_BIN_DIR ?? "/opt/homebrew/opt/postgresql@15/bin";
  const data = join(root, "isolated-db");
  function run(exe: string, args: string[], input?: string) {
    const r = spawnSync(join(bin, exe), args, { encoding: "utf8", input, timeout: 30000 });
    if (r.status !== 0) throw new Error(`${exe} failed: ${r.stderr}`);
    return r.stdout.trim();
  }
  let started = false;
  try {
    run("initdb", ["-D", data, "-U", "test_admin", "-A", "trust", "--no-locale"]);
    run("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-o", `-k ${root} -p 55449 -c listen_addresses=''`, "-w", "start"]);
    started = true;
    const args = ["-h", root, "-p", "55449", "-U", "test_admin", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-At"];
    run("psql", args, `
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE public.users(id uuid PRIMARY KEY, auth_user_id uuid UNIQUE REFERENCES auth.users(id),
        full_name text, handle text UNIQUE, wallet_address text UNIQUE);
      INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
      INSERT INTO public.users VALUES ('33333333-3333-4333-8333-333333333333', NULL, 'Legacy caller', 'legacy', 'legacy-wallet');
    `);
    const migration = join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations/20260928100000_social_person_onboarding.sql");
    run("psql", [...args, "-f", migration]);
    const checked = run("psql", args, String.raw`
      SELECT NOT has_function_privilege('anon', 'public.create_social_person_v1(uuid,text)', 'EXECUTE');
      SELECT NOT has_function_privilege('authenticated', 'public.create_social_person_v1(uuid,text)', 'EXECUTE');
      SELECT has_function_privilege('service_role', 'public.create_social_person_v1(uuid,text)', 'EXECUTE');
      SELECT proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'] FROM pg_proc WHERE proname='create_social_person_v1';
      SET ROLE service_role;
      SELECT public.create_social_person_v1('11111111-1111-4111-8111-111111111111','Alice') AS alice_id \gset
      SELECT public.create_social_person_v1('11111111-1111-4111-8111-111111111111','Overwrite') = :'alice_id'::uuid;
      SELECT public.create_social_person_v1('22222222-2222-4222-8222-222222222222','Bob') <> :'alice_id'::uuid;
      RESET ROLE;
      SELECT count(*)=3 FROM public.users;
      SELECT full_name='Alice' AND wallet_address IS NULL AND id<>auth_user_id FROM public.users WHERE id=:'alice_id'::uuid;
      SELECT auth_user_id IS NULL AND full_name='Legacy caller' AND wallet_address='legacy-wallet' FROM public.users WHERE handle='legacy';
      DO $$ BEGIN
        BEGIN PERFORM public.create_social_person_v1(NULL,'Nobody'); RAISE EXCEPTION 'accepted null'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        BEGIN PERFORM public.create_social_person_v1('44444444-4444-4444-8444-444444444444','Unknown'); RAISE EXCEPTION 'accepted unknown'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        BEGIN PERFORM public.create_social_person_v1('11111111-1111-4111-8111-111111111111',' '); RAISE EXCEPTION 'accepted blank'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        BEGIN PERFORM public.create_social_person_v1('11111111-1111-4111-8111-111111111111',repeat('x',61)); RAISE EXCEPTION 'accepted long'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
      END $$;
    `);
    expect(checked.split("\n").filter(x => x === "t")).toHaveLength(9);
    expect(checked.split("\n")).not.toContain("f");
  } finally {
    if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
    // Only the unique scratch directory created by this test, after shutdown.
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
