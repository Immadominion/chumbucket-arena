/**
 * Shared fixtures for the Packet A (identity / RLS / wallet-proof) tests.
 *
 * `FakeIdentityStore` is a faithful in-memory model of the four SQL functions
 * added by the `*_auth_identity_*` migrations — same inputs, same `reason`
 * strings, same atomicity. It exists because `SupabaseIdentityStore` (like
 * `SocialStore`) holds the service-role key and bypasses RLS by construction,
 * so the thing worth testing in-process is the AUTHORISATION LAYER above it.
 * The database's own policies are asserted separately, against a live database,
 * in authIdentityRls.test.ts — and visibly skipped when there isn't one.
 *
 * The model is deliberately strict: `consumeWalletNonce` performs its check and
 * its write in one synchronous block, exactly as the SQL does in one UPDATE, so
 * two concurrent redemptions of the same challenge cannot both win here either.
 */

import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import type {
  AttachWalletInput,
  ClaimLegacyInput,
  ConsumeNonceInput,
  IdentityStore,
  IssueNonceInput,
  StoreResult,
} from "../src/auth/IdentityStore.ts";
import type { SupabaseJwtVerifier, SupabaseSession } from "../src/auth/SupabaseJwt.ts";

const bs58 = utils.bytes.bs58;

// ── wallets ─────────────────────────────────────────────────────────────────

export interface TestWallet {
  privateKey: KeyObject;
  address: string;
}

export function makeWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, address: bs58.encode(new Uint8Array(der.subarray(der.length - 32))) };
}

export function signMessage(privateKey: KeyObject, message: string): string {
  return bs58.encode(new Uint8Array(nodeSign(null, Buffer.from(message), privateKey)));
}

// ── session verifier ────────────────────────────────────────────────────────

/** Maps an opaque test token to an auth.users id. Stands in for GoTrue. */
export class FakeJwtVerifier implements SupabaseJwtVerifier {
  private readonly tokens = new Map<string, string>();

  issue(token: string, authUserId: string): this {
    this.tokens.set(token, authUserId);
    return this;
  }

  async verify(accessToken: string): Promise<SupabaseSession | null> {
    const id = this.tokens.get(accessToken);
    return id ? { authUserId: id } : null;
  }
}

// ── identity store ──────────────────────────────────────────────────────────

interface NonceRow {
  id: string;
  nonceHash: string;
  userId: string;
  walletAddress: string;
  purpose: string;
  domain: string;
  uri: string;
  network: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

interface WalletRow {
  id: string;
  userId: string;
  address: string;
  revokedAt: number | null;
  proofVersion: number;
}

interface ClaimRow {
  id: string;
  provider: string;
  subject: string;
  userId: string;
  state: string;
  evidence: string;
}

export interface AuditEntry {
  action: "linked" | "reaffirmed" | "revoked" | "transferred";
  address: string;
  fromUserId?: string;
  toUserId?: string;
  reason?: string;
}

const EVIDENCE_WHITELIST = ["privy_session", "supabase_jwt", "siws_proof", "operator_manual"];

export class FakeIdentityStore implements IdentityStore {
  readonly enabled = true;

  /** auth.users.id -> public.users.id */
  private readonly users = new Map<string, string>();
  private readonly nonces = new Map<string, NonceRow>();
  private readonly wallets = new Map<string, WalletRow>();
  private readonly claims = new Map<string, ClaimRow>();
  /** Mirrors public.wallet_link_audit. */
  readonly audit: AuditEntry[] = [];

  private seq = 0;
  private clock: () => number;

