/**
 * §0.1 / §3 — "A call is a free, immutable, timestamped statement by a person."
 *
 * Two things are proved here:
 *   1. EVERY column §3 freezes after `lockedAt` is actually refused, one test
 *      per column, plus the ones §0.1 freezes by calling a call an immutable
 *      statement.
 *   2. Deleting a call HIDES it from distribution and rewrites nothing — the
 *      call row, its CallResult and the author's accuracy all survive.
 *
 * And, because a rule enforced in two places can drift apart, the migration SQL
 * is read and asserted to cover exactly the same column list.
 */

import { describe, expect, test } from "bun:test";
import {
  IMMUTABLE_CALL_FIELDS,
  MUTABLE_CALL_FIELDS,
  type CallsStore,
} from "../src/calls/store.ts";
import { isCallsError } from "../src/calls/errors.ts";
import type { CallRecord } from "../src/calls/types.ts";
import {
  CALLS_MIGRATION,
  RESPONSES_MIGRATION,
  RESULTS_MIGRATION,
  harness,
  market,
  migrationSql,
  migrationsAvailable,
  person,
  sqlWithoutComments,
  type Harness,
} from "./socialCallsFixtures.ts";

const MARKET = "mkt-btc";

function seeded(): { h: Harness; callId: string } {
  const h = harness({
    people: [person("u-author"), person("u-other")],
    markets: [market(MARKET)],
  });
  h.venue.appendSnapshot({ marketId: MARKET, yesProbability: 0.42, observedAt: h.clock.now(), source: "fixture" });
  const entry = h.rt.service.createCall({ marketId: MARKET, side: "YES", thesis: "because" }, "u-author");
  return { h, callId: entry.call.id };
}

/** A value that is definitely different from whatever the column holds now. */
function otherValue(field: keyof CallRecord, current: CallRecord): unknown {
  switch (field) {
    case "marketId":
      return "mkt-somewhere-else";
    case "side":
      return current.side === "YES" ? "NO" : "YES";
    case "entryProbability":
      return 0.99;
    case "snapshotId":
      return "snap:forged";
    case "createdAt":
    case "lockedAt":
      return current.lockedAt + 5_000;
    case "fundingState":
      return "FILLED";
    case "id":
      return "call-forged";
    case "userId":
      return "u-other";
    case "thesis":
      return "rewritten after the fact";
    case "confidence":
      return 0.1;
    case "parentCallId":
      return "call-elsewhere";
    case "visibility":
      return current.visibility === "public" ? "followers" : "public";
    default:
      return "changed";
  }
}

