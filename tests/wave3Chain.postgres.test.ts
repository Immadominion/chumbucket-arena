import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: the WHOLE migration chain together.
//
// Each package proved its own migration on its own reduced schema. This proves
// them as production will run them: a database with the LIVE legacy rights
// (mobile docs/schema/legacy-rights-2026-10-02.sql, in the shape it had before
// the identity pivot), then every migration in the mobile repo from
// 20260913120000 on, in version order — identity, venue catalog, social calls,
// notifications, onboarding, existing-account claims, Panta prices and trades,
// person follows, then 20261002090000 -> 120000 -> 130000 -> 140000 -> 150000
// (already applied in production) -> 170000 -> 171000 -> 180000 and anything
// added after. The list is read from the directory, so a new migration is
// included without editing this file.
//
// Then the seams between packages:
//   * versions are unique, so no migration can shadow another;
//   * lockdown's revocations survive trust's migration, and every new table is
//     service-role only;
//   * delete_account_v1 (trust) removes the person's push_tokens (lockdown) as
//     well as the legacy fcm_tokens, friends (with lockdown's nickname),
//     follows, blocks and mutes, and leaves other people's rows alone;
//   * an old build's wallet connect (lockdown's neutered sync_user_by_wallet)
//     and lockdown's carry-over (bind_wallet_session_v1) never reach the
//     deleted row, and update_own_profile_v1 refuses it.
// Run: VERIFY_LOCAL_PG=true bun test tests/wave3Chain.postgres.test.ts
//      (CHUMBUCKET_MOBILE_DIR=/path/to/chumbucket-social-calls if it is not a sibling)

function migrationsDir(): string {
  const candidates = [
    process.env.CHUMBUCKET_MOBILE_DIR && join(process.env.CHUMBUCKET_MOBILE_DIR, "supabase/migrations"),
    join(import.meta.dir, "../../mobile/supabase/migrations"),
    join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations"),
  ].filter((c): c is string => typeof c === "string");
  const found = candidates.find((c) => existsSync(join(c, "20261002180000_trust_safety_and_account.sql")));
  if (!found) throw new Error(`mobile migrations not found in: ${candidates.join(", ")}`);
  return found;
}

/** Already applied in production (do not edit; additive migrations only). */
const APPLIED_IN_PRODUCTION_THROUGH = "20261002150000";
const WAVE_CHAIN = [
  "20261002090000_wallet_sign_in_and_usernames.sql",
  "20261002120000_lock_profile_identity_columns.sql",
  "20261002130000_call_thesis_updates.sql",
  "20261002140000_market_proposals.sql",
  "20261002150000_claim_own_handle.sql",
  "20261002170000_panta_claim_sessions.sql",
  "20261002171000_lockdown_profiles_push_privacy.sql",
  "20261002180000_trust_safety_and_account.sql",
];

