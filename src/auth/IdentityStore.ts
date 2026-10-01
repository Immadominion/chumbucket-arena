/**
 * IdentityStore — the Packet A read/write side of Supabase.
 *
 * Why this is NOT `SocialStore`: contract §6 gives Packet A `src/auth/**` and
 * gives nobody permission to edit `src/social/SocialStore.ts`. So the ~35 lines
 * of PostgREST plumbing (rpc / getRows / headers / decode) are COPIED here
 * verbatim in shape, not inherited. Two small duplicated transports that each
 * packet can evolve independently beat one shared file three agents fight over.
 *
 * Security posture, stated once:
 *   * This store holds the service-role key and therefore BYPASSES RLS by
 *     construction — exactly the property contract §2 flags about SocialStore.
 *     Authorisation is enforced ABOVE this layer (WalletLinkService) and,
 *     independently, by RLS for anything that reads Supabase directly from the
 *     device. The two are not interchangeable and neither is optional.
 *   * Every method below takes an ALREADY-AUTHENTICATED canonical user id. None
 *     of them accepts a wallet string as an authorisation input.
 *   * No method logs its arguments. A nonce hash, a service key and a JWT never
 *     reach console output, and `decode` deliberately does not echo a request
 *     body into an error.
 */

import type { SiwsNetwork, SiwsPurpose } from "./SiwsMessage.ts";
import { AuthIdentityError } from "./AuthIdentityError.ts";

export interface IdentityStoreConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  network: SiwsNetwork;
}

export interface StoreResult {
  ok: boolean;
  reason?: string;
  [k: string]: unknown;
}

export interface IssueNonceInput {
  nonceHash: string;
  userId: string;
  walletAddress: string;
  purpose: SiwsPurpose;
  domain: string;
  uri: string;
  network: SiwsNetwork;
  ttlSeconds: number;
}

export interface ConsumeNonceInput {
  nonceHash: string;
  userId: string;
  walletAddress: string;
  purpose: SiwsPurpose;
  domain: string;
  uri: string;
  network: SiwsNetwork;
}

export interface AttachWalletInput {
  userId: string;
  walletAddress: string;
  proofVersion: number;
  nonceId?: string;
  walletType?: string;
}

export interface ClaimLegacyInput {
  legacyProvider: "privy" | "legacy_user_id" | "wallet";
  legacySubject: string;
  userId: string;
  /** Only server-verified evidence kinds exist — see the SQL CHECK constraint. */
  evidence: "privy_session" | "supabase_jwt" | "siws_proof" | "operator_manual";
  evidenceRef?: string;
  authUserId?: string;
}

export type UsernameStatus = "available" | "invalid" | "reserved" | "taken";

export interface CreatePersonInput {
  authUserId: string;
  displayName: string;
  handle: string;
  /** Only ever the address Supabase Auth verified for this session. */
  walletAddress: string | null;
}

export interface IdentityStore {
  readonly enabled: boolean;
  /** auth.uid() -> exactly one public.users.id, or null when unlinked. */
  userIdForAuthUser(authUserId: string): Promise<string | null>;
  /** Verified auth subject only. Idempotent; never merges legacy accounts. */
  createPersonForAuthUser(authUserId: string, displayName: string): Promise<string>;
  /** 'available' | 'invalid' | 'reserved' | 'taken' (case-insensitive). */
  usernameStatus(handle: string): Promise<UsernameStatus>;
  /** A new account with a claimed @username; a wallet sign-in passes its verified wallet. */
  createPersonWithUsername(input: CreatePersonInput): Promise<StoreResult>;
  /** Carry the existing account whose wallet this is over to a wallet sign-in. */
  bindWalletSession(authUserId: string, walletAddress: string): Promise<StoreResult>;
  issueWalletNonce(input: IssueNonceInput): Promise<StoreResult>;
  consumeWalletNonce(input: ConsumeNonceInput): Promise<StoreResult>;
  attachVerifiedWallet(input: AttachWalletInput): Promise<StoreResult>;
  claimLegacyIdentity(input: ClaimLegacyInput): Promise<StoreResult>;
}