  constructor(now: () => number = Date.now) {
    this.clock = now;
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /** Create a canonical user with a linked Supabase session. */
  addUser(authUserId: string, userId: string): this {
    this.users.set(authUserId, userId);
    return this;
  }

  /** Direct read used by assertions — not part of the IdentityStore contract. */
  walletOwner(address: string): string | undefined {
    const row = this.wallets.get(address);
    return row && row.revokedAt === null ? row.userId : undefined;
  }

  claimFor(provider: string, subject: string): ClaimRow | undefined {
    return this.claims.get(`${provider}|${subject}`);
  }

  claimCount(): number {
    return this.claims.size;
  }

  /** Model of transfer_verified_wallet_v1 — the ONLY way an address moves. */
  transferWallet(address: string, fromUserId: string, toUserId: string, reason: string): StoreResult {
    if (!reason.trim()) return { ok: false, reason: "reason_required" };
    if (fromUserId === toUserId) return { ok: false, reason: "same_user" };
    const row = this.wallets.get(address);
    if (!row || row.userId !== fromUserId) return { ok: false, reason: "not_owned_by_from_user" };
    row.userId = toUserId;
    row.revokedAt = null;
    this.audit.push({ action: "transferred", address, fromUserId, toUserId, reason });
    return { ok: true, outcome: "transferred" };
  }

  async userIdForAuthUser(authUserId: string): Promise<string | null> {
    return this.users.get(authUserId) ?? null;
  }

  async issueWalletNonce(input: IssueNonceInput): Promise<StoreResult> {
    if (![...this.users.values()].includes(input.userId)) {
      return { ok: false, reason: "unknown_user" };
    }
    const now = this.clock();
    // Supersede any live challenge for the same (user, address, purpose).
    for (const row of this.nonces.values()) {
      if (
        row.consumedAt === null &&
        row.userId === input.userId &&
        row.walletAddress === input.walletAddress &&
        row.purpose === input.purpose
      ) {
        row.consumedAt = now;
      }
    }
    const row: NonceRow = {
      id: this.id("nonce"),
      nonceHash: input.nonceHash,
      userId: input.userId,
      walletAddress: input.walletAddress,
      purpose: input.purpose,
      domain: input.domain,
      uri: input.uri,
      network: input.network,
      issuedAt: now,
      expiresAt: now + input.ttlSeconds * 1000,
      consumedAt: null,
    };
    this.nonces.set(row.nonceHash, row);
    return { ok: true, nonce_id: row.id, expires_at: new Date(row.expiresAt).toISOString() };
  }

  /** One synchronous claim-or-fail, mirroring the single SQL UPDATE. */
  async consumeWalletNonce(input: ConsumeNonceInput): Promise<StoreResult> {
    const now = this.clock();
    const row = this.nonces.get(input.nonceHash);
    if (!row) return { ok: false, reason: "nonce_unknown" };

    const matches =
      row.consumedAt === null &&
      row.expiresAt > now &&
      row.userId === input.userId &&
      row.walletAddress === input.walletAddress &&
      row.purpose === input.purpose &&
      row.domain === input.domain &&
      row.uri === input.uri &&
      row.network === input.network;

    if (matches) {
      row.consumedAt = now;
      return {
        ok: true,
        nonce_id: row.id,
        user_id: row.userId,
        wallet_address: row.walletAddress,
        purpose: row.purpose,
      };
    }

    if (row.consumedAt !== null) return { ok: false, reason: "nonce_reused" };
    if (row.expiresAt <= now) return { ok: false, reason: "nonce_expired" };
    if (row.userId !== input.userId) return { ok: false, reason: "nonce_user_mismatch" };
    if (row.walletAddress !== input.walletAddress) return { ok: false, reason: "nonce_address_mismatch" };
    if (row.purpose !== input.purpose) return { ok: false, reason: "nonce_purpose_mismatch" };
    if (row.domain !== input.domain) return { ok: false, reason: "nonce_domain_mismatch" };
    if (row.uri !== input.uri) return { ok: false, reason: "nonce_uri_mismatch" };
    if (row.network !== input.network) return { ok: false, reason: "nonce_network_mismatch" };
    return { ok: false, reason: "nonce_reused" };
  }

  async attachVerifiedWallet(input: AttachWalletInput): Promise<StoreResult> {
    const existing = this.wallets.get(input.walletAddress);
    if (existing) {
      if (existing.userId !== input.userId) {
        return {
          ok: false,
          reason: existing.revokedAt === null ? "wallet_owned_by_another_user" : "wallet_requires_transfer",
        };
      }
      existing.revokedAt = null;
      existing.proofVersion = input.proofVersion;
      this.audit.push({
        action: "reaffirmed",
        address: input.walletAddress,
        fromUserId: input.userId,
        toUserId: input.userId,
      });
      return { ok: true, link_id: existing.id, outcome: "reaffirmed" };
    }
    const row: WalletRow = {
      id: this.id("link"),
      userId: input.userId,
      address: input.walletAddress,
      revokedAt: null,
      proofVersion: input.proofVersion,
    };
    this.wallets.set(row.address, row);
    this.audit.push({ action: "linked", address: row.address, toUserId: input.userId });
    return { ok: true, link_id: row.id, outcome: "linked" };
  }

  async claimLegacyIdentity(input: ClaimLegacyInput): Promise<StoreResult> {
    if (!EVIDENCE_WHITELIST.includes(input.evidence)) {
      return { ok: false, reason: "unverified_evidence" };
    }
    const key = `${input.legacyProvider}|${input.legacySubject}`;
    const existing = this.claims.get(key);
    if (existing) {
      if (existing.userId !== input.userId) return { ok: false, reason: "claimed_by_another_user" };
      // Idempotent replay: nothing is written.
      return { ok: true, claim_id: existing.id, state: existing.state, outcome: "already_claimed" };
    }
    const row: ClaimRow = {
      id: this.id("claim"),
      provider: input.legacyProvider,
      subject: input.legacySubject,
      userId: input.userId,
      state: "PENDING",
      evidence: input.evidence,
    };
    this.claims.set(key, row);
    return { ok: true, claim_id: row.id, state: row.state, outcome: "claimed" };
  }
}

// ── policy ──────────────────────────────────────────────────────────────────

export const TEST_DOMAIN = "chumbucket.app";
export const TEST_URI = "https://chumbucket.app";

export const testPolicy = {
  allowedDomains: [TEST_DOMAIN] as const,
  allowedUris: [TEST_URI] as const,
  network: "devnet" as const,
  nonceTtlSeconds: 300,
  proofVersion: 1,
};