/** The live legacy rights, before the identity pivot's own migrations ran. */
const LIVE_LEGACY_PRE_PIVOT = String.raw`
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  -- Supabase Auth's own table (every project has it): who signed in with
  -- which provider. 20261003200000_find_person_identities reads it.
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
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT SELECT ON auth.users TO service_role;

  CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text UNIQUE, privy_id text UNIQUE, email text, full_name text, bio text,
    handle text, sns_domain text, profile_image_id integer DEFAULT 1, profile_picture text,
    last_seen_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE public.linked_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    wallet_address text NOT NULL UNIQUE, wallet_type text NOT NULL DEFAULT 'mwa',
    is_primary boolean NOT NULL DEFAULT false, first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_signed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now());
  -- As 20260715134226 created it (its first and only CREATE; link_identity
  -- and the pending-target functions write every one of these columns).
  CREATE TABLE public.linked_identities(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider text NOT NULL, provider_subject text NOT NULL, provider_username text,
    provider_display_name text, provider_avatar_url text, provider_email text,
    verified_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(provider, provider_subject));
  CREATE TABLE public.friends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    friend_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'accepted', created_at timestamptz DEFAULT now(),
    UNIQUE(user_id, friend_id), CONSTRAINT no_self_friendship CHECK (user_id <> friend_id));
  CREATE TABLE public.fcm_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text UNIQUE, fcm_token text, platform text, user_display_name text,
    network text DEFAULT 'devnet', updated_at timestamptz DEFAULT now());
  -- 20260715230000_social_graph_feeds.sql (applied long before the pivot).
  CREATE TABLE public.follows(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    network text NOT NULL DEFAULT 'devnet', follower_wallet text NOT NULL, followee_wallet text NOT NULL,
    follower_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    followee_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (network, follower_wallet, followee_wallet));

  ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.linked_wallets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
  CREATE POLICY users_insert ON public.users FOR INSERT WITH CHECK (true);
  CREATE POLICY users_select ON public.users FOR SELECT USING (true);
  CREATE POLICY users_update ON public.users FOR UPDATE USING (true);
  CREATE POLICY linked_wallets_public_select ON public.linked_wallets FOR SELECT USING (true);
  CREATE POLICY friends_all ON public.friends FOR ALL USING (true) WITH CHECK (true);
  CREATE POLICY fcm_tokens_all ON public.fcm_tokens FOR ALL USING (true) WITH CHECK (true);
  CREATE POLICY follows_public_select ON public.follows FOR SELECT USING (true);

  GRANT SELECT (id, wallet_address, privy_id, full_name, bio, profile_picture,
    profile_image_id, created_at, updated_at, sns_domain, handle, last_seen_at)
    ON public.users TO anon, authenticated;
  GRANT INSERT (bio,created_at,email,full_name,handle,id,last_seen_at,privy_id,profile_image_id,profile_picture,sns_domain,updated_at,wallet_address),
        UPDATE (bio,created_at,email,full_name,handle,id,last_seen_at,privy_id,profile_image_id,profile_picture,sns_domain,updated_at,wallet_address)
    ON public.users TO anon, authenticated;
  GRANT DELETE, TRUNCATE ON public.users TO anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.linked_wallets TO anon, authenticated;
  GRANT ALL ON public.friends, public.fcm_tokens TO anon, authenticated;
  GRANT SELECT ON public.follows TO anon, authenticated;
  GRANT ALL ON public.users, public.linked_wallets, public.linked_identities, public.friends,
    public.fcm_tokens, public.follows TO service_role;

  CREATE FUNCTION public.update_user_profile(p_privy_id text, p_full_name text, p_bio text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    UPDATE public.users SET full_name = p_full_name, bio = p_bio, updated_at = now()
     WHERE privy_id = p_privy_id OR wallet_address = p_privy_id; END; $$;
  CREATE FUNCTION public.update_user_profile_with_pfp(p_privy_id text, p_full_name text, p_bio text, p_pfp_path text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    UPDATE public.users SET full_name = p_full_name, bio = p_bio, profile_picture = p_pfp_path, updated_at = now()
     WHERE privy_id = p_privy_id OR wallet_address = p_privy_id; END; $$;
  CREATE FUNCTION public.fetch_user_profile(p_privy_id text)
    RETURNS TABLE(id uuid, wallet_address text, full_name text, bio text, profile_image_id integer)
    LANGUAGE sql SECURITY DEFINER AS $$
    SELECT u.id, u.wallet_address, u.full_name, u.bio, u.profile_image_id FROM public.users u
     WHERE u.privy_id = p_privy_id OR u.wallet_address = p_privy_id $$;
  -- 20260715134226's body, as live.
  CREATE FUNCTION public.sync_user_by_wallet(p_wallet_address text, p_sns_domain text DEFAULT NULL)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE v_user_id uuid; BEGIN
    SELECT id INTO v_user_id FROM public.users WHERE wallet_address = trim(p_wallet_address);
    IF v_user_id IS NULL THEN
      INSERT INTO public.users(wallet_address, sns_domain, full_name, handle, created_at, updated_at, last_seen_at)
      VALUES (trim(p_wallet_address), nullif(trim(coalesce(p_sns_domain,'')),''),
              nullif(trim(coalesce(p_sns_domain,'')),''), nullif(trim(coalesce(p_sns_domain,'')),''), now(), now(), now())
      RETURNING id INTO v_user_id;
    END IF;
    INSERT INTO public.linked_wallets(user_id, wallet_address, wallet_type, is_primary, first_seen_at, last_signed_at)
    VALUES (v_user_id, trim(p_wallet_address), 'mwa', true, now(), now())
    ON CONFLICT (wallet_address) DO UPDATE SET user_id = EXCLUDED.user_id, last_signed_at = now();
    RETURN v_user_id; END; $$;
  GRANT EXECUTE ON FUNCTION public.update_user_profile(text,text,text),
    public.update_user_profile_with_pfp(text,text,text,text), public.fetch_user_profile(text),
    public.sync_user_by_wallet(text,text) TO anon, authenticated;
`;

