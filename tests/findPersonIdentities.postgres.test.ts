import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: Supabase Auth's auth.identities, the
// identity tables as the earlier migrations shape them, then the REAL
// 20261003200000_find_person_identities.sql — judged on every answer, on who
// may call it, and on refusing to install without its prerequisites. No
// DATABASE_URL, linked project or existing cluster is ever read.
// Run: VERIFY_LOCAL_PG=true bun test tests/findPersonIdentities.postgres.test.ts

const MIGRATION = "20261003200000_find_person_identities.sql";

function migrationsDir(): string {
  const candidates = [
    process.env.CHUMBUCKET_MOBILE_DIR && join(process.env.CHUMBUCKET_MOBILE_DIR, "supabase/migrations"),
    join(import.meta.dir, "../../mobile/supabase/migrations"),
    join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations"),
  ].filter((c): c is string => typeof c === "string");
  const found = candidates.find((c) => existsSync(join(c, MIGRATION)));
  if (!found) throw new Error(`${MIGRATION} not found in: ${candidates.join(", ")}`);
  return found;
}

// auth.users ids
const AU = {
  irfan: "a0000000-0000-4000-8000-000000000001",
  stale: "a0000000-0000-4000-8000-000000000002",
  ada: "a0000000-0000-4000-8000-000000000003",
  google: "a0000000-0000-4000-8000-000000000004",
  gone: "a0000000-0000-4000-8000-000000000005",
  holder: "a0000000-0000-4000-8000-000000000006",
  orphan: "a0000000-0000-4000-8000-000000000007",
  both: "a0000000-0000-4000-8000-000000000008",
};
// public.users ids
const U = {
  irfan: "b0000000-0000-4000-8000-000000000001",
  stale: "b0000000-0000-4000-8000-000000000002",
  ada: "b0000000-0000-4000-8000-000000000003",
  google: "b0000000-0000-4000-8000-000000000004",
  gone: "b0000000-0000-4000-8000-000000000005",
  placeholder: "b0000000-0000-4000-8000-000000000006",
  lee: "b0000000-0000-4000-8000-000000000007",
  both: "b0000000-0000-4000-8000-000000000008",
  plain: "b0000000-0000-4000-8000-000000000009",
  walletOwner: "b0000000-0000-4000-8000-00000000000a",
  linkedOwner: "b0000000-0000-4000-8000-00000000000b",
};
const W = {
  owner: "OwnerWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  placeholder: "P1aceho1derWa11etBBBBBBBBBBBBBBBBBBBBBBBBB",
  deleted: "De1etedWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  linked: "L1nkedWa11etDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  revoked: "RevokedWa11etEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
  linkedToPlaceholder: "L1nkedP1aceho1derFFFFFFFFFFFFFFFFFFFFFFFFF",
};

/** Supabase's own auth.identities, and the identity tables as earlier
 *  migrations leave them (linked_identities exactly as 20260715134226). */
const BASE = String.raw`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE TABLE auth.identities (
    provider_id text NOT NULL,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identity_data jsonb NOT NULL,
    provider text NOT NULL,
    last_sign_in_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    email text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider));

  CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text UNIQUE, email text, full_name text, handle text,
    auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE public.linked_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    wallet_address text NOT NULL UNIQUE, wallet_type text NOT NULL DEFAULT 'mwa',
    is_primary boolean NOT NULL DEFAULT false, revoked_at timestamptz);
  CREATE TABLE IF NOT EXISTS public.linked_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    provider_username TEXT,
    provider_display_name TEXT,
    provider_avatar_url TEXT,
    provider_email TEXT,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT linked_identities_provider_check CHECK (provider IN ('google', 'x', 'twitter', 'apple', 'email', 'wallet')),
    CONSTRAINT linked_identities_provider_subject_not_empty CHECK (length(trim(provider_subject)) > 0),
    UNIQUE(provider, provider_subject));
  GRANT ALL ON public.users, public.linked_wallets, public.linked_identities TO service_role;
  GRANT SELECT ON public.users TO anon, authenticated;
`;

/** The two columns later migrations add, exactly as they add them. */
const LATER_COLUMNS = String.raw`
  ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT false; -- 20261002171000
  ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;                        -- 20261002180000
`;

