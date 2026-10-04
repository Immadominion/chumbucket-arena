import { expect, test } from "bun:test";
import { randomInt, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: the real calls and Panta trade migrations,
// then 20261004140000_money_calls.sql and 20261004140500_wallet_transfers.sql
// (each applied twice: re-runnable). No DATABASE_URL, linked project or
// existing cluster is ever read.
// Run: VERIFY_LOCAL_PG=true [MOBILE_MIGRATIONS_DIR=…] bun test tests/moneyLedgers.postgres.test.ts
test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "money_calls and wallet_transfers: funded only by a fill, never expired mid-trade, history permanent",
  () => {
    const root = mkdtempSync(join(tmpdir(), "chum-money-"));
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
      /** As the BFF: the service role. */
      const bff = (text: string) => sql(`SET ROLE service_role;\n${text}`);
      const refused = (text: string, pattern: RegExp, role = "service_role") => {
        const r = run("psql", args, `SET ROLE ${role};\n${text}`);
        expect(r.ok).toBe(false);
        expect(r.err).toMatch(pattern);
      };
      const migrations = process.env.MOBILE_MIGRATIONS_DIR ?? join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations");
      const apply = (file: string) => must("psql", [...args, "-f", join(migrations, file)]);

      sql(String.raw`
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
        CREATE TABLE public.users(id UUID PRIMARY KEY, wallet_address TEXT UNIQUE, full_name TEXT, handle TEXT UNIQUE);
        CREATE TABLE public.follows(follower_user_id UUID REFERENCES public.users(id), followee_user_id UUID REFERENCES public.users(id));
        GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
      `);
      // money_calls refuses to install before the trade ledger exists.
      const early = run("psql", [...args, "-f", join(migrations, "20261004140000_money_calls.sql")]);
      expect(early.ok).toBe(false);
      expect(early.err).toContain("requires 20260929120000_panta_trade_sessions.sql");
      for (const file of [
        "20260913120000_auth_identity_auth_user_link.sql",
        "20260913130000_venue_market_catalog.sql",
        "20260913130500_venue_market_resolutions.sql",
        "20260913140000_social_calls_calls.sql",
        "20260928210000_panta_share_price_evidence.sql",
        "20260929120000_panta_trade_sessions.sql",
      ]) apply(file);
      apply("20261004140000_money_calls.sql");
      apply("20261004140000_money_calls.sql"); // re-runnable
      apply("20261004140500_wallet_transfers.sql");
      apply("20261004140500_wallet_transfers.sql"); // re-runnable

      const ANN = randomUUID(), BOB = randomUUID();
      const W = "AnnWa11et1111111111111111111111111111111111";
      const FRIEND = "FriendWa11et1111111111111111111111111111111";
      sql(`INSERT INTO public.users(id, wallet_address) VALUES ('${ANN}', '${W}'), ('${BOB}', NULL);`);
      /** A fresh open market: one live call per person per market. */
      const market = (): string => {
        const id = randomUUID();
        sql(`INSERT INTO public.venue_markets(id, venue, venue_event_id, venue_market_id, question, rules_text, outcomes, status, raw_status,
            opens_at, closes_at, payload_version, raw_payload)
          VALUES ('${id}', 'fixture', '${id}', 'vm-${id}', 'Synthetic local question', 'Synthetic exact rules',
            '[{"side":"YES"},{"side":"NO"}]', 'OPEN', 'open', now() - interval '1 hour', now() + interval '1 hour', 1, '{"synthetic":true}');`);
        return id;
      };
      const marketOf = new Map<string, string>();
      const call = (id: string, user: string, side: "YES" | "NO", m: string) => {
        marketOf.set(id, m);
        bff(`INSERT INTO public.calls(id, user_id, market_id, side, visibility) VALUES ('${id}', '${user}', '${m}', '${side}', 'public');`);
      };
      const intent = (callId: string, user: string, m: string, over: { kind?: string; target?: string | null; side?: string; key?: string } = {}) =>
        `INSERT INTO public.money_calls(call_id, user_id, market_id, side, kind, target_call_id, amount_base_units, max_slippage_bps,
          wallet_address, idempotency_key, request_fingerprint, expires_at)
         VALUES ('${callId}', '${user}', '${m}', '${over.side ?? "YES"}', '${over.kind ?? "own"}',
          ${over.target ? `'${over.target}'` : "NULL"}, 5000000, 100, '${W}', '${over.key ?? `tap-key-${callId.slice(0, 8)}-abcdef`}',
          '${"a".repeat(64)}', now() + interval '10 minutes');`;
      const state = (callId: string) => sql(`SELECT state || '|' || coalesce(ended_reason, '') FROM public.money_calls WHERE call_id = '${callId}'`);
      // Trade rows for the money guard's reads only. The trade ledger's own
      // JSON evidence rules are proven in pantaTrading.postgres.test.ts; here
      // they are relaxed so a state can be seeded without a real approval.
      sql(`ALTER TABLE public.panta_trade_sessions DROP CONSTRAINT panta_trade_prepared_binding,
        DROP CONSTRAINT panta_trade_confirmed_evidence;`);
      const trade = (callId: string, user: string, tradeState: "SUBMITTED" | "FILLED" | "FAILED") => {
        const id = randomUUID();
        const signature = "1".repeat(40) + id.replace(/-/g, "").replace(/0/g, "2");
        sql(`SET session_replication_role = replica;
          INSERT INTO public.panta_trade_sessions(id, user_id, call_id, market_id, wallet_address, venue_market_id, side, amount_base_units,
            max_slippage_bps, idempotency_key, request_fingerprint, state, provider_order_id, prepared, signed_transaction, signature, fill_evidence)
          VALUES ('${id}', '${user}', '${callId}', '${marketOf.get(callId)}', '${W}', 'vm-money', 'YES', 5000000, 100, 'trade-${id}', '${"b".repeat(64)}',
            '${tradeState}', 'ord-${id}', '{}'::jsonb, 'AAAA', '${signature}', ${tradeState === "FILLED" ? "'{}'::jsonb" : "NULL"});`);
        return id;
      };

      // ── money_calls ──
      const m1 = market(), m2 = market(), m3 = market(), m4 = market();
      const X = randomUUID();
      bff(intent(X, ANN, m1));
      expect(state(X)).toBe("PENDING|");
      // Written before its call, and only then the call.
      call(X, ANN, "YES", m1);
      const existing = randomUUID();
      call(existing, ANN, "NO", m2);
      refused(intent(existing, ANN, m2, { key: "tap-key-existing-abcdef" }), /recorded before its call exists/);
      refused(intent(randomUUID(), ANN, m3, { key: "tap-key-badstart-abcdef" }).replace("expires_at)", "expires_at, state)")
        .replace("'10 minutes')", "'10 minutes', 'FUNDED')"), /starts PENDING/);
      // A tail or fade answers someone else's call on the same market and the right side.
      const bobs = randomUUID();
      call(bobs, BOB, "YES", m3);
      refused(intent(randomUUID(), ANN, m3, { kind: "back", target: bobs, side: "NO", key: "tap-key-badback-abcdef" }), /same or the opposite side/);
      refused(intent(randomUUID(), ANN, m2, { kind: "fade", target: existing, side: "YES", key: "tap-key-selffade-abcdef" }), /same or the opposite side/);
      refused(intent(randomUUID(), ANN, m3, { kind: "back", target: bobs, side: "YES", key: "tap-key-othermkt-abcdef" }).replace(`'${m3}'`, `'${m1}'`),
        /same or the opposite side/);
      refused(intent(randomUUID(), ANN, m3, { kind: "back", target: null, key: "tap-key-notarget-abcdef" }), /money_calls_target_matches_kind/);
      bff(intent(randomUUID(), BOB, m2, { kind: "fade", target: existing, side: "YES", key: "tap-key-goodfade-abcdef" }));
      // The intent never changes: no column grant, and the guard for any role.
      refused(`UPDATE public.money_calls SET amount_base_units = 6000000 WHERE call_id = '${X}';`, /permission denied/);
      refused(`UPDATE public.money_calls SET side = 'NO' WHERE call_id = '${X}';`, /intent is immutable/, "test_admin");
      expect(state(X)).toBe("PENDING|");
      // FUNDED only with a FILLED trade.
      refused(`UPDATE public.money_calls SET state = 'FUNDED', ended_reason = 'filled' WHERE call_id = '${X}';`, /funded only by a confirmed fill/);
      // Never EXPIRED while a trade is going through.
      const t = trade(X, ANN, "SUBMITTED");
      refused(`UPDATE public.money_calls SET state = 'EXPIRED', ended_reason = 'expired' WHERE call_id = '${X}';`, /cannot expire/);
      refused(`UPDATE public.money_calls SET state = 'FUNDED', ended_reason = 'filled' WHERE call_id = '${X}';`, /funded only by a confirmed fill/);
      // Reasons match states.
      refused(`UPDATE public.money_calls SET state = 'FREE', ended_reason = 'expired' WHERE call_id = '${X}';`, /money_calls_reason_matches_state/);
      // A retry bumps attempts and may switch wallet; attempts never go down.
      bff(`UPDATE public.money_calls SET attempts = 2, expires_at = expires_at + interval '1 minute' WHERE call_id = '${X}';`);
      refused(`UPDATE public.money_calls SET attempts = 1 WHERE call_id = '${X}';`, /only go up/);
      // The fill lands: FUNDED, then final.
      sql(`SET session_replication_role = replica; UPDATE public.panta_trade_sessions SET state = 'FILLED', fill_evidence = '{}'::jsonb WHERE id = '${t}';`);
      bff(`UPDATE public.money_calls SET state = 'FUNDED', ended_reason = 'filled' WHERE call_id = '${X}';`);
      expect(state(X)).toBe("FUNDED|filled");
      refused(`UPDATE public.money_calls SET updated_at = now() WHERE call_id = '${X}';`, /funded money call is final/);
      // Abandoned: EXPIRED with nothing going through; terminal except for a late fill.
      const Y = randomUUID();
      bff(intent(Y, ANN, m4, { key: "tap-key-abandoned-abcdef" }));
      bff(`UPDATE public.money_calls SET state = 'EXPIRED', ended_reason = 'expired' WHERE call_id = '${Y}';`);
      refused(`UPDATE public.money_calls SET state = 'FREE', ended_reason = 'kept_free' WHERE call_id = '${Y}';`, /Invalid money call transition/);
      refused(`UPDATE public.money_calls SET attempts = 2 WHERE call_id = '${Y}';`, /Only a pending money call/);
      // Kept free, and later funded by a fill all the same (the venue wins).
      const Z = randomUUID();
      const m5 = market();
      bff(intent(Z, ANN, m5, { key: "tap-key-keptfree-abcdef" }));
      call(Z, ANN, "YES", m5);
      bff(`UPDATE public.money_calls SET state = 'FREE', ended_reason = 'kept_free' WHERE call_id = '${Z}';`);
      trade(Z, ANN, "FILLED");
      bff(`UPDATE public.money_calls SET state = 'FUNDED', ended_reason = 'filled' WHERE call_id = '${Z}';`);
      expect(state(Z)).toBe("FUNDED|filled");
      // History is permanent; nobody but the BFF reads it.
      refused(`DELETE FROM public.money_calls WHERE call_id = '${Y}';`, /permission denied|permanent/);
      refused(`TRUNCATE public.money_calls;`, /permanent/, "test_admin");
      refused(`SELECT * FROM public.money_calls;`, /permission denied/, "authenticated");
      refused(`SELECT * FROM public.money_calls;`, /permission denied/, "anon");
      expect(bff(`SELECT count(*) FROM public.money_calls WHERE user_id = '${ANN}'`)).toBe("3");

      // ── wallet_transfers ──
      const T1 = randomUUID();
      const prepared = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, from: W, to: FRIEND, amountBaseUnits: "3000000",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", encoding: "solana-tx-base64", transaction: "AAAA", messageHash: "c".repeat(64),
        recentBlockhash: FRIEND, lastValidBlockHeight: 500, createsAccount: true, networkFeeLamports: "5600", rentLamports: "2039280",
        createdAt: 1_760_000_000_000, expiresAt: 1_760_000_060_000, ...over });
      const transfer = (id: string, json: string, extra = "", from = W, to = FRIEND) =>
        `INSERT INTO public.wallet_transfers(id, user_id, kind, from_wallet, to_wallet, amount_base_units, idempotency_key, request_fingerprint, prepared${extra ? ", state" : ""})
         VALUES ('${id}', '${ANN}', 'cash_out', '${from}', '${to}', 3000000, 'cash-out-${id.slice(0, 8)}-abcdef', '${"d".repeat(64)}', '${json}'::jsonb${extra});`;
      bff(transfer(T1, prepared()));
      refused(transfer(randomUUID(), prepared(), ", 'SUBMITTED'"), /starts as an unsigned review|wallet_transfers_signature_state/);
      refused(transfer(randomUUID(), prepared({ amountBaseUnits: "3000001" })), /wallet_transfers_prepared_binding/);
      refused(transfer(randomUUID(), prepared({ mint: FRIEND })), /wallet_transfers_prepared_binding/);
      refused(transfer(randomUUID(), prepared({ expiresAt: 1_760_000_300_000 })), /wallet_transfers_prepared_binding/);
      refused(transfer(randomUUID(), prepared({ to: W }), "", W, W), /wallet_transfers_not_to_self/);
      const sig = "5".repeat(88);
      refused(`UPDATE public.wallet_transfers SET state = 'CONFIRMED' WHERE id = '${T1}';`, /Invalid wallet transfer transition|wallet_transfers_/);
      refused(`UPDATE public.wallet_transfers SET amount_base_units = 1 WHERE id = '${T1}';`, /permission denied/);
      bff(`UPDATE public.wallet_transfers SET state = 'SUBMITTED', signature = '${sig}', signed_transaction = 'AAAA' WHERE id = '${T1}';`);
      refused(`UPDATE public.wallet_transfers SET signature = '${"6".repeat(88)}' WHERE id = '${T1}';`, /only one transaction/);
      refused(`UPDATE public.wallet_transfers SET state = 'CONFIRMED' WHERE id = '${T1}';`, /wallet_transfers_evidence_state|wallet_transfers_confirmed_evidence/);
      refused(`UPDATE public.wallet_transfers SET state = 'CONFIRMED', confirm_evidence = '{"independentlyVerified":true,"messageHash":"${"c".repeat(64)}","signature":"${sig}","amountBaseUnits":"3000001","slot":9}'::jsonb WHERE id = '${T1}';`, /wallet_transfers_confirmed_evidence/);
      bff(`UPDATE public.wallet_transfers SET state = 'CONFIRMED', confirm_evidence = '{"independentlyVerified":true,"messageHash":"${"c".repeat(64)}","signature":"${sig}","amountBaseUnits":"3000000","slot":9}'::jsonb WHERE id = '${T1}';`);
      refused(`UPDATE public.wallet_transfers SET state = 'FAILED' WHERE id = '${T1}';`, /settled wallet transfer is final/);
      refused(`DELETE FROM public.wallet_transfers WHERE id = '${T1}';`, /permission denied|permanent/);
      refused(`SELECT * FROM public.wallet_transfers;`, /permission denied/, "authenticated");
      expect(bff(`SELECT state FROM public.wallet_transfers WHERE id = '${T1}'`)).toBe("CONFIRMED");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