test("migration versions are unique and the wave-3 chain sorts in the order it must apply", () => {
  const files = readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  const versions = files.map((f) => f.slice(0, 14));
  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  expect(dupes).toEqual([]);
  const wave = files.filter((f) => f >= WAVE_CHAIN[0]!);
  expect(wave.slice(0, WAVE_CHAIN.length)).toEqual(WAVE_CHAIN);
  // Lockdown's migration (moved off 170000) sorts after money's and before trust's.
  expect(files.indexOf("20261002171000_lockdown_profiles_push_privacy.sql")).toBe(
    files.indexOf("20261002170000_panta_claim_sessions.sql") + 1,
  );
  expect(WAVE_CHAIN.filter((f) => f.slice(0, 14) <= APPLIED_IN_PRODUCTION_THROUGH)).toHaveLength(5);
});

test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "the whole chain applies on the live legacy rights, and trust's deletion reaches lockdown's push tokens",
  () => {
    const dir = migrationsDir();
    const root = mkdtempSync(join(tmpdir(), "chum-wave3-"));
    const data = join(root, "isolated-db");
    const bin = process.env.POSTGRES_BIN_DIR ?? "/opt/homebrew/opt/postgresql@15/bin";
    const port = String(randomInt(54000, 59000));
    const run = (exe: string, args: string[], input?: string) => {
      const r = spawnSync(join(bin, exe), args, { encoding: "utf8", input, timeout: 60_000 });
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
      const svc = (text: string) => sql(`SET ROLE service_role; ${text}`);
      const as = (role: string, text: string) => run("psql", args, `SET ROLE ${role}; ${text}`);
      const denied = (role: string, text: string) => {
        const r = as(role, text);
        expect(r.ok, `${role} should be refused: ${text}`).toBe(false);
        expect(r.err).toMatch(/permission denied|violates row-level security/);
      };

      sql(LIVE_LEGACY_PRE_PIVOT);
      const applied: string[] = [];
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f >= "20260913120000").sort()) {
        const r = run("psql", [...args, "-f", join(dir, file)]);
        if (!r.ok) throw new Error(`${file} failed on the chain: ${r.err}`);
        applied.push(file);
      }
      for (const f of WAVE_CHAIN) expect(applied).toContain(f);
      for (const table of ["call_thesis_updates", "market_proposals", "panta_claim_sessions", "push_tokens",
        "content_reports", "user_blocks", "user_mutes", "account_deletions"]) {
        expect(sql(`SELECT to_regclass('public.${table}') IS NOT NULL`)).toBe("t");
      }

      // ── lockdown's rights survive everything after it ─────────────────────
      for (const role of ["anon", "authenticated"]) {
        denied(role, `UPDATE public.users SET full_name = 'vandal'`);
        denied(role, `INSERT INTO public.users(wallet_address, full_name) VALUES ('${"9".repeat(44)}', 'squat')`);
        denied(role, `SELECT count(*) FROM public.push_tokens`);
        denied(role, `SELECT count(*) FROM public.fcm_tokens`);
        denied(role, `SELECT count(*) FROM public.user_blocks`);
        denied(role, `SELECT count(*) FROM public.panta_claim_sessions`);
        denied(role, `SELECT public.delete_account_v1(gen_random_uuid(), gen_random_uuid())`);
        denied(role, `SELECT public.update_own_profile_v1(gen_random_uuid(), 'x', NULL, NULL)`);
        denied(role, `UPDATE public.friends SET nickname = 'x'`);
      }

      // ── a real person with every kind of row the deletion must reach ──────
      const ADA_WALLET = "AdaWa11et1111111111111111111111111111111111";
      const BOB_WALLET = "BobWa11et2222222222222222222222222222222222";
      const NEW_FRIEND = "NewFr1end333333333333333333333333333333333";
      const A1 = "a0000000-0000-4000-8000-000000000001";
      const A2 = "a0000000-0000-4000-8000-000000000002";
      const A3 = "a0000000-0000-4000-8000-000000000003";
      sql(`INSERT INTO auth.users VALUES ('${A1}'),('${A2}'),('${A3}')`);
      expect(svc(`SELECT public.create_social_person_v2('${A1}', 'Ada', 'ada', '${ADA_WALLET}')->>'outcome'`)).toBe("created");
      expect(svc(`SELECT public.create_social_person_v2('${A2}', 'Bob', 'bob', '${BOB_WALLET}')->>'outcome'`)).toBe("created");
      const ADA = sql(`SELECT id FROM public.users WHERE auth_user_id = '${A1}'`);
      const BOB = sql(`SELECT id FROM public.users WHERE auth_user_id = '${A2}'`);
      const ADA_TOKEN = "ada-device-" + "a".repeat(30);
      const BOB_TOKEN = "bob-device-" + "b".repeat(30);
      svc(`INSERT INTO public.push_tokens(token, user_id, platform) VALUES ('${ADA_TOKEN}', '${ADA}', 'android'),
             ('${ADA_TOKEN}2', '${ADA}', 'ios'), ('${BOB_TOKEN}', '${BOB}', 'android')`);
      svc(`INSERT INTO public.fcm_tokens(wallet_address, fcm_token) VALUES ('${ADA_WALLET}', 'legacy-ada'), ('${BOB_WALLET}', 'legacy-bob')`);
      expect(svc(`SELECT public.add_wallet_friend_v1('${ADA}', '${BOB_WALLET}', 'Bobby')->>'ok'`)).toBe("true");
      expect(svc(`SELECT public.add_wallet_friend_v1('${ADA}', '${NEW_FRIEND}', 'Someone')->>'created_placeholder'`)).toBe("true");
      expect(svc(`SELECT public.add_wallet_friend_v1('${BOB}', '${NEW_FRIEND}', NULL)->>'ok'`)).toBe("true");
      svc(`INSERT INTO public.person_follows(follower_user_id, followee_user_id) VALUES ('${ADA}', '${BOB}'), ('${BOB}', '${ADA}');
           INSERT INTO public.user_blocks(blocker_user_id, blocked_user_id) VALUES ('${BOB}', '${ADA}');
           INSERT INTO public.user_mutes(muter_user_id, muted_user_id) VALUES ('${ADA}', '${BOB}');`);
      expect(svc(`SELECT public.update_own_profile_v1('${ADA}', 'Ada L', 'my bio', 3)->>'ok'`)).toBe("true");

      // ── add a friend's lookup (find_person_identities) over the chain ─────
      sql(`INSERT INTO auth.identities(provider_id, user_id, identity_data, provider, last_sign_in_at) VALUES
             ('x-ada', '${A1}', '{"user_name":"Ada_X","avatar_url":"https://pbs.twimg.com/profile_images/1/a_normal.jpg","email":"ada@example.com"}', 'x', now()),
             ('x-bob', '${A2}', '{"user_name":"bob_x"}', 'x', now())`);
      const byX = (h: string) => svc(`SELECT coalesce(string_agg(user_id::text, ','), '<none>') FROM public.person_x_identities_v1('${h}', NULL)`);
      const byWallet = (w: string) => svc(`SELECT coalesce(public.person_for_wallet_v1('${w}')::text, '<null>')`);
      expect(byX("ada_x")).toBe(ADA);
      expect(byX("@BOB_X")).toBe(BOB);
      expect(byWallet(ADA_WALLET)).toBe(ADA);
      // add_wallet_friend_v1's placeholder is nobody to find.
      expect(byWallet(NEW_FRIEND)).toBe("<null>");
      for (const role of ["anon", "authenticated"]) {
        denied(role, `SELECT * FROM public.person_x_identities_v1('ada_x', NULL)`);
        denied(role, `SELECT public.person_for_wallet_v1('${ADA_WALLET}')`);
      }

      // ── delete ────────────────────────────────────────────────────────────
      const out = JSON.parse(svc(`SELECT public.delete_account_v1('${ADA}', '${A1}')::text`)) as {
        ok: boolean; outcome: string; summary: Record<string, number>;
      };
      expect(out).toMatchObject({ ok: true, outcome: "deleted" });
      expect(out.summary.push_tokens).toBe(2);
      expect(out.summary.fcm_tokens).toBe(1);
      expect(out.summary.friends).toBe(4);
      expect(out.summary.person_follows).toBe(2);
      expect(out.summary.user_blocks).toBe(1);
      expect(out.summary.user_mutes).toBe(1);

      expect(sql(`SELECT count(*) FROM public.push_tokens WHERE user_id = '${ADA}'`)).toBe("0");
      expect(sql(`SELECT count(*) FROM public.fcm_tokens WHERE wallet_address = '${ADA_WALLET}'`)).toBe("0");
      expect(sql(`SELECT count(*) FROM public.friends WHERE '${ADA}' IN (user_id, friend_id)`)).toBe("0");
      expect(sql(`SELECT count(*) FROM public.person_follows WHERE '${ADA}' IN (follower_user_id, followee_user_id)`)).toBe("0");
      // Nobody else's rows are touched.
      expect(sql(`SELECT count(*) FROM public.push_tokens WHERE user_id = '${BOB}'`)).toBe("1");
      expect(sql(`SELECT count(*) FROM public.fcm_tokens WHERE wallet_address = '${BOB_WALLET}'`)).toBe("1");
      expect(sql(`SELECT count(*) FROM public.friends WHERE user_id = '${BOB}'`)).toBe("1");
      expect(sql(`SELECT full_name || '|' || coalesce(wallet_address, '-') || '|' || coalesce(auth_user_id::text, '-') || '|' || coalesce(bio, '-')
                    FROM public.users WHERE id = '${ADA}'`)).toBe("Deleted account|-|-|-");

      // A retry is "already deleted", never a second pass.
      expect(svc(`SELECT public.delete_account_v1('${ADA}', '${A1}')->>'outcome'`)).toBe("already_deleted");

      // Add a friend no longer finds her, by her X account or her old wallet;
      // everyone else is still found.
      expect(byX("ada_x")).toBe("<none>");
      expect(byWallet(ADA_WALLET)).toBe("<null>");
      expect(byX("bob_x")).toBe(BOB);

      // ── nothing brings the deleted row back ───────────────────────────────
      // An old build's wallet connect makes, at most, a fresh empty placeholder.
      const synced = sql(`SET ROLE anon; SELECT public.sync_user_by_wallet('${ADA_WALLET}')`);
      expect(synced).not.toBe(ADA);
      expect(sql(`SELECT is_placeholder::text || '|' || coalesce(full_name, '-') FROM public.users WHERE id = '${synced}'`)).toBe("true|-");
      // That placeholder is nobody to add as a friend.
      expect(byWallet(ADA_WALLET)).toBe("<null>");
      // Lockdown's carry-over binds a new sign-in at that wallet to the
      // placeholder at most, never to the anonymised row.
      const bound = svc(`SELECT public.bind_wallet_session_v1('${A3}', '${ADA_WALLET}')::text`);
      expect(bound).not.toContain(ADA);
      // And the deleted row takes no profile edit.
      expect(svc(`SELECT public.update_own_profile_v1('${ADA}', 'Back again', NULL, NULL)->>'reason'`)).toBe("unknown_user");
      expect(sql(`SELECT full_name FROM public.users WHERE id = '${ADA}'`)).toBe("Deleted account");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
