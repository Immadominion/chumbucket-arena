/**
 * The one HTTP helper the venue adapters share: a hard timeout, a status→
 * VenueError mapping, and Retry-After parsing. It never logs a header, because
 * headers are where the API key lives.
 */

import { VenueError } from "./errors.ts";
import type { VenueId } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/** Parse Retry-After (seconds, or an HTTP-date) into milliseconds. */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return undefined;
}

/**
 * Perform one request. Returns the parsed JSON body as `unknown` — parsing it
 * into a domain shape is the adapter's job, and its failure is a schema error,
 * not a transport one.
 */
export async function httpJson(
  fetchImpl: FetchLike,
  venue: VenueId,
  req: HttpRequest,
  nowMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(req.url, {
      method: req.method ?? "GET",
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted || (err as { name?: string })?.name === "AbortError";
    throw new VenueError(
      aborted ? "VENUE_TIMEOUT" : "VENUE_UNAVAILABLE",
      aborted
        ? `${venue}: request timed out after ${req.timeoutMs}ms`
        : `${venue}: transport failure — ${(err as Error)?.message ?? "unknown"}`,
      { venue, details: { path: pathOf(req.url) }, cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw statusError(venue, res, req, nowMs, await safeText(res));

  const text = await safeText(res);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A non-JSON 200 is the venue changing shape under us.
    throw new VenueError("VENUE_SCHEMA", `${venue}: response was not JSON`, {
      venue,
      details: { path: pathOf(req.url), bodyPreview: text.slice(0, 200) },
    });
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Never echo a full URL with a query string back — it can carry credentials. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function statusError(
  venue: VenueId,
  res: Response,
  req: HttpRequest,
  nowMs: number,
  bodyPreview: string,
): VenueError {
  const details = { status: res.status, path: pathOf(req.url), bodyPreview: bodyPreview.slice(0, 200) };
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), nowMs);
    return new VenueError("VENUE_RATE_LIMITED", `${venue}: rate limited (429)`, {
      venue,
      details,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (res.status === 404) {
    return new VenueError("VENUE_NOT_FOUND", `${venue}: not found (404)`, { venue, details });
  }
  if (res.status === 408 || res.status === 504) {
    return new VenueError("VENUE_TIMEOUT", `${venue}: upstream timeout (${res.status})`, { venue, details });
  }
  if (res.status >= 500) {
    return new VenueError("VENUE_UNAVAILABLE", `${venue}: upstream error (${res.status})`, { venue, details });
  }
  return new VenueError("VENUE_BAD_REQUEST", `${venue}: rejected the request (${res.status})`, {
    venue,
    details,
  });
}
