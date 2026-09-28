import { randomBytes } from "node:crypto";
import { AuthIdentityError, failAuth } from "./AuthIdentityError.ts";
import type { AuthIdentityPolicy } from "./AuthIdentityRuntime.ts";
import type { ExistingAccountStore } from "./ExistingAccountStore.ts";
import type { SupabaseJwtVerifier } from "./SupabaseJwt.ts";
import { hashNonce, isSolanaAddress, type RequestNonceResult } from "./WalletLinkService.ts";
import { buildSiwsMessage, CHAIN_IDS, SIWS_PROOF_VERSION, STATEMENTS, verifySiwsProof } from "./SiwsMessage.ts";

interface Deps {
  enabled: boolean;
  store?: ExistingAccountStore;
  verifier: SupabaseJwtVerifier;
  policy: AuthIdentityPolicy;
  now?: () => number;
}
interface Input { accessToken: string; address: string }

/** Bootstrap linking is NOT wallet attachment or an account merge. A verified
 * auth subject + fresh proof can claim only a reviewed historical anchor. */
export class ExistingAccountClaimService {
  constructor(private readonly deps: Deps) {}

  private async authenticate(token: string): Promise<string> {
    if (!this.deps.enabled) failAuth("ACCOUNT_CLAIMS_DISABLED");
    if (!this.deps.store) failAuth("IDENTITY_NOT_CONFIGURED");
    if (!token.trim()) failAuth("AUTH_TOKEN_MISSING");
    try {
      const session = await this.deps.verifier.verify(token);
      if (!session) failAuth("AUTH_TOKEN_INVALID");
      return session.authUserId;
    } catch (error) {
      if (error instanceof AuthIdentityError) throw error;
      failAuth("IDENTITY_STORE_ERROR");
    }
  }

  async request(input: Input & { domain: string; uri: string }): Promise<RequestNonceResult> {
    const authUserId = await this.authenticate(input.accessToken);
    const policy = this.deps.policy;
    if (!isSolanaAddress(input.address)) failAuth("SIWS_ADDRESS_MISMATCH");
    if (!policy.allowedDomains.includes(input.domain)) failAuth("SIWS_DOMAIN_NOT_ALLOWED");
    if (!policy.allowedUris.includes(input.uri)) failAuth("SIWS_URI_NOT_ALLOWED");
    const now = (this.deps.now ?? Date.now)();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + policy.nonceTtlSeconds * 1000).toISOString();
    const nonce = randomBytes(32).toString("hex");
    const message = buildSiwsMessage({
      domain: input.domain, uri: input.uri, address: input.address,
      statement: STATEMENTS.claim_account, chainId: CHAIN_IDS[policy.network],
      nonce, issuedAt, expirationTime: expiresAt, purpose: "claim_account",
    });
    await this.deps.store!.issue({
      authUserId, walletAddress: input.address, network: policy.network,
      nonceHash: hashNonce(nonce), messageHash: hashNonce(message), issuedAt, expiresAt,
    });
    return { message, issuedAt, expiresAt, domain: input.domain, uri: input.uri,
      network: policy.network, purpose: "claim_account", proofVersion: SIWS_PROOF_VERSION };
  }

  async claim(input: Input & { message: string; signature: string }) {
    const authUserId = await this.authenticate(input.accessToken);
    if (!isSolanaAddress(input.address)) failAuth("SIWS_ADDRESS_MISMATCH");
    const fields = verifySiwsProof(input.message, input.signature, {
      ...this.deps.policy, address: input.address, purpose: "claim_account",
      now: (this.deps.now ?? Date.now)(),
    });
    const result = await this.deps.store!.claim({
      authUserId, walletAddress: fields.address, network: this.deps.policy.network,
      nonceHash: hashNonce(fields.nonce), messageHash: hashNonce(input.message),
    });
    return { ...result, authUserId };
  }
}