test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "person_x_identities_v1 / person_for_wallet_v1: real people only, X by username, service-role only",
  () => {
    const root = mkdtempSync(join(tmpdir(), "chum-find-person-"));
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
      const sql = (text: string) => must("psql", args, text);
      const last = (text: string) => sql(text).split("\n").pop() ?? "";
      const migration = join(migrationsDir(), MIGRATION);

      sql(BASE);

      // Refuses to install before the placeholder flag and deleted_at exist.
      const early = run("psql", [...args, "-f", migration]);
      expect(early.ok).toBe(false);
      expect(early.err).toContain("requires 20261002171000_lockdown_profiles_push_privacy.sql");
      sql(`ALTER TABLE public.users ADD COLUMN is_placeholder BOOLEAN NOT NULL DEFAULT false;`);
      const stillEarly = run("psql", [...args, "-f", migration]);
      expect(stillEarly.ok).toBe(false);
      expect(stillEarly.err).toContain("requires 20261002180000_trust_safety_and_account.sql");
      sql(LATER_COLUMNS);

      const pic = (n: number) => `https://pbs.twimg.com/profile_images/${n}/p_normal.jpg`;
      sql(String.raw`
        INSERT INTO auth.users VALUES ${Object.values(AU).map((id) => `('${id}')`).join(",")};
        INSERT INTO public.users(id, auth_user_id, full_name, handle, wallet_address, email, is_placeholder, deleted_at) VALUES
          ('${U.irfan}',  '${AU.irfan}',  'Irfan',      'irfan_calls', NULL, 'irfan@example.com', false, NULL),
          ('${U.stale}',  '${AU.stale}',  'Old Irfan',  'old_irfan',   NULL, NULL, false, NULL),
          ('${U.ada}',    '${AU.ada}',    'Ada',        'ada',         NULL, NULL, false, NULL),
          ('${U.google}', '${AU.google}', 'Googler',    'googler',     NULL, NULL, false, NULL),
          ('${U.gone}',   '${AU.gone}',   'Deleted account', 'deleted_b00000000000', NULL, NULL, false, now()),
          ('${U.placeholder}', '${AU.holder}', NULL, NULL, '${W.placeholder}', NULL, true, NULL),
          ('${U.lee}',    NULL,           'Lee',        'lee',         NULL, NULL, false, NULL),
          ('${U.both}',   '${AU.both}',   'Both',       'both',        NULL, NULL, false, NULL),
          ('${U.plain}',  NULL,           'Plain',      'plain',       NULL, NULL, false, NULL),
          ('${U.walletOwner}', NULL,      'Owner',      'owner',       '${W.owner}', NULL, false, NULL),
          ('${U.linkedOwner}', NULL,      'Linked',     'linked',      NULL, NULL, false, NULL);
        UPDATE public.users SET wallet_address = '${W.deleted}' WHERE id = '${U.gone}';

        INSERT INTO auth.identities(provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) VALUES
          ('x-1', '${AU.irfan}', '{"sub":"x-1","user_name":"Irfan","name":"Irfan","avatar_url":"${pic(1)}","email":"irfan@x.example"}', 'x', '2026-10-02T00:00:00Z', now(), now()),
          -- an older account whose X snapshot still says @irfan (renamed since)
          ('x-2', '${AU.stale}', '{"sub":"x-2","user_name":"irfan","avatar_url":"${pic(2)}"}', 'x', '2026-01-01T00:00:00Z', now(), now()),
          -- the OAuth 1.0a provider name, username in preferred_username only
          ('tw-3', '${AU.ada}', '{"sub":"tw-3","preferred_username":"Ada_X","picture":"${pic(3)}"}', 'twitter', NULL, '2026-05-01T00:00:00Z', NULL),
          -- a Google identity that happens to carry a user_name: never X
          ('g-4', '${AU.google}', '{"sub":"g-4","user_name":"irfan","email":"g@example.com"}', 'google', now(), now(), now()),
          ('x-5', '${AU.gone}', '{"sub":"x-5","user_name":"gone_x"}', 'x', now(), now(), now()),
          ('x-6', '${AU.holder}', '{"sub":"x-6","user_name":"holder_x"}', 'x', now(), now(), now()),
          -- an X sign-in with no Chumbucket account behind it
          ('x-7', '${AU.orphan}', '{"sub":"x-7","user_name":"orphan_x"}', 'x', now(), now(), now()),
          ('x-8', '${AU.both}', '{"sub":"x-8","user_name":"both_now"}', 'x', '2026-09-30T00:00:00Z', now(), now());

        INSERT INTO public.linked_identities(user_id, provider, provider_subject, provider_username, provider_avatar_url, provider_email, verified_at) VALUES
          ('${U.lee}',  'twitter', 'li-1', 'Legacy_Lee', '${pic(4)}', 'lee@example.com', '2026-07-20T00:00:00Z'),
          ('${U.both}', 'twitter', 'li-2', 'both_then',  NULL, NULL, '2026-07-01T00:00:00Z'),
          ('${U.plain}', 'google', 'li-3', 'plain_google', NULL, NULL, now());

        INSERT INTO public.linked_wallets(user_id, wallet_address, revoked_at) VALUES
          ('${U.linkedOwner}', '${W.linked}', NULL),
          ('${U.linkedOwner}', '${W.revoked}', now()),
          ('${U.placeholder}', '${W.linkedToPlaceholder}', NULL);
      `);

      sql(`\\i ${migration}`);
      const svc = (q: string) => last(`SET ROLE service_role; ${q}`);
      const byHandle = (h: string) =>
        svc(`SELECT coalesce(string_agg(user_id || '|' || x_username || '|' || coalesce(x_avatar_url, '-'), ';' ORDER BY seen_at DESC NULLS LAST, user_id), '<none>') FROM public.person_x_identities_v1('${h}')`);

      // Case-insensitive, most recently seen first; the stale snapshot is kept,
      // but after the account that signed in with it last.
      expect(byHandle("IRFAN")).toBe(`${U.irfan}|Irfan|${pic(1)};${U.stale}|irfan|${pic(2)}`);
      expect(byHandle("  @irfan ")).toBe(byHandle("irfan"));
      // The OAuth 1.0a provider and the preferred_username / picture fallbacks.
      expect(byHandle("ada_x")).toBe(`${U.ada}|Ada_X|${pic(3)}`);
      // An old linked identity counts.
      expect(byHandle("legacy_lee")).toBe(`${U.lee}|Legacy_Lee|${pic(4)}`);
      // Never Google, a deleted account, a placeholder, or an X sign-in with no account.
      for (const h of ["gone_x", "holder_x", "orphan_x", "plain_google"]) expect(byHandle(h), h).toBe("<none>");
      // Not a handle, both arguments, or no arguments: nothing.
      for (const h of ["", "has space", "sixteen_chars_xx", "irfan;drop"]) expect(byHandle(h), h).toBe("<none>");
      expect(svc(`SELECT count(*) FROM public.person_x_identities_v1('irfan', ARRAY['${U.irfan}']::uuid[])`)).toBe("0");
      expect(svc(`SELECT count(*) FROM public.person_x_identities_v1()`)).toBe("0");

      // By ids: each person's X account, the most recent of two; nobody without one.
      const byIds = (ids: string[]) =>
        svc(`SELECT coalesce(string_agg(user_id || '|' || x_username, ';' ORDER BY user_id), '<none>') FROM public.person_x_identities_v1(NULL, ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::uuid[])`);
      expect(byIds([U.irfan, U.both, U.plain, U.gone])).toBe(`${U.irfan}|Irfan;${U.both}|both_now`);
      expect(byIds([U.lee])).toBe(`${U.lee}|Legacy_Lee`);
      expect(svc(`SELECT count(*) FROM public.person_x_identities_v1(NULL, ARRAY[]::uuid[])`)).toBe("0");
      expect(
        svc(`SELECT count(*) FROM public.person_x_identities_v1(NULL, (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 51)) || ARRAY['${U.irfan}']::uuid[])`),
      ).toBe("0");

      // The answer has exactly four columns: no email, wallet or provider subject.
      expect(last(`SELECT pg_get_function_result('public.person_x_identities_v1(text, uuid[])'::regprocedure)`)).toBe(
        "TABLE(user_id uuid, x_username text, x_avatar_url text, seen_at timestamp with time zone)",
      );

      // Wallets: the real holder, via users then an unrevoked linked wallet.
      const wallet = (w: string) => svc(`SELECT coalesce(public.person_for_wallet_v1('${w}')::text, '<null>')`);
      expect(wallet(W.owner)).toBe(U.walletOwner);
      expect(wallet(`  ${W.owner} `)).toBe(U.walletOwner);
      expect(wallet(W.linked)).toBe(U.linkedOwner);
      for (const w of [W.placeholder, W.deleted, W.revoked, W.linkedToPlaceholder, "Unkn0wnWa11et", ""]) {
        expect(wallet(w), w).toBe("<null>");
      }
      expect(svc(`SELECT coalesce(public.person_for_wallet_v1(NULL)::text, '<null>')`)).toBe("<null>");

      // Read-only definers with a pinned search_path.
      expect(
        last(`SELECT string_agg(proname::text || ':' || provolatile::text || ':' || prosecdef::text || ':' || array_to_string(proconfig, ','), ' ' ORDER BY proname)
                FROM pg_proc WHERE proname IN ('person_x_identities_v1', 'person_for_wallet_v1')`),
      ).toBe(
        "person_for_wallet_v1:s:true:search_path=pg_catalog, public, pg_temp person_x_identities_v1:s:true:search_path=pg_catalog, public, pg_temp",
      );

      // Only the service role may call either.
      for (const role of ["anon", "authenticated"]) {
        const x = run("psql", args, `SET ROLE ${role}; SELECT * FROM public.person_x_identities_v1('irfan');`);
        expect(x.ok, role).toBe(false);
        expect(x.err).toContain("permission denied for function person_x_identities_v1");
        const w = run("psql", args, `SET ROLE ${role}; SELECT public.person_for_wallet_v1('${W.owner}');`);
        expect(w.ok, role).toBe(false);
        expect(w.err).toContain("permission denied for function person_for_wallet_v1");
      }

      // Nothing was written by any of it.
      expect(last(`SELECT count(*) FROM public.users WHERE updated_at > created_at`)).toBe("0");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
