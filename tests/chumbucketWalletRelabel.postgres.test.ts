import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: the real identity migrations, then
// 20261004130000_linked_wallets_chumbucket_type.sql and
// 20261004130500_attach_wallet_chumbucket_relabel.sql. No DATABASE_URL,
// linked project or existing cluster is ever read.
// Run: VERIFY_LOCAL_PG=true [MOBILE_MIGRATIONS_DIR=…] bun test tests/chumbucketWalletRelabel.postgres.test.ts
test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "attach_verified_wallet_v1: a Chumbucket re-proof relabels its own wallet, one way only",
  () => {
    const root = mkdtempSync(join(tmpdir(), "chum-relabel-"));
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
      const migrations = process.env.MOBILE_MIGRATIONS_DIR ?? join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations");
      const apply = (file: string) => must("psql", [...args, "-f", join(migrations, file)]);

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
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT linked_wallets_wallet_type_check CHECK (wallet_type IN ('mwa', 'embedded', 'imported')));
      `);
      apply("20260913120000_auth_identity_auth_user_link.sql");
      apply("20260913121500_auth_identity_linked_wallets.sql");
      // The relabel refuses to install before the label exists.
      const early = run("psql", [...args, "-f", join(migrations, "20261004130500_attach_wallet_chumbucket_relabel.sql")]);
      expect(early.ok).toBe(false);
      expect(early.err).toContain("requires 20261004130000_linked_wallets_chumbucket_type.sql");
      apply("20261004130000_linked_wallets_chumbucket_type.sql");
      apply("20261004130500_attach_wallet_chumbucket_relabel.sql");
      apply("20261004130500_attach_wallet_chumbucket_relabel.sql"); // re-runnable

      const ANN = "11111111-1111-4111-8111-111111111111";
      const BOB = "22222222-2222-4222-8222-222222222222";
      const W = "ChumWa11et111111111111111111111111111111111";
      sql(`INSERT INTO public.users(id) VALUES ('${ANN}'), ('${BOB}');`);
      const attach = (user: string, type: string) =>
        sql(`SELECT coalesce(r->>'outcome', '') || '|' || coalesce(r->>'reason', '')
               FROM (SELECT public.attach_verified_wallet_v1('${user}', '${W}', 1::smallint, NULL, '${type}') AS r) s`);
      const label = () => sql(`SELECT wallet_type FROM public.linked_wallets WHERE wallet_address = '${W}'`);

      expect(attach(ANN, "mwa")).toBe("linked|");
      expect(label()).toBe("mwa");
      // The Chumbucket flow re-proves it: the label follows.
      expect(attach(ANN, "chumbucket")).toBe("reaffirmed|");
      expect(label()).toBe("chumbucket");
      // Another flow re-proving it never relabels a Chumbucket wallet back.
      expect(attach(ANN, "mwa")).toBe("reaffirmed|");
      expect(label()).toBe("chumbucket");
      // Another account cannot relabel (or take) it.
      expect(attach(BOB, "chumbucket")).toBe("|wallet_owned_by_another_user");
      expect(sql(`SELECT user_id FROM public.linked_wallets WHERE wallet_address = '${W}'`)).toBe(ANN);
      // Still service-role only.
      expect(sql(`SELECT has_function_privilege('authenticated', 'public.attach_verified_wallet_v1(uuid,text,smallint,uuid,text)', 'EXECUTE')`)).toBe("f");
      expect(sql(`SELECT has_function_privilege('service_role', 'public.attach_verified_wallet_v1(uuid,text,smallint,uuid,text)', 'EXECUTE')`)).toBe("t");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
