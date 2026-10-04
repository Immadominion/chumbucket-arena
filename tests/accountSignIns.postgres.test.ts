import { expect, test } from "bun:test";
import { createHash, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: Supabase Auth's auth.identities, the REAL
// identity chain (nonces, linked wallets, onboarding, wallet sign-in and
// usernames, the identity lock, trust and deletion, find-person), then the
// REAL 20261004120000_account_sign_ins.sql — applied twice (it is re-runnable)
// — judged on the owner's case (@dev links X, which is on @dominion;
// @dominion folds into @dev), on who may fold (only the folded account's own
// first sign-in), on every money refusal (fail closed), on a wallet sign-in
// landing on the account it was linked to, on unlinking, on deleting the
// whole person from any sign-in, and on who may call any of it. The wallet
// workstream's 20261004130000_linked_wallets_chumbucket_type.sql is applied
// beside it: the 'chumbucket' label is admitted, and an account holding that
// app-held wallet is never folded. No DATABASE_URL, linked project or
// existing cluster is ever read.
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
  dev: "a0000000-0000-4000-8000-000000000001", // web3: the owner's wallet account
  dominion: "a0000000-0000-4000-8000-000000000002", // google + x (auto-linked by email)
  money: "a0000000-0000-4000-8000-000000000003", // google: a funded call
  xonly: "a0000000-0000-4000-8000-000000000004", // x
  xonlyWallet: "a0000000-0000-4000-8000-000000000005", // web3: first sign-in of a wallet linked to @xonly
  stranger: "a0000000-0000-4000-8000-000000000006", // web3: another wallet
  googleNew: "a0000000-0000-4000-8000-000000000007", // google: no account
  phil: "a0000000-0000-4000-8000-000000000008", // web3: @phil was made with this wallet
  repointed: "a0000000-0000-4000-8000-000000000009", // web3: a link the audit does not back
  escrow: "a0000000-0000-4000-8000-00000000000a", // google: made a SOL escrow challenge
  escrowWallet: "a0000000-0000-4000-8000-00000000000b", // google: its wallet is in an escrow
  app: "a0000000-0000-4000-8000-00000000000c", // google: holds an app wallet
  plain: "a0000000-0000-4000-8000-00000000000d", // google: nothing at all
  bare: "a0000000-0000-4000-8000-00000000000e", // web3: a wallet merely linked to @plain
  wal2: "a0000000-0000-4000-8000-00000000000f", // web3: another wallet-made account
};
const W = {
  dev: "DevWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  xonly: "XWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  stranger: "StrangerWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  phil: "Phi1Wa11etDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  repointed: "RepointedWa11etEEEEEEEEEEEEEEEEEEEEEEEEEEE",
  escrow: "EscrowWa11etFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
  app: "AppWa11etGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
  bare: "BareWa11etHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH",
  wal2: "SecondWa11etJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ",
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

/** What the lockdown, calls, trading and legacy escrow migrations leave,
 *  reduced to the columns this migration reads. */
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
  CREATE TABLE public.venue_orders(order_id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.users(id));
  CREATE TABLE public.venue_positions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.users(id));
  CREATE TABLE public.panta_trade_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, wallet_address text, state text NOT NULL);
  CREATE TABLE public.panta_claim_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id), wallet_address text);
  CREATE TABLE public.market_creation_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    publisher_id uuid NOT NULL REFERENCES public.users(id), wallet_address text);
  CREATE TABLE public.prediction_positions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES public.users(id), wallet_address text NOT NULL);
  CREATE TABLE public.claims(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES public.users(id), wallet_address text NOT NULL);
  -- The legacy SOL escrow (database_migrations/001_complete_schema.sql).
  CREATE TABLE public.challenges(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id uuid REFERENCES public.users(id), participant_id uuid REFERENCES public.users(id),
    witness_id uuid REFERENCES public.users(id), winner_id text, creator_wallet_address text,
    member1_address text, member2_address text);
  CREATE TABLE public.challenge_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge_id uuid REFERENCES public.challenges(id), wallet_address text NOT NULL);
  CREATE TABLE public.challenge_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge_id uuid REFERENCES public.challenges(id), from_address text, to_address text);
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`;

test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "account_sign_ins: link, wallet sign-in, unlink, fold and deletion, with every refusal, service-role only",
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
      const fails = (text: string) => run("psql", args, text);
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
      apply(MIGRATION); // re-runnable

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
           ${web3(A.phil, W.phil)}
           ${web3(A.repointed, W.repointed)}
           ${oauth(A.escrow, "google", "g-escrow", '{"email":"escrow@example.com"}')}
           ${oauth(A.escrowWallet, "google", "g-escrow-w", '{"email":"escrow-w@example.com"}')}
           ${oauth(A.app, "google", "g-app", '{"email":"app@example.com"}')}
           ${oauth(A.plain, "google", "g-plain", '{"email":"plain@example.com"}')}
           ${web3(A.bare, W.bare)}
           ${web3(A.wal2, W.wal2)}`);

      const create = (auth: string, name: string, handle: string, wallet: string | null) =>
        json(`public.create_social_person_v2('${auth}', '${name}', '${handle}', ${wallet ? `'${wallet}'` : "NULL"})`);
      for (const [auth, name, handle, wallet] of [
        [A.dev, "Dev", "dev", W.dev],
        [A.dominion, "Dominion", "dominion", null],
        [A.money, "Money", "money", null],
        [A.xonly, "X Only", "xonly", null],
        [A.phil, "Phil", "phil", W.phil],
        [A.escrow, "Escrow", "escrow", null],
        [A.escrowWallet, "Escrow W", "escrow_w", null],
        [A.app, "App", "app_wallet", null],
        [A.plain, "Plain", "plain", null],
        [A.wal2, "Second", "second", W.wal2],
      ] as const) expect(create(auth, name, handle, wallet).outcome).toBe("created");
      const id = (handle: string) => sql(`SELECT id FROM public.users WHERE handle = '${handle}'`);
      const [DEV, DOMINION, MONEY, XONLY, PHIL, ESCROW, ESCROW_W, APP, PLAIN, WAL2] = [
        "dev", "dominion", "money", "xonly", "phil", "escrow", "escrow_w", "app_wallet", "plain", "second",
      ].map(id) as [string, string, string, string, string, string, string, string, string, string];
      sql(`INSERT INTO public.users(id, full_name, handle) VALUES ('${FRIEND}', 'Friend', 'friend'), ('${FAN}', 'Fan', 'fan');
           INSERT INTO public.calls(id, user_id, thesis, funding_state, created_at, locked_at)
             VALUES ('${CALL}', '${DOMINION}', 'free call', 'NONE', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'),
                    ('${MONEY_CALL}', '${MONEY}', 'funded', 'FILLED', '2026-10-01T11:00:00Z', '2026-10-01T11:00:00Z');
           INSERT INTO public.person_follows VALUES ('${DOMINION}', '${FRIEND}'), ('${FAN}', '${DOMINION}'), ('${DOMINION}', '${DEV}');
           INSERT INTO public.push_tokens(token, user_id, platform) VALUES ('${"t".repeat(24)}', '${DOMINION}', 'ios');
           INSERT INTO public.linked_identities(user_id, provider, provider_subject, provider_username)
             VALUES ('${DOMINION}', 'x', 'legacy-x-dominion', 'ownerx');
           INSERT INTO public.challenges(creator_id) VALUES ('${ESCROW}');`);

      const resolve = (auth: string) => json(`public.resolve_auth_user_v1('${auth}')`).user_id ?? null;
      expect(resolve(A.dev)).toBe(DEV);
      expect(resolve(A.dominion)).toBe(DOMINION);
      expect(resolve(A.googleNew)).toBeNull();

      // ── service role only, and the history is append-only ──
      for (const role of ["anon", "authenticated"]) {
        for (const fn of [
          `public.resolve_auth_user_v1('${A.dev}')`,
          `public.account_sign_ins_v1('${DEV}')`,
          `public.complete_account_link_v1('${hash("x")}', '${A.dev}', true, true, 'fold', NULL)`,
          `public.resolve_wallet_sign_in_v1('${A.dev}', '${W.dev}')`,
          `public.delete_account_v2('${DEV}', '${A.dev}')`,
        ]) {
          const denied = fails(`SET ROLE ${role}; SELECT ${fn};`);
          expect(denied.ok).toBe(false);
          expect(denied.err).toContain("permission denied");
        }
        expect(fails(`SET ROLE ${role}; SELECT count(*) FROM public.account_sign_ins;`).ok).toBe(false);
      }

      const issue = (user: string, auth: string, method: string, ticket: string) =>
        json(`public.issue_account_link_ticket_v1('${user}', '${auth}', '${method}', '${hash(ticket)}', 600)`);
      const preview = (ticket: string, auth: string) => json(`public.preview_account_link_v1('${hash(ticket)}', '${auth}')`);
      const complete = (ticket: string, auth: string, outcome: string, other: string | null, link = true, fold = true) =>
        json(`public.complete_account_link_v1('${hash(ticket)}', '${auth}', ${link}, ${fold}, '${outcome}', ${other ? `'${other}'` : "NULL"})`);

      // ── the owner's case: @dev links X, which is on @dominion ──
      expect(issue(DEV, A.dominion, "x", "nope").reason).toBe("session_mismatch");
      expect(issue(DEV, A.dev, "x", "t-dev-x").ok).toBe(true);
      // The other side must sign in with the method the ticket names.
      expect(preview("t-dev-x", A.money).reason).toBe("method_mismatch");
      // The preview names what was proven: the X account, not just the account.
      expect(preview("t-dev-x", A.dominion)).toMatchObject({
        ok: true, outcome: "fold", into_user_id: DEV, other_user_id: DOMINION, refusal: null, proof_label: "ownerx",
      });
      // What the person confirms must still be true.
      expect(complete("t-dev-x", A.dominion, "link", null).reason).toBe("preview_changed");
      expect(complete("t-dev-x", A.dominion, "fold", MONEY).reason).toBe("preview_changed");
      expect(complete("t-dev-x", A.dominion, "fold", DOMINION, true, false).reason).toBe("fold_disabled");
      expect(resolve(A.dominion)).toBe(DOMINION); // nothing moved, ticket still usable
      const folded = complete("t-dev-x", A.dominion, "fold", DOMINION);
      expect(folded).toMatchObject({
        ok: true, outcome: "folded", user_id: DEV, folded_user_id: DOMINION,
        folded_handle: "dominion", into_handle: "dev",
      });
      // The folded account's devices are named so the BFF can tell them.
      expect(folded.notify).toEqual([{ token: "t".repeat(24), platform: "ios" }]);
      expect(complete("t-dev-x", A.dominion, "fold", DOMINION).reason).toBe("ticket_used");

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
      expect(sql(`SELECT user_id FROM public.push_tokens`)).toBe(DEV);
      expect(sql(`SELECT user_id FROM public.linked_identities WHERE provider_subject = 'legacy-x-dominion'`)).toBe(DEV);
      expect(sql(`SELECT summary ->> 'calls_kept' FROM public.account_folds WHERE folded_user_id = '${DOMINION}'`)).toBe("1");
      expect(sql(`SELECT count(*) FROM public.account_link_audit WHERE action = 'folded' AND user_id = '${DEV}' AND other_user_id = '${DOMINION}'`)).toBe("1");
      expect(fails(`UPDATE public.account_link_audit SET detail = '{}'`).ok).toBe(false);
      expect(fails(`DELETE FROM public.account_folds`).ok).toBe(false);
      // A folded account never signs in again, by any path.
      expect(fails(`UPDATE public.users SET auth_user_id = '${A.stranger}' WHERE id = '${DOMINION}'`).err).toContain("never signs in again");
      expect(json(`public.bind_wallet_session_v1('${A.stranger}', '${W.stranger}')`).reason).toBe("no_profile");
      // …and no money session can start on it.
      expect(fails(`INSERT INTO public.panta_trade_sessions(user_id, state) VALUES ('${DOMINION}', 'PREPARING')`).err)
        .toContain("folded or deleted");

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
      expect(svc(`SELECT string_agg(user_id::text, ',') FROM public.person_x_identities_v2('ownerx', NULL)`)).toBe(DEV);
      expect(issue(DOMINION, A.dominion, "google", "t-folded").reason).toBe("session_mismatch");

      // ── money: never folded, and anything unknowable counts as money ──
      expect(issue(PLAIN, A.plain, "google", "t-money").ok).toBe(true);
      expect(preview("t-money", A.money)).toMatchObject({ outcome: "fold", other_user_id: MONEY, refusal: "has_money" });
      expect(complete("t-money", A.money, "fold", MONEY)).toMatchObject({ ok: false, reason: "has_money", money: "funded_call" });
      expect(resolve(A.money)).toBe(MONEY);
      const money = (user: string) => sql(`SELECT coalesce(public.account_money_activity_v1('${user}'), 'none')`);
      expect(money(ESCROW)).toBe("escrow_challenge");
      sql(`INSERT INTO public.linked_wallets(user_id, wallet_address, siws_proof_version, verified_at) VALUES ('${ESCROW_W}', '${W.escrow}', 1, now());
           INSERT INTO public.challenge_participants(wallet_address) VALUES ('${W.escrow}');`);
      expect(money(ESCROW_W)).toBe("escrow_participant");
      // The wallet workstream's app-held wallet type is money-bearing. Its label
      // is refused until its own migration widens the check.
      const chumbucketRow = `INSERT INTO public.linked_wallets(user_id, wallet_address, wallet_type, siws_proof_version, verified_at)
             VALUES ('${APP}', '${W.app}', 'chumbucket', 1, now());`;
      const unlabelled = run("psql", args, chumbucketRow);
      expect(unlabelled.ok).toBe(false);
      expect(unlabelled.err).toContain("linked_wallets_wallet_type_check");
      apply(CHUMBUCKET_TYPE);
      apply(CHUMBUCKET_TYPE); // re-runnable
      sql(chumbucketRow);
      expect(money(APP)).toBe("app_wallet");
      // An account holding the Chumbucket wallet is never folded, and keeps it.
      expect(issue(PLAIN, A.plain, "google", "t-app").ok).toBe(true);
      expect(preview("t-app", A.app)).toMatchObject({ outcome: "fold", other_user_id: APP, refusal: "has_money" });
      expect(complete("t-app", A.app, "fold", APP)).toMatchObject({ ok: false, reason: "has_money", money: "app_wallet" });
      expect(resolve(A.app)).toBe(APP);
      expect(sql(`SELECT user_id FROM public.linked_wallets WHERE wallet_address = '${W.app}'`)).toBe(APP);
      // Settings lists it with its label.
      expect((json(`public.account_sign_ins_v1('${APP}')`).wallets as { wallet_type: string }[]).map((w) => w.wallet_type))
        .toEqual(["chumbucket"]);
      expect(money(PLAIN)).toBe("none");
      for (const tbl of ["claims", "challenge_transactions"]) {
        sql(`ALTER TABLE public.${tbl} RENAME TO ${tbl}_away`);
        expect(money(PLAIN)).toBe("unverifiable");
        sql(`ALTER TABLE public.${tbl}_away RENAME TO ${tbl}`);
      }
      sql(`INSERT INTO public.claims(wallet_address) VALUES ('${W.wal2}')`);
      expect(money(WAL2)).toBe("prediction_claim");
      sql(`DELETE FROM public.claims`);

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
             VALUES ('${PLAIN}', '${W.repointed}', 1, now());
           INSERT INTO public.wallet_link_audit(wallet_address, action, to_user_id) VALUES ('${W.repointed}', 'linked', '${MONEY}');`);
      expect(json(`public.resolve_wallet_sign_in_v1('${A.repointed}', '${W.repointed}')`).reason).toBe("no_link");
      sql(`DELETE FROM public.linked_wallets WHERE wallet_address = '${W.repointed}'`);
      // A wallet that signs in to one account is a conflict for any other.
      expect(svc(`SELECT public.wallet_sign_in_conflict_v1('${XONLY}', '${W.dev}')`)).toBe("t");
      expect(svc(`SELECT public.wallet_sign_in_conflict_v1('${DEV}', '${W.dev}')`)).toBe("f");
      // A sign-in that is an additional one can never also become a primary.
      expect(create(A.xonlyWallet, "Dup", "dupe", null).ok).toBe(false);
      expect(sql(`SELECT count(*) FROM public.users WHERE handle = 'dupe'`)).toBe("0");

      // ── only an account's own first sign-in can fold it ──
      expect(json(`public.attach_verified_wallet_v1('${PLAIN}', '${W.bare}', 1::smallint)`).outcome).toBe("linked");
      expect(issue(DEV, A.dev, "wallet", "t-bare").ok).toBe(true);
      expect(preview("t-bare", A.bare)).toMatchObject({
        outcome: "fold", other_user_id: PLAIN, refusal: "not_primary_sign_in", proof_label: W.bare,
      });
      expect(complete("t-bare", A.bare, "fold", PLAIN).reason).toBe("not_primary_sign_in");
      expect(resolve(A.plain)).toBe(PLAIN);
      expect(issue(PLAIN, A.plain, "wallet", "t-extra").ok).toBe(true);
      expect(complete("t-extra", A.xonlyWallet, "fold", XONLY).reason).toBe("not_primary_sign_in");

      // ── unlink ──
      const unlinkWallet = (user: string, session: string, wallet: string) =>
        json(`public.unlink_sign_in_v1('${user}', '${session}', NULL, '${wallet}')`);
      expect(unlinkWallet(XONLY, A.xonlyWallet, W.xonly).reason).toBe("current_sign_in");
      expect(unlinkWallet(DEV, A.dev, W.dev).reason).toBe("current_sign_in");
      expect(unlinkWallet(DEV, A.dominion, W.dev).reason).toBe("primary_sign_in");
      expect(unlinkWallet(DEV, A.xonly, W.dev).reason).toBe("session_mismatch");
      // The legacy wallet column never keeps naming a wallet the account let go.
      sql(`UPDATE public.users SET wallet_address = '${W.xonly}' WHERE id = '${XONLY}'`);
      expect(unlinkWallet(XONLY, A.xonly, W.xonly)).toMatchObject({ ok: true, sign_ins: 1, wallets: 1 });
      expect(sql(`SELECT coalesce(wallet_address, 'none') FROM public.users WHERE id = '${XONLY}'`)).toBe("none");
      expect(resolve(A.xonlyWallet)).toBeNull();
      expect(json(`public.resolve_wallet_sign_in_v1('${A.xonlyWallet}', '${W.xonly}')`).reason).toBe("no_link");
      const dominionSignIn = sql(`SELECT id FROM public.account_sign_ins WHERE auth_user_id = '${A.dominion}' AND revoked_at IS NULL`);
      expect(json(`public.unlink_sign_in_v1('${DEV}', '${A.dominion}', '${dominionSignIn}', NULL)`).reason).toBe("current_sign_in");

      // ── a sign-in with no account becomes an additional sign-in ──
      expect(issue(XONLY, A.xonly, "google", "t-xonly-google").ok).toBe(true);
      expect(preview("t-xonly-google", A.googleNew)).toMatchObject({ outcome: "link", proof_label: "new@example.com" });
      expect(complete("t-xonly-google", A.googleNew, "link", null, false, true).reason).toBe("linking_disabled");
      expect(complete("t-xonly-google", A.googleNew, "link", null, true, false).outcome).toBe("linked");
      expect(resolve(A.googleNew)).toBe(XONLY);
      // Tickets: one live per account.
      expect(issue(XONLY, A.xonly, "x", "t-a").ok).toBe(true);
      expect(issue(XONLY, A.xonly, "x", "t-b").ok).toBe(true);
      expect(preview("t-a", A.xonly).reason).toBe("ticket_used");

      // ── a wallet-made account folds by its own wallet; its wallet column moves ──
      expect(issue(XONLY, A.xonly, "wallet", "t-phil").ok).toBe(true);
      expect(preview("t-phil", A.phil)).toMatchObject({ outcome: "fold", other_user_id: PHIL, refusal: null });
      expect(complete("t-phil", A.phil, "fold", PHIL).outcome).toBe("folded");
      expect(resolve(A.phil)).toBe(XONLY);
      expect(sql(`SELECT coalesce(wallet_address, 'none') FROM public.users WHERE id = '${PHIL}'`)).toBe("none");
      expect(sql(`SELECT wallet_address FROM public.users WHERE id = '${XONLY}'`)).toBe(W.phil);
      expect(sql(`SELECT user_id FROM public.linked_wallets WHERE wallet_address = '${W.phil}'`)).toBe(XONLY);
      expect(sql(`SELECT action || ':' || to_user_id FROM public.wallet_link_audit WHERE wallet_address = '${W.phil}' ORDER BY created_at DESC LIMIT 1`))
        .toBe(`transferred:${XONLY}`);
      // Two legacy wallet columns: refused rather than orphan one.
      expect(issue(XONLY, A.xonly, "wallet", "t-wal2").ok).toBe(true);
      expect(preview("t-wal2", A.wal2).refusal).toBe("wallet_conflict");
      expect(complete("t-wal2", A.wal2, "fold", WAL2).reason).toBe("wallet_conflict");
      // A live account still opens money sessions.
      sql(`INSERT INTO public.panta_trade_sessions(user_id, state) VALUES ('${XONLY}', 'PREPARING')`);

      // ── deletion: the whole person, from any sign-in ──
      expect(json(`public.delete_account_v2('${XONLY}', '${A.dominion}')`).reason).toBe("session_mismatch");
      const deleted = json(`public.delete_account_v2('${DEV}', '${A.dominion}')`);
      expect(deleted).toMatchObject({ ok: true, outcome: "deleted", user_id: DEV, folded_user_ids: [DOMINION] });
      expect((deleted.auth_user_ids as string[]).sort()).toEqual([A.dev, A.dominion].sort());
      expect(resolve(A.dev)).toBeNull();
      expect(resolve(A.dominion)).toBeNull();
      expect(sql(`SELECT full_name || ' ' || coalesce(handle, '') || ' ' || (deleted_at IS NOT NULL) FROM public.users WHERE id = '${DOMINION}'`))
        .toMatch(/^Deleted account deleted_[0-9a-f]+ true$/);
      expect(sql(`SELECT user_id FROM public.calls WHERE id = '${CALL}'`)).toBe(DOMINION); // calls stay
      const retried = json(`public.delete_account_v2(NULL, '${A.dev}')`);
      expect(retried).toMatchObject({ ok: true, outcome: "already_deleted", user_id: DEV });
      expect((retried.auth_user_ids as string[]).sort()).toEqual([A.dev, A.dominion].sort());
      expect(json(`public.delete_account_v2(NULL, '${A.dominion}')`).outcome).toBe("already_deleted");
      // …and a deleted account's sign-ins are free to start again.
      expect(create(A.dominion, "Again", "again", null).outcome).toBe("created");
      apply(MIGRATION); // still re-runnable with data in place
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
