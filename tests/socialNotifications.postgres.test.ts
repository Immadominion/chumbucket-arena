import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in throwaway PostgreSQL 15: the two Packet F migrations, applied as they
// are, judge the exact statements PostgREST generates from
// SupabaseNotificationsStore's requests (insert ... on_conflict + ignore- or
// merge-duplicates, and a filtered PATCH). No DATABASE_URL, linked project or
// existing cluster is ever read.
// Run: VERIFY_LOCAL_PG=true bun test tests/socialNotifications.postgres.test.ts
test.skipIf(process.env.VERIFY_LOCAL_PG !== "true")(
  "the durable inbox's writes satisfy the real Packet F triggers",
  () => {
    const root = mkdtempSync(join(tmpdir(), "chum-social-notifications-"));
    const data = join(root, "isolated-db");
    const bin = process.env.POSTGRES_BIN_DIR ?? "/opt/homebrew/opt/postgresql@15/bin";
    const port = String(randomInt(54000, 59000));
    const run = (exe: string, args: string[], input?: string): { ok: boolean; out: string; err: string } => {
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
      // The value a script ends with (psql also echoes SET / INSERT tags).
      const sql = (text: string) => must("psql", args, text).split("\n").pop() ?? "";
      const refused = (text: string): string => {
        const r = run("psql", args, text);
        expect(r.ok).toBe(false);
        return r.err;
      };

      const ANN = "11111111-1111-4111-8111-111111111111";
      const BOB = "22222222-2222-4222-8222-222222222222";
      const CALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const BOB_CALL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const BACK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const MKT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

      // The prerequisites the migrations check for, with the columns they read.
      sql(String.raw`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        GRANT USAGE ON SCHEMA public TO service_role, authenticated;
        CREATE TABLE public.users(id uuid PRIMARY KEY);
        CREATE FUNCTION public.current_app_user_id() RETURNS uuid LANGUAGE sql STABLE
          AS $$ SELECT nullif(current_setting('app.test_user_id', true), '')::uuid $$;
        CREATE TABLE public.venue_markets(id uuid PRIMARY KEY, category text NOT NULL);
        CREATE TABLE public.calls(id uuid PRIMARY KEY, user_id uuid REFERENCES public.users(id),
          market_id uuid REFERENCES public.venue_markets(id), funding_state text NOT NULL DEFAULT 'NONE',
          hidden_at timestamptz);
        CREATE TABLE public.call_responses(id uuid PRIMARY KEY, actor_user_id uuid, kind text,
          target_call_id uuid REFERENCES public.calls(id));
        CREATE TABLE public.call_results(call_id uuid PRIMARY KEY REFERENCES public.calls(id),
          outcome text NOT NULL, resolved_at timestamptz);
        INSERT INTO public.users VALUES ('${ANN}'), ('${BOB}');
        INSERT INTO public.venue_markets VALUES ('${MKT}', 'crypto');
        INSERT INTO public.calls(id, user_id, market_id) VALUES ('${CALL}', '${ANN}', '${MKT}'),
          ('${BOB_CALL}', '${BOB}', '${MKT}');
        INSERT INTO public.call_responses VALUES ('${BACK}', '${BOB}', 'back', '${CALL}');
      `);
      const migrations = join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations");
      must("psql", [...args, "-f", join(migrations, "20260913150000_social_notifications_inbox.sql")]);
      must("psql", [...args, "-f", join(migrations, "20260913150500_social_notifications_category_record.sql")]);

      // insertIfAbsent: POST social_notifications?on_conflict=recipient_user_id,dedupe_key
      // with Prefer: resolution=ignore-duplicates, and no dedupe_key in the body.
      const insertBacked = (id: string) => String.raw`
        SET ROLE service_role;
        INSERT INTO public.social_notifications (id, recipient_user_id, kind, actor_user_id,
          subject_call_id, response_id, rival_call_id, call_result_outcome, rematch_reason,
          created_at, read_at)
        VALUES ('${id}', '${ANN}', 'BACKED', '${BOB}', '${CALL}', '${BACK}', NULL, NULL, NULL,
          '2026-10-01T10:00:00.000Z', NULL)
        ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING;`;
      sql(insertBacked("eeeeeeee-eeee-4eee-8eee-000000000001"));
      // The same fact again, from another replica with another id: one row.
      sql(insertBacked("eeeeeeee-eeee-4eee-8eee-000000000002"));
      expect(
        sql(`SELECT count(*) || ':' || min(dedupe_key) FROM public.social_notifications;`),
      ).toBe(`1:BACKED:${BACK}`);

      // A RESOLVED is refused until call_results says so, then accepted.
      const insertResolved = String.raw`
        SET ROLE service_role;
        INSERT INTO public.social_notifications (id, recipient_user_id, kind, actor_user_id,
          subject_call_id, response_id, rival_call_id, call_result_outcome, rematch_reason,
          created_at, read_at)
        VALUES ('eeeeeeee-eeee-4eee-8eee-000000000003', '${ANN}', 'RESOLVED', NULL, '${CALL}',
          NULL, NULL, 'CORRECT', NULL, '2026-10-01T11:00:00.000Z', NULL)
        ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING;`;
      expect(refused(insertResolved)).toContain("no derived result");
      sql(`INSERT INTO public.call_results VALUES ('${CALL}', 'CORRECT', '2026-10-01T10:30:00Z');`);
      sql(insertResolved);

      // markRead: PATCH ?recipient_user_id=eq.<ann>&read_at=is.null&id=in.(...)
      sql(String.raw`
        SET ROLE service_role;
        UPDATE public.social_notifications SET read_at = '2026-10-01T12:00:00.000Z'
        WHERE recipient_user_id = '${ANN}' AND read_at IS NULL
          AND id IN ('eeeeeeee-eeee-4eee-8eee-000000000001');`);
      expect(
        sql(`SELECT count(*) FILTER (WHERE read_at IS NULL) || '/' || count(*) FROM public.social_notifications;`),
      ).toBe("1/2");
      // Nothing but read_at may ever move.
      expect(
        refused(`SET ROLE service_role; UPDATE public.social_notifications SET kind = 'FADED';`),
      ).toContain("only read_at may change");

      // writeRecordRow: POST call_category_records?on_conflict=user_id,category,funding_class
      // with Prefer: resolution=merge-duplicates (every payload column updated).
      const upsertRecord = (correct: number, incorrect: number, pending: number) => String.raw`
        SET ROLE service_role;
        INSERT INTO public.call_category_records (user_id, category, funding_class,
          correct_count, incorrect_count, void_count, resolved_count, pending_count,
          last_resolved_at, updated_at)
        VALUES ('${ANN}', 'crypto', 'free', ${correct}, ${incorrect}, 0, ${correct + incorrect},
          ${pending}, ${correct + incorrect > 0 ? "'2026-10-01T10:30:00.000Z'" : "NULL"},
          '2026-10-01T12:00:00.000Z')
        ON CONFLICT (user_id, category, funding_class) DO UPDATE SET
          correct_count = EXCLUDED.correct_count, incorrect_count = EXCLUDED.incorrect_count,
          void_count = EXCLUDED.void_count, resolved_count = EXCLUDED.resolved_count,
          pending_count = EXCLUDED.pending_count, last_resolved_at = EXCLUDED.last_resolved_at,
          updated_at = EXCLUDED.updated_at;`;
      sql(upsertRecord(0, 0, 1));
      sql(upsertRecord(1, 0, 0)); // the call resolved: pending may fall, correct rises
      expect(
        sql(`SELECT correct_count || '/' || decided_count || '/' || accuracy_reportable FROM public.call_category_records;`),
      ).toBe("1/1/false");
      // A miss can never be shed, whoever writes.
      sql(upsertRecord(1, 1, 0));
      expect(refused(upsertRecord(1, 0, 0))).toContain("misses never go down");

      // The recipient reads their own rows and nobody else's; anon has nothing.
      expect(
        sql(`SET ROLE authenticated; SET app.test_user_id = '${BOB}'; SELECT count(*) FROM public.social_notifications;`),
      ).toBe("0");
      expect(
        sql(`SET ROLE authenticated; SET app.test_user_id = '${ANN}'; SELECT count(*) FROM public.social_notifications;`),
      ).toBe("2");
      expect(refused(`SET ROLE anon; SELECT count(*) FROM public.social_notifications;`)).toContain(
        "permission denied",
      );
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
