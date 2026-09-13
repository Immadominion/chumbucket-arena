/**
 * Secret redaction. The venue API key is server-side only: contracts §4 says it
 * is never in a response body, a log line, or a client.
 *
 * Relying on "we remember not to log it" is not a control. Instead every secret
 * the adapter holds is registered here at construction, and EVERY VenueError
 * message/detail runs through `redactSecrets` on the way out — so even an
 * upstream body that echoes the key back cannot leak it through an error.
 */

/** Registered secrets. Short strings are ignored (too collision-prone to mask). */
const SECRETS = new Set<string>();

const MIN_SECRET_LENGTH = 8;

export const REDACTED = "[redacted]";

/** Register a secret so it can never appear in an error, a log or a response. */
export function registerSecret(secret: string | undefined | null): void {
  if (!secret) return;
  if (secret.length < MIN_SECRET_LENGTH) return;
  SECRETS.add(secret);
}

/** Replace every registered secret in `text` with `[redacted]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const s of SECRETS) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

/** Deep-redact any JSON-ish value: strings are masked, structure is preserved. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Mask the value of anything that *names* itself a credential, whether or
      // not the literal was registered (defence against a rotated key).
      out[k] = /key|secret|token|authorization|password/i.test(k)
        ? REDACTED
        : redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Test-only: forget every registered secret. */
export function __clearSecretsForTests(): void {
  SECRETS.clear();
}
