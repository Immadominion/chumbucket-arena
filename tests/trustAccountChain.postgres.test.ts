import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15. Where trustAccount.postgres.test.ts proves
// the deletion against the LIVE legacy rights on a reduced schema, this one
// runs it against the REAL identity migration chain from the repo (nonces,
// legacy claims, linked wallets, onboarding, existing-account claims, wallet
// sign-in and usernames, the identity lock), so every table and column
// delete_account_v1 names is the one production has, and the sign-in paths
// that could bring a deleted account back are exercised for real.
// Run: VERIFY_LOCAL_PG=true bun test tests/trustAccountChain.postgres.test.ts

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
  "account deletion on the real identity chain: no table missed, no way back in, safe under a taken handle",
  () => {
    const dir = migrationsDir();
    const root = mkdtempSync(join(tmpdir(), "chum-trust-chain-"));
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
      const svc = (text: string) => sql(`SET ROLE service_role; ${text}`);
      const apply = (file: string) => must("psql", [...args, "-f", join(dir, file)]);

      // The pre-pivot shape the identity migrations were written against
      // (same as walletSignInUsernames.postgres.test.ts), with the profile
      // columns the live table carries.
      sql(String.raw`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        GRANT USAGE ON SCHEMA auth TO service_role; GRANT SELECT ON auth.users TO service_role;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
        CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet_address text UNIQUE, privy_id text UNIQUE, email text, full_name text, bio text,
          handle text, sns_domain text, profile_image_id integer DEFAULT 1, profile_picture text,
          last_seen_at timestamptz,
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
        CREATE TABLE public.linked_identities (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL, provider_subject TEXT NOT NULL, provider_email TEXT,
          UNIQUE(provider, provider_subject));
      `);
      for (const file of [
        "20260913120000_auth_identity_auth_user_link.sql",
        "20260913120500_auth_identity_wallet_nonces.sql",
        "20260913121000_auth_identity_legacy_claims.sql",
        "20260913121500_auth_identity_linked_wallets.sql",
        "20260928100000_social_person_onboarding.sql",
        "20260928120000_existing_account_claims.sql",
        "20261002090000_wallet_sign_in_and_usernames.sql",
        "20261002120000_lock_profile_identity_columns.sql",
      ]) apply(file);
      // calls only needs to exist (and refuse deletes) for the trust migration.
      sql(String.raw`
        CREATE TABLE public.calls(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
          thesis text, hidden_at timestamptz);
        CREATE FUNCTION public.calls_guard_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'calls are never deleted'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER trg_calls_guard_immutability BEFORE UPDATE OR DELETE ON public.calls
          FOR EACH ROW EXECUTE FUNCTION public.calls_guard_immutability();
        GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      `);
      apply("20261002180000_trust_safety_and_account.sql");

      const WALLET = "De1eteMeWa11et11111111111111111111111111111";
      const OTHER_WALLET = "AnchoredWa11et2222222222222222222222222222";
      const A1 = "a0000000-0000-4000-8000-000000000001"; // the person who deletes
      const A2 = "a0000000-0000-4000-8000-000000000002"; // a later sign-in at the same wallet
      const A3 = "a0000000-0000-4000-8000-000000000003"; // control: claims an anchored, unowned person
      const A4 = "a0000000-0000-4000-8000-000000000004"; // second deleter (handle taken)
      const UNOWNED = "55555555-5555-4555-8555-555555555555";
      const CALL = "44444444-4444-4444-8444-444444444444";
      const hex = (n: number) => n.toString(16).padStart(64, "0");
      sql(`INSERT INTO auth.users VALUES ('${A1}'),('${A2}'),('${A3}'),('${A4}');`);

      // A real onboarding: @ada with a verified wallet link and its audit row.
      expect(svc(`SELECT public.create_social_person_v2('${A1}', 'Ada', 'ada', '${WALLET}')->>'outcome'`)).toBe("created");
      const ADA = sql(`SELECT id FROM public.users WHERE auth_user_id = '${A1}'`);
      sql(`INSERT INTO public.calls(id, user_id, thesis) VALUES ('${CALL}', '${ADA}', 'it will happen');
           INSERT INTO public.linked_identities(user_id, provider, provider_subject, provider_email)
             VALUES ('${ADA}', 'google', 'g-ada', 'ada@example.com');
           INSERT INTO public.wallet_nonces(nonce_hash, user_id, wallet_address, purpose, domain, uri, network, expires_at)
             VALUES ('${hex(1)}', '${ADA}', '${WALLET}', 'link_wallet', 'chumbucket.fun', 'https://chumbucket.fun', 'mainnet-beta', now() + interval '5 minutes');
           INSERT INTO public.legacy_identity_claims(legacy_provider, legacy_subject, user_id, evidence)
             VALUES ('wallet', '${WALLET}', '${ADA}', 'siws_proof');
           INSERT INTO public.existing_account_anchors(user_id, wallet_address, network, evidence_sha256, review_ref, reviewed_by)
             VALUES ('${ADA}', '${WALLET}', 'mainnet-beta', '${hex(2)}', 'review-1', 'operator');`);

      // Control: an anchored person with no sign-in IS claimable in this harness,
      // so the refusal after deletion below means something.
      sql(`INSERT INTO public.users(id, full_name, handle) VALUES ('${UNOWNED}', 'Historic', 'historic');
           INSERT INTO public.existing_account_anchors(user_id, wallet_address, network, evidence_sha256, review_ref, reviewed_by)
             VALUES ('${UNOWNED}', '${OTHER_WALLET}', 'mainnet-beta', '${hex(3)}', 'review-2', 'operator');`);
      expect(svc(`SELECT public.issue_existing_account_proof_v1('${A3}', '${OTHER_WALLET}', 'mainnet-beta', '${hex(10)}', '${hex(11)}', now(), now() + interval '5 minutes')->>'ok'`)).toBe("true");
      expect(svc(`SELECT public.claim_existing_account_v1('${A3}', '${OTHER_WALLET}', 'mainnet-beta', '${hex(10)}', '${hex(11)}')->>'outcome'`)).toBe("claimed");

      // Delete.
      const out = svc(`SELECT public.delete_account_v1('${ADA}', '${A1}')::text`);
      const result = JSON.parse(out) as { ok: boolean; outcome: string; summary: Record<string, number> };
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("deleted");
      // Every real table was found (a misspelt table or column would read 0).
      expect(result.summary.linked_wallets).toBe(1);
      expect(result.summary.linked_identities).toBe(1);
      expect(result.summary.wallet_nonces).toBe(1);
      expect(result.summary.legacy_identity_claims).toBe(1);
      expect(result.summary.existing_account_anchors_revoked).toBe(1);

      expect(sql(`SELECT concat_ws('|', full_name, coalesce(wallet_address,'∅'), coalesce(auth_user_id::text,'∅'), handle, (deleted_at IS NOT NULL)::text)
                    FROM public.users WHERE id = '${ADA}'`)).toBe(`Deleted account|∅|∅|deleted_${ADA.replace(/-/g, "").slice(0, 12)}|true`);
      expect(sql(`SELECT user_id FROM public.calls WHERE id = '${CALL}'`)).toBe(ADA);
      expect(sql(`SELECT (revoked_at IS NOT NULL)::text FROM public.existing_account_anchors WHERE user_id = '${ADA}'`)).toBe("true");
      expect(sql(`SELECT count(*) FROM public.wallet_link_audit WHERE from_user_id = '${ADA}' AND action = 'revoked'`)).toBe("1");
      // The control's anchor is untouched.
      expect(sql(`SELECT (revoked_at IS NULL)::text FROM public.existing_account_anchors WHERE user_id = '${UNOWNED}'`)).toBe("true");

      // No way back in for the anonymised row:
      //  - a wallet sign-in at the same address finds nothing to carry;
      expect(svc(`SELECT public.bind_wallet_session_v1('${A2}', '${WALLET}')->>'reason'`)).toBe("no_profile");
      //  - the reviewed existing-account claim is refused (anchor revoked);
      expect(svc(`SELECT public.issue_existing_account_proof_v1('${A2}', '${WALLET}', 'mainnet-beta', '${hex(20)}', '${hex(21)}', now(), now() + interval '5 minutes')->>'ok'`)).toBe("true");
      expect(svc(`SELECT public.claim_existing_account_v1('${A2}', '${WALLET}', 'mainnet-beta', '${hex(20)}', '${hex(21)}')->>'reason'`)).toBe("claim_unavailable");
      expect(sql(`SELECT coalesce(auth_user_id::text, '∅') FROM public.users WHERE id = '${ADA}'`)).toBe("∅");
      //  - and the freed wallet can start a brand-new account.
      expect(svc(`SELECT public.create_social_person_v2('${A2}', 'Ada again', 'ada_two', '${WALLET}')->>'outcome'`)).toBe("created");
      expect(sql(`SELECT (id <> '${ADA}')::text FROM public.users WHERE auth_user_id = '${A2}'`)).toBe("true");

      // A retry is "already deleted".
      expect(svc(`SELECT public.delete_account_v1('${ADA}', '${A1}')->>'outcome'`)).toBe("already_deleted");

      // A taken deleted_ handle never blocks a deletion.
      expect(svc(`SELECT public.create_social_person_v2('${A4}', 'Bea', 'bea', NULL)->>'outcome'`)).toBe("created");
      const BEA = sql(`SELECT id FROM public.users WHERE auth_user_id = '${A4}'`);
      const short = `deleted_${BEA.replace(/-/g, "").slice(0, 12)}`;
      sql(`UPDATE public.users SET handle = '${short}' WHERE id = '${UNOWNED}'`);
      expect(svc(`SELECT public.delete_account_v1('${BEA}', '${A4}')->>'outcome'`)).toBe("deleted");
      expect(sql(`SELECT handle FROM public.users WHERE id = '${BEA}'`)).toBe(`deleted_${BEA.replace(/-/g, "")}`);
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
