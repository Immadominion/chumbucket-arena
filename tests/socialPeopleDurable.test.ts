/**
 * The people layer against the durable store, through the PostgREST fake that
 * transcribes the real constraints (tests/pgrestFake.ts).
 *
 * The property that matters most here is operational: the thesis thread ships
 * with its own additive migration, and the BFF may be deployed before that
 * migration is applied. Until it is, the feed must boot exactly as before and
 * NOTHING may be queued against the missing table — a refused write would
 * quarantine the shared queue, and every call, response and market write
 * behind it, for a feature that is optional.
 */

import { describe, expect, test } from "bun:test";
import { isCallsError } from "../src/calls/errors.ts";
import { personFromRow, SupabaseCallsStore, THESIS_UPDATES_TABLE } from "../src/calls/supabaseStore.ts";
import { MAX_THESIS_UPDATES_PER_CALL } from "../src/calls/types.ts";
import { THESIS_UPDATE_MAX } from "../src/calls/store.ts";
import { PgrestFake, seedUser, UUIDS } from "./pgrestFake.ts";
import { migrationSql, sqlWithoutComments } from "./socialCallsFixtures.ts";

const MARKET = "44444444-4444-4444-8444-444444444444";
const CALL = "55555555-5555-4555-8555-555555555555";
const UPDATE_1 = "66666666-6666-4666-8666-666666666666";
const LOCKED_AT = "2026-10-01T12:00:00.000Z";

const THESIS_MIGRATION = "20261002130000_call_thesis_updates.sql";

function seedCall(fake: PgrestFake, overrides: Record<string, unknown> = {}) {
  fake.seed("venue_markets", { id: MARKET, venue: "fixture", status: "OPEN" });
  fake.seed("calls", {
    id: CALL,
    user_id: UUIDS.alice,
    market_id: MARKET,
    side: "YES",
    confidence: null,
    thesis: "the original reason",
    entry_probability: null,
    snapshot_id: null,
    entry_price: null,
    visibility: "public",
    created_at: LOCKED_AT,
    locked_at: LOCKED_AT,
    parent_call_id: null,
    funding_state: "NONE",
    hidden_at: null,
    hidden_reason: null,
    ...overrides,
  });
}

function world(opts: { migrated: boolean }) {
  const fake = new PgrestFake(opts.migrated ? {} : { omitTables: [THESIS_UPDATES_TABLE] });
  seedUser(fake, UUIDS.alice, { handle: "alice" });
  seedUser(fake, UUIDS.bob, { handle: "bob" });
  seedCall(fake);
  const open = () => new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl });
  return { fake, open };
}

const update = (overrides: Partial<{ id: string; callId: string; authorUserId: string; body: string; createdAt: number }> = {}) => ({
  id: UPDATE_1,
  callId: CALL,
  authorUserId: UUIDS.alice,
  body: "flows still accelerating",
  createdAt: Date.parse(LOCKED_AT) + 60_000,
  ...overrides,
});

describe("before the migration is applied", () => {
  test("the store boots with every call intact and the thread switched off", async () => {
    const { fake, open } = world({ migrated: false });
    const store = open();
    const report = await store.hydrate();

    expect(report.calls).toBe(1);
    expect(report.thesisUpdates).toBeNull();
    expect(store.thesisUpdatesAvailable()).toBe(false);
    expect(store.getCall(CALL)?.thesis).toBe("the original reason");

    let refused: unknown;
    try {
      store.insertThesisUpdate(update());
    } catch (err) {
      refused = err;
    }
    expect(isCallsError(refused) && refused.code).toBe("THESIS_UPDATES_UNAVAILABLE");
    // Nothing was queued, so nothing can fail and quarantine the queue.
    await store.flush();
    expect(store.failures).toHaveLength(0);
    expect(fake.log.some((r) => r.table === THESIS_UPDATES_TABLE && r.method !== "GET")).toBe(false);
  });
});

