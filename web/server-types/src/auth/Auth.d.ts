/**
 * Auth port — turns a client credential into the player identity (their Solana
 * address). The API depends on this, not on any one provider, so swapping
 * dev-mode for Privy is a composition-root change, not an API change.
 *
 * verify() returns null for a missing/invalid credential (caller treats the
 * request as logged-out) and throws only on genuine server errors.
 */
import type { Wallet } from "../domain/ids";
import type { OAuthIdentity } from "../social/SocialStore";
export interface AuthedUser {
    userId: string;
    wallet: Wallet;
    /** The player's Privy wallet handle, when the provider custodies it — needed to
     *  sweep an inbound deposit out of the player's wallet into the Sessions float. */
    privyWalletId?: string;
}
export interface Auth {
    verify(token: string): Promise<AuthedUser | null>;
    /**
     * Fetch the provider's already-linked social identities (X/Google) for an
     * authenticated user, so the web client can populate `linked_identities`
     * without a separate OAuth round-trip — Privy already did that linking as
     * part of normal login (loginMethods includes google/twitter). Returns an
     * empty array when the provider has no such concept (e.g. dev auth) or the
     * user has no linked social accounts.
     */
    fetchLinkedIdentities(userId: string): Promise<OAuthIdentity[]>;
}
