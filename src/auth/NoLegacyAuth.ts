/**
 * The legacy-credential adapter for a production calls BFF with no verifying
 * provider configured: it accepts NOTHING.
 *
 * `DevAuth` treats the `x-wallet` header (or any bearer string) as a verified
 * wallet. That is fine on a laptop and indefensible in production, where it
 * made every `authedProcedure` accept any string as identity (B2). The social
 * and Panta paths never read that credential — they verify a Supabase session
 * — so in production the honest replacement is an adapter under which no
 * legacy credential ever verifies.
 */

import type { OAuthIdentity } from "../social/SocialStore.ts";
import type { Auth, AuthedUser } from "./Auth.ts";

export class NoLegacyAuth implements Auth {
  async verify(): Promise<AuthedUser | null> {
    return null;
  }

  async fetchLinkedIdentities(): Promise<OAuthIdentity[]> {
    return [];
  }
}
