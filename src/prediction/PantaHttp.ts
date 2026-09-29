/** Server-only Panta writes. Session-opening POSTs are deliberately NOT retried. */
import { VenueError, schemaError } from "./errors.ts";
import { registerSecret } from "./redact.ts";
import { PANTA_BASE_URL } from "./PantaVenue.ts";

const paths = new Set(["/primaryorderquote/", "/primaryorderbuild/", "/primaryordersubmit/", "/primaryorderverify/", "/trades/", "/claim/build/"]);
export function pantaPost(apiKey: string, timeoutMs = 8_000, fetchImpl: typeof fetch = fetch) {
  registerSecret(apiKey);
  if (!/^pk_live_[A-Za-z0-9_-]+$/.test(apiKey)) throw new VenueError("VENUE_MISCONFIGURED", "Panta requires a live server key", { venue: "panta" });
  return async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    if (!paths.has(path)) throw new VenueError("VENUE_BAD_REQUEST", "Unsupported Panta operation", { venue: "panta" });
    try {
      const res = await fetchImpl(`${PANTA_BASE_URL}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Never echo provider error bodies, request objects, or causes.
        const code = res.status === 429 ? "VENUE_RATE_LIMITED" : res.status === 404 ? "VENUE_NOT_FOUND"
          : res.status >= 500 ? "VENUE_UNAVAILABLE" : "VENUE_BAD_REQUEST";
        throw new VenueError(code, `Panta operation refused (HTTP ${res.status}); review or requote`, { venue: "panta" });
      }
      const text = await res.text();
      if (text.length > 262_144 || text.includes(apiKey)) throw schemaError("panta", "unsafe operation response");
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw schemaError("panta", "invalid operation JSON"); }
      if (data && typeof data === "object") {
        const flags = data as Record<string, unknown>;
        if (flags.demo === true || flags.testMode === true || /sandbox|fixture|test mode/i.test(String(flags.disclaimer ?? ""))) {
          throw schemaError("panta", "sandbox execution response");
        }
      }
      return data;
    } catch (error) {
      if (error instanceof VenueError) throw error;
      throw new VenueError("VENUE_UNAVAILABLE", "Panta operation did not complete; do not assume a fill", { venue: "panta" });
    }
  };
}
