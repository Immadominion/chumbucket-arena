/**
 * Privy auth — the production identity layer. Verifies the user's Privy access
 * token (local JWT verification, no per-request network), then resolves them to
 * a server-authoritative **Solana** embedded wallet.
 *
 * We create the wallet explicitly with chain_type 'solana' and key it to the
 * user via a deterministic external_id + idempotency_key — so "get or create"
 * is one safe, repeatable call. That address is the player identity the rest
 * of the system already speaks in. (The frontend should treat this as the
 * user's wallet — i.e. fund *this* address — so there's exactly one wallet per
 * player.)
 */
import type { OAuthIdentity } from "../social/SocialStore";
import type { Auth, AuthedUser } from "./Auth";
export declare class PrivyAuth implements Auth {
    private readonly client;
    private readonly walletByUser;
    constructor(appId: string, appSecret: string, verificationKey?: string);
    verify(token: string): Promise<AuthedUser | null>;
    /**
     * The user's already-linked X/Google identities, straight from Privy — no
     * separate OAuth token exchange needed, since Privy's own login already did
     * that linking (loginMethods includes google/twitter). One extra
     * authenticated call to Privy's Users API using the same client instance
     * `verify()` already trusts.
     */
    fetchLinkedIdentities(userId: string): Promise<OAuthIdentity[]>;
    private resolveWallet;
}