/** Used when no Supabase project is configured. Every call is a clean refusal,
 *  never a silent success — an unconfigured server must not appear to link. */
export class NoopIdentityStore implements IdentityStore {
  readonly enabled = false;
  async userIdForAuthUser(): Promise<string | null> {
    return null;
  }
  async createPersonForAuthUser(): Promise<string> {
    throw new AuthIdentityError("IDENTITY_NOT_CONFIGURED");
  }
  async usernameStatus(): Promise<UsernameStatus> {
    throw new AuthIdentityError("IDENTITY_NOT_CONFIGURED");
  }
  async createPersonWithUsername(): Promise<StoreResult> {
    return { ok: false, reason: "identity store is not configured" };
  }
  async bindWalletSession(): Promise<StoreResult> {
    return { ok: false, reason: "identity store is not configured" };
  }
  async issueWalletNonce(): Promise<StoreResult> {
    return { ok: false, reason: "identity store is not configured" };
  }
  async consumeWalletNonce(): Promise<StoreResult> {
    return { ok: false, reason: "identity store is not configured" };
  }
  async attachVerifiedWallet(): Promise<StoreResult> {
    return { ok: false, reason: "identity store is not configured" };
  }
  async claimLegacyIdentity(): Promise<StoreResult> {
    return { ok: false, reason: "identity store is not configured" };
  }
}

export class SupabaseIdentityStore implements IdentityStore {
  readonly enabled = true;
  private readonly restBase: string;

