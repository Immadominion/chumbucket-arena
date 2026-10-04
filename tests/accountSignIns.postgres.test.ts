import { expect, test } from "bun:test";
import { createHash, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: Supabase Auth's auth.identities, the REAL
// identity chain (nonces, linked wallets, onboarding, wallet sign-in and
// usernames, the identity lock, trust and deletion, find-person), then the
// REAL 20261004120000_account_sign_ins.sql — judged on the owner's case
// (@dev links X, which is on @dominion; @dominion folds into @dev), on a
// wallet sign-in landing on the account it was linked to, on unlinking, on
// every refusal, and on who may call it. The wallet workstream's
// 20261004130000_linked_wallets_chumbucket_type.sql is applied beside it: the
// 'chumbucket' label is admitted, and an account holding that app-held wallet
// is never folded. No DATABASE_URL, linked project or existing cluster is
// ever read.
// Run: VERIFY_LOCAL_PG=true bun test tests/accountSignIns.postgres.test.ts

const MIGRATION = "20261004120000_account_sign_ins.sql";
const CHUMBUCKET_TYPE = "20261004130000_linked_wallets_chumbucket_type.sql";

function migrationsDir(): string {
  const candidates = [
    process.env.CHUMBUCKET_MOBILE_DIR && join(process.env.CHUMBUCKET_MOBILE_DIR, "supabase/migrations"),
    process.env.MIGRATIONS_DIR,
    join(import.meta.dir, "../../mobile/supabase/migrations"),
    join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  const found = candidates.find((c) => existsSync(join(c, MIGRATION)));
  if (!found) throw new Error(`${MIGRATION} not found in: ${candidates.join(", ")}`);
  return found;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

// auth.users
const A = {
  dev: "a0000000-0000-4000-8000-000000000001", // web3 (the owner's wallet account)
  dominion: "a0000000-0000-4000-8000-000000000002", // google + x (auto-linked by email)
  money: "a0000000-0000-4000-8000-000000000003", // google, an account with a funded call
  xonly: "a0000000-0000-4000-8000-000000000004", // x
  xonlyWallet: "a0000000-0000-4000-8000-000000000005", // web3, first sign-in of a wallet linked to @xonly
  stranger: "a0000000-0000-4000-8000-000000000006", // web3, another wallet
  googleNew: "a0000000-0000-4000-8000-000000000007", // google, no account
  phil: "a0000000-0000-4000-8000-000000000008", // google
  philWallet: "a0000000-0000-4000-8000-000000000009", // web3, a wallet linked to @phil, never signed in
  repointed: "a0000000-0000-4000-8000-00000000000a", // web3, a wallet whose link the audit does not back
};
const W = {
  dev: "DevWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  xonly: "XWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  stranger: "StrangerWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  phil: "Phi1Wa11etDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  repointed: "RepointedWa11etEEEEEEEEEEEEEEEEEEEEEEEEEEE",
  chumbucket: "ChumbucketWa11etFFFFFFFFFFFFFFFFFFFFFFFFFF",
};
const FRIEND = "f0000000-0000-4000-8000-000000000001";
const FAN = "f0000000-0000-4000-8000-000000000002";
const CALL = "c0000000-0000-4000-8000-000000000001";
const MONEY_CALL = "c0000000-0000-4000-8000-000000000002";

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
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    email text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider));
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT linked_wallets_wallet_type_check CHECK (wallet_type IN ('mwa', 'embedded', 'imported')));
  CREATE TABLE public.linked_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
    provider_username TEXT, provider_display_name TEXT, provider_avatar_url TEXT, provider_email TEXT,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, provider_subject));
