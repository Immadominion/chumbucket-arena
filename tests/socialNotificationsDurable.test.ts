/**
 * `SupabaseNotificationsStore` — what it sends to PostgREST, in what order, and
 * what a restart reads back.
 *
 * Notifications here are derived by the real `NotificationDeriver` from a real
 * Packet D world (calls, responses, results written by `CallsService` and
 * `ResolutionSync`), never hand-inserted. The PostgREST side is a recording
 * fake: these tests pin the wire contract; the SQL rules themselves are checked
 * against the real migrations in socialNotifications.postgres.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { buildNotificationsRuntime } from "../src/notifications/runtime.ts";
import { SupabaseNotificationsStore } from "../src/notifications/supabaseStore.ts";
import { WriteQueue } from "../src/prediction/pgrest.ts";
import { harness as callsHarness, market, person, T0 } from "./socialCallsFixtures.ts";

type Sent = { method: string; table: string; query: URLSearchParams; body: unknown };

/** A PostgREST stand-in that records every request and serves canned selects. */
function recordingPg(seed: { notifications?: unknown[]; records?: unknown[] } = {}) {
  const sent: Sent[] = [];
  let failNextInsert = false;
  const fetchImpl = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const table = url.pathname.split("/").pop()!;
      const method = init?.method ?? "GET";
      sent.push({
        method,
        table,
        query: url.searchParams,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (method === "GET") {
        const rows =
          table === "social_notifications" ? seed.notifications ?? [] : seed.records ?? [];
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return new Response(JSON.stringify(offset === 0 ? rows : []), { status: 200 });
      }
      if (method === "POST" && failNextInsert) {
        failNextInsert = false;
        return new Response(JSON.stringify({ code: "P0001", message: "refused by a guard" }), {
          status: 400,
        });
      }
      return new Response(null, { status: 201 });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  return {
    sent,
    fetchImpl,
    failNextInsert() {
      failNextInsert = true;
    },
  };
}

const CONFIG = { supabaseUrl: "https://db.test", serviceRoleKey: "service-role-key-under-test" };
const A = "mkt-a";

/** Ann's call, backed by Bob, faded by Cid, then settled YES. */
function world(pg: ReturnType<typeof recordingPg>, parentQueue?: WriteQueue) {
  const calls = callsHarness({
    people: [person("u-ann"), person("u-bob"), person("u-cid")],
    markets: [market(A)],
  });
  calls.venue.appendSnapshot({ marketId: A, yesProbability: 0.6, observedAt: T0, source: "fixture" });
  const store = new SupabaseNotificationsStore({
    config: CONFIG,
    fetchImpl: pg.fetchImpl,
    clock: calls.clock,
    ...(parentQueue ? { parentQueue } : {}),
  });
  const rt = buildNotificationsRuntime(undefined, { calls: calls.rt, clock: calls.clock, store });
  const ann = calls.rt.service.createCall({ marketId: A, side: "YES", thesis: null }, "u-ann");
  calls.clock.advance(1000);
  calls.rt.service.respond({ targetCallId: ann.call.id, kind: "back" }, "u-bob");
  calls.clock.advance(1000);
  calls.rt.service.respond({ targetCallId: ann.call.id, kind: "fade" }, "u-cid");
  calls.clock.advance(1000);
  calls.resolve(A, "YES");
  calls.rt.sync.runOnce();
  return { calls, store, rt, ann };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("writes", () => {
  test("each new notification is inserted once, with a UUID, deduped by the database's key", async () => {
    const pg = recordingPg();
    const { rt, store } = world(pg);
    rt.deriver.runOnce();
    rt.deriver.runOnce(); // a second pass is the same facts: no new writes
    await store.flush();

    const inserts = pg.sent.filter((s) => s.method === "POST" && s.table === "social_notifications");
    const rows = inserts.map((s) => (s.body as Record<string, unknown>[])[0]!);
    // Ann hears about the back, the fade and her result; Bob and Cid each made
    // their own call by responding, so each hears about their own result.
    expect(rows.map((r) => `${r.recipient_user_id}:${r.kind}`).sort()).toEqual([
      "u-ann:BACKED",
      "u-ann:FADED",
      "u-ann:RESOLVED",
      "u-bob:RESOLVED",
      "u-cid:RESOLVED",
    ]);
    for (const s of inserts) {
      const row = (s.body as Record<string, unknown>[])[0]!;
      expect(row.id as string).toMatch(UUID);
      expect(row.read_at).toBeNull();
      expect("dedupe_key" in row).toBe(false); // the guard trigger computes it
      expect(s.query.get("on_conflict")).toBe("recipient_user_id,dedupe_key");
    }
    // Mirror ids are the ids Postgres was given.
    const ids = rt.store.listAll().map((n) => n.id).sort();
    expect(inserts.map((s) => (s.body as { id: string }[])[0]!.id).sort()).toEqual(ids);
  });

  test("mark read patches only this person's unread rows", async () => {
    const pg = recordingPg();
    const { rt, store } = world(pg);
    rt.deriver.runOnce();
    const [first] = rt.store.listForRecipient("u-ann");
    rt.service.markRead([first!.id], "u-ann");
    rt.service.markRead(null, "u-ann");
    await store.flush();

    const patches = pg.sent.filter((s) => s.method === "PATCH");
    expect(patches).toHaveLength(2);
    for (const p of patches) {
      expect(p.query.get("recipient_user_id")).toBe("eq.u-ann");
      expect(p.query.get("read_at")).toBe("is.null");
      expect(typeof (p.body as { read_at: string }).read_at).toBe("string");
    }
    expect(patches[0]!.query.get("id")).toBe(`in.(${first!.id})`);
    expect(patches[1]!.query.has("id")).toBe(false);
    expect(rt.store.unreadCount("u-ann")).toBe(0);
  });

  test("record rows are written when they change, not on every pass", async () => {
    const pg = recordingPg();
    const { rt, store } = world(pg);
    rt.deriver.runOnce();
    await store.flush();
    const first = pg.sent.filter((s) => s.table === "call_category_records" && s.method === "POST");
    expect(first.length).toBeGreaterThan(0);
    for (const s of first) {
      const row = (s.body as Record<string, unknown>[])[0]!;
      expect("decided_count" in row).toBe(false);
      expect("accuracy_reportable" in row).toBe(false);
      expect(s.query.get("on_conflict")).toBe("user_id,category,funding_class");
    }

    rt.deriver.runOnce();
    rt.deriver.runOnce();
    await store.flush();
    const after = pg.sent.filter((s) => s.table === "call_category_records" && s.method === "POST");
    expect(after.length).toBe(first.length);
  });
});

describe("ordering and failure isolation", () => {
  test("every write waits for the calls writer to drain first", async () => {
    const pg = recordingPg();
    const parent = new WriteQueue();
    const order: string[] = [];
    let release!: () => void;
    parent.push("calls row", () => new Promise<void>((r) => (release = () => {
      order.push("calls row written");
      r();
    })));
    const { rt, store } = world(pg, parent);
    rt.deriver.runOnce();
    await new Promise((r) => setTimeout(r, 10));
    expect(pg.sent.filter((s) => s.method === "POST")).toHaveLength(0);
    release();
    await store.flush();
    order.push("notifications written");
    expect(order).toEqual(["calls row written", "notifications written"]);
    expect(pg.sent.filter((s) => s.method === "POST").length).toBeGreaterThan(0);
  });

  test("a refused notification is recorded here and never quarantines calls", async () => {
    const pg = recordingPg();
    const parent = new WriteQueue({ onFailure: () => {} });
    const { rt, store } = world(pg, parent);
    pg.failNextInsert();
    const quiet = console.error;
    console.error = () => {};
    try {
      rt.deriver.runOnce();
      await store.queue.drain();
    } finally {
      console.error = quiet;
    }
    expect(store.failures.length).toBe(1);
    expect(parent.failures.length).toBe(0);
    await expect(store.flush()).rejects.toThrow(/durable write/);
  });
});

describe("restart", () => {
  test("hydrating keeps ids and read state, and re-deriving adds nothing", async () => {
    // First life: derive, read one, and capture what Postgres would hold.
    const pg1 = recordingPg();
    const first = world(pg1);
    first.rt.deriver.runOnce();
    const rows = first.rt.store.listForRecipient("u-ann");
    first.rt.service.markRead([rows[0]!.id], "u-ann");
    const stored = first.rt.store.listAll().map((n) => ({
      id: n.id,
      recipient_user_id: n.recipientUserId,
      kind: n.kind,
      actor_user_id: n.actorUserId,
      subject_call_id: n.subjectCallId,
      response_id: n.responseId,
      rival_call_id: n.rivalCallId,
      call_result_outcome: n.outcome,
      rematch_reason: n.rematchReason,
      created_at: new Date(n.createdAt).toISOString(),
      read_at: n.readAt === null ? null : new Date(n.readAt).toISOString(),
    }));

    // Second life: same calls world, a store that hydrates those rows.
    const pg2 = recordingPg({ notifications: stored });
    const second = world(pg2);
    const report = await second.store.hydrate();
    expect(report.notifications).toBe(stored.length);
    expect(second.rt.store.unreadCount("u-ann")).toBe(
      stored.filter((s) => s.recipient_user_id === "u-ann").length - 1,
    );

    second.rt.deriver.runOnce();
    await second.store.flush();
    expect(pg2.sent.filter((s) => s.table === "social_notifications" && s.method === "POST")).toHaveLength(0);
    expect(second.rt.store.listAll().map((n) => n.id).sort()).toEqual(
      stored.map((s) => s.id).sort(),
    );
  });

  test("an in-memory runtime is unchanged, and ready() resolves without a database", async () => {
    const calls = callsHarness({ people: [person("u-ann")], markets: [market(A)] });
    const rt = buildNotificationsRuntime(undefined, { calls: calls.rt, clock: calls.clock });
    expect(rt.durable).toBeNull();
    await rt.ready();
  });
});
