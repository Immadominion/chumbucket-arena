/**
 * Supabase session verification.
 *
 * A Supabase access token is an HS256 JWT signed with the project's JWT secret.
 * That secret is not part of `AppConfig`, and `src/config.ts` is integration-
 * owned (contract §6), so this packet does NOT invent a local signature check
 * against a key it cannot legitimately obtain. Instead it asks the issuer:
 * `GET {supabaseUrl}/auth/v1/user` with the token as a Bearer credential.
 * GoTrue validates the signature, the expiry, and whether the session has been
 * revoked — which a local HS256 check could not do — and returns the user.
 * `SocialStore.verifyOAuthUser` already uses exactly this pattern, so this is
 * the project's established way to turn a Supabase token into an identity.
 *
 * The cheap local pre-check that happens first is an optimisation ONLY. It
 * rejects obvious junk (not three segments, no `sub`, already expired) without
 * a network round trip. It is never trusted on its own: an unsigned token that
 * passes the pre-check still has to survive GoTrue.
 *
 * Nothing here logs, returns, or stores the token, any claim of it, or the
 * service-role key.
 */

import type { IdentityStoreConfig } from "./IdentityStore.ts";

export interface SupabaseSession {
  /** auth.users.id — what auth.uid() evaluates to inside Postgres. */
  authUserId: string;
}

export interface SupabaseJwtVerifier {
  /** Returns the session, or null for a missing/invalid/expired credential. */
  verify(accessToken: string): Promise<SupabaseSession | null>;
}

/** Structural pre-check. NOT a signature check — see the module header. */
export function looksLikeLiveJwt(token: string, now: number): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const body = parts[1];
  if (!body) return false;
  try {
    const json = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { sub?: unknown; exp?: unknown };
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return false;
    // `exp` is seconds since epoch. Absent exp is not fatal here — GoTrue decides.
    if (typeof claims.exp === "number" && claims.exp * 1000 <= now) return false;
    return true;
  } catch {
    return false;
  }
}

export class GoTrueJwtVerifier implements SupabaseJwtVerifier {
  private readonly authBase: string;

  constructor(
    private readonly cfg: IdentityStoreConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowFn: () => number = Date.now,
  ) {
    this.authBase = `${cfg.supabaseUrl.replace(/\/$/, "")}/auth/v1`;
  }

  async verify(accessToken: string): Promise<SupabaseSession | null> {
    const token = accessToken?.trim();
    if (!token) return null;
    if (!looksLikeLiveJwt(token, this.nowFn())) return null;

    const res = await this.fetchImpl(`${this.authBase}/user`, {
      headers: { apikey: this.cfg.serviceRoleKey, Authorization: `Bearer ${token}` },
    });
    // Any non-2xx from GoTrue is "not a valid session", full stop. We do not
    // read the body on failure: it can echo the credential back.
    if (!res.ok) return null;

    const user = (await res.json()) as { id?: unknown; aud?: unknown };
    if (typeof user.id !== "string" || user.id.length === 0) return null;
    return { authUserId: user.id };
  }
}

/** Always-null verifier for a server with no Supabase project configured. */
export class UnconfiguredJwtVerifier implements SupabaseJwtVerifier {
  async verify(): Promise<SupabaseSession | null> {
    return null;
  }
}
