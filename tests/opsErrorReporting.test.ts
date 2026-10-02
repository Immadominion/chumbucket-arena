/**
 * Sentry error reporting via environment (audit M5): absent = off, and when on
 * it sends only scrubbed, identity-free events, bounded and fire-and-forget.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  errorReporterFromEnv,
  installErrorReporting,
  parseDsn,
  parseStack,
  reportError,
  scrub,
  SentryReporter,
  setErrorReporterForTest,
} from "../src/ops/errorReporting.ts";

const DSN = "https://abc123@o42.ingest.sentry.io/4507";

function recorder() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const eventOf = (body: string) => JSON.parse(body.trim().split("\n")[2]!) as Record<string, any>;

afterEach(() => setErrorReporterForTest(null));

describe("configuration", () => {
  test("no SENTRY_DSN means off, and installing changes nothing", () => {
    const listeners: string[] = [];
    const r = installErrorReporting({}, { on: ((e: string) => { listeners.push(e); }) as any, exit: (() => {}) as any });
    expect(r.enabled).toBe(false);
    expect(r.reason).toContain("SENTRY_DSN not set");
    expect(listeners).toEqual([]);
    reportError(new Error("nothing happens"));
  });

  test("an invalid DSN is off, and the reason never repeats the value", () => {
    const r = errorReporterFromEnv({ SENTRY_DSN: "not a dsn secretvalue" });
    expect(r.enabled).toBe(false);
    expect(r.reason).not.toContain("secretvalue");
  });

  test("a valid DSN is on; environment and release come from env", () => {
    const r = errorReporterFromEnv({ SENTRY_DSN: DSN, NODE_ENV: "production", RAILWAY_GIT_COMMIT_SHA: "9870733abcdef0123" });
    expect(r.enabled).toBe(true);
    expect(r.reason).toContain("production");
    expect(r.reason).not.toContain("abc123");
  });

  test("parseDsn builds the envelope endpoint", () => {
    expect(parseDsn(DSN)).toEqual({
      publicKey: "abc123",
      projectId: "4507",
      envelopeUrl: "https://o42.ingest.sentry.io/api/4507/envelope/",
    });
    expect(parseDsn("https://k@host/prefix/12")?.envelopeUrl).toBe("https://host/prefix/api/12/envelope/");
    expect(parseDsn("https://host/12")).toBeNull();
    expect(parseDsn("https://k@host/notanumber")).toBeNull();
    expect(parseDsn(undefined)).toBeNull();
  });

  test("when on, fatal process errors are reported and still exit 1", async () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    let exitCode = 0;
    const { calls, fetchImpl } = recorder();
    installErrorReporting(
      { SENTRY_DSN: DSN },
      {
        on: ((e: string, h: (x: unknown) => void) => { handlers[e] = h; }) as any,
        exit: ((code: number) => { exitCode = code; }) as any,
      },
      fetchImpl,
    );
    expect(Object.keys(handlers).sort()).toEqual(["uncaughtException", "unhandledRejection"]);

    const origError = console.error;
    console.error = () => {};
    try {
      handlers.unhandledRejection!(new Error("rejected"));
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.error = origError;
    }
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    const event = eventOf(String(calls[0]!.init.body));
    expect(event.level).toBe("fatal");
    expect(event.tags).toEqual({ source: "unhandledRejection" });
  });
});

describe("what is sent", () => {
  test("one envelope, authenticated with the public key, with a scrubbed event", async () => {
    const { calls, fetchImpl } = recorder();
    const r = new SentryReporter({ dsn: parseDsn(DSN)!, environment: "production", release: "abc", fetchImpl, now: () => 1_700_000_000_000 });
    const err = new Error(
      "insert failed for 479yvcq7yibHaVKAGLEWu89G7G3KnmWSaDZHNXphd1Mu with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4In0.c2lnbmF0dXJlc2ln ada@example.com https://rpc.example/?api-key=SECRETKEY",
    );
    r.capture(err, { tags: { source: "trpc", path: "calls.create", "bad key!": "x" } });
    await r.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://o42.ingest.sentry.io/api/4507/envelope/");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-sentry-auth"]).toContain("sentry_key=abc123");
    expect(headers["content-type"]).toBe("application/x-sentry-envelope");

    const body = String(calls[0]!.init.body);
    for (const secret of ["479yvcq7yibHaVKAGLEWu89G7G3KnmWSaDZHNXphd1Mu", "eyJhbGciOiJIUzI1NiJ9", "ada@example.com", "SECRETKEY"]) {
      expect(body).not.toContain(secret);
    }
    const event = eventOf(body);
    expect(event.environment).toBe("production");
    expect(event.release).toBe("abc");
    expect(event.tags).toEqual({ source: "trpc", path: "calls.create" });
    expect(event.exception.values[0].type).toBe("Error");
    expect(event.exception.values[0].value).toContain("[base58]");
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("request");
  });

  test("duplicates within a minute are sent once, and the rate is capped", async () => {
    let now = 0;
    const { calls, fetchImpl } = recorder();
    const r = new SentryReporter({ dsn: parseDsn(DSN)!, environment: "t", fetchImpl, now: () => now, maxPerMinute: 3 });
    for (let i = 0; i < 5; i++) r.capture(new Error("same"));
    await r.flush();
    expect(calls).toHaveLength(1);

    for (let i = 0; i < 10; i++) r.capture(new Error(`distinct ${i}`));
    await r.flush();
    expect(calls).toHaveLength(3);

    now += 61_000;
    r.capture(new Error("same"));
    await r.flush();
    expect(calls).toHaveLength(4);
  });

  test("a failing transport never throws into the caller", async () => {
    const r = new SentryReporter({
      dsn: parseDsn(DSN)!,
      environment: "t",
      fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(() => r.capture(new Error("x"))).not.toThrow();
      await r.flush();
    } finally {
      console.warn = warn;
    }
  });

  test("non-Error values are reported as NonError", () => {
    const r = new SentryReporter({ dsn: parseDsn(DSN)!, environment: "t", fetchImpl: recorder().fetchImpl });
    const e = r.buildEvent({ weird: true }) as any;
    expect(e.exception.values[0].type).toBe("NonError");
  });
});

describe("helpers", () => {
  test("scrub removes tokens, keys, emails, wallets and database URLs", () => {
    const out = scrub(
      "postgresql://user:pw@db.host:5432/x token=abc password=p key=k1 Bearer xyz.abc 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin a@b.co",
    );
    expect(out).not.toMatch(/user:pw|abc|=p\b|k1|xyz|9xQeWv|a@b\.co/);
  });

  test("parseStack reads V8/JSC frames, oldest first", () => {
    const frames = parseStack(
      "Error: x\n    at inner (/app/src/calls/CallsService.ts:10:5)\n    at outer (/app/node_modules/zod/index.js:3:1)\n    at /app/src/index.ts:1:2",
    );
    expect(frames.map((f) => f.filename)).toEqual(["src/index.ts", "node_modules/zod/index.js", "src/calls/CallsService.ts"]);
    expect(frames[1]!.in_app).toBe(false);
    expect(frames[2]!.function).toBe("inner");
  });
});
