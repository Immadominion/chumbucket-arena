import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15 that reproduces the LIVE legacy rights (as
// recorded in the mobile repo's docs/schema/legacy-rights-2026-10-02.sql),
// applies the REAL migrations 20261002090000 -> 20261002120000 ->
// 20261002170000, and proves:
//   * nobody but the service role can write a profile, a placeholder, a push
//     token or read linked wallets any more (B1, M1, B3, M2);
//   * every legacy client path the app still uses keeps working;
//   * carry-over never carries a placeholder's words.
// Run: VERIFY_LOCAL_PG=true bun test tests/lockdown.postgres.test.ts

function migrationsDir(): string {
  const candidates = [
    process.env.CHUMBUCKET_MOBILE_DIR && join(process.env.CHUMBUCKET_MOBILE_DIR, "supabase/migrations"),
    join(import.meta.dir, "../../mobile/supabase/migrations"),
    join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations"),
  ].filter((c): c is string => typeof c === "string");
  const found = candidates.find((c) => existsSync(join(c, "20261002170000_lockdown_profiles_push_privacy.sql")));
  if (!found) throw new Error(`lockdown migration not found in: ${candidates.join(", ")}`);
  return found;
}

const W = {
  victim: "Vict1mWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 44),
  friend: "Fr1endWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".slice(0, 44),
  newbie: "NewWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC".slice(0, 44),
  legacy: "LegacyWa11etDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD".slice(0, 44),
  linked: "L1nkedWa11etEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE".slice(0, 44),
  other: "UtherWa11etFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF".slice(0, 44),
};
const AUTH = {
  victim: "a1111111-1111-4111-8111-111111111111",
  legacy: "a2222222-2222-4222-8222-222222222222",
  newbie: "a3333333-3333-4333-8333-333333333333",
  owner: "a4444444-4444-4444-8444-444444444444",
};
const USER = {
  owner: "b4444444-4444-4444-8444-444444444444",
  legacy: "b2222222-2222-4222-8222-222222222222",
  stranger: "b5555555-5555-4555-8555-555555555555",
};

/** The live shape and rights, as read on 2026-10-02 (see the docs snapshot). */
const LIVE_LEGACY = String.raw`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text UNIQUE, privy_id text UNIQUE, email text, full_name text, bio text,
    handle text, sns_domain text, profile_image_id integer DEFAULT 1, profile_picture text,
    last_seen_at timestamptz, auth_user_id uuid UNIQUE,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE public.linked_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    wallet_address text NOT NULL UNIQUE, wallet_type text NOT NULL DEFAULT 'mwa',
    is_primary boolean NOT NULL DEFAULT false, first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_signed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), siws_proof_version smallint,
    verified_at timestamptz, revoked_at timestamptz);
  CREATE TABLE public.wallet_link_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL, action text NOT NULL, from_user_id uuid, to_user_id uuid,
    reason text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.friends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    friend_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'accepted', created_at timestamptz DEFAULT now(),
    UNIQUE(user_id, friend_id), CONSTRAINT no_self_friendship CHECK (user_id <> friend_id));
  CREATE TABLE public.fcm_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text UNIQUE, fcm_token text, platform text, user_display_name text,
    network text DEFAULT 'devnet', updated_at timestamptz DEFAULT now());

  ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.linked_wallets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;
  CREATE POLICY users_insert ON public.users FOR INSERT WITH CHECK (true);
  CREATE POLICY users_select ON public.users FOR SELECT USING (true);
  CREATE POLICY users_update ON public.users FOR UPDATE USING (true);
  CREATE POLICY linked_wallets_public_select ON public.linked_wallets FOR SELECT USING (true);
  CREATE POLICY friends_all ON public.friends FOR ALL USING (true) WITH CHECK (true);
  CREATE POLICY fcm_tokens_all ON public.fcm_tokens FOR ALL USING (true) WITH CHECK (true);

  -- users: SELECT re-granted per column without email (20260719161500);
  -- INSERT/UPDATE per column on everything but auth_user_id.
  GRANT SELECT (id, wallet_address, privy_id, full_name, bio, profile_picture,
    profile_image_id, created_at, updated_at, sns_domain, handle, last_seen_at)
    ON public.users TO anon, authenticated;
  GRANT INSERT (bio,created_at,email,full_name,handle,id,last_seen_at,privy_id,profile_image_id,profile_picture,sns_domain,updated_at,wallet_address),
        UPDATE (bio,created_at,email,full_name,handle,id,last_seen_at,privy_id,profile_image_id,profile_picture,sns_domain,updated_at,wallet_address)
    ON public.users TO anon, authenticated;
  GRANT DELETE, TRUNCATE ON public.users TO anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.linked_wallets TO anon, authenticated;
  GRANT ALL ON public.friends, public.fcm_tokens TO anon, authenticated;
  GRANT ALL ON public.users, public.linked_wallets, public.friends, public.fcm_tokens,
    public.wallet_link_audit TO service_role;
  GRANT SELECT ON auth.users TO service_role;

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
    ELSE
      UPDATE public.users SET sns_domain = coalesce(nullif(trim(coalesce(p_sns_domain,'')),''), sns_domain),
        full_name = coalesce(full_name, nullif(trim(coalesce(p_sns_domain,'')),'')),
        handle = coalesce(handle, nullif(trim(coalesce(p_sns_domain,'')),'')),
        updated_at = now(), last_seen_at = now() WHERE id = v_user_id;
    END IF;
    INSERT INTO public.linked_wallets(user_id, wallet_address, wallet_type, is_primary, first_seen_at, last_signed_at)
    VALUES (v_user_id, trim(p_wallet_address), 'mwa', true, now(), now())
    ON CONFLICT (wallet_address) DO UPDATE SET user_id = EXCLUDED.user_id, last_signed_at = now();
    RETURN v_user_id; END; $$;
  GRANT EXECUTE ON FUNCTION public.update_user_profile(text,text,text),
    public.update_user_profile_with_pfp(text,text,text,text), public.fetch_user_profile(text),
    public.sync_user_by_wallet(text,text) TO anon, authenticated;

  -- Prerequisites the 2 Oct migrations check for.
  CREATE FUNCTION public.create_social_person_v1(p_auth_user_id uuid, p_display_name text)
    RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::uuid $$;
  CREATE FUNCTION public.current_app_user_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS $$ SELECT u.id FROM public.users u WHERE u.auth_user_id = auth.uid() $$;
  GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO anon, authenticated, service_role;
`;

test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "lockdown closes every client identity write and keeps the legacy reads",
  () => {
    const dir = migrationsDir();
    const root = mkdtempSync(join(tmpdir(), "chum-lockdown-"));
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
      const as = (role: string, text: string, sub?: string) =>
        run("psql", args, `SET ROLE ${role}; ${sub ? `SELECT set_config('request.jwt.claim.sub', '${sub}', false);` : ""} ${text}`);
      const ok = (role: string, text: string, sub?: string): string => {
        const r = as(role, text, sub);
        if (!r.ok) throw new Error(`${role}: ${text}\n${r.err}`);
        return r.out.split("\n").pop() ?? "";
      };
      const denied = (role: string, text: string, sub?: string) => {
        const r = as(role, text, sub);
        expect(r.ok, `${role} should be refused: ${text}`).toBe(false);
        expect(r.err).toMatch(/permission denied|violates row-level security/);
      };
      const migrate = (name: string) => must("psql", [...args, "-f", join(dir, name)]);

      sql(LIVE_LEGACY);
      sql(`INSERT INTO auth.users(id) VALUES ('${AUTH.victim}'), ('${AUTH.legacy}'), ('${AUTH.newbie}'), ('${AUTH.owner}')`);
      // A real, signed-in person and a legacy wallet profile nobody has bound yet.
      sql(`INSERT INTO public.users(id, auth_user_id, wallet_address, full_name, handle)
             VALUES ('${USER.owner}', '${AUTH.owner}', '${W.other}', 'Owner', 'owner')`);
      sql(`INSERT INTO public.users(id, wallet_address, full_name, bio, handle)
             VALUES ('${USER.legacy}', '${W.legacy}', 'Legacy Lou', 'my own bio', 'lou')`);
      sql(`INSERT INTO public.users(id, auth_user_id, wallet_address, full_name)
             VALUES ('${USER.stranger}', '${AUTH.legacy}', '${W.linked.replace("L", "M")}', 'Linked Lee')`);
      sql(`INSERT INTO public.linked_wallets(user_id, wallet_address, verified_at, siws_proof_version)
             VALUES ('${USER.stranger}', '${W.linked}', now(), 1)`);
      sql(`INSERT INTO public.fcm_tokens(wallet_address, fcm_token) VALUES ('${W.legacy}', 'legacy-token')`);

      // ── before: the holes are real ────────────────────────────────────────
      ok("anon", `UPDATE public.users SET full_name = 'vandal' WHERE id = '${USER.owner}'`);
      ok("anon", `SELECT public.update_user_profile('${W.legacy}', 'vandal', 'x')`);
      // The pre-seed: a stranger labels the victim's wallet before they ever arrive.
      ok("anon", `INSERT INTO public.users(privy_id, email, full_name, wallet_address, created_at)
                    VALUES ('wallet_${W.victim.slice(0, 8)}', 'wallet_${W.victim.slice(0, 8)}@temp.com', 'Scammer', '${W.victim}', now())`);
      expect(ok("anon", `SELECT count(*) FROM public.fcm_tokens`)).toBe("1");
      expect(ok("anon", `SELECT count(*) FROM public.linked_wallets`)).not.toBe("0");
      sql(`UPDATE public.users SET full_name = 'Owner' WHERE id = '${USER.owner}'`);
      sql(`UPDATE public.users SET full_name = 'Legacy Lou', bio = 'my own bio' WHERE id = '${USER.legacy}'`);

      migrate("20261002090000_wallet_sign_in_and_usernames.sql");
      migrate("20261002120000_lock_profile_identity_columns.sql");
      migrate("20261002170000_lockdown_profiles_push_privacy.sql");

      // The pre-lockdown placeholder is found; real rows are not flagged.
      expect(sql(`SELECT is_placeholder FROM public.users WHERE wallet_address = '${W.victim}'`)).toBe("t");
      expect(sql(`SELECT is_placeholder FROM public.users WHERE id = '${USER.legacy}'`)).toBe("f");

      // ── B1/M1: nobody writes a users row from a client any more ──────────
      for (const role of ["anon", "authenticated"]) {
        const sub = role === "authenticated" ? AUTH.owner : undefined;
        denied(role, `UPDATE public.users SET full_name = 'vandal' WHERE id = '${USER.owner}'`, sub);
        denied(role, `UPDATE public.users SET profile_image_id = 3 WHERE id = '${USER.owner}'`, sub);
        denied(role, `UPDATE public.users SET bio = 'x' WHERE wallet_address = '${W.other}'`, sub);
        denied(role, `INSERT INTO public.users(privy_id, email, full_name, wallet_address)
                        VALUES ('wallet_x', 'wallet_x@temp.com', 'Squat', '${W.friend}')`, sub);
        denied(role, `DELETE FROM public.users WHERE id = '${USER.owner}'`, sub);
        denied(role, `SELECT public.update_user_profile('${W.legacy}', 'vandal', 'x')`, sub);
        denied(role, `SELECT public.update_user_profile_with_pfp('${W.legacy}', 'vandal', 'x', 'p')`, sub);
        denied(role, `SELECT public.update_own_profile_v1('${USER.owner}', 'vandal', NULL, NULL)`, sub);
        denied(role, `SELECT public.add_wallet_friend_v1('${USER.owner}', '${W.friend}', 'x')`, sub);
        denied(role, `SELECT public.bind_wallet_session_v1('${AUTH.victim}', '${W.victim}')`, sub);
        // B3: the legacy token registry is closed both ways, and so is the new one.
        denied(role, `SELECT count(*) FROM public.fcm_tokens`, sub);
        denied(role, `INSERT INTO public.fcm_tokens(wallet_address, fcm_token) VALUES ('${W.friend}', 't')`, sub);
        denied(role, `DELETE FROM public.fcm_tokens WHERE wallet_address = '${W.legacy}'`, sub);
        denied(role, `SELECT count(*) FROM public.push_tokens`, sub);
        denied(role, `INSERT INTO public.push_tokens(token, user_id, platform) VALUES ('${"t".repeat(30)}', '${USER.owner}', 'android')`, sub);
      }
      expect(sql(`SELECT full_name FROM public.users WHERE id = '${USER.owner}'`)).toBe("Owner");

      // ── M2: linked wallets are the owner's business ──────────────────────
      denied("anon", `SELECT count(*) FROM public.linked_wallets`);
      expect(ok("authenticated", `SELECT count(*) FROM public.linked_wallets`, AUTH.owner)).toBe("0");
      expect(ok("authenticated", `SELECT count(*) FROM public.linked_wallets`, AUTH.legacy)).toBe("1");
      denied("authenticated", `UPDATE public.linked_wallets SET user_id = '${USER.owner}'`, AUTH.owner);

      // ── the legacy client paths that remain, still work ──────────────────
      for (const role of ["anon", "authenticated"]) {
        expect(ok(role, `SELECT full_name FROM public.users WHERE wallet_address = '${W.legacy}'`)).toBe("Legacy Lou");
        expect(ok(role, `SELECT full_name FROM public.fetch_user_profile('${W.legacy}')`)).toBe("Legacy Lou");
        ok(role, `SELECT id, full_name, profile_image_id, wallet_address FROM public.users WHERE privy_id = 'nobody'`);
        // Wallet connect still answers with an id, but can no longer label anyone.
        expect(ok(role, `SELECT public.sync_user_by_wallet('${W.legacy}', 'hostile.sol') IS NOT NULL`)).toBe("t");
        ok(role, `SELECT public.sync_user_by_wallet('${W.newbie}', 'squatter.sol')`);
        // Friend graph reads, and an edge between two existing rows (old builds).
        ok(role, `SELECT f.friend_id, f.nickname, u.full_name FROM public.friends f
                    JOIN public.users u ON u.id = f.friend_id WHERE f.user_id = '${USER.legacy}'`);
      }
      expect(sql(`SELECT concat_ws('|', full_name, handle, sns_domain, bio) FROM public.users WHERE id = '${USER.legacy}'`))
        .toBe("Legacy Lou|lou|my own bio");
      expect(sql(`SELECT concat_ws('|', coalesce(full_name, '-'), coalesce(handle, '-'), coalesce(sns_domain, '-'), is_placeholder)
                    FROM public.users WHERE wallet_address = '${W.newbie}'`)).toBe("-|-|-|t");
      expect(sql(`SELECT count(*) FROM public.linked_wallets WHERE wallet_address = '${W.newbie}'`)).toBe("0");
      ok("anon", `INSERT INTO public.friends(user_id, friend_id, status) VALUES ('${USER.legacy}', '${USER.owner}', 'accepted')`);
      expect(as("anon", `SELECT public.sync_user_by_wallet('not a wallet', NULL)`).ok).toBe(false);

      // ── the service-role replacements ────────────────────────────────────
      const svc = (q: string) => ok("service_role", q);
      expect(svc(`SELECT public.update_own_profile_v1('${USER.owner}', '  New Name ', E'line one\nline two', 4)->>'ok'`)).toBe("true");
      expect(sql(`SELECT concat_ws('|', full_name, replace(bio, E'\\n', '/'), profile_image_id) FROM public.users WHERE id = '${USER.owner}'`))
        .toBe("New Name|line one/line two|4");
      expect(svc(`SELECT public.update_own_profile_v1('${USER.owner}', NULL, '', NULL)->>'ok'`)).toBe("true");
      expect(sql(`SELECT coalesce(bio, 'NULL') || '|' || full_name FROM public.users WHERE id = '${USER.owner}'`)).toBe("NULL|New Name");
      for (const [args, reason] of [
        [`'${USER.owner}', '', NULL, NULL`, "invalid_name"],
        [`'${USER.owner}', E'bad\\u0007', NULL, NULL`, "invalid_name"],
        [`'${USER.owner}', '${"x".repeat(61)}', NULL, NULL`, "invalid_name"],
        [`'${USER.owner}', NULL, '${"x".repeat(281)}', NULL`, "invalid_bio"],
        [`'${USER.owner}', NULL, NULL, 6`, "invalid_avatar"],
        [`'${USER.owner}', NULL, NULL, 0`, "invalid_avatar"],
        [`'${USER.owner}', NULL, NULL, NULL`, "nothing_to_change"],
        // A row nobody has signed in to is never edited, even by the service.
        [`'${USER.legacy}', 'vandal', NULL, NULL`, "unknown_user"],
      ] as const) {
        expect(svc(`SELECT public.update_own_profile_v1(${args})->>'reason'`)).toBe(reason);
      }
      expect(sql(`SELECT full_name FROM public.users WHERE id = '${USER.legacy}'`)).toBe("Legacy Lou");

      // Add a friend by wallet: an unknown wallet gets an EMPTY placeholder,
      // the typed name stays on the adder's own edge.
      const added = svc(`SELECT public.add_wallet_friend_v1('${USER.owner}', '${W.friend}', 'Bob from work')::text`);
      expect(JSON.parse(added)).toMatchObject({ ok: true, created_placeholder: true, already_friends: false });
      expect(sql(`SELECT concat_ws('|', coalesce(full_name, '-'), coalesce(handle, '-'), is_placeholder)
                    FROM public.users WHERE wallet_address = '${W.friend}'`)).toBe("-|-|t");
      expect(sql(`SELECT f.nickname FROM public.friends f JOIN public.users u ON u.id = f.friend_id
                    WHERE f.user_id = '${USER.owner}' AND u.wallet_address = '${W.friend}'`)).toBe("Bob from work");
      expect(sql(`SELECT count(*) FROM public.friends f JOIN public.users u ON u.id = f.user_id
                    WHERE f.friend_id = '${USER.owner}' AND u.wallet_address = '${W.friend}'`)).toBe("1");
      const again = JSON.parse(svc(`SELECT public.add_wallet_friend_v1('${USER.owner}', '${W.friend}', NULL)::text`));
      expect(again).toMatchObject({ ok: true, created_placeholder: false, already_friends: true });
      expect(sql(`SELECT f.nickname FROM public.friends f JOIN public.users u ON u.id = f.friend_id
                    WHERE f.user_id = '${USER.owner}' AND u.wallet_address = '${W.friend}'`)).toBe("Bob from work");
      // A wallet verified to another account resolves to that account.
      expect(JSON.parse(svc(`SELECT public.add_wallet_friend_v1('${USER.owner}', '${W.linked}', NULL)::text`)))
        .toMatchObject({ ok: true, friend_user_id: USER.stranger, created_placeholder: false });
      expect(svc(`SELECT public.add_wallet_friend_v1('${USER.owner}', '${W.other}', NULL)->>'reason'`)).toBe("self");
      expect(svc(`SELECT public.add_wallet_friend_v1('${USER.owner}', 'nope', NULL)->>'reason'`)).toBe("invalid_wallet");
      expect(svc(`SELECT public.add_wallet_friend_v1('${USER.legacy}', '${W.friend}', NULL)->>'reason'`)).toBe("unknown_user");

      // Push tokens: one row per device, owned by whoever registered it last.
      svc(`INSERT INTO public.push_tokens(token, user_id, platform) VALUES ('${"a".repeat(40)}', '${USER.owner}', 'android')`);
      expect(as("service_role", `INSERT INTO public.push_tokens(token, user_id, platform) VALUES ('short', '${USER.owner}', 'android')`).ok).toBe(false);
      expect(as("service_role", `INSERT INTO public.push_tokens(token, user_id, platform) VALUES ('${"b".repeat(40)}', '${USER.owner}', 'web')`).ok).toBe(false);

      // ── M1: carry-over never carries a placeholder's words ───────────────
      const carriedVictim = JSON.parse(svc(`SELECT public.bind_wallet_session_v1('${AUTH.victim}', '${W.victim}')::text`));
      expect(carriedVictim).toMatchObject({ ok: true, outcome: "carried_placeholder" });
      expect(sql(`SELECT concat_ws('|', coalesce(full_name, '-'), coalesce(handle, '-'), coalesce(privy_id, '-'),
                    coalesce(email, '-'), is_placeholder, auth_user_id) FROM public.users WHERE wallet_address = '${W.victim}'`))
        .toBe(`-|-|-|-|f|${AUTH.victim}`);
      // A wallet-connect placeholder: carried clean as well.
      expect(JSON.parse(svc(`SELECT public.bind_wallet_session_v1('${AUTH.newbie}', '${W.newbie}')::text`)))
        .toMatchObject({ ok: true, outcome: "carried_placeholder" });
      // A real legacy profile keeps its own name, bio and handle.
      expect(JSON.parse(svc(`SELECT public.bind_wallet_session_v1('${AUTH.legacy}', '${W.legacy}')::text`)))
        .toMatchObject({ ok: true, outcome: "existing" });
      sql(`INSERT INTO auth.users(id) VALUES ('a5555555-5555-4555-8555-555555555555')`);
      expect(JSON.parse(svc(`SELECT public.bind_wallet_session_v1('a5555555-5555-4555-8555-555555555555', '${W.legacy}')::text`)))
        .toMatchObject({ ok: true, outcome: "carried" });
      expect(sql(`SELECT concat_ws('|', full_name, bio, handle) FROM public.users WHERE id = '${USER.legacy}'`))
        .toBe("Legacy Lou|my own bio|lou");
      // Once bound, the owner edits their own row through the BFF function.
      const victimId = sql(`SELECT id FROM public.users WHERE wallet_address = '${W.victim}'`);
      expect(svc(`SELECT public.update_own_profile_v1('${victimId}', 'The Real Victim', NULL, 2)->>'ok'`)).toBe("true");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
