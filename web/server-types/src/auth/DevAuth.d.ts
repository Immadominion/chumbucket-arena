/**
 * Dev auth — the credential IS the Solana address. No verification, no network.
 * This is what the `x-wallet` header used to mean; it stays the default when
 * Privy isn't configured so local dev, the smoke run, and tests keep working.
 * NEVER the production path — PrivyAuth verifies a real session.
 */
import type { OAuthIdentity } from "../social/SocialStore";
import type { Auth, AuthedUser } from "./Auth";
export declare class DevAuth implements Auth {
    verify(token: string): Promise<AuthedUser | null>;
    /** Dev auth has no real provider session to ask — nothing to link. */
    fetchLinkedIdentities(): Promise<OAuthIdentity[]>;
}
