import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: the real identity migrations, then
// 20261002090000_wallet_sign_in_and_usernames.sql, judged on every outcome.
// No DATABASE_URL, linked project or existing cluster is ever read.
// Run: VERIFY_LOCAL_PG=true bun test tests/walletSignInUsernames.postgres.test.ts
test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "wallet sign-in and usernames: claims, uniqueness, carry-over and refusals",
  () => {
    const root = mkdtempSync(join(tmpdir(), "chum-wallet-sign-in-"));
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

      const OLD = "11111111-1111-4111-8111-111111111111";
      const OLD_WALLET = "OldWa11et1111111111111111111111111111111111";
      const NEW_WALLET = "NewWa11et2222222222222222222222222222222222";
      const A1 = "a0000000-0000-4000-8000-000000000001"; // wallet sign-in, old profile
      const A2 = "a0000000-0000-4000-8000-000000000002"; // wallet sign-in, new wallet
      const A3 = "a0000000-0000-4000-8000-000000000003"; // Google sign-in
      const A4 = "a0000000-0000-4000-8000-000000000004"; // second sign-in at the old wallet
      sql(`INSERT INTO auth.users VALUES ('${A1}'),('${A2}'),('${A3}'),('${A4}');
           INSERT INTO public.users(id, wallet_address, full_name, handle)
             VALUES ('${OLD}', '${OLD_WALLET}', 'Dominion', 'dominion.sol');
           INSERT INTO public.linked_wallets(user_id, wallet_address, is_primary)
             VALUES ('${OLD}', '${OLD_WALLET}', true);`);

      apply("20261002090000_wallet_sign_in_and_usernames.sql");
      const svc = (q: string) => sql(`SET ROLE service_role; ${q}`);

      // Usernames: format, reserved, taken (case-insensitively), available.
      expect(svc(`SELECT public.handle_status_v1('ab')`)).toBe("invalid");
      expect(svc(`SELECT public.handle_status_v1('has space')`)).toBe("invalid");
      expect(svc(`SELECT public.handle_status_v1('admin')`)).toBe("reserved");
      expect(svc(`SELECT public.handle_status_v1('caller_x1')`)).toBe("reserved");
      expect(svc(`SELECT public.handle_status_v1('DOMINION.SOL')`)).toBe("invalid"); // '.' is not allowed in a new one
      expect(svc(`SELECT public.handle_status_v1('ada')`)).toBe("available");

      // A new wallet claims @ada: account, verified wallet link and audit.
      expect(svc(`SELECT public.create_social_person_v2('${A2}', 'Ada', 'Ada', '${NEW_WALLET}')->>'outcome'`)).toBe("created");
      expect(sql(`SELECT handle || '|' || wallet_address FROM public.users WHERE auth_user_id = '${A2}'`)).toBe(`ada|${NEW_WALLET}`);
      expect(sql(`SELECT siws_proof_version || '|' || (verified_at IS NOT NULL) FROM public.linked_wallets WHERE wallet_address = '${NEW_WALLET}'`)).toBe("1|true");
      expect(sql(`SELECT count(*) FROM public.wallet_link_audit WHERE wallet_address = '${NEW_WALLET}' AND action = 'linked'`)).toBe("1");
      // The same sign-in again is the same account, not a second one.
      expect(svc(`SELECT public.create_social_person_v2('${A2}', 'Ada', 'other_name', NULL)->>'outcome'`)).toBe("existing");

      // Google claims a taken username (any case) and is refused; then a free one.
      expect(svc(`SELECT public.create_social_person_v2('${A3}', 'Someone', 'ADA', NULL)->>'reason'`)).toBe("handle_taken");
      expect(svc(`SELECT public.create_social_person_v2('${A3}', 'Someone', 'someone_1', NULL)->>'outcome'`)).toBe("created");
      expect(sql(`SELECT wallet_address IS NULL FROM public.users WHERE auth_user_id = '${A3}'`)).toBe("t");

      // A wallet that already has an account never gets a second one.
      expect(svc(`SELECT public.create_social_person_v2('${A1}', 'Dup', 'dup_name', '${OLD_WALLET}')->>'reason'`)).toBe("wallet_has_profile");

      // Carry-over: the old account is bound to the wallet sign-in, history intact.
      expect(svc(`SELECT public.bind_wallet_session_v1('${A1}', '${OLD_WALLET}')->>'outcome'`)).toBe("carried");
      expect(sql(`SELECT id || '|' || full_name || '|' || handle FROM public.users WHERE auth_user_id = '${A1}'`)).toBe(`${OLD}|Dominion|dominion.sol`);
      expect(sql(`SELECT siws_proof_version || '|' || (verified_at IS NOT NULL) FROM public.linked_wallets WHERE wallet_address = '${OLD_WALLET}'`)).toBe("1|true");
      expect(svc(`SELECT public.bind_wallet_session_v1('${A1}', '${OLD_WALLET}')->>'outcome'`)).toBe("existing");
      // A different sign-in at the same wallet cannot take it over.
      expect(svc(`SELECT public.bind_wallet_session_v1('${A4}', '${OLD_WALLET}')->>'reason'`)).toBe("owned");
      // A wallet with no account has nothing to carry.
      expect(svc(`SELECT public.bind_wallet_session_v1('${A4}', 'NoAccount333333333333333333333333333333333')->>'reason'`)).toBe("no_profile");

      // Only the service role may call any of it.
      for (const role of ["anon", "authenticated"]) {
        const r = run("psql", args, `SET ROLE ${role}; SELECT public.handle_status_v1('ada');`);
        expect(r.ok).toBe(false);
        expect(r.err).toContain("permission denied");
      }
      // And the unique index holds even for a direct write.
      const dup = run("psql", args, `UPDATE public.users SET handle = 'ADA' WHERE id = '${OLD}';`);
      expect(dup.ok).toBe(false);
      expect(dup.err).toContain("uq_users_handle_lower");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