`;

/** What the lockdown and the calls/follows/trading migrations leave, reduced
 *  to the columns this migration reads. */
const LATER = String.raw`
  ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT false;
  CREATE TABLE public.push_tokens (token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    platform text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.person_follows (
    follower_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    followee_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT person_follows_not_self CHECK (follower_user_id <> followee_user_id),
    CONSTRAINT person_follows_pair PRIMARY KEY (follower_user_id, followee_user_id));
  -- calls: author and timestamps immutable, never deleted (20260913140000).
  CREATE TABLE public.calls(id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    thesis text, funding_state text NOT NULL DEFAULT 'NONE',
    created_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz NOT NULL DEFAULT now(),
    hidden_at timestamptz);
  CREATE FUNCTION public.calls_guard_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'calls are never deleted'; END IF;
      IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'a call never changes author'; END IF;
      IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
        RAISE EXCEPTION 'call timestamps are immutable'; END IF;
      RETURN NEW;
    END; $$;
  CREATE TRIGGER trg_calls_guard_immutability BEFORE UPDATE OR DELETE ON public.calls
    FOR EACH ROW EXECUTE FUNCTION public.calls_guard_immutability();
  CREATE TABLE public.panta_trade_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, state text NOT NULL);
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`;

test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "account_sign_ins: link, wallet sign-in, unlink and fold, with every refusal, service-role only",
  () => {
    const dir = migrationsDir();
    const root = mkdtempSync(join(tmpdir(), "chum-account-sign-ins-"));
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
      const json = (text: string) => JSON.parse(svc(`SELECT (${text})::text`)) as Record<string, unknown>;
      const apply = (file: string) => must("psql", [...args, "-f", join(dir, file)]);

      sql(BASE);
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
      sql(LATER);
      apply("20261002180000_trust_safety_and_account.sql");

      // Refuses to install before find-person.
      const early = run("psql", [...args, "-f", join(dir, MIGRATION)]);
      expect(early.ok).toBe(false);
      expect(early.err).toContain("requires 20261003200000_find_person_identities.sql");
      apply("20261003200000_find_person_identities.sql");
      apply(MIGRATION);
      // The Chumbucket wallet's label: refused until its own migration widens the check.
      const chumbucketRow = (user: string) =>
        `INSERT INTO public.linked_wallets(user_id, wallet_address, wallet_type, siws_proof_version, verified_at)
           VALUES ('${user}', '${W.chumbucket}', 'chumbucket', 1, now());`;

      // ── people ──
      const web3 = (auth: string, wallet: string) =>
        `INSERT INTO auth.identities(provider_id, user_id, identity_data, provider, last_sign_in_at)
         VALUES ('web3:solana:${wallet}', '${auth}',
           jsonb_build_object('sub', 'web3:solana:${wallet}', 'custom_claims', jsonb_build_object('chain', 'solana', 'address', '${wallet}')),
           'web3', now());`;
      const oauth = (auth: string, provider: string, subject: string, data: string) =>
        `INSERT INTO auth.identities(provider_id, user_id, identity_data, provider, last_sign_in_at)
         VALUES ('${subject}', '${auth}', '${data}'::jsonb, '${provider}', now());`;
      sql(`INSERT INTO auth.users VALUES ${Object.values(A).map((id) => `('${id}')`).join(",")};
           ${web3(A.dev, W.dev)}
           ${oauth(A.dominion, "google", "g-dominion", '{"email":"owner@example.com","name":"Owner"}')}
           ${oauth(A.dominion, "x", "x-dominion", '{"user_name":"ownerx","avatar_url":"https://pbs.twimg.com/a.jpg"}')}
           ${oauth(A.money, "google", "g-money", '{"email":"money@example.com"}')}
           ${oauth(A.xonly, "x", "x-xonly", '{"user_name":"xonly"}')}
           ${web3(A.xonlyWallet, W.xonly)}
           ${web3(A.stranger, W.stranger)}
           ${oauth(A.googleNew, "google", "g-new", '{"email":"new@example.com"}')}
           ${oauth(A.phil, "google", "g-phil", '{"email":"phil@example.com"}')}
           ${web3(A.philWallet, W.phil)}
           ${web3(A.repointed, W.repointed)}`);

      const create = (auth: string, name: string, handle: string, wallet: string | null) =>
        json(`public.create_social_person_v2('${auth}', '${name}', '${handle}', ${wallet ? `'${wallet}'` : "NULL"})`);
      expect(create(A.dev, "Dev", "dev", W.dev).outcome).toBe("created");
      expect(create(A.dominion, "Dominion", "dominion", null).outcome).toBe("created");
      expect(create(A.money, "Money", "money", null).outcome).toBe("created");
      expect(create(A.xonly, "X Only", "xonly", null).outcome).toBe("created");
      expect(create(A.phil, "Phil", "phil", null).outcome).toBe("created");
      const id = (handle: string) => sql(`SELECT id FROM public.users WHERE handle = '${handle}'`);
      const DEV = id("dev");
      const DOMINION = id("dominion");
      const MONEY = id("money");
      const XONLY = id("xonly");
      const PHIL = id("phil");
      sql(`INSERT INTO public.users(id, full_name, handle) VALUES ('${FRIEND}', 'Friend', 'friend'), ('${FAN}', 'Fan', 'fan');
           INSERT INTO public.calls(id, user_id, thesis, funding_state, created_at, locked_at)
             VALUES ('${CALL}', '${DOMINION}', 'free call', 'NONE', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'),
                    ('${MONEY_CALL}', '${MONEY}', 'funded', 'FILLED', '2026-10-01T11:00:00Z', '2026-10-01T11:00:00Z');
           INSERT INTO public.person_follows VALUES ('${DOMINION}', '${FRIEND}'), ('${FAN}', '${DOMINION}'), ('${DOMINION}', '${DEV}');
           INSERT INTO public.push_tokens(token, user_id, platform) VALUES ('${"t".repeat(24)}', '${DOMINION}', 'ios');
           INSERT INTO public.linked_identities(user_id, provider, provider_subject, provider_username)
             VALUES ('${DOMINION}', 'x', 'legacy-x-dominion', 'ownerx');`);

      const resolve = (auth: string) => json(`public.resolve_auth_user_v1('${auth}')`).user_id ?? null;
      expect(resolve(A.dev)).toBe(DEV);
      expect(resolve(A.dominion)).toBe(DOMINION);
      expect(resolve(A.googleNew)).toBeNull();

      // ── service role only, and the history is append-only ──
      for (const role of ["anon", "authenticated"]) {
        for (const fn of [
          `public.resolve_auth_user_v1('${A.dev}')`,
          `public.account_sign_ins_v1('${DEV}')`,
          `public.complete_account_link_v1('${hash("x")}', '${A.dev}', true, true)`,
          `public.resolve_wallet_sign_in_v1('${A.dev}', '${W.dev}')`,
        ]) {
          const denied = run("psql", args, `SET ROLE ${role}; SELECT ${fn};`);
          expect(denied.ok).toBe(false);
          expect(denied.err).toContain("permission denied");
        }
        const read = run("psql", args, `SET ROLE ${role}; SELECT count(*) FROM public.account_sign_ins;`);
        expect(read.ok).toBe(false);
      }

      // ── the owner's case: @dev links X, which is on @dominion ──
      const issue = (user: string, auth: string, method: string, ticket: string) =>
        json(`public.issue_account_link_ticket_v1('${user}', '${auth}', '${method}', '${hash(ticket)}', 600)`);
      expect(issue(DEV, A.dominion, "x", "nope").reason).toBe("session_mismatch");
      expect(issue(DEV, A.dev, "x", "t-dev-x").ok).toBe(true);
      // The other side must sign in with the method the ticket names.
      expect(json(`public.preview_account_link_v1('${hash("t-dev-x")}', '${A.money}')`).reason).toBe("method_mismatch");
      const preview = json(`public.preview_account_link_v1('${hash("t-dev-x")}', '${A.dominion}')`);
      expect(preview).toMatchObject({ ok: true, outcome: "fold", into_user_id: DEV, other_user_id: DOMINION, refusal: null });
      expect(json(`public.complete_account_link_v1('${hash("t-dev-x")}', '${A.dominion}', true, false)`).reason).toBe("fold_disabled");
      expect(resolve(A.dominion)).toBe(DOMINION); // nothing moved, ticket still usable
      const folded = json(`public.complete_account_link_v1('${hash("t-dev-x")}', '${A.dominion}', true, true)`);
      expect(folded).toMatchObject({ ok: true, outcome: "folded", user_id: DEV, folded_user_id: DOMINION });
      expect(json(`public.complete_account_link_v1('${hash("t-dev-x")}', '${A.dominion}', true, true)`).reason).toBe("ticket_used");

      // X (and Google, on the same sign-in) now land on @dev; the wallet still does.
      expect(resolve(A.dominion)).toBe(DEV);
      expect(resolve(A.dev)).toBe(DEV);
      expect(sql(`SELECT coalesce(auth_user_id::text, 'none') FROM public.users WHERE id = '${DOMINION}'`)).toBe("none");
      // The free call stays exactly as made: same author, same timestamps.
      expect(sql(`SELECT user_id || ' ' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') || ' ' || funding_state
                    FROM public.calls WHERE id = '${CALL}'`)).toBe(`${DOMINION} 2026-10-01T10:00 NONE`);
      // Follows copied both ways, never onto @dev itself; the old rows stay.
      expect(sql(`SELECT string_agg(follower_user_id || '>' || followee_user_id, ',' ORDER BY follower_user_id, followee_user_id)
                    FROM public.person_follows WHERE '${DEV}' IN (follower_user_id, followee_user_id)`))
        .toBe([`${DEV}>${FRIEND}`, `${DOMINION}>${DEV}`, `${FAN}>${DEV}`].sort().join(","));
      expect(sql(`SELECT count(*) FROM public.person_follows WHERE follower_user_id = '${DOMINION}'`)).toBe("2");
      expect(sql(`SELECT user_id FROM public.push_tokens`)).toBe(DEV);
      expect(sql(`SELECT user_id FROM public.linked_identities WHERE provider_subject = 'legacy-x-dominion'`)).toBe(DEV);
      expect(sql(`SELECT count(*) FROM public.account_folds WHERE folded_user_id = '${DOMINION}' AND into_user_id = '${DEV}'`)).toBe("1");
      expect(sql(`SELECT summary ->> 'calls_kept' FROM public.account_folds WHERE folded_user_id = '${DOMINION}'`)).toBe("1");
      expect(sql(`SELECT count(*) FROM public.account_link_audit WHERE action = 'folded' AND user_id = '${DEV}' AND other_user_id = '${DOMINION}'`)).toBe("1");
      // Append-only history.
      expect(run("psql", args, `UPDATE public.account_link_audit SET detail = '{}'`).ok).toBe(false);
      expect(run("psql", args, `DELETE FROM public.account_folds`).ok).toBe(false);

      // Settings sees both sign-ins and what each one is.
      const methods = json(`public.account_sign_ins_v1('${DEV}')`) as {
        sign_ins: { auth_user_id: string; primary: boolean; via: string; identities: { provider: string; label: string }[] }[];
        wallets: { address: string }[];
      };
      expect(methods.sign_ins.map((s) => [s.auth_user_id, s.primary, s.via])).toEqual([
        [A.dev, true, "primary"],
        [A.dominion, false, "fold"],
      ]);
      expect(methods.sign_ins[0]!.identities).toMatchObject([{ provider: "web3", label: W.dev }]);
      expect(methods.sign_ins[1]!.identities.map((i) => `${i.provider}:${i.label}`).sort()).toEqual([
        "google:owner@example.com",
        "x:ownerx",
      ]);
      expect(methods.wallets.map((w) => w.address)).toEqual([W.dev]);
      // Find-by-X now finds @dev.
      expect(svc(`SELECT string_agg(user_id::text, ',') FROM public.person_x_identities_v2('ownerx', NULL)`)).toBe(DEV);

      // A folded account cannot start or receive a link.
      expect(issue(DOMINION, A.dominion, "google", "t-folded").reason).toBe("session_mismatch");

      // ── an account with money is never folded ──
      expect(issue(DEV, A.dev, "google", "t-dev-money").ok).toBe(true);
      expect(json(`public.preview_account_link_v1('${hash("t-dev-money")}', '${A.money}')`))
        .toMatchObject({ outcome: "fold", other_user_id: MONEY, refusal: "has_money", money: "funded_call" });
      expect(json(`public.complete_account_link_v1('${hash("t-dev-money")}', '${A.money}', true, true)`))
        .toMatchObject({ ok: false, reason: "has_money" });
      expect(resolve(A.money)).toBe(MONEY);
      sql(`INSERT INTO public.panta_trade_sessions(user_id, state) VALUES ('${PHIL}', 'FAILED')`);
      expect(sql(`SELECT public.account_money_activity_v1('${PHIL}')`)).toBe("panta_trade");
      sql(`DELETE FROM public.panta_trade_sessions`);
      // The Chumbucket wallet is app-held money: an account holding one is never folded.
      const unlabelled = run("psql", args, chumbucketRow(PHIL));
      expect(unlabelled.ok).toBe(false);
      expect(unlabelled.err).toContain("linked_wallets_wallet_type_check");
      apply(CHUMBUCKET_TYPE);
      apply(CHUMBUCKET_TYPE); // re-runnable
      sql(chumbucketRow(PHIL));
      expect(sql(`SELECT public.account_money_activity_v1('${PHIL}')`)).toBe("app_wallet");
      expect(issue(DEV, A.dev, "google", "t-dev-chumbucket").ok).toBe(true);
      expect(json(`public.preview_account_link_v1('${hash("t-dev-chumbucket")}', '${A.phil}')`))
        .toMatchObject({ outcome: "fold", other_user_id: PHIL, refusal: "has_money", money: "app_wallet" });
      expect(json(`public.complete_account_link_v1('${hash("t-dev-chumbucket")}', '${A.phil}', true, true)`))
        .toMatchObject({ ok: false, reason: "has_money", money: "app_wallet" });
      expect(resolve(A.phil)).toBe(PHIL);
      expect(sql(`SELECT user_id FROM public.linked_wallets WHERE wallet_address = '${W.chumbucket}'`)).toBe(PHIL);
      // Settings lists it with its label.
      expect((json(`public.account_sign_ins_v1('${PHIL}')`).wallets as { wallet_type: string }[]).map((w) => w.wallet_type))
        .toEqual(["chumbucket"]);
      sql(`DELETE FROM public.linked_wallets WHERE wallet_address = '${W.chumbucket}'`);
      expect(sql(`SELECT coalesce(public.account_money_activity_v1('${PHIL}'), 'none')`)).toBe("none");

      // ── a wallet linked to an X account: its first sign-in lands there ──
      expect(json(`public.attach_verified_wallet_v1('${XONLY}', '${W.xonly}', 1::smallint)`).outcome).toBe("linked");
      expect(json(`public.resolve_wallet_sign_in_v1('${A.stranger}', '${W.xonly}')`).reason).toBe("not_this_wallet");
      expect(json(`public.resolve_wallet_sign_in_v1('${A.xonlyWallet}', '${W.xonly}')`))
        .toMatchObject({ ok: true, user_id: XONLY, outcome: "linked" });
      expect(json(`public.resolve_wallet_sign_in_v1('${A.xonlyWallet}', '${W.xonly}')`).outcome).toBe("existing");
      expect(resolve(A.xonlyWallet)).toBe(XONLY);
      expect(json(`public.resolve_wallet_sign_in_v1('${A.stranger}', '${W.stranger}')`).reason).toBe("no_link");
      // A link the audit trail does not back (a legacy repoint) counts for nothing.
      sql(`INSERT INTO public.linked_wallets(user_id, wallet_address, siws_proof_version, verified_at)
             VALUES ('${PHIL}', '${W.repointed}', 1, now());
           INSERT INTO public.wallet_link_audit(wallet_address, action, to_user_id) VALUES ('${W.repointed}', 'linked', '${MONEY}');`);
      expect(json(`public.resolve_wallet_sign_in_v1('${A.repointed}', '${W.repointed}')`).reason).toBe("no_link");
      sql(`DELETE FROM public.linked_wallets WHERE wallet_address = '${W.repointed}'`);
      // A wallet that signs in to one account is a conflict for any other.
      expect(svc(`SELECT public.wallet_sign_in_conflict_v1('${XONLY}', '${W.dev}')`)).toBe("t");
      expect(svc(`SELECT public.wallet_sign_in_conflict_v1('${DEV}', '${W.dev}')`)).toBe("f");
      expect(svc(`SELECT public.wallet_sign_in_conflict_v1('${XONLY}', '${W.stranger}')`)).toBe("f");

      // A sign-in that is an additional one can never also become a primary.
      expect(create(A.xonlyWallet, "Dup", "dupe", null).ok).toBe(false);
      expect(sql(`SELECT count(*) FROM public.users WHERE handle = 'dupe'`)).toBe("0");

      // ── unlink ──
      const unlinkWallet = (user: string, session: string, wallet: string) =>
        json(`public.unlink_sign_in_v1('${user}', '${session}', NULL, '${wallet}')`);
      expect(unlinkWallet(XONLY, A.xonlyWallet, W.xonly).reason).toBe("current_sign_in");
      expect(unlinkWallet(DEV, A.dev, W.dev).reason).toBe("current_sign_in");
      expect(unlinkWallet(DEV, A.dominion, W.dev).reason).toBe("primary_sign_in");
      expect(unlinkWallet(DEV, A.xonly, W.dev).reason).toBe("session_mismatch");
      expect(unlinkWallet(XONLY, A.xonly, W.xonly)).toMatchObject({ ok: true, sign_ins: 1, wallets: 1 });
      expect(resolve(A.xonlyWallet)).toBeNull();
      expect(json(`public.resolve_wallet_sign_in_v1('${A.xonlyWallet}', '${W.xonly}')`).reason).toBe("no_link");
      const signInOf = (auth: string) =>
        sql(`SELECT id FROM public.account_sign_ins WHERE auth_user_id = '${auth}' AND revoked_at IS NULL`);
      const dominionSignIn = signInOf(A.dominion);
      expect(json(`public.unlink_sign_in_v1('${DEV}', '${A.dominion}', '${dominionSignIn}', NULL)`).reason).toBe("current_sign_in");

      // ── a sign-in with no account becomes an additional sign-in ──
      expect(issue(XONLY, A.xonly, "google", "t-xonly-google").ok).toBe(true);
      expect(json(`public.preview_account_link_v1('${hash("t-xonly-google")}', '${A.googleNew}')`).outcome).toBe("link");
      expect(json(`public.complete_account_link_v1('${hash("t-xonly-google")}', '${A.googleNew}', false, true)`).reason).toBe("linking_disabled");
      expect(json(`public.complete_account_link_v1('${hash("t-xonly-google")}', '${A.googleNew}', true, false)`).outcome).toBe("linked");
      expect(resolve(A.googleNew)).toBe(XONLY);
      // Tickets: one live per account, ten a minute.
      expect(issue(XONLY, A.xonly, "x", "t-a").ok).toBe(true);
      expect(issue(XONLY, A.xonly, "x", "t-b").ok).toBe(true);
      expect(json(`public.preview_account_link_v1('${hash("t-a")}', '${A.xonly}')`).reason).toBe("ticket_used");

      // ── fold through a wallet that was linked but never signed in ──
      expect(json(`public.attach_verified_wallet_v1('${PHIL}', '${W.phil}', 1::smallint)`).outcome).toBe("linked");
      expect(issue(DEV, A.dev, "wallet", "t-dev-wallet").ok).toBe(true);
      expect(json(`public.preview_account_link_v1('${hash("t-dev-wallet")}', '${A.philWallet}')`))
        .toMatchObject({ outcome: "fold", other_user_id: PHIL, refusal: null });
      expect(json(`public.complete_account_link_v1('${hash("t-dev-wallet")}', '${A.philWallet}', true, true)`).outcome).toBe("folded");
      expect(resolve(A.philWallet)).toBe(DEV);
      expect(resolve(A.phil)).toBe(DEV);
      expect(sql(`SELECT user_id FROM public.linked_wallets WHERE wallet_address = '${W.phil}'`)).toBe(DEV);
      expect(sql(`SELECT action || ':' || to_user_id FROM public.wallet_link_audit WHERE wallet_address = '${W.phil}' ORDER BY created_at DESC LIMIT 1`))
        .toBe(`transferred:${DEV}`);
      // After the fold the audit backs @dev, so the wallet's link is proven for @dev.
      expect(svc(`SELECT public.wallet_sign_in_conflict_v1('${DEV}', '${W.phil}')`)).toBe("f");

      // Now @dev can unlink the folded sign-in (signed in with the wallet).
      expect(json(`public.unlink_sign_in_v1('${DEV}', '${A.dev}', '${dominionSignIn}', NULL)`)).toMatchObject({ ok: true, sign_ins: 1 });
      expect(resolve(A.dominion)).toBeNull();

      // ── a deleted account is reached by none of its sign-ins ──
      expect(json(`public.delete_account_v1('${DEV}', '${A.dev}')`).outcome).toBe("deleted");
      expect(resolve(A.dev)).toBeNull();
      expect(resolve(A.philWallet)).toBeNull();
      expect(resolve(A.phil)).toBeNull();
      // …and is free to start a new account, or to be linked to another one.
      expect(create(A.phil, "Phil Again", "phil_again", null).outcome).toBe("created");
      expect(resolve(A.phil)).toBe(id("phil_again"));
      expect(issue(XONLY, A.xonly, "wallet", "t-after-delete").ok).toBe(true);
      expect(json(`public.complete_account_link_v1('${hash("t-after-delete")}', '${A.philWallet}', true, false)`).outcome).toBe("linked");
      expect(resolve(A.philWallet)).toBe(XONLY);
      expect(sql(`SELECT count(*) FROM public.account_sign_ins WHERE revoked_reason = 'account_deleted'`)).toBe("1");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
