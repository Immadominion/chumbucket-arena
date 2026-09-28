import { z } from "zod";
import { AuthIdentityError, codeForStoreReason } from "./AuthIdentityError.ts";
import type { IdentityStoreConfig } from "./IdentityStore.ts";
import type { SiwsNetwork } from "./SiwsMessage.ts";

export interface AccountProofBinding {
  authUserId: string;
  walletAddress: string;
  network: SiwsNetwork;
  nonceHash: string;
  messageHash: string;
}
export interface AccountProofIssue extends AccountProofBinding {
  issuedAt: string;
  expiresAt: string;
}
export interface AccountClaimResult {
  userId: string;
  outcome: "claimed" | "already_claimed";
}
export interface ExistingAccountStore {
  issue(input: AccountProofIssue): Promise<void>;
  /** Atomic: check approved anchor, bind existing user, consume proof, audit. */
  claim(input: AccountProofBinding): Promise<AccountClaimResult>;
}

const refusal = z.object({ ok: z.literal(false), reason: z.string() });
const issued = z.object({ ok: z.literal(true) });
const claimed = z.object({
  ok: z.literal(true), user_id: z.string().uuid(),
  outcome: z.enum(["claimed", "already_claimed"]),
});

/** Service-only RPCs. No lookup against editable wallet/profile columns. */
export class SupabaseExistingAccountStore implements ExistingAccountStore {
  constructor(private readonly cfg: IdentityStoreConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private body(input: AccountProofBinding): Record<string, unknown> {
    return {
      p_auth_user_id: input.authUserId, p_wallet_address: input.walletAddress,
      p_network: input.network, p_nonce_hash: input.nonceHash,
      p_message_hash: input.messageHash,
    };
  }
  async issue(input: AccountProofIssue): Promise<void> {
    const value = await this.rpc("issue_existing_account_proof_v1", {
      ...this.body(input), p_issued_at: input.issuedAt, p_expires_at: input.expiresAt,
    });
    if (!issued.safeParse(value).success) throw new AuthIdentityError("IDENTITY_STORE_ERROR");
  }
  async claim(input: AccountProofBinding): Promise<AccountClaimResult> {
    const value = await this.rpc("claim_existing_account_v1", this.body(input));
    const parsed = claimed.safeParse(value);
    if (!parsed.success) throw new AuthIdentityError("IDENTITY_STORE_ERROR");
    return { userId: parsed.data.user_id, outcome: parsed.data.outcome };
  }
  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      const res = await this.fetchImpl(`${this.cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: this.cfg.serviceRoleKey, Authorization: `Bearer ${this.cfg.serviceRoleKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new AuthIdentityError("IDENTITY_STORE_ERROR");
      const value: unknown = await res.json();
      const denied = refusal.safeParse(value);
      if (denied.success) {
        const reason = denied.data.reason;
        const code = reason === "claim_unavailable" ? "ACCOUNT_CLAIM_UNAVAILABLE"
          : reason === "claim_conflict" ? "ACCOUNT_CLAIM_CONFLICT"
          : reason === "rate_limited" ? "ACCOUNT_CLAIM_RATE_LIMITED"
          : codeForStoreReason(reason, "IDENTITY_STORE_ERROR");
        throw new AuthIdentityError(code);
      }
      return value;
    } catch (error) {
      if (error instanceof AuthIdentityError) throw error;
      // Neither provider bodies nor fetch/parser errors can reach tRPC/logs.
      throw new AuthIdentityError("IDENTITY_STORE_ERROR");
    }
  }
}