describe("a locked call is immutable — every frozen column", () => {
  for (const { field, column, source } of IMMUTABLE_CALL_FIELDS) {
    test(`calls.${column} cannot change (${source})`, () => {
      const { h, callId } = seeded();
      const before = h.calls.getCall(callId)!;

      let thrown: unknown;
      try {
        h.calls.attemptCallUpdate(callId, { [field]: otherValue(field, before) } as Partial<CallRecord>);
      } catch (e) {
        thrown = e;
      }

      expect(isCallsError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("CALL_IMMUTABLE");
      // The row is untouched, not partially written.
      expect(h.calls.getCall(callId)).toEqual(before);
    });
  }

  test("the mutable surface is exactly hiddenAt + hiddenReason", () => {
    expect([...MUTABLE_CALL_FIELDS].sort()).toEqual(["hiddenAt", "hiddenReason"]);
    const { h, callId } = seeded();
    const updated = h.calls.attemptCallUpdate(callId, { hiddenAt: 1, hiddenReason: "why" });
    expect(updated.hiddenAt).toBe(1);
    expect(updated.hiddenReason).toBe("why");
  });

  test("an unknown column is refused too — the guard is an allowlist, not a denylist", () => {
    const { h, callId } = seeded();
    expect(() =>
      h.calls.attemptCallUpdate(callId, { somethingNew: true } as unknown as Partial<CallRecord>),
    ).toThrow(/not a mutable column/);
  });

  test("a call cannot be created already hidden", () => {
    const { h } = seeded();
    expect(() =>
      h.calls.insertCall({
        id: "call-born-hidden",
        userId: "u-other",
        marketId: MARKET,
        side: "NO",
        confidence: null,
        thesis: null,
        entryProbability: null,
        snapshotId: null,
        visibility: "public",
        createdAt: 1,
        lockedAt: 1,
        parentCallId: null,
        fundingState: "NONE",
        hiddenAt: 1,
        hiddenReason: "x",
      }),
    ).toThrow(/may not be created already hidden/);
  });
});

describe("deleting a call hides it without rewriting history", () => {
  test("there is no delete path at all — deleteCall exists only to refuse", () => {
    const { h, callId } = seeded();
    let thrown: unknown;
    try {
      (h.calls as CallsStore).deleteCall(callId);
    } catch (e) {
      thrown = e;
    }
    expect(isCallsError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("CALL_NOT_DELETABLE");
    expect(h.calls.getCall(callId)).toBeDefined();
  });

  test("hiding removes it from distribution but leaves the CallResult and the record intact", () => {
    const { h, callId } = seeded();

    // Settle it from venue evidence first, so there IS history to protect.
    h.resolve(MARKET, "YES");
    h.rt.sync.runOnce();

    const resultBefore = h.calls.getResult(callId)!;
    expect(resultBefore.outcome).toBe("CORRECT");
    const accuracyBefore = h.rt.service.getPerson({ personRef: "u-author" }, null).person;
    expect(accuracyBefore.settledCalls).toBe(1);
    expect(accuracyBefore.correctCalls).toBe(1);

    h.rt.service.hideCall(callId, "u-author");

    // Gone from every distribution surface…
    expect(h.rt.service.feed({ mode: "global" }, null).entries).toHaveLength(0);
    expect(h.rt.service.getPerson({ personRef: "u-author" }, null).calls).toHaveLength(0);
    expect(() => h.rt.service.getCall({ callId }, "u-other")).toThrow(/couldn't find that call/);

    // …and nothing was rewritten.
    expect(h.calls.getCall(callId)).toBeDefined();
    expect(h.calls.getResult(callId)).toEqual(resultBefore);
    const after = h.rt.service.getPerson({ personRef: "u-author" }, null).person;
    expect(after.settledCalls).toBe(1);
    expect(after.correctCalls).toBe(1);
  });

  test("the author still sees their own hidden call, so it can be restored", () => {
    const { h, callId } = seeded();
    h.rt.service.hideCall(callId, "u-author");
    expect(h.rt.service.getCall({ callId }, "u-author").entry.call.id).toBe(callId);

    h.calls.unhideCall(callId);
    expect(h.rt.service.feed({ mode: "global" }, null).entries).toHaveLength(1);
  });

  test("only the author may withdraw a call", () => {
    const { h, callId } = seeded();
    expect(() => h.rt.service.hideCall(callId, "u-other")).toThrow(/only withdraw your own call/);
  });

  test("hiding a losing call cannot launder a record — accuracy still counts it", () => {
    const h = harness({ people: [person("u-author")], markets: [market("m1"), market("m2")] });
    const win = h.rt.service.createCall({ marketId: "m1", side: "YES" }, "u-author").call.id;
    const loss = h.rt.service.createCall({ marketId: "m2", side: "YES" }, "u-author").call.id;
    h.resolve("m1", "YES");
    h.resolve("m2", "NO");
    h.rt.sync.runOnce();

    h.rt.service.hideCall(loss, "u-author");

    const p = h.rt.service.getPerson({ personRef: "u-author" }, null).person;
    expect(p.settledCalls).toBe(2); // the loss still counts
    expect(p.correctCalls).toBe(1);
    expect(h.calls.getResult(loss)!.outcome).toBe("INCORRECT");
    expect(h.calls.getResult(win)!.outcome).toBe("CORRECT");
  });
});

describe("the SQL trigger and the TypeScript guard cannot drift apart", () => {
  const available = migrationsAvailable();
  const maybe = available ? test : test.skip;

  maybe("calls_guard_immutability rejects every column IMMUTABLE_CALL_FIELDS names", () => {
    const sql = migrationSql(CALLS_MIGRATION)!;
    const body = sql.slice(sql.indexOf("CREATE FUNCTION public.calls_guard_immutability()"));
    for (const { column } of IMMUTABLE_CALL_FIELDS) {
      expect(body).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
  });

  maybe("the migration refuses a hard DELETE and has no DELETE policy or grant", () => {
    const sql = sqlWithoutComments(migrationSql(CALLS_MIGRATION)!);
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON public.calls");
    expect(sql).toMatch(/TG_OP = 'DELETE'[\s\S]{0,400}RAISE EXCEPTION/);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR DELETE ON public\.calls/);
    expect(sql).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*ON public\.calls/);
  });

  maybe("no new table carries a USING (true) policy, and every one enables RLS", () => {
    for (const name of [CALLS_MIGRATION, RESPONSES_MIGRATION, RESULTS_MIGRATION]) {
      const sql = sqlWithoutComments(migrationSql(name)!);
      expect(sql).not.toMatch(/USING\s*\(\s*true\s*\)/i);
      expect(sql).not.toMatch(/WITH CHECK\s*\(\s*true\s*\)/i);
      expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
      expect(sql).toContain("REVOKE ALL ON public.");
      expect(sql).toContain("GRANT ALL ON public.");
    }
  });

  maybe("every new function pins search_path and is revoked from anon/authenticated", () => {
    for (const name of [CALLS_MIGRATION, RESPONSES_MIGRATION, RESULTS_MIGRATION]) {
      const sql = sqlWithoutComments(migrationSql(name)!);
      const creates = [...sql.matchAll(/CREATE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]!);
      expect(creates.length).toBeGreaterThan(0);
      for (const fn of creates) {
        const at = sql.indexOf(`CREATE FUNCTION public.${fn}(`);
        const header = sql.slice(at, at + 400);
        expect(header).toContain("SET search_path = pg_catalog, public, pg_temp");
        expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated`);
      }
      // §5: never redefine an existing function.
      expect(sql).not.toContain("CREATE OR REPLACE");
    }
  });

  maybe("every new migration aborts loudly without current_app_user_id()", () => {
    for (const name of [CALLS_MIGRATION, RESPONSES_MIGRATION, RESULTS_MIGRATION]) {
      const sql = sqlWithoutComments(migrationSql(name)!);
      expect(sql).toContain("to_regprocedure('public.current_app_user_id()') IS NULL");
      expect(sql).toMatch(/RAISE EXCEPTION\s*\n?\s*'[^']*current_app_user_id/);
    }
  });

  maybe("the calls table carries no money and no wallet column", () => {
    const sql = sqlWithoutComments(migrationSql(CALLS_MIGRATION)!);
    const table = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS public.calls"), sql.indexOf("CREATE INDEX"));
    expect(table).not.toMatch(/^\s+(amount|stake|escrow|payout|tx_signature|wallet_address)\b/im);
  });
});
