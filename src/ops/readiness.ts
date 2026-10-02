/**
 * `/ready` — is this instance actually able to serve the calls product?
 *
 * `/health` (the tRPC procedure Railway probes) answers "is the process up".
 * It is static: it reads the wiring chosen at boot and says nothing about
 * whether the durable writer has failed, whether the mirrors finished
 * hydrating from Postgres, or whether the market/result sync has silently
 * stopped. `/ready` answers those, for an uptime monitor or alert:
 *
 *   200 {"ready":true,...}   everything the calls product needs is working
 *   503 {"ready":false,...}  something is not; `reasons` says what
 *
 * Deliberately NOT the Railway healthcheck path: a stale worker should page a
 * human, not make the platform kill a process that is still serving reads.
 *
 * Public by design (an external monitor must reach it), so it carries only
 * states, timestamps, counts and fixed codes: no config values, no hostnames,
 * no error messages, no wallet or user data.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { HeartbeatReport, Heartbeats } from "./heartbeats.ts";

export interface DurableWriterView {
  failures: readonly unknown[];
  pending: number;
  acceptedWrites: number;
  completedWrites: number;
}

export interface ReadinessInputs {
  /** Whether the calls/markets mirrors finished hydrating. */
  hydrated: boolean;
  /** Whether calls are written to Postgres. */
  persisting: boolean;
  /** The shared FIFO writer, when persisting. */
  writer: DurableWriterView | null;
  heartbeats: HeartbeatReport[];
  /** When true, an in-memory calls store is itself a reason not to be ready. */
  requireDurable: boolean;
  now: number;
  startedAt: number;
}

export interface ReadinessReport {
  ready: boolean;
  reasons: string[];
  uptimeMs: number;
  calls: {
    hydrated: boolean;
    persistence: "postgres" | "in-memory";
    writer: {
      state: "ok" | "failed" | "absent";
      pending: number;
      failures: number;
      acceptedWrites: number;
      completedWrites: number;
    };
  };
  workers: HeartbeatReport[];
  servedAt: number;
}

export function computeReadiness(i: ReadinessInputs): ReadinessReport {
  const reasons: string[] = [];
  if (!i.hydrated) reasons.push("CALLS_NOT_HYDRATED");
  if (!i.persisting && i.requireDurable) reasons.push("CALLS_NOT_DURABLE");

  const failures = i.writer?.failures.length ?? 0;
  if (failures > 0) reasons.push("DURABLE_WRITER_FAILED");

  for (const w of i.heartbeats) {
    if (!w.required) continue;
    if (w.status === "stale") reasons.push(`WORKER_STALE:${w.name}`);
    if (w.status === "failing") reasons.push(`WORKER_FAILING:${w.name}`);
  }

  return {
    ready: reasons.length === 0,
    reasons,
    uptimeMs: Math.max(0, i.now - i.startedAt),
    calls: {
      hydrated: i.hydrated,
      persistence: i.persisting ? "postgres" : "in-memory",
      writer: {
        state: i.writer === null ? "absent" : failures > 0 ? "failed" : "ok",
        pending: i.writer?.pending ?? 0,
        failures,
        acceptedWrites: i.writer?.acceptedWrites ?? 0,
        completedWrites: i.writer?.completedWrites ?? 0,
      },
    },
    workers: i.heartbeats,
    servedAt: i.now,
  };
}

/** What `src/index.ts` registers so the HTTP layer can answer `/ready`. */
export interface ReadinessSource {
  hydrated(): boolean;
  persisting(): boolean;
  writer(): DurableWriterView | null;
  heartbeats: Heartbeats;
  requireDurable: boolean;
  startedAt: number;
}

let source: ReadinessSource | null = null;

export function setReadinessSource(s: ReadinessSource | null): void {
  source = s;
}

export function readinessNow(now: number = Date.now()): ReadinessReport {
  if (!source) {
    return computeReadiness({
      hydrated: false,
      persisting: false,
      writer: null,
      heartbeats: [],
      requireDurable: false,
      now,
      startedAt: now,
    });
  }
  return computeReadiness({
    hydrated: source.hydrated(),
    persisting: source.persisting(),
    writer: source.writer(),
    heartbeats: source.heartbeats.report(),
    requireDurable: source.requireDurable,
    now,
    startedAt: source.startedAt,
  });
}

/** Plain-HTTP handler, mounted by `src/api/server.ts` beside the webhook. */
export function handleReady(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    return;
  }
  const report = readinessNow();
  res.writeHead(report.ready ? 200 : 503, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(report));
}
