import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15 reproducing the LIVE rights on the legacy
// tables (permissive users policies + column grants, world-readable
// linked_wallets, anon-writable fcm_tokens and friends), then the identity
// lock (20261002120000) and 20261002180000_trust_safety_and_account.sql.
//
// Proves: every legacy client write still works; the new tables and the
// deletion function are unreachable for anon/authenticated; deletion
// anonymises the person, keeps calls, removes what identifies them, frees the
// wallet, and is idempotent; acceptances are append-only.
// Run: VERIFY_LOCAL_PG=true bun test tests/trustAccount.postgres.test.ts

function migrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    join(import.meta.dir, "../../mobile/supabase/migrations"),
    join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations"),
  ].filter((c): c is string => !!c);
  const found = candidates.find((c) => existsSync(join(c, "20261002180000_trust_safety_and_account.sql")));
  if (!found) throw new Error(`migrations not found in ${candidates.join(", ")}`);
  return found;
}

test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "trust migration keeps legacy writes, stays service-only, and deletes accounts idempotently",
  () => {
    const dir = migrationsDir();
    const root = mkdtempSync(join(tmpdir(), "chum-trust-"));
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
      const as = (role: string, text: string) => run("psql", args, `SET ROLE ${role}; ${text}`);
      const ok = (role: string, text: string) => {
        const r = as(role, text);
        if (!r.ok) throw new Error(`${role}: ${text}\n${r.err}`);
        return r.out.split("\n").pop() ?? "";
      };
      const denied = (role: string, text: string) => {
        const r = as(role, text);
        expect(r.ok).toBe(false);
        return r.err;
      };

      const VICTIM = "11111111-1111-4111-8111-111111111111";
      const FRIEND = "22222222-2222-4222-8222-222222222222";
      const OTHER = "33333333-3333-4333-8333-333333333333";
      const AUTH_V = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const AUTH_O = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const CALL = "44444444-4444-4444-8444-444444444444";

      // The live shape and rights, as read from production (see the audit and
      // profileIdentityLock.postgres.test.ts), reduced to what deletion touches.
      sql(String.raw`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet_address text UNIQUE, privy_id text UNIQUE, email text, full_name text, bio text,
          handle text, sns_domain text, profile_image_id integer DEFAULT 1, profile_picture text,
          last_seen_at timestamptz, auth_user_id uuid UNIQUE,
          created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
        CREATE UNIQUE INDEX uq_users_handle_lower ON public.users (lower(handle)) WHERE handle IS NOT NULL;
        CREATE TABLE public.linked_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, wallet_address text NOT NULL UNIQUE,
          wallet_type text NOT NULL DEFAULT 'mwa', is_primary boolean NOT NULL DEFAULT false,
          siws_proof_version smallint, verified_at timestamptz, revoked_at timestamptz,
          updated_at timestamptz DEFAULT now());
        CREATE TABLE public.linked_identities(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          provider text NOT NULL, provider_subject text NOT NULL, provider_email text);
        CREATE TABLE public.wallet_link_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet_address text NOT NULL, action text NOT NULL,
          from_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          to_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          nonce_id uuid, actor text NOT NULL DEFAULT 'service', reason text, created_at timestamptz DEFAULT now());
        CREATE TABLE public.calls(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
          thesis text, hidden_at timestamptz);
        CREATE FUNCTION public.calls_guard_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'calls are never deleted'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER trg_calls_guard_immutability BEFORE UPDATE OR DELETE ON public.calls
          FOR EACH ROW EXECUTE FUNCTION public.calls_guard_immutability();
        CREATE TABLE public.person_follows(follower_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          followee_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          PRIMARY KEY (follower_user_id, followee_user_id));
        CREATE TABLE public.follows(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), network text NOT NULL DEFAULT 'mainnet-beta',
          follower_wallet text NOT NULL, followee_wallet text NOT NULL,
          follower_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          followee_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL);
        CREATE TABLE public.friends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          friend_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'accepted', UNIQUE(user_id, friend_id));
        CREATE TABLE public.fcm_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet_address text UNIQUE,
          fcm_token text, platform text, user_display_name text, updated_at timestamptz);
        CREATE TABLE public.social_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          recipient_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          actor_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
          subject_call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE);

        ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.linked_wallets ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;
        CREATE POLICY users_insert ON public.users FOR INSERT WITH CHECK (true);
        CREATE POLICY users_select ON public.users FOR SELECT USING (true);
        CREATE POLICY users_update ON public.users FOR UPDATE USING (true);
        CREATE POLICY lw_select ON public.linked_wallets FOR SELECT USING (true);
        CREATE POLICY fcm_all ON public.fcm_tokens FOR ALL USING (true) WITH CHECK (true);
        CREATE POLICY friends_all ON public.friends FOR ALL USING (true) WITH CHECK (true);
        GRANT SELECT ON public.users, public.linked_wallets TO anon, authenticated;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.fcm_tokens, public.friends TO anon, authenticated;
        GRANT INSERT (bio,created_at,email,full_name,handle,id,last_seen_at,privy_id,profile_image_id,profile_picture,sns_domain,updated_at,wallet_address),
              UPDATE (bio,created_at,email,full_name,handle,id,last_seen_at,privy_id,profile_image_id,profile_picture,sns_domain,updated_at,wallet_address)
          ON public.users TO anon, authenticated;
        GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.linked_wallets TO anon, authenticated;
        GRANT TRUNCATE ON public.users TO anon, authenticated;
        CREATE FUNCTION public.update_user_profile(p_privy_id text, p_full_name text, p_bio text)
          RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
          UPDATE users SET full_name = p_full_name, bio = p_bio, updated_at = now()
           WHERE privy_id = p_privy_id OR wallet_address = p_privy_id; END; $$;
        CREATE FUNCTION public.sync_user_by_wallet(p_wallet_address text, p_sns_domain text)
          RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$ DECLARE v uuid; BEGIN
          SELECT id INTO v FROM users WHERE wallet_address = p_wallet_address;
          IF v IS NULL THEN INSERT INTO users(wallet_address, sns_domain, handle)
            VALUES (p_wallet_address, p_sns_domain, p_sns_domain) RETURNING id INTO v;
          ELSE UPDATE users SET handle = coalesce(handle, p_sns_domain) WHERE id = v; END IF;
          RETURN v; END; $$;
        GRANT EXECUTE ON FUNCTION public.update_user_profile(text,text,text), public.sync_user_by_wallet(text,text) TO anon, authenticated;

        INSERT INTO public.users(id, wallet_address, privy_id, full_name, bio, email, handle, sns_domain, profile_picture, auth_user_id)
          VALUES ('${VICTIM}', 'VictimWallet', 'VictimWallet', 'Victim Name', 'my bio', 'v@example.com', 'victim', 'victim.sol', 'pfp.png', '${AUTH_V}'),
                 ('${FRIEND}', 'FriendWallet', 'FriendWallet', 'Friend', NULL, NULL, 'friend', NULL, NULL, NULL),
                 ('${OTHER}', 'OtherWallet', NULL, 'Other', NULL, NULL, 'other', NULL, NULL, '${AUTH_O}');
        INSERT INTO public.linked_wallets(user_id, wallet_address, is_primary) VALUES
          ('${VICTIM}', 'VictimWallet', true), ('${VICTIM}', 'VictimSecond', false), ('${OTHER}', 'OtherWallet', true);
        INSERT INTO public.linked_identities(user_id, provider, provider_subject, provider_email)
          VALUES ('${VICTIM}', 'google', 'g-1', 'v@example.com'), ('${OTHER}', 'google', 'g-2', 'o@example.com');
        INSERT INTO public.calls(id, user_id, thesis) VALUES ('${CALL}', '${VICTIM}', 'it will happen');
        INSERT INTO public.person_follows VALUES ('${VICTIM}', '${OTHER}'), ('${OTHER}', '${VICTIM}'), ('${FRIEND}', '${OTHER}');
        INSERT INTO public.follows(follower_wallet, followee_wallet, follower_user_id, followee_user_id)
          VALUES ('VictimWallet', 'OtherWallet', '${VICTIM}', '${OTHER}'), ('FriendWallet', 'OtherWallet', '${FRIEND}', '${OTHER}');
        INSERT INTO public.friends(user_id, friend_id) VALUES ('${VICTIM}', '${FRIEND}'), ('${FRIEND}', '${VICTIM}'), ('${FRIEND}', '${OTHER}');
        INSERT INTO public.fcm_tokens(wallet_address, fcm_token) VALUES ('VictimWallet', 'tok-v'), ('OtherWallet', 'tok-o');
        INSERT INTO public.social_notifications(recipient_user_id, actor_user_id, subject_call_id)
          VALUES ('${VICTIM}', '${OTHER}', '${CALL}');
      `);

      must("psql", [...args, "-f", join(dir, "20261002120000_lock_profile_identity_columns.sql")]);
      must("psql", [...args, "-f", join(dir, "20261002180000_trust_safety_and_account.sql")]);

      // Every legacy client write still works, for both client roles.
      for (const role of ["anon", "authenticated"]) {
        ok(role, `SELECT public.sync_user_by_wallet('NewWallet_${role}', NULL)`);
        ok(role, `SELECT public.update_user_profile('FriendWallet', 'Friend ${role}', 'bio')`);
        ok(role, `UPDATE public.users SET profile_image_id = 3 WHERE privy_id = 'FriendWallet'`);
        ok(role, `INSERT INTO public.users(privy_id, email, full_name, wallet_address, created_at)
                    VALUES ('wallet_${role}', 'wallet_${role}@temp.com', 'Friend', 'FriendWallet_${role}', now())`);
        ok(role, `UPDATE public.users SET full_name = 'Friend named' WHERE wallet_address = 'FriendWallet_${role}' AND full_name IS NOT NULL`);
        ok(role, `INSERT INTO public.fcm_tokens(wallet_address, fcm_token) VALUES ('W_${role}', 't')
                    ON CONFLICT (wallet_address) DO UPDATE SET fcm_token = EXCLUDED.fcm_token`);
        ok(role, `DELETE FROM public.fcm_tokens WHERE wallet_address = 'W_${role}'`);
        ok(role, `SELECT count(*) FROM public.linked_wallets`);
      }

      // The new tables and functions are service-only.
      for (const role of ["anon", "authenticated"]) {
        for (const table of ["content_reports", "user_blocks", "user_mutes", "legal_acceptances", "account_deletions", "account_deletion_requests"]) {
          expect(denied(role, `SELECT count(*) FROM public.${table}`)).toContain("permission denied");
        }
        expect(denied(role, `INSERT INTO public.user_blocks VALUES ('${OTHER}', '${VICTIM}')`)).toContain("permission denied");
        expect(denied(role, `SELECT public.delete_account_v1('${VICTIM}', '${AUTH_V}')`)).toContain("permission denied");
        expect(denied(role, `SELECT public.trust_delete_rows_v1('users', 'id', ARRAY['${VICTIM}'])`)).toContain("permission denied");
        expect(denied(role, `UPDATE public.users SET deleted_at = now() WHERE id = '${FRIEND}'`)).toContain("permission denied");
      }
      expect(denied("service_role", `SELECT public.trust_delete_rows_v1('users', 'id', ARRAY['${VICTIM}'])`)).toContain("permission denied");

      // Service-side state the deletion must clear.
      ok("service_role", `INSERT INTO public.user_blocks VALUES ('${VICTIM}', '${FRIEND}'), ('${OTHER}', '${VICTIM}'), ('${OTHER}', '${FRIEND}')`);
      ok("service_role", `INSERT INTO public.user_mutes VALUES ('${VICTIM}', '${OTHER}')`);

      // A session may only delete its own profile.
      expect(ok("service_role", `SELECT public.delete_account_v1('${VICTIM}', '${AUTH_O}')->>'reason'`)).toBe("session_mismatch");
      expect(sql(`SELECT full_name FROM public.users WHERE id = '${VICTIM}'`)).toBe("Victim Name");

      // Deletion.
      expect(ok("service_role", `SELECT public.delete_account_v1('${VICTIM}', '${AUTH_V}')->>'outcome'`)).toBe("deleted");
      const row = sql(`SELECT concat_ws('|', full_name, coalesce(bio,'∅'), coalesce(email,'∅'), coalesce(wallet_address,'∅'),
        coalesce(privy_id,'∅'), handle, coalesce(sns_domain,'∅'), coalesce(profile_picture,'∅'), coalesce(auth_user_id::text,'∅'),
        (deleted_at IS NOT NULL)::text) FROM public.users WHERE id = '${VICTIM}'`);
      expect(row).toBe("Deleted account|∅|∅|∅|∅|deleted_111111111111|∅|∅|∅|true");
      // The call survives, still attributed to the (anonymised) row.
      expect(sql(`SELECT user_id FROM public.calls WHERE id = '${CALL}'`)).toBe(VICTIM);
      const count = (q: string) => Number(sql(`SELECT count(*) FROM ${q}`));
      expect(count(`public.linked_wallets WHERE user_id = '${VICTIM}'`)).toBe(0);
      expect(count(`public.wallet_link_audit WHERE from_user_id = '${VICTIM}' AND action = 'revoked'`)).toBe(2);
      expect(count(`public.linked_identities WHERE user_id = '${VICTIM}'`)).toBe(0);
      expect(count(`public.person_follows WHERE '${VICTIM}' IN (follower_user_id, followee_user_id)`)).toBe(0);
      expect(count(`public.follows WHERE follower_wallet = 'VictimWallet' OR '${VICTIM}' IN (follower_user_id, followee_user_id)`)).toBe(0);
      expect(count(`public.friends WHERE '${VICTIM}' IN (user_id, friend_id)`)).toBe(0);
      expect(count(`public.fcm_tokens WHERE wallet_address = 'VictimWallet'`)).toBe(0);
      expect(count(`public.social_notifications WHERE recipient_user_id = '${VICTIM}'`)).toBe(0);
      expect(count(`public.user_blocks WHERE '${VICTIM}' IN (blocker_user_id, blocked_user_id)`)).toBe(0);
      expect(count(`public.user_mutes WHERE muter_user_id = '${VICTIM}'`)).toBe(0);
      // Nobody else lost anything.
      expect(count(`public.linked_wallets WHERE user_id = '${OTHER}'`)).toBe(1);
      expect(count(`public.linked_identities WHERE user_id = '${OTHER}'`)).toBe(1);
      expect(count(`public.person_follows WHERE follower_user_id = '${FRIEND}'`)).toBe(1);
      expect(count(`public.follows WHERE follower_user_id = '${FRIEND}'`)).toBe(1);
      expect(count(`public.friends WHERE user_id = '${FRIEND}' AND friend_id = '${OTHER}'`)).toBe(1);
      expect(count(`public.fcm_tokens WHERE wallet_address = 'OtherWallet'`)).toBe(1);
      expect(count(`public.user_blocks WHERE blocker_user_id = '${OTHER}' AND blocked_user_id = '${FRIEND}'`)).toBe(1);

      // Idempotent.
      expect(ok("service_role", `SELECT public.delete_account_v1('${VICTIM}', '${AUTH_V}')->>'outcome'`)).toBe("already_deleted");
      expect(count(`public.account_deletions WHERE auth_user_id = '${AUTH_V}'`)).toBe(1);

      // The anonymised row is read-only to clients; other rows still edit.
      for (const role of ["anon", "authenticated"]) {
        expect(denied(role, `UPDATE public.users SET full_name = 'vandal' WHERE id = '${VICTIM}'`)).toContain("deleted");
        ok(role, `UPDATE public.users SET full_name = 'Friend ok' WHERE id = '${FRIEND}'`);
      }
      // The legacy wallet sign-in path no longer finds the deleted profile.
      expect(ok("anon", `SELECT public.sync_user_by_wallet('VictimWallet', NULL)`)).not.toBe(VICTIM);
      // And the freed wallet can belong to another account.
      ok("service_role", `INSERT INTO public.linked_wallets(user_id, wallet_address) VALUES ('${OTHER}', 'VictimSecond')`);

      // A sign-in that never made a profile is recorded so its auth user can go.
      expect(ok("service_role", `SELECT public.delete_account_v1(NULL, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')->>'outcome'`)).toBe("no_profile");

      // Acceptances are append-only and record only a yes.
      ok("service_role", `INSERT INTO public.legal_acceptances(user_id, scope, terms_version, is_18_plus, jurisdiction_eligible, venue_terms_accepted)
                            VALUES ('${OTHER}', 'funded_trading', '2026-10-02-draft', true, true, true)`);
      expect(denied("service_role", `UPDATE public.legal_acceptances SET terms_version = 'x' WHERE user_id = '${OTHER}'`)).toContain("append-only");
      expect(denied("service_role", `DELETE FROM public.legal_acceptances WHERE user_id = '${OTHER}'`)).toContain("append-only");
      expect(denied("service_role", `INSERT INTO public.legal_acceptances(user_id, scope, terms_version, is_18_plus, jurisdiction_eligible, venue_terms_accepted)
                                       VALUES ('${FRIEND}', 'funded_trading', 'v1', false, true, true)`)).toContain("legal_acceptances_all_attested");

      // One open report per reporter per subject.
      ok("service_role", `INSERT INTO public.content_reports(reporter_user_id, subject_kind, subject_call_id, subject_user_id, reason)
                            VALUES ('${OTHER}', 'call', '${CALL}', '${VICTIM}', 'spam')`);
      expect(denied("service_role", `INSERT INTO public.content_reports(reporter_user_id, subject_kind, subject_call_id, subject_user_id, reason)
                                       VALUES ('${OTHER}', 'call', '${CALL}', '${VICTIM}', 'hate')`)).toContain("uq_content_reports_open_subject");
      expect(denied("service_role", `INSERT INTO public.content_reports(reporter_user_id, subject_kind, subject_user_id, reason)
                                       VALUES ('${OTHER}', 'person', '${OTHER}', 'spam')`)).toContain("content_reports_not_self");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