describe("after the migration is applied", () => {
  test("an update is written, survives a restart and leaves the call untouched", async () => {
    const { fake, open } = world({ migrated: true });
    const store = open();
    expect((await store.hydrate()).thesisUpdates).toBe(0);
    expect(store.thesisUpdatesAvailable()).toBe(true);

    store.insertThesisUpdate(update({ body: "  flows still accelerating  " }));
    await store.flush();
    expect(fake.rows(THESIS_UPDATES_TABLE)).toMatchObject([
      { id: UPDATE_1, call_id: CALL, author_user_id: UUIDS.alice, body: "flows still accelerating" },
    ]);
    // The call row was never written to.
    expect(fake.log.some((r) => r.table === "calls" && r.method !== "GET")).toBe(false);

    const restarted = open();
    expect((await restarted.hydrate()).thesisUpdates).toBe(1);
    expect(restarted.thesisUpdatesFor(CALL).map((u) => u.body)).toEqual(["flows still accelerating"]);
  });

  test("the mirror refuses what the trigger refuses, before anything is queued", async () => {
    const { open } = world({ migrated: true });
    const store = open();
    await store.hydrate();
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (err) {
        return isCallsError(err) ? err.code : String(err);
      }
    };
    expect(codeOf(() => store.insertThesisUpdate(update({ authorUserId: UUIDS.bob })))).toBe("THESIS_NOT_AUTHOR");
    expect(codeOf(() => store.insertThesisUpdate(update({ body: " " })))).toBe("CALL_INVALID");
    expect(codeOf(() => store.insertThesisUpdate(update({ body: "x".repeat(THESIS_UPDATE_MAX + 1) })))).toBe(
      "CALL_INVALID",
    );
    expect(codeOf(() => store.insertThesisUpdate(update({ createdAt: Date.parse(LOCKED_AT) - 1 })))).toBe(
      "CALL_INVALID",
    );
    await store.flush();
    expect(store.failures).toHaveLength(0);
  });

  test("an update written before a call was withdrawn is replayed with it", async () => {
    const fake = new PgrestFake();
    seedUser(fake, UUIDS.alice);
    seedCall(fake, { hidden_at: "2026-10-01T13:00:00.000Z", hidden_reason: "withdrawn by author" });
    fake.seed(THESIS_UPDATES_TABLE, {
      id: UPDATE_1,
      call_id: CALL,
      author_user_id: UUIDS.alice,
      body: "said before withdrawing",
      created_at: "2026-10-01T12:30:00.000Z",
    });
    const store = new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl });
    const report = await store.hydrate();
    expect(report.hiddenCalls).toBe(1);
    expect(report.thesisUpdates).toBe(1);
    expect(store.thesisUpdatesFor(CALL).map((u) => u.body)).toEqual(["said before withdrawing"]);
  });
});

describe("profile columns", () => {
  test("bio and join date come from the directory row when it has them, and are absent otherwise", () => {
    const base = {
      id: UUIDS.alice,
      handle: "alice",
      full_name: "Alice",
      profile_picture: null,
      wallet_address: null,
      sns_domain: null,
    };
    expect(personFromRow({ ...base, bio: "  calls crypto  ", created_at: "2026-01-02T03:04:05.000Z" })).toMatchObject({
      bio: "calls crypto",
      joinedAt: Date.parse("2026-01-02T03:04:05.000Z"),
    });
    const bare = personFromRow({ ...base, bio: null, created_at: null });
    expect("bio" in bare).toBe(false);
    expect("joinedAt" in bare).toBe(false);
  });
});

describe("the migration says what the store enforces", () => {
  const raw = migrationSql(THESIS_MIGRATION);

  test.skipIf(raw === null)("same bounds, append-only for every role, readable exactly as its call", () => {
    const sql = sqlWithoutComments(raw!);
    expect(sql).toMatch(new RegExp(`BETWEEN 1 AND ${THESIS_UPDATE_MAX}\\b`));
    expect(sql).toMatch(new RegExp(`v_count >= ${MAX_THESIS_UPDATES_PER_CALL}\\b`));
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.call_thesis_updates/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    // Reads inherit the call's own RLS through EXISTS; never USING (true).
    expect(sql).toMatch(/EXISTS \(\s*SELECT 1 FROM public\.calls c WHERE c\.id = call_thesis_updates\.call_id\s*\)/);
    expect(sql).not.toMatch(/USING \(true\)/i);
    // One write path: no client role may insert, update or delete.
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*TO\s+(anon|authenticated)/i);
    // Additive only: nothing existing is replaced or altered.
    expect(sql).not.toMatch(/CREATE OR REPLACE/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.(calls|users)/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });
});
