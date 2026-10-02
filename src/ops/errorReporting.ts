/**
 * Error reporting to Sentry, configured entirely by environment.
 *
 *   SENTRY_DSN            absent or invalid -> reporting is OFF (nothing sent)
 *   SENTRY_ENVIRONMENT    default: NODE_ENV, else "production"
 *   SENTRY_RELEASE        default: RAILWAY_GIT_COMMIT_SHA, else unset
 *
 * A dependency-free client for Sentry's envelope endpoint, so turning error
 * reporting on is a Railway variable, not a lockfile change. It sends only
 * what an engineer needs to find a bug: error type, a scrubbed message, a
 * stack, the tRPC path or worker name, and fixed codes. Never a request body,
 * a header, a token, a wallet address, an email or a provider response.
 *
 * It must never become the outage: every send is fire-and-forget with a
 * timeout, failures are swallowed, and a rate limit stops a crash loop from
 * flooding the project.
 */

import { randomUUID } from "node:crypto";

export type ErrorLevel = "error" | "fatal" | "warning";

export interface ErrorContext {
  level?: ErrorLevel;
  /** Short, non-secret labels, e.g. { source: "trpc", path: "calls.create" }. */
  tags?: Record<string, string>;
}

export interface ErrorReporter {
  readonly enabled: boolean;
  /** Why reporting is on or off, safe to log (never contains the DSN). */
  readonly reason: string;
  capture(err: unknown, ctx?: ErrorContext): void;
  /** Wait (bounded) for in-flight sends. */
  flush(timeoutMs?: number): Promise<void>;
}

export interface ParsedDsn {
  publicKey: string;
  projectId: string;
  envelopeUrl: string;
}

