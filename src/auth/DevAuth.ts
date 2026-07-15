/**
 * Dev auth — the credential IS the Solana address. No verification, no network.
 * This is what the `x-wallet` header used to mean; it stays the default when
 * Privy isn't configured so local dev, the smoke run, and tests keep working.
 * NEVER the production path — PrivyAuth verifies a real session.
 */

import { asWallet } from "../domain/ids.ts";
import type { Auth, AuthedUser } from "./Auth.ts";

export class DevAuth implements Auth {
  async verify(token: string): Promise<AuthedUser | null> {
    const t = token?.trim();
    if (!t) return null;
    const wallet = asWallet(t);
    return { userId: `dev:${wallet}`, wallet };
  }
}
