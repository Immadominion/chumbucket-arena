/**
 * `/ready` and the worker heartbeats behind it (audit M5).
 *
 * `/health` is static wiring; `/ready` must turn red when the calls product
 * cannot actually serve: mirrors not hydrated, the durable writer failed, or
 * the market/result sync silently stopped. And because it is public, it must
 * never carry a message, a hostname or a config value.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Heartbeats } from "../src/ops/heartbeats.ts";
import {
  computeReadiness,
  handleReady,
  readinessNow,
  setReadinessSource,
  type DurableWriterView,
} from "../src/ops/readiness.ts";

const okWriter = (): DurableWriterView => ({ failures: [], pending: 0, acceptedWrites: 3, completedWrites: 3 });

describe("heartbeats", () => {
  test("a loop is starting, then ok, then stale after three missed intervals", () => {
    let now = 1_000;
    const hb = new Heartbeats(() => now);
    hb.register("marketSync", { intervalMs: 60_000, required: true });
    expect(hb.report()[0]!.status).toBe("starting");

    now += 1_000;
    hb.success("marketSync");
    expect(hb.report()[0]!.status).toBe("ok");

    now += 3 * 60_000 + 1;
    expect(hb.report()[0]!.status).toBe("stale");
  });

  test("a loop that never succeeds goes stale after its window", () => {
    let now = 0;
    const hb = new Heartbeats(() => now);
    hb.register("x", { intervalMs: 10, required: true });
    now = 31;
    expect(hb.report()[0]!.status).toBe("stale");
  });

  test("three failures in a row is failing; a success clears it", () => {
    let now = 0;
    const hb = new Heartbeats(() => now);
    hb.register("x", { intervalMs: 1_000, required: true });
    for (let i = 0; i < 3; i++) hb.failure("x", "VENUE_TIMEOUT");
    expect(hb.report()[0]!.status).toBe("failing");
    expect(hb.report()[0]!.lastFailureCode).toBe("VENUE_TIMEOUT");
    hb.success("x");
    expect(hb.report()[0]!.status).toBe("ok");
    expect(hb.report()[0]!.consecutiveFailures).toBe(0);
  });

  test("only fixed codes are kept, never a message", () => {
    const hb = new Heartbeats(() => 0);
    hb.register("x", { intervalMs: 1_000, required: false });
    hb.failure("x", "connect ECONNREFUSED 10.0.0.1:5432 password=hunter2");
    expect(hb.report()[0]!.lastFailureCode).toBe("UNCLASSIFIED");
  });

  test("run() records success and failure around a promise", async () => {
    const hb = new Heartbeats(() => 5);
    hb.register("x", { intervalMs: 1_000, required: false });
    expect(await hb.run("x", async () => 42, () => "E")).toBe(42);
    expect(hb.report()[0]!.lastSuccessAt).toBe(5);
    await expect(hb.run("x", async () => { throw new Error("no"); }, () => "BOOM")).rejects.toThrow("no");
    expect(hb.report()[0]!.lastFailureCode).toBe("BOOM");
  });
});

describe("computeReadiness", () => {
  const base = {
    hydrated: true,
    persisting: true,
    writer: okWriter(),
    heartbeats: [],
    requireDurable: false,
    now: 10_000,
    startedAt: 4_000,
  };

  test("ready when hydrated, the writer is clean and required loops are alive", () => {
    const r = computeReadiness(base);
    expect(r.ready).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.uptimeMs).toBe(6_000);
    expect(r.calls.writer.state).toBe("ok");
    expect(r.calls.persistence).toBe("postgres");
  });

  test("not ready before hydration", () => {
    expect(computeReadiness({ ...base, hydrated: false }).reasons).toContain("CALLS_NOT_HYDRATED");
  });

  test("not ready once the durable writer has failed", () => {
    const r = computeReadiness({ ...base, writer: { ...okWriter(), failures: [{}] } });
    expect(r.ready).toBe(false);
    expect(r.reasons).toContain("DURABLE_WRITER_FAILED");
    expect(r.calls.writer.state).toBe("failed");
  });

  test("a stale or failing REQUIRED loop is a reason; an optional one is reported only", () => {
    const hb = new Heartbeats(() => 0);
    hb.register("marketSync", { intervalMs: 1, required: true });
    hb.register("engineTick", { intervalMs: 1, required: false });
    const report = hb.report().map((w) => ({ ...w, status: "stale" as const }));
    const r = computeReadiness({ ...base, heartbeats: report });
    expect(r.reasons).toEqual(["WORKER_STALE:marketSync"]);
    expect(r.workers).toHaveLength(2);
  });

  test("in-memory persistence is only a reason when required", () => {
    expect(computeReadiness({ ...base, persisting: false, writer: null }).ready).toBe(true);
    expect(
      computeReadiness({ ...base, persisting: false, writer: null, requireDurable: true }).reasons,
    ).toContain("CALLS_NOT_DURABLE");
  });

  test("with no source registered yet, the answer is not ready", () => {
    setReadinessSource(null);
    expect(readinessNow().ready).toBe(false);
  });
});

describe("GET /ready over HTTP", () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
    setReadinessSource(null);
  });

  const serve = async (): Promise<string> => {
    server = createServer((req, res) => handleReady(req, res));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    return `http://127.0.0.1:${addr.port}/ready`;
  };

  test("200 with a JSON report when ready, 503 when not", async () => {
    const hb = new Heartbeats();
    hb.register("marketSync", { intervalMs: 60_000, required: true });
    hb.success("marketSync");
    let hydrated = true;
    setReadinessSource({
      hydrated: () => hydrated,
      persisting: () => true,
      writer: okWriter,
      heartbeats: hb,
      requireDurable: false,
      startedAt: Date.now(),
    });
    const url = await serve();

    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = (await ok.json()) as { ready: boolean; workers: Array<{ name: string; status: string }> };
    expect(body.ready).toBe(true);
    expect(body.workers[0]).toMatchObject({ name: "marketSync", status: "ok" });

    hydrated = false;
    const bad = await fetch(url);
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as { reasons: string[] }).reasons).toContain("CALLS_NOT_HYDRATED");

    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  });

  test("the public report carries no config, hosts or messages", async () => {
    const hb = new Heartbeats();
    hb.register("marketSync", { intervalMs: 60_000, required: true });
    hb.failure("marketSync", "VENUE_UNAVAILABLE");
    setReadinessSource({
      hydrated: () => true,
      persisting: () => true,
      writer: () => ({ failures: [{ label: "calls.insert", error: "secret detail" }], pending: 1, acceptedWrites: 1, completedWrites: 0 }),
      heartbeats: hb,
      requireDurable: false,
      startedAt: Date.now(),
    });
    const text = await (await fetch(await serve())).text();
    expect(text).not.toContain("secret detail");
    expect(text).not.toContain("calls.insert");
    expect(text).not.toMatch(/supabase|railway|https?:\/\//i);
  });
});
