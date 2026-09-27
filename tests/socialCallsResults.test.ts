/**
 * §0.2 / §3 — the result derivation, the whole truth table, and the sync.
 *
 *     resolution === 'VOID'            -> VOID
 *     resolution === call.side         -> CORRECT
 *     resolution is the other side     -> INCORRECT
 *     no resolution yet                -> PENDING
 *
 * "Late resolution stays PENDING. There is no other branch, no admin override,
 * and no client input."
 *
 * Proved below: every cell of that table; that PENDING never decays into
 * anything on its own however late the venue is; that the synchroniser is
 * idempotent and repairs from venue history after a restart; and that a client
 * cannot write a `call_results` row at all.
 */

import { describe, expect, test } from "bun:test";
import { callsRouter } from "../src/api/calls.ts";
import { RESOLUTION_CURSOR, ResolutionSync } from "../src/calls/ResolutionSync.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { isCallsError } from "../src/calls/errors.ts";
import { deriveCallOutcome } from "../src/prediction/types.ts";
import type { CallOutcome, Resolution, Side } from "../src/prediction/types.ts";
import { asWallet } from "../src/domain/ids.ts";
import {
  RESULTS_MIGRATION,
  harness,
  market,
  migrationSql,
  migrationsAvailable,
  person,
  sqlWithoutComments,
} from "./socialCallsFixtures.ts";

// ── the truth table, as data ────────────────────────────────────────────────

const TRUTH_TABLE: { side: Side; resolution: Resolution | null; outcome: CallOutcome }[] = [
  { side: "YES", resolution: "YES", outcome: "CORRECT" },
  { side: "YES", resolution: "NO", outcome: "INCORRECT" },
  { side: "YES", resolution: "VOID", outcome: "VOID" },
  { side: "YES", resolution: null, outcome: "PENDING" },
  { side: "NO", resolution: "NO", outcome: "CORRECT" },
  { side: "NO", resolution: "YES", outcome: "INCORRECT" },
  { side: "NO", resolution: "VOID", outcome: "VOID" },
  { side: "NO", resolution: null, outcome: "PENDING" },
];

describe("the §3 derivation, cell by cell", () => {
  test("it is exhaustive: 2 sides x 4 evidence states, and nothing else exists", () => {
    expect(TRUTH_TABLE).toHaveLength(8);
    expect(new Set(TRUTH_TABLE.map((r) => r.outcome))).toEqual(
      new Set(["CORRECT", "INCORRECT", "VOID", "PENDING"]),
    );
  });

  for (const { side, resolution, outcome } of TRUTH_TABLE) {
    test(`side ${side} + resolution ${resolution ?? "none"} -> ${outcome}`, () => {
      // Packet B's shared rule — the SAME function the mobile client mirrors.
      expect(deriveCallOutcome(side, resolution)).toBe(outcome);

      // And end to end through the store, which is the only writer.
      const h = harness({ people: [person("u1")], markets: [market("m")] });
      const call = h.rt.service.createCall({ marketId: "m", side }, "u1");
      if (resolution) h.resolve("m", resolution);
      h.rt.sync.runOnce();
      expect(h.calls.getResult(call.call.id)!.outcome).toBe(outcome);
    });
  }

  test("a VOID is never a win and never a loss — it leaves accuracy untouched", () => {
    const h = harness({ people: [person("u1")], markets: [market("m1"), market("m2")] });
    h.rt.service.createCall({ marketId: "m1", side: "YES" }, "u1");
    h.rt.service.createCall({ marketId: "m2", side: "YES" }, "u1");
    h.resolve("m1", "YES");
    h.resolve("m2", "VOID");
    h.rt.sync.runOnce();

    const p = h.rt.service.getPerson({ personRef: "u1" }, null).person;
    expect(p.settledCalls).toBe(1); // the VOID is in neither the numerator…
    expect(p.correctCalls).toBe(1); // …nor the denominator
  });
});

