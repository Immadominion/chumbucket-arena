/**
 * Push configuration: a Firebase service account for FCM HTTP v1, from env.
 *
 *   FIREBASE_SERVICE_ACCOUNT_JSON   the service-account JSON key, either raw or
 *                                   base64-encoded. Absent -> no pushes are
 *                                   sent, and the server says so once.
 *   PUSH_MAX_AGE_MS                 only events this recent are pushed
 *                                   (default 30 minutes), so a backlog derived
 *                                   after downtime or a first deploy never
 *                                   floods anyone's lock screen.
 *
 * The private key never leaves this module except into the signer, is never
 * logged, and a malformed value is reported without quoting it.
 */

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export type PushConfig =
  | { enabled: true; account: ServiceAccount; maxAgeMs: number }
  | { enabled: false; reason: string; maxAgeMs: number };

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

function decode(raw: string): unknown {
  const text = raw.trim();
  if (text.startsWith("{")) return JSON.parse(text);
  return JSON.parse(Buffer.from(text, "base64").toString("utf8"));
}

export function resolvePushConfig(env: Record<string, string | undefined> = process.env): PushConfig {
  const age = Number(env.PUSH_MAX_AGE_MS);
  const maxAgeMs = Number.isFinite(age) && age > 0 ? age : DEFAULT_MAX_AGE_MS;
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || raw.trim() === "") {
    return { enabled: false, reason: "FIREBASE_SERVICE_ACCOUNT_JSON is not set", maxAgeMs };
  }
  let parsed: unknown;
  try {
    parsed = decode(raw);
  } catch {
    return { enabled: false, reason: "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON (raw or base64)", maxAgeMs };
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const projectId = o.project_id;
  const clientEmail = o.client_email;
  const privateKey = o.private_key;
  if (typeof projectId !== "string" || typeof clientEmail !== "string" || typeof privateKey !== "string" ||
      !projectId || !clientEmail || !privateKey.includes("PRIVATE KEY")) {
    return {
      enabled: false,
      reason: "FIREBASE_SERVICE_ACCOUNT_JSON lacks project_id, client_email or private_key",
      maxAgeMs,
    };
  }
  // The token endpoint is Google's, always: a signed assertion is never sent
  // to an address read out of configuration.
  return {
    enabled: true,
    account: { projectId, clientEmail, privateKey, tokenUri: GOOGLE_TOKEN_URI },
    maxAgeMs,
  };
}
