/**
 * FCM HTTP v1, without the Firebase Admin SDK.
 *
 * The admin SDK does two things here, both small enough to own: mint an OAuth2
 * access token from the service account (a JWT signed RS256 with the account's
 * private key, exchanged at Google's token endpoint) and POST one message per
 * device to `projects/{id}/messages:send`. Owning them keeps the dependency
 * tree (and the shared lockfile) unchanged.
 *
 * Nothing here logs a token, a key, a device token or a response body.
 */

import { createSign } from "node:crypto";
import type { ServiceAccount } from "./config.ts";

export type FetchLike = typeof fetch;

export interface PushMessage {
  title: string;
  body: string;
  /** String values only — FCM data payloads are string maps. */
  data: Record<string, string>;
}

/**
 * ok           delivered to FCM
 * unregistered the device token is dead (uninstalled, signed out, rotated) —
 *              forget it
 * retry        FCM or the network is struggling; the message is dropped this
 *              time (the inbox still has it)
 * failed       our request is wrong (auth, payload); dropped, reported
 */
export type SendOutcome = "ok" | "unregistered" | "retry" | "failed";

export interface PushSender {
  send(deviceToken: string, message: PushMessage): Promise<SendOutcome>;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The RS256 assertion Google's token endpoint exchanges for an access token. */
export function signServiceAccountJwt(account: ServiceAccount, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: SCOPE,
      aud: account.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(account.privateKey))}`;
}

export class FcmHttpV1Sender implements PushSender {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async token(): Promise<string> {
    const at = this.now();
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > at) return this.accessToken.value;
    const assertion = signServiceAccountJwt(this.account, Math.floor(at / 1000));
    const res = await this.fetchImpl(this.account.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`push: token exchange failed (HTTP ${res.status})`);
    const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== "string") throw new Error("push: token exchange returned no access token");
    const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.accessToken = { value: json.access_token, expiresAt: at + ttl * 1000 };
    return json.access_token;
  }

  async send(deviceToken: string, message: PushMessage): Promise<SendOutcome> {
    let bearer: string;
    try {
      bearer = await this.token();
    } catch {
      return "retry";
    }
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: { priority: "high", notification: { tag: message.data.notification_id ?? undefined } },
          },
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return "retry";
    }
    if (res.ok) return "ok";
    if (res.status === 401) {
      // A stale access token: mint a fresh one next time.
      this.accessToken = null;
      return "retry";
    }
    if (res.status === 404) return "unregistered";
    if (res.status === 400) {
      // INVALID_ARGUMENT is also how FCM answers a malformed or foreign token.
      const code = await errorCode(res);
      return code === "UNREGISTERED" || code === "INVALID_ARGUMENT" ? "unregistered" : "failed";
    }
    if (res.status === 429 || res.status >= 500) return "retry";
    return "failed";
  }
}

async function errorCode(res: Response): Promise<string | null> {
  try {
    const json = (await res.json()) as { error?: { status?: unknown; details?: { errorCode?: unknown }[] } };
    const detail = json.error?.details?.find((d) => typeof d?.errorCode === "string")?.errorCode;
    if (typeof detail === "string") return detail;
    return typeof json.error?.status === "string" ? json.error.status : null;
  } catch {
    return null;
  }
}