describe("PENDING never decays — absence of evidence is not evidence", () => {
  test("a market whose STATUS reads RESOLVED, with no venue resolution, stays PENDING", () => {
    const h = harness({
      people: [person("u1")],
      markets: [market("m", { status: "OPEN" })],
    });
    const call = h.rt.service.createCall({ marketId: "m", side: "YES" }, "u1");
    // The venue's own status moves. It publishes nothing.
    h.venue.upsertMarket(market("m", { status: "RESOLVED", rawStatus: "resolved" }), null);
    h.rt.sync.runOnce();
    expect(h.calls.getResult(call.call.id)!.outcome).toBe("PENDING");
  });

  test("a CANCELLED market is not a VOID until the venue publishes one", () => {
    const h = harness({ people: [person("u1")], markets: [market("m")] });
    const call = h.rt.service.createCall({ marketId: "m", side: "YES" }, "u1");
    h.venue.upsertMarket(market("m", { status: "CANCELLED", rawStatus: "cancelled" }), null);
    h.rt.sync.runOnce();
    expect(h.calls.getResult(call.call.id)!.outcome).toBe("PENDING");

    h.resolve("m", "VOID");
    h.rt.sync.runOnce();
    expect(h.calls.getResult(call.call.id)!.outcome).toBe("VOID");
  });

  test("LATE resolution stays PENDING — a decade past resolvesAt, and then settles", () => {
    const h = harness({ people: [person("u1")], markets: [market("m")] });
    const call = h.rt.service.createCall({ marketId: "m", side: "NO" }, "u1");

    // Ten years pass. The venue has published nothing.
    for (let i = 0; i < 10; i++) {
      h.clock.advance(365 * 24 * 60 * 60 * 1000);
      const report = h.rt.sync.runOnce();
      expect(report.stillPending).toBe(1);
      expect(report.resultsSettled).toBe(0);
      expect(h.calls.getResult(call.call.id)!.outcome).toBe("PENDING");
    }

    // Then it publishes, very late, and the rule applies unchanged.
    h.resolve("m", "NO");
    const final = h.rt.sync.runOnce();
    expect(final.resultsSettled).toBe(1);
    expect(h.calls.getResult(call.call.id)!.outcome).toBe("CORRECT");
  });

  test("a PENDING result exists from the instant the call locks, with no evidence cited", () => {
    const h = harness({ people: [person("u1")], markets: [market("m")] });
    const call = h.rt.service.createCall({ marketId: "m", side: "YES" }, "u1");
    const r = h.calls.getResult(call.call.id)!;
    expect(r).toEqual({
      callId: call.call.id,
      outcome: "PENDING",
      resolution: null,
      resolvedAt: null,
      marketResolutionId: null,
      derivedAt: h.clock.now(),
    });
  });

  test("a settled result cites the exact venue evidence it came from", () => {
    const h = harness({ people: [person("u1")], markets: [market("m")] });
    const call = h.rt.service.createCall({ marketId: "m", side: "YES" }, "u1");
    const evidenceId = h.resolve("m", "YES", 1_760_000_555_000);
    h.rt.sync.runOnce();
    const r = h.calls.getResult(call.call.id)!;
    expect(r.marketResolutionId).toBe(evidenceId);
    expect(r.resolution).toBe("YES");
    expect(r.resolvedAt).toBe(1_760_000_555_000);
  });
});