/** `https://<key>@<host>[/<path>]/<projectId>` -> where and how to send. */
export function parseDsn(dsn: string | undefined): ParsedDsn | null {
  if (!dsn || !dsn.trim()) return null;
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const publicKey = decodeURIComponent(url.username);
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = segments.length ? `/${segments.join("/")}` : "";
  return {
    publicKey,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

const SCRUBBERS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [/\b(api[-_]?key|apikey|access_token|token|secret|password|key)=([^&\s"']+)/gi, "$1=[redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Solana addresses and signatures (base58, 32-88 chars).
  [/\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g, "[base58]"],
  [/postgres(ql)?:\/\/[^\s"']+/gi, "[postgres-url]"],
];

/** Removes credentials and personal identifiers from free text. */
export function scrub(text: string): string {
  let out = text;
  for (const [re, replacement] of SCRUBBERS) out = out.replace(re, replacement);
  return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
}

interface Frame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

/** V8/JSC "at fn (file:line:col)" lines -> Sentry frames, oldest first. */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const filename = m[2]!.replace(/^file:\/\//, "");
    frames.push({
      function: m[1] ?? "<anonymous>",
      filename: filename.replace(/^.*?\/(src|node_modules)\//, "$1/"),
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes("node_modules"),
    });
  }
  return frames.reverse().slice(-50);
}

function errorParts(err: unknown): { type: string; value: string; stack?: string } {
  if (err instanceof Error) {
    return { type: err.name || "Error", value: scrub(err.message ?? ""), stack: err.stack };
  }
  return { type: "NonError", value: scrub(typeof err === "string" ? err : safeJson(err)) };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const TAG_KEY = /^[a-zA-Z0-9_.-]{1,32}$/;

export interface SentryReporterOptions {
  dsn: ParsedDsn;
  environment: string;
  release?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Max events per rolling minute. */
  maxPerMinute?: number;
}

export class SentryReporter implements ErrorReporter {
  readonly enabled = true;
  readonly reason: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxPerMinute: number;
  private sentTimes: number[] = [];
  private readonly recent = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();
  private warned = false;

  constructor(private readonly opts: SentryReporterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.maxPerMinute = opts.maxPerMinute ?? 20;
    this.reason = `on (environment ${opts.environment}${opts.release ? `, release ${opts.release.slice(0, 12)}` : ""})`;
  }

  /** Builds the event without sending it. Exposed for tests. */
  buildEvent(err: unknown, ctx: ErrorContext = {}): Record<string, unknown> {
    const parts = errorParts(err);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.tags ?? {})) {
      if (TAG_KEY.test(k)) tags[k] = scrub(String(v)).slice(0, 200);
    }
    const frames = parseStack(parts.stack);
    return {
      event_id: randomUUID().replace(/-/g, ""),
      timestamp: this.now() / 1000,
      platform: "node",
      level: ctx.level ?? "error",
      logger: "chumbucket-bff",
      environment: this.opts.environment,
      ...(this.opts.release ? { release: this.opts.release } : {}),
      tags,
      exception: {
        values: [
          {
            type: parts.type,
            value: parts.value,
            ...(frames.length ? { stacktrace: { frames } } : {}),
          },
        ],
      },
    };
  }

  capture(err: unknown, ctx: ErrorContext = {}): void {
    try {
      const t = this.now();
      this.sentTimes = this.sentTimes.filter((s) => t - s < 60_000);
      if (this.sentTimes.length >= this.maxPerMinute) return;

      const parts = errorParts(err);
      const fingerprint = `${parts.type}|${parts.value}|${ctx.tags?.path ?? ctx.tags?.worker ?? ""}`;
      const last = this.recent.get(fingerprint);
      if (last !== undefined && t - last < 60_000) return;
      this.recent.set(fingerprint, t);
      if (this.recent.size > 500) this.recent.clear();
      this.sentTimes.push(t);

      const event = this.buildEvent(err, ctx);
      const body =
        `${JSON.stringify({ event_id: event.event_id, sent_at: new Date(t).toISOString() })}\n` +
        `${JSON.stringify({ type: "event" })}\n` +
        `${JSON.stringify(event)}\n`;
      const p = this.fetchImpl(this.opts.dsn.envelopeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_client=chumbucket-bff/1.0, sentry_key=${this.opts.dsn.publicKey}`,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      })
        .then(() => undefined)
        .catch(() => {
          if (!this.warned) {
            this.warned = true;
            console.warn("[errors] could not reach the error reporter; continuing without it");
          }
        })
        .finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    } catch {
      // Reporting must never throw into the caller.
    }
  }

  async flush(timeoutMs = 2_000): Promise<void> {
    if (this.inflight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}

class DisabledReporter implements ErrorReporter {
  readonly enabled = false;
  constructor(readonly reason: string) {}
  capture(): void {}
  async flush(): Promise<void> {}
}

export function errorReporterFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): ErrorReporter {
  if (!env.SENTRY_DSN || !env.SENTRY_DSN.trim()) {
    return new DisabledReporter("off (SENTRY_DSN not set)");
  }
  const dsn = parseDsn(env.SENTRY_DSN);
  if (!dsn) return new DisabledReporter("off (SENTRY_DSN is not a valid DSN)");
  return new SentryReporter({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || "production",
    release: env.SENTRY_RELEASE?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined,
    fetchImpl,
  });
}

let active: ErrorReporter = new DisabledReporter("off (not installed)");

/** The process-wide reporter. */
export function errorReporter(): ErrorReporter {
  return active;
}

/** Report an error to the configured reporter; a no-op when reporting is off. */
export function reportError(err: unknown, ctx?: ErrorContext): void {
  active.capture(err, ctx);
}

/**
 * Configures the process-wide reporter from the environment. When reporting is
 * on, uncaught exceptions and unhandled rejections are reported and the
 * process still exits with code 1 exactly as it would have (Railway's
 * ON_FAILURE policy restarts it). When off, nothing about the process changes.
 */
export function installErrorReporting(
  env: Record<string, string | undefined> = process.env,
  proc: Pick<NodeJS.Process, "on" | "exit"> = process,
  fetchImpl?: typeof fetch,
): ErrorReporter {
  active = errorReporterFromEnv(env, fetchImpl);
  if (!active.enabled) return active;
  const die = (err: unknown, source: string) => {
    console.error(`[fatal] ${source}:`, err);
    active.capture(err, { level: "fatal", tags: { source } });
    void active.flush(2_000).finally(() => proc.exit(1));
  };
  proc.on("uncaughtException", (err) => die(err, "uncaughtException"));
  proc.on("unhandledRejection", (reason) => die(reason, "unhandledRejection"));
  return active;
}

/** Test seam. */
export function setErrorReporterForTest(r: ErrorReporter | null): void {
  active = r ?? new DisabledReporter("off (not installed)");
}
