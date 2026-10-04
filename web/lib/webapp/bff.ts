/**
 * The web app's client for the calls BFF: tRPC's own wire (GET for queries,
 * POST for mutations, superjson envelopes), with the session's Supabase
 * access token as `Authorization: Bearer`, exactly as the Android app sends
 * it. The BFF verifies that token with Supabase on every call; nothing here
 * asserts who anybody is.
 *
 * The token travels in the header only, never in a URL. Procedures that take
 * it as input (`auth.whoami`, `auth.completeProfile`) are mutations, so it
 * travels in a POST body.
 *
 * Errors come back as four kinds the screens tell apart:
 *   SignedOut  - UNAUTHORIZED: sign in again
 *   Rejected   - a refusal a person can read (the BFF writes its 4xx
 *                messages as copy), shown as it is
 *   Failure    - the BFF failed (5xx): a generic line, never its message
 *   Offline    - the request never completed
 *
 * Pure: no DOM, so the BFF repo's bun tests can import it.
 */

import superjson from "superjson";

export const BFF_URL = (
  process.env.NEXT_PUBLIC_CALLS_BFF_URL ?? "https://chumbucket-calls-bff-production.up.railway.app"
).replace(/\/+$/, "");

export class BffError extends Error {
  constructor(
    message: string,
    /** The tRPC code (`UNAUTHORIZED`, `CONFLICT`, …) or `OFFLINE`. */
    readonly code: string,
    /** The BFF's public, machine-readable facts (`data.details`): only its own ids and codes, strings only. */
    readonly details: Readonly<Record<string, string>> | null = null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
/** No session the BFF accepts. */
export class BffSignedOut extends BffError {}
/** A refusal with a message written for people. */
export class BffRejected extends BffError {}
/** The BFF failed. Its message is not copy. */
export class BffFailure extends BffError {}
/** The request never completed. */
export class BffOffline extends BffError {}

/** 4xx codes whose messages the BFF writes as copy (the app shows them verbatim too). */
const READABLE = new Set([
  "BAD_REQUEST",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "UNPROCESSABLE_CONTENT",
  "TOO_MANY_REQUESTS",
]);

const FALLBACK = "That didn’t work. Try again.";

/** A zod validation failure arrives as serialized issues, not a sentence. */
function readable(message: unknown): string {
  if (typeof message !== "string") return FALLBACK;
  const m = message.trim();
  if (!m || m.startsWith("[") || m.startsWith("{")) return FALLBACK;
  return m;
}

/** `data.details`: a flat object of short strings, or nothing. */
function detailsOf(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.length <= 200 && /^[A-Za-z0-9_]{1,40}$/.test(k)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function queryUrl(base: string, path: string, input: unknown): string {
  const url = `${base}/${path}`;
  if (input === undefined) return url;
  return `${url}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`;
}

/** Map a tRPC response body (and its HTTP status) to data, or throw the right kind. */
export function parseTrpcResponse<T>(status: number, body: unknown): T {
  const err = (body as { error?: { json?: { message?: unknown; data?: { code?: unknown; details?: unknown } } } } | null)?.error;
  if (err) {
    const code = typeof err.json?.data?.code === "string" ? err.json.data.code : status >= 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST";
    const message = err.json?.message;
    const details = detailsOf(err.json?.data?.details);
    if (code === "UNAUTHORIZED") throw new BffSignedOut(readable(message), code, details);
    if (READABLE.has(code)) throw new BffRejected(readable(message), code, details);
    throw new BffFailure(typeof message === "string" ? message : FALLBACK, code, details);
  }
  const data = (body as { result?: { data?: unknown } } | null)?.result?.data;
  if (data === undefined) throw new BffFailure("Unexpected response", "PARSE_ERROR");
  return superjson.deserialize(data as Parameters<typeof superjson.deserialize>[0]) as T;
}

export interface BffCallOptions {
  path: string;
  input?: unknown;
  kind: "query" | "mutation";
  /** The Supabase access token, or null when signed out. */
  token?: string | null;
  base?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function bffCall<T>(opts: BffCallOptions): Promise<T> {
  const base = opts.base ?? BFF_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  // Older browsers lack AbortSignal.timeout/any: then the request simply has no deadline.
  const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(opts.timeoutMs ?? 15_000) : undefined;
  const signal =
    opts.signal && timeout && typeof AbortSignal.any === "function"
      ? AbortSignal.any([opts.signal, timeout])
      : (opts.signal ?? timeout);
  let res: Response;
  try {
    if (opts.kind === "query") {
      res = await doFetch(queryUrl(base, opts.path, opts.input), { method: "GET", headers, signal });
    } else {
      headers["content-type"] = "application/json";
      res = await doFetch(`${base}/${opts.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(superjson.serialize(opts.input ?? {})),
        signal,
      });
    }
  } catch (e) {
    // A caller that cancelled is not offline; let the cancellation through.
    if (opts.signal?.aborted) throw e;
    throw new BffOffline("You’re offline.", "OFFLINE");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new BffFailure("Unexpected response", res.status >= 500 ? "INTERNAL_SERVER_ERROR" : "PARSE_ERROR");
  }
  return parseTrpcResponse<T>(res.status, body);
}
