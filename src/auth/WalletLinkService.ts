/**
 * WalletLinkService — the authorisation layer for Packet A.
 *
 * Invariant 3 of the pivot, enforced here: identity is `public.users.id`, a
 * wallet is a linked credential, and NOTHING authorises on a wallet string.
 * Concretely, in every method below:
 *
 *   1. the canonical user id comes from a verified Supabase session, never from
 *      an input field;
 *   2. the wallet address the caller supplies is a *claim*, and it only becomes
 *      a fact after a signature over a server-issued, server-bound, single-use
 *      challenge verifies against it;
 *   3. the nonce is consumed atomically, in the same statement that re-checks
 *      every binding, so a replay is impossible rather than unlikely.
 *
 * Ordering is a security property, not a style choice: every static rejection
 * (malformed message, wrong domain/uri/network/address/statement, bad
 * signature) happens BEFORE the nonce is touched, so a mis-bound attempt never
 * burns the user's live challenge; and the nonce is consumed BEFORE the wallet
 * is attached, so a link can never happen twice off one proof.
 *
 * Nothing here logs. The nonce plaintext exists in exactly two places — the
 * response to the authenticated user who asked for it, and the message they
 * sign — and is never written to the database, a log, or an error.
 */

import { createHash, randomBytes } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { AuthIdentityError, codeForStoreReason, failAuth } from "./AuthIdentityError.ts";
import type { AuthIdentityPolicy } from "./AuthIdentityRuntime.ts";
import type { ClaimLegacyInput, IdentityStore } from "./IdentityStore.ts";
import type { SupabaseJwtVerifier } from "./SupabaseJwt.ts";
import {
  buildSiwsMessage,
  CHAIN_IDS,
  SIWS_PROOF_VERSION,
  STATEMENTS,
  verifySiwsProof,
  type SiwsPurpose,
} from "./SiwsMessage.ts";

const bs58 = utils.bytes.bs58;

/** A Solana address is a 32-byte ed25519 public key in base58. Reject anything
 *  else before it can reach the database as a "wallet". */