  constructor(
    private readonly cfg: IdentityStoreConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.restBase = `${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  }

  /**
   * The single mapping the whole packet rests on. `limit=2` on purpose: the
   * UNIQUE constraint makes two rows impossible, so if two ever come back the
   * schema has been violated and the honest answer is to refuse, not to pick
   * the first one and hand someone else's account to this session.
   */
  async userIdForAuthUser(authUserId: string): Promise<string | null> {
    const params = new URLSearchParams({
      auth_user_id: `eq.${authUserId}`,
      select: "id",
      limit: "2",
    });
    const rows = await this.getRows<{ id: string }>("users", params);
    if (rows.length > 1) throw new AuthIdentityError("AUTH_USER_AMBIGUOUS");
    return rows[0]?.id ?? null;
  }

  async createPersonForAuthUser(authUserId: string, displayName: string): Promise<string> {
    const id = await this.rpc<unknown>("create_social_person_v1", {
      p_auth_user_id: authUserId,
      p_display_name: displayName,
    });
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new AuthIdentityError("IDENTITY_STORE_ERROR", "profile RPC returned no canonical id");
    }
    return id;
  }

  async usernameStatus(handle: string): Promise<UsernameStatus> {
    const status = await this.rpc<unknown>("handle_status_v1", { p_handle: handle });
    if (status === "available" || status === "invalid" || status === "reserved" || status === "taken") {
      return status;
    }
    throw new AuthIdentityError("IDENTITY_STORE_ERROR", "username RPC returned no status");
  }

  async createPersonWithUsername(input: CreatePersonInput): Promise<StoreResult> {
    return this.asResult(
      await this.rpc<StoreResult>("create_social_person_v2", {
        p_auth_user_id: input.authUserId,
        p_display_name: input.displayName,
        p_handle: input.handle,
        p_wallet_address: input.walletAddress,
      }),
    );
  }

  async bindWalletSession(authUserId: string, walletAddress: string): Promise<StoreResult> {
    return this.asResult(
      await this.rpc<StoreResult>("bind_wallet_session_v1", {
        p_auth_user_id: authUserId,
        p_wallet_address: walletAddress,
      }),
    );
  }

  async issueWalletNonce(input: IssueNonceInput): Promise<StoreResult> {
    return this.asResult(
      await this.rpc<StoreResult>("issue_wallet_nonce_v1", {
        p_nonce_hash: input.nonceHash,
        p_user_id: input.userId,
        p_wallet_address: input.walletAddress,
        p_purpose: input.purpose,
        p_domain: input.domain,
        p_uri: input.uri,
        p_network: input.network,
        p_ttl_seconds: input.ttlSeconds,
      }),
    );
  }

  async consumeWalletNonce(input: ConsumeNonceInput): Promise<StoreResult> {
    return this.asResult(
      await this.rpc<StoreResult>("consume_wallet_nonce_v1", {
        p_nonce_hash: input.nonceHash,
        p_user_id: input.userId,
        p_wallet_address: input.walletAddress,
        p_purpose: input.purpose,
        p_domain: input.domain,
        p_uri: input.uri,
        p_network: input.network,
      }),
    );
  }

  async attachVerifiedWallet(input: AttachWalletInput): Promise<StoreResult> {
    return this.asResult(
      await this.rpc<StoreResult>("attach_verified_wallet_v1", {
        p_user_id: input.userId,
        p_wallet_address: input.walletAddress,
        p_proof_version: input.proofVersion,
        p_nonce_id: input.nonceId ?? null,
        p_wallet_type: input.walletType ?? "mwa",
      }),
    );
  }

  async claimLegacyIdentity(input: ClaimLegacyInput): Promise<StoreResult> {
    return this.asResult(
      await this.rpc<StoreResult>("claim_legacy_identity_v1", {
        p_legacy_provider: input.legacyProvider,
        p_legacy_subject: input.legacySubject,
        p_user_id: input.userId,
        p_evidence: input.evidence,
        p_evidence_ref: input.evidenceRef ?? null,
        p_auth_user_id: input.authUserId ?? null,
      }),
    );
  }

  // ── PostgREST transport (same shape as SocialStore's, owned by this packet) ──

  private async rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(`${this.restBase}/rpc/${name}`, {
      method: "POST",
      headers: this.headers({ prefer: "return=representation" }),
      body: JSON.stringify(body),
    }, `rpc/${name}`);
  }

  private async getRows<T>(table: string, params: URLSearchParams): Promise<T[]> {
    return (await this.request<T[]>(`${this.restBase}/${table}?${params.toString()}`, {
      method: "GET",
      headers: this.headers(),
    }, table)) ?? [];
  }

  private async request<T>(url: string, init: RequestInit, label: string): Promise<T> {
    try {
      // Service-role headers and proof bodies belong only to the configured
      // issuer. Never follow even a same-host redirect; never return raw fetch
      // or JSON parser errors (they may contain credentials/provider payloads).
      const res = await this.fetchImpl(url, {
        ...init, redirect: "manual", signal: AbortSignal.timeout(10_000),
      });
      return await this.decode<T>(res, label);
    } catch (error) {
      if (error instanceof AuthIdentityError) throw error;
      throw new AuthIdentityError("IDENTITY_STORE_ERROR");
    }
  }

  private headers(extra?: { prefer?: string }): Record<string, string> {
    return {
      apikey: this.cfg.serviceRoleKey,
      Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(extra?.prefer ? { Prefer: extra.prefer } : {}),
    };
  }

  private async decode<T>(res: Response, label: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      // `label` is a fixed route name, never a request body — no argument of a
      // wallet/nonce/claim call can reach a log line through this path.
      throw new AuthIdentityError("IDENTITY_STORE_ERROR", `${label} HTTP ${res.status}`);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** A SQL function that returns NULL/empty is a bug, not a success. Fail loudly
   *  rather than let `undefined.ok` read as falsy-and-ignored downstream. */
  private asResult(value: StoreResult | undefined | null): StoreResult {
    if (!value || typeof value.ok !== "boolean") {
      throw new AuthIdentityError("IDENTITY_STORE_ERROR", "rpc returned an unexpected shape");
    }
    return value;
  }
}
