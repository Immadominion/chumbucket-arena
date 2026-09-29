/**
 * Supabase session verification.
 *
 * Supabase issues JWTs using the project's configured signing mechanism.
 * This adapter does not assume an algorithm or trust locally decoded claims.
 * Instead it asks the issuer:
 * `GET {supabaseUrl}/auth/v1/user` with the token as a Bearer credential.
 * GoTrue validates the credential and returns the user. Access-token revocation
 * semantics remain the issuer's policy; this is not an instant-revocation claim.
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
import { AuthIdentityError } from "./AuthIdentityError.ts";

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

    try {
      const res = await this.fetchImpl(`${this.authBase}/user`, {
        headers: { apikey: this.cfg.serviceRoleKey, Authorization: `Bearer ${token}` },
        redirect: "manual", signal: AbortSignal.timeout(10_000),
      });
      // A redirect cannot become another issuer or receive the credential.
      // Do not read failure bodies: they can echo the request back.
      if (!res.ok) return null;

      const user = (await res.json()) as { id?: unknown; aud?: unknown } | null;
      if (!user || typeof user.id !== "string" || user.id.length === 0) return null;
      return { authUserId: user.id };
    } catch (_) {
      // whoami/onboarding also use this verifier; all callers get only a
      // fixed safe code, never a native exception containing headers/body.
      throw new AuthIdentityError("IDENTITY_STORE_ERROR");
    }
  }
}

/** Always-null verifier for a server with no Supabase project configured. */
export class UnconfiguredJwtVerifier implements SupabaseJwtVerifier {
  async verify(): Promise<SupabaseSession | null> {
    return null;
  }
}
