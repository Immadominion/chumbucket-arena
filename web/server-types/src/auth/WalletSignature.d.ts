/**
 * Wallet-signature verification — the reusable identity primitive that
 * authenticates social writes. A Solana wallet (ed25519) signs a canonical,
 * network-bound, timestamped message with MWA; the backend verifies it against
 * the claimed wallet before acting. This proves the caller controls the wallet,
 * so no one can attribute a follow — or a prediction call — to a wallet they
 * don't own. No custody, no session server.
 *
 * Zero extra dependencies: Node's built-in ed25519 verify (a Solana pubkey IS a
 * raw ed25519 public key, wrapped in the standard SPKI DER header) + Anchor's
 * bundled bs58 (already a direct dependency).
 *
 * Replay note: proofs are bound to (action, target/params, network, timestamp)
 * and accepted only within SIGNATURE_MAX_AGE_MS. There is no server nonce store,
 * so a *leaked* proof is replayable within that window (re-asserting an action
 * the wallet itself signed). Accepted tradeoff: the proof only travels TLS from
 * the owner's device to the trusted backend, the affected state is a public
 * self-authored edge/optimistic row, and it self-heals on the next legit action
 * or on-chain reconciliation. Add a nonce/used-signature store if that changes.
 */
/** How far the signed timestamp may drift from now (replay / stale-proof window). */
export declare const SIGNATURE_MAX_AGE_MS: number;
export type SocialAction = "follow" | "unfollow" | "add_pending_target";
/**
 * The exact string a wallet must sign for a follow/unfollow/add_pending_target.
 * Deterministic and human-readable so the wallet's signing UI shows what's
 * being authorized.
 */
export declare function socialActionMessage(action: SocialAction, target: string, network: string, timestamp: number): string;
/** A parameterless signed action (e.g. "read_notifications"). */
export declare function genericActionMessage(action: string, network: string, timestamp: number): string;
export interface GenericActionProof {
    wallet: string;
    action: string;
    timestamp: number;
    signature: string;
}
/** Verify a parameterless action proof against the backend's `network`. */
export declare function verifyGenericAction(proof: GenericActionProof, now: number, network: string): {
    ok: boolean;
    reason?: string;
};
/** The exact string a wallet must sign to attribute a prediction call to itself. */
export declare function callProofMessage(params: {
    matchId: string;
    bucket: string;
    stake: string;
    txSignature: string;
    network: string;
    timestamp: number;
}): string;
/** Verify an ed25519 signature (base58 or base64) by `wallet` over `message`. */
export declare function verifyWalletSignature(wallet: string, message: string, signature: string): boolean;
export interface SocialActionProof {
    wallet: string;
    action: SocialAction;
    target: string;
    timestamp: number;
    signature: string;
}
/** Verify a follow/unfollow/add_pending_target proof against the backend's configured `network`. */
export declare function verifySocialAction(proof: SocialActionProof, now: number, network: string): {
    ok: boolean;
    reason?: string;
};
export interface CallProof {
    wallet: string;
    matchId: string;
    bucket: string;
    stake: string;
    txSignature: string;
    timestamp: number;
    signature: string;
}
/** Verify a prediction-call attribution proof against the backend's `network`. */
export declare function verifyCallProof(proof: CallProof, now: number, network: string): {
    ok: boolean;
    reason?: string;
};