export function isSolanaAddress(value: string): boolean {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** sha256 hex. The ONLY representation of a nonce that is ever persisted. */
export function hashNonce(noncePlaintext: string): string {
  return createHash("sha256").update(noncePlaintext, "utf8").digest("hex");
}

export interface AuthedIdentity {
  authUserId: string;
  /** The canonical public.users.id. The only thing that authorises anything. */
  userId: string;
}

export interface RequestNonceInput {
  accessToken: string;
  address: string;
  purpose?: SiwsPurpose;
  domain: string;
  uri: string;
}

export interface RequestNonceResult {
  /** The exact string the wallet must sign. Contains the nonce plaintext. */
  message: string;
  expiresAt: string;
  issuedAt: string;
  domain: string;
  uri: string;
  network: string;
  purpose: SiwsPurpose;
  proofVersion: number;
}

export interface LinkWalletInput {
  accessToken: string;
  address: string;
  message: string;
  signature: string;
  purpose?: SiwsPurpose;
}

export interface LinkWalletResult {
  userId: string;
  address: string;
  outcome: string;
  proofVersion: number;
}

export interface ClaimLegacyIdentityInput {
  accessToken: string;
  legacyProvider: ClaimLegacyInput["legacyProvider"];
  legacySubject: string;
  /** Server-verified evidence only. There is no client-asserted kind. */
  evidence: ClaimLegacyInput["evidence"];
  evidenceRef?: string;
}

export interface WalletLinkDeps {
  store: IdentityStore;
  verifier: SupabaseJwtVerifier;
  policy: AuthIdentityPolicy;
  now?: () => number;
  /** Override only in tests. Production uses 32 bytes of CSPRNG. */
  makeNonce?: () => string;
}

export class WalletLinkService {
  private readonly now: () => number;
  private readonly makeNonce: () => string;

  constructor(private readonly deps: WalletLinkDeps) {
    this.now = deps.now ?? Date.now;
    this.makeNonce = deps.makeNonce ?? (() => randomBytes(32).toString("hex"));
  }

  /**
   * Supabase JWT -> exactly one canonical user.
   *
   * Three distinct failures, because they mean three different things to a
   * client: no credential, a bad credential, and a good credential attached to
   * an account that has never been linked to a canonical row.
   */
  async authenticate(accessToken: string): Promise<AuthedIdentity> {
    if (!this.deps.store.enabled) failAuth("IDENTITY_NOT_CONFIGURED");
    const token = (accessToken ?? "").trim();
    if (!token) failAuth("AUTH_TOKEN_MISSING");

    const session = await this.deps.verifier.verify(token);
    if (!session) failAuth("AUTH_TOKEN_INVALID");

    const userId = await this.deps.store.userIdForAuthUser(session.authUserId);
    if (!userId) failAuth("AUTH_USER_UNLINKED");

    return { authUserId: session.authUserId, userId };
  }

  /**
   * Issue a single-use challenge bound to (user, address, purpose, domain, uri,
   * network) and return the exact message to sign.
   *
   * The domain and uri the caller asks for are checked against the server
   * allowlist FIRST. A domain the server does not serve can never be bound into
   * a nonce, so a phishing site cannot obtain a challenge that its own origin
   * would satisfy.
   */
  async requestWalletNonce(input: RequestNonceInput): Promise<RequestNonceResult> {
    const identity = await this.authenticate(input.accessToken);
    const policy = this.deps.policy;
    const purpose: SiwsPurpose = input.purpose ?? "link_wallet";

    if (!isSolanaAddress(input.address)) failAuth("SIWS_ADDRESS_MISMATCH", "not a Solana address");
    if (!policy.allowedDomains.includes(input.domain)) failAuth("SIWS_DOMAIN_NOT_ALLOWED");
    if (!policy.allowedUris.includes(input.uri)) failAuth("SIWS_URI_NOT_ALLOWED");

    const noncePlaintext = this.makeNonce();
    const nonceHash = hashNonce(noncePlaintext);
    const issued = new Date(this.now());
    const expires = new Date(this.now() + policy.nonceTtlSeconds * 1000);

    const stored = await this.deps.store.issueWalletNonce({
      nonceHash,
      userId: identity.userId,
      walletAddress: input.address,
      purpose,
      domain: input.domain,
      uri: input.uri,
      network: policy.network,
      ttlSeconds: policy.nonceTtlSeconds,
    });
    if (!stored.ok) failAuth(codeForStoreReason(stored.reason, "NONCE_ISSUE_FAILED"));

    const message = buildSiwsMessage({
      domain: input.domain,
      address: input.address,
      statement: STATEMENTS[purpose],
      uri: input.uri,
      chainId: CHAIN_IDS[policy.network],
      nonce: noncePlaintext,
      issuedAt: issued.toISOString(),
      expirationTime: expires.toISOString(),
      purpose,
    });

    return {
      message,
      issuedAt: issued.toISOString(),
      expiresAt: expires.toISOString(),
      domain: input.domain,
      uri: input.uri,
      network: policy.network,
      purpose,
      proofVersion: SIWS_PROOF_VERSION,
    };
  }

  /**
   * Verify a signed SIWS message, consume its nonce atomically, and link the
   * address to the canonical user.
   *
   * Rejects with a distinct code for: a reused nonce, an expired nonce, a wrong
   * domain, a wrong uri, a wrong network, a wrong address, a wrong statement, a
   * nonce issued to a different user, and a bad signature.
   */
  async linkWallet(input: LinkWalletInput): Promise<LinkWalletResult> {
    const identity = await this.authenticate(input.accessToken);
    const policy = this.deps.policy;
    const purpose: SiwsPurpose = input.purpose ?? "link_wallet";

    if (!isSolanaAddress(input.address)) failAuth("SIWS_ADDRESS_MISMATCH", "not a Solana address");

    // Static bindings + signature. Throws before any write.
    const fields = verifySiwsProof(input.message, input.signature, {
      allowedDomains: policy.allowedDomains,
      allowedUris: policy.allowedUris,
      network: policy.network,
      purpose,
      address: input.address,
      now: this.now(),
    });

    // Atomic single-use redemption. Every binding is re-asserted server-side
    // against the row that was issued, including which user it was issued to —
    // this is what makes a stolen or borrowed challenge useless.
    const consumed = await this.deps.store.consumeWalletNonce({
      nonceHash: hashNonce(fields.nonce),
      userId: identity.userId,
      walletAddress: fields.address,
      purpose: fields.purpose,
      domain: fields.domain,
      uri: fields.uri,
      network: policy.network,
    });
    if (!consumed.ok) failAuth(codeForStoreReason(consumed.reason, "NONCE_UNKNOWN"));

    const nonceId = typeof consumed.nonce_id === "string" ? consumed.nonce_id : undefined;

    const attached = await this.deps.store.attachVerifiedWallet({
      userId: identity.userId,
      walletAddress: fields.address,
      proofVersion: policy.proofVersion,
      ...(nonceId ? { nonceId } : {}),
    });
    if (!attached.ok) failAuth(codeForStoreReason(attached.reason, "WALLET_LINK_FAILED"));

    return {
      userId: identity.userId,
      address: fields.address,
      outcome: typeof attached.outcome === "string" ? attached.outcome : "linked",
      proofVersion: policy.proofVersion,
    };
  }

  /**
   * Record a legacy identity -> canonical user mapping.
   *
   * Idempotent by construction (the SQL side does ON CONFLICT DO NOTHING and
   * reports `already_claimed`), and impossible to drive from client assertion
   * alone: the caller must hand over an evidence kind from the server-verified
   * whitelist, and `authRoutes` only ever supplies one it has itself verified.
   */
  async claimLegacyIdentity(input: ClaimLegacyIdentityInput): Promise<{
    userId: string;
    claimId?: string;
    state?: string;
    outcome: string;
  }> {
    const identity = await this.authenticate(input.accessToken);

    const subject = (input.legacySubject ?? "").trim();
    if (!subject) failAuth("LEGACY_CLAIM_FAILED", "empty legacy subject");

    const result = await this.deps.store.claimLegacyIdentity({
      legacyProvider: input.legacyProvider,
      legacySubject: subject,
      userId: identity.userId,
      evidence: input.evidence,
      ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
      authUserId: identity.authUserId,
    });
    if (!result.ok) failAuth(codeForStoreReason(result.reason, "LEGACY_CLAIM_FAILED"));

    return {
      userId: identity.userId,
      ...(typeof result.claim_id === "string" ? { claimId: result.claim_id } : {}),
      ...(typeof result.state === "string" ? { state: result.state } : {}),
      outcome: typeof result.outcome === "string" ? result.outcome : "claimed",
    };
  }
}

export { AuthIdentityError };
