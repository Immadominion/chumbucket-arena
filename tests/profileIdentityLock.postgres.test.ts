import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15 reproducing the LIVE public.users rights read
// on 2026-10-02 (permissive policies, column grants on everything but
// auth_user_id, definer profile functions), then
// 20261002120000_lock_profile_identity_columns.sql. Every operation the old
// app and web client perform must still succeed; repointing a wallet or a
// username must not. Run: VERIFY_LOCAL_PG=true bun test tests/profileIdentityLock.postgres.test.ts
test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "locking identity columns keeps every legacy write and stops wallet takeover",
  () => {
    const root = mkdtempSync(join(tmpdir(), "chum-profile-lock-"));
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

      const VICTIM = "11111111-1111-4111-8111-111111111111";
      // The live shape and rights, as read from production.
      sql(String.raw`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet_address text UNIQUE, privy_id text UNIQUE, email text, full_name text, bio text,
          handle text, sns_domain text, profile_image_id integer, profile_picture text,
          last_seen_at timestamptz, auth_user_id uuid UNIQUE,
          created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
        CREATE TABLE public.linked_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid REFERENCES public.users(id), wallet_address text UNIQUE);
        ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.linked_wallets ENABLE ROW LEVEL SECURITY;
        CREATE POLICY users_insert ON public.users FOR INSERT WITH CHECK (true);
        CREATE POLICY users_select ON public.users FOR SELECT USING (true);
        CREATE POLICY users_update ON public.users FOR UPDATE USING (true);
        CREATE POLICY lw_select ON public.linked_wallets FOR SELECT USING (true);
        GRANT SELECT ON public.users, public.linked_wallets TO anon, authenticated;
        GRANT ALL ON public.users, public.linked_wallets TO service_role;
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
        INSERT INTO public.users(id, wallet_address, privy_id, full_name, handle)
          VALUES ('${VICTIM}', 'VictimWallet', 'VictimWallet', 'Victim', 'victim');
      `);

      // Before: the hole is real.
      expect(as("anon", `UPDATE public.users SET wallet_address = 'AttackerWallet' WHERE id = '${VICTIM}'`).ok).toBe(true);
      sql(`UPDATE public.users SET wallet_address = 'VictimWallet' WHERE id = '${VICTIM}'`);

      must("psql", [...args, "-f", join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations/20261002120000_lock_profile_identity_columns.sql")]);

      // Every legacy client write still works.
      for (const role of ["anon", "authenticated"]) {
        const ok = (q: string) => {
          const r = as(role, q);
          if (!r.ok) throw new Error(`${role}: ${q}\n${r.err}`);
        };
        ok(`SELECT public.sync_user_by_wallet('NewWallet_${role}', NULL)`);
        ok(`SELECT public.sync_user_by_wallet('VictimWallet', 'victim.sol')`);
        ok(`SELECT public.update_user_profile('VictimWallet', 'Victim ${role}', 'bio')`);
        ok(`UPDATE public.users SET profile_image_id = 3 WHERE privy_id = 'VictimWallet'`);
        ok(`INSERT INTO public.users(privy_id, email, full_name, wallet_address, created_at)
              VALUES ('wallet_${role}', 'wallet_${role}@temp.com', 'Friend', 'FriendWallet_${role}', now())`);
        ok(`UPDATE public.users SET full_name = 'Friend named' WHERE wallet_address = 'FriendWallet_${role}' AND full_name IS NOT NULL`);
        ok(`SELECT id FROM public.users WHERE wallet_address = 'VictimWallet'`);
      }

      // Identity columns are no longer client-writable.
      for (const role of ["anon", "authenticated"]) {
        for (const q of [
          `UPDATE public.users SET wallet_address = 'AttackerWallet' WHERE id = '${VICTIM}'`,
          `UPDATE public.users SET handle = 'stolen' WHERE id = '${VICTIM}'`,
          `UPDATE public.users SET privy_id = 'AttackerWallet' WHERE id = '${VICTIM}'`,
          `INSERT INTO public.users(wallet_address, handle) VALUES ('X_${role}', 'squat_${role}')`,
          `TRUNCATE public.linked_wallets`,
        ]) {
          const r = as(role, q);
          expect(r.ok).toBe(false);
          expect(r.err).toContain("permission denied");
        }
      }
      expect(sql(`SELECT wallet_address || '|' || handle FROM public.users WHERE id = '${VICTIM}'`)).toBe("VictimWallet|victim");
      // The service role is untouched.
      expect(as("service_role", `UPDATE public.users SET handle = 'victim' WHERE id = '${VICTIM}'`).ok).toBe(true);
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