describe("resolution sync: idempotent, cursor-backed, restart-safe", () => {
  function threeCalls() {
    const h = harness({
      people: [person("u1"), person("u2"), person("u3")],
      markets: [market("m1"), market("m2")],
    });
    h.rt.service.createCall({ marketId: "m1", side: "YES" }, "u1");
    h.rt.service.createCall({ marketId: "m1", side: "NO" }, "u2");
    h.rt.service.createCall({ marketId: "m2", side: "YES" }, "u3");
    return h;
  }

  test("running it twice changes nothing — not a row, not a derivedAt", () => {
    const h = threeCalls();
    h.resolve("m1", "YES");
    const first = h.rt.sync.runOnce();
    expect(first.resultsSettled).toBe(2);

    const snapshot = JSON.stringify(h.calls.listResults().sort((a, b) => a.callId.localeCompare(b.callId)));
    h.clock.advance(60_000); // time moves; the rows must not

    const second = h.rt.sync.runOnce();
    expect(second.resultsSettled).toBe(0);
    expect(JSON.stringify(h.calls.listResults().sort((a, b) => a.callId.localeCompare(b.callId)))).toBe(
      snapshot,
    );
  });

  test("ten passes over the same history are indistinguishable from one", () => {
    const h = threeCalls();
    h.resolve("m1", "NO");
    h.resolve("m2", "VOID");
    h.rt.sync.runOnce();
    const snapshot = JSON.stringify(h.calls.listResults().sort((a, b) => a.callId.localeCompare(b.callId)));
    for (let i = 0; i < 10; i++) {
      h.clock.advance(1000);
      h.rt.sync.runOnce();
    }
    expect(JSON.stringify(h.calls.listResults().sort((a, b) => a.callId.localeCompare(b.callId)))).toBe(
      snapshot,
    );
  });

  test("the cursor advances and is persisted after every page", () => {
    const h = threeCalls();
    expect(h.rt.sync.cursorAt()).toBe(0);
    h.resolve("m1", "YES", 1_000);
    h.rt.sync.runOnce();
    const afterFirst = h.calls.getCursor(RESOLUTION_CURSOR);
    expect(afterFirst).not.toBeNull();

    h.clock.advance(5_000);
    h.resolve("m2", "NO", 2_000);
    h.rt.sync.runOnce();
    expect(Number(h.calls.getCursor(RESOLUTION_CURSOR))).toBeGreaterThanOrEqual(Number(afterFirst));
  });

  test("a brand-new synchroniser with an EMPTY cursor repairs from venue history", () => {
    const h = threeCalls();
    h.resolve("m1", "YES");
    h.resolve("m2", "VOID");
    h.rt.sync.runOnce();
    const before = JSON.stringify(h.calls.listResults().sort((a, b) => a.callId.localeCompare(b.callId)));

    // Simulate a restart: a fresh synchroniser over the SAME store, cursor lost.
    const fresh = new ResolutionSync({ store: h.calls, markets: h.rt.markets, clock: h.clock });
    fresh.resetCursor();
    expect(fresh.cursorAt()).toBe(0);
    const report = fresh.runOnce();

    expect(report.resolutionsSeen).toBe(2); // the whole history re-walked
    expect(report.resultsSettled).toBe(0); // and nothing changed
    expect(JSON.stringify(h.calls.listResults().sort((a, b) => a.callId.localeCompare(b.callId)))).toBe(
      before,
    );
  });

  test("a call AFTER resolution is refused even when the catalog is still OPEN", () => {
    const h = harness({ people: [person("u1"), person("u2")], markets: [market("m")] });
    h.rt.service.createCall({ marketId: "m", side: "YES" }, "u1");
    h.resolve("m", "YES");
    h.rt.sync.runOnce(); // consumes the resolution and advances the cursor

    // u2 goes on record late, on a market the cursor has already passed.
    h.venue.upsertMarket(market("m", { status: "OPEN" }), null);
    expect(() => h.rt.service.createCall({ marketId: "m", side: "NO" }, "u2")).toThrow();
    expect(h.calls.listResults()).toHaveLength(1);

    const report = h.rt.sync.runOnce();
    expect(h.calls.listResults()[0]!.outcome).toBe("CORRECT");
    expect(report.resultsSettled).toBe(0); // already right; nothing to do
  });

  test("it never invents a resolution: with no venue evidence, nothing settles", () => {
    const h = threeCalls();
    const report = h.rt.sync.runOnce();
    expect(report.resolutionsSeen).toBe(0);
    expect(report.resultsSettled).toBe(0);
    expect(report.stillPending).toBe(3);
    expect(h.calls.listResults().every((r) => r.outcome === "PENDING")).toBe(true);
  });

  test("a settled result is permanent — there is no admin override", () => {
    const h = harness({ people: [person("u1")], markets: [market("m")] });
    const call = h.rt.service.createCall({ marketId: "m", side: "YES" }, "u1");
    h.resolve("m", "YES");
    h.rt.sync.runOnce();
    expect(h.calls.getResult(call.call.id)!.outcome).toBe("CORRECT");

    // Fabricate contradicting "evidence" and try to apply it.
    const forged = {
      id: "res_forged",
      marketId: "m",
      venue: "fixture" as const,
      venueMarketId: "vm-m",
      resolution: "NO" as const,
      resolvedAt: h.clock.now(),
      evidenceSource: "an admin's opinion",
      rawEvidence: {},
      recordedAt: h.clock.now(),
      demo: true,
    };
    let thrown: unknown;
    try {
      h.calls.writeResult({ callId: call.call.id, evidence: forged }, h.clock.now(), { actor: "service" });
    } catch (e) {
      thrown = e;
    }
    expect(isCallsError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("RESULT_DERIVATION_VIOLATION");
    expect(h.calls.getResult(call.call.id)!.outcome).toBe("CORRECT");
  });

  test("evidence from another market is refused outright", () => {
    const h = harness({ people: [person("u1")], markets: [market("m1"), market("m2")] });
    const call = h.rt.service.createCall({ marketId: "m1", side: "YES" }, "u1");
    h.resolve("m2", "YES");
    const wrong = h.venue.getResolution("m2")!;
    expect(() =>
      h.calls.writeResult({ callId: call.call.id, evidence: wrong }, h.clock.now(), { actor: "service" }),
    ).toThrow(/is for market m2, but call .* is on market m1/);
  });
});

describe("call_results is service-write only (§5)", () => {
  test("a client actor cannot write a result, at any outcome", () => {
    const h = harness({ people: [person("u1")], markets: [market("m")] });
    const call = h.rt.service.createCall({ marketId: "m", side: "YES" }, "u1");
    h.resolve("m", "YES");
    const evidence = h.venue.getResolution("m")!;

    for (const ev of [null, evidence]) {
      let thrown: unknown;
      try {
        h.calls.writeResult({ callId: call.call.id, evidence: ev }, h.clock.now(), { actor: "client" });
      } catch (e) {
        thrown = e;
      }
      expect(isCallsError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("RESULT_SERVICE_WRITE_ONLY");
    }
    // Still exactly what the service derived.
    expect(h.calls.getResult(call.call.id)!.outcome).toBe("PENDING");
  });

  test("no procedure on the router can write a result — there is no such input", async () => {
    const h = harness({ people: [person("u1")], markets: [market("m")] });
    const app = await (await import("./socialCallsFixtures.ts")).testApp();
    setCallsRuntime(app.config, h.rt);
    const caller = callsRouter.createCaller({ app, wallet: asWallet("Wallet_u1") });

    const entry = await caller.calls.create({ marketId: "m", side: "YES" });
    // Every write input is strict, so an outcome/resolution field is rejected.
    for (const attempt of [
      () => caller.calls.create({ marketId: "m", side: "YES", outcome: "CORRECT" } as never),
      () => caller.calls.respond({ targetCallId: entry.call.id, kind: "back", resolution: "YES" } as never),
    ]) {
      const err = await attempt().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/[Uu]nrecognized/);
    }
    expect(h.calls.getResult(entry.call.id)!.outcome).toBe("PENDING");
  });

  test("the SQL side has no write policy and no write grant for a client", () => {
    if (!migrationsAvailable()) return;
    const sql = sqlWithoutComments(migrationSql(RESULTS_MIGRATION)!);
    expect(sql).toContain("REVOKE ALL ON public.call_results FROM anon, authenticated");
    expect(sql).toContain("GRANT SELECT ON public.call_results TO anon, authenticated");
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[^;]*ON public\.call_results TO (anon|authenticated)/);
    const policies = [...sql.matchAll(/CREATE POLICY \w+ ON public\.call_results\s+FOR (\w+)/g)].map((m) => m[1]);
    expect(policies).toEqual(["SELECT"]);
  });

  test("the SQL trigger encodes the SAME four-branch rule and no fifth", () => {
    if (!migrationsAvailable()) return;
    const sql = sqlWithoutComments(migrationSql(RESULTS_MIGRATION)!);
    expect(sql).toContain("WHEN v_res_value = 'VOID' THEN 'VOID'");
    expect(sql).toContain("WHEN v_res_value = v_side THEN 'CORRECT'");
    expect(sql).toContain("ELSE 'INCORRECT'");
    expect(sql).toContain("v_expected := 'PENDING';");
    // Exactly one CASE decides the outcome. A second would be a second branch.
    expect([...sql.matchAll(/v_expected := CASE/g)]).toHaveLength(1);
  });
});
