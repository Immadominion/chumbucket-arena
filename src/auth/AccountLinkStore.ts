/**
 * AccountLinkStore — the service-role side of 20261004120000_account_sign_ins.sql.
 *
 * One account, many sign-ins. Supabase Auth links Google and X onto one auth
 * user, but never a Solana wallet, and never an identity another auth user
 * already holds. Those become ADDITIONAL sign-ins of an account, recorded by
 * the definer functions this store calls, and only after the BFF verified
 * every session involved with GoTrue. Nothing here takes a user id from a
 * client: every id passed in was resolved from a verified session above.
 *
 * Same transport rules as IdentityStore: service-role headers only to the
 * configured issuer, no redirects, no request body or provider answer in an
 * error, and a 404 from a function this deploy expects but the database does
 * not have yet is "not available" where that is safe, never a guess.
 */

import { AuthIdentityError } from "./AuthIdentityError.ts";
import type { IdentityStoreConfig, StoreResult } from "./IdentityStore.ts";

export type LinkMethod = "wallet" | "x" | "google";

export interface SignInIdentity {
  /** auth.identities.id — what supabase.auth.unlinkIdentity takes. */
  identityId: string;
  provider: string;
  /** X username, Google email, or wallet address. */
  label: string | null;
  lastSignInAt: string | null;
}

export interface AccountSignIn {
  authUserId: string;
  /** users.auth_user_id: the account's own first sign-in. */
  primary: boolean;
  /** account_sign_ins.id for an additional sign-in; null for the primary. */
  signInId: string | null;
  via: "primary" | "wallet" | "sign_in" | "fold";
  identities: SignInIdentity[];
}

export interface AccountWallet {
  address: string;
  walletType: string;
  isPrimary: boolean;
}

export interface AccountSignIns {
  signIns: AccountSignIn[];
  wallets: AccountWallet[];
}

export interface AccountCard {
  userId: string;
  handle: string | null;
  displayName: string | null;
}

export interface AccountLinkStore {
  /** A Web3 sign-in with no account lands on the account its wallet was linked to. */
  resolveWalletSignIn(authUserId: string, walletAddress: string): Promise<StoreResult>;
  /** Whether this wallet already signs in to an account other than `userId`. */
  walletSignInConflict(userId: string, walletAddress: string): Promise<boolean>;
  signIns(userId: string): Promise<AccountSignIns>;
  unlink(input: { userId: string; sessionAuthUserId: string; signInId?: string; wallet?: string }): Promise<StoreResult>;
  issueTicket(input: {
    userId: string;
    authUserId: string;
    method: LinkMethod;
    ticketHash: string;
    ttlSeconds: number;
  }): Promise<StoreResult>;
  preview(ticketHash: string, authUserId: string): Promise<StoreResult>;
  complete(input: { ticketHash: string; authUserId: string; allowLink: boolean; allowFold: boolean }): Promise<StoreResult>;
  /** Public profile fields (handle, name) of up to two accounts, for a confirm sheet. */
  cards(userIds: string[]): Promise<AccountCard[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function signInsFrom(value: unknown): AccountSignIns {
  const root = (value ?? {}) as { ok?: unknown; sign_ins?: unknown; wallets?: unknown };
  if (root.ok !== true || !Array.isArray(root.sign_ins) || !Array.isArray(root.wallets)) {
    throw new AuthIdentityError("IDENTITY_STORE_ERROR", "account_sign_ins_v1 returned an unexpected shape");
  }
  const signIns: AccountSignIn[] = [];
  for (const raw of root.sign_ins as Record<string, unknown>[]) {
    const authUserId = str(raw?.auth_user_id);
    if (!authUserId || !UUID.test(authUserId)) continue;
    const via = raw.via;
    signIns.push({
      authUserId,
      primary: raw.primary === true,
      signInId: str(raw.sign_in_id),
      via: via === "wallet" || via === "sign_in" || via === "fold" ? via : "primary",
      identities: (Array.isArray(raw.identities) ? (raw.identities as Record<string, unknown>[]) : [])
        .map((i) => ({
          identityId: str(i?.identity_id) ?? "",
          provider: str(i?.provider) ?? "",
          label: str(i?.label),
          lastSignInAt: str(i?.last_sign_in_at),
        }))
        .filter((i) => i.identityId && i.provider),
    });
  }
  const wallets: AccountWallet[] = (root.wallets as Record<string, unknown>[])
    .map((w) => ({
      address: str(w?.address) ?? "",
      walletType: str(w?.wallet_type) ?? "mwa",
      isPrimary: w?.is_primary === true,
    }))
    .filter((w) => w.address);
  return { signIns, wallets };
}

export class SupabaseAccountLinkStore implements AccountLinkStore {
  private readonly restBase: string;

  constructor(
    private readonly cfg: IdentityStoreConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.restBase = `${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  }

  async resolveWalletSignIn(authUserId: string, walletAddress: string): Promise<StoreResult> {
    const value = await this.rpc("resolve_wallet_sign_in_v1", {
      p_auth_user_id: authUserId,
      p_wallet_address: walletAddress,
    }, { missingIs: { ok: false, reason: "unavailable" } });
    return this.asResult(value);
  }

  async walletSignInConflict(userId: string, walletAddress: string): Promise<boolean> {
    // Before the migration there are no additional sign-ins, and the linked
    // wallet guard in attach_verified_wallet_v1 is the whole answer.
    const value = await this.rpc("wallet_sign_in_conflict_v1", {
      p_user_id: userId,
      p_wallet_address: walletAddress,
    }, { missingIs: false });
    return value === true;
  }

  async signIns(userId: string): Promise<AccountSignIns> {
    return signInsFrom(await this.rpc("account_sign_ins_v1", { p_user_id: userId }));
  }

  async unlink(input: { userId: string; sessionAuthUserId: string; signInId?: string; wallet?: string }): Promise<StoreResult> {
    return this.asResult(await this.rpc("unlink_sign_in_v1", {
      p_user_id: input.userId,
      p_session_auth_user_id: input.sessionAuthUserId,
      p_sign_in_id: input.signInId ?? null,
      p_wallet: input.wallet ?? null,
    }));
  }

  async issueTicket(input: {
    userId: string;
    authUserId: string;
    method: LinkMethod;
    ticketHash: string;
    ttlSeconds: number;
  }): Promise<StoreResult> {
    return this.asResult(await this.rpc("issue_account_link_ticket_v1", {
      p_user_id: input.userId,
      p_auth_user_id: input.authUserId,
      p_method: input.method,
      p_ticket_hash: input.ticketHash,
      p_ttl_seconds: input.ttlSeconds,
    }));
  }

  async preview(ticketHash: string, authUserId: string): Promise<StoreResult> {
    return this.asResult(await this.rpc("preview_account_link_v1", {
      p_ticket_hash: ticketHash,
      p_auth_user_id: authUserId,
    }));
  }

  async complete(input: { ticketHash: string; authUserId: string; allowLink: boolean; allowFold: boolean }): Promise<StoreResult> {
    return this.asResult(await this.rpc("complete_account_link_v1", {
      p_ticket_hash: input.ticketHash,
      p_auth_user_id: input.authUserId,
      p_allow_link: input.allowLink,
      p_allow_fold: input.allowFold,
    }));
  }

  async cards(userIds: string[]): Promise<AccountCard[]> {
    const ids = [...new Set(userIds.filter((id) => UUID.test(id)))].slice(0, 2);
    if (ids.length === 0) return [];
    const params = new URLSearchParams({ id: `in.(${ids.join(",")})`, select: "id,handle,full_name" });
    const rows = await this.request<{ id: string; handle: string | null; full_name: string | null }[]>(
      `${this.restBase}/users?${params.toString()}`,
      { method: "GET", headers: this.headers() },
      "users",
    );
    return (rows ?? []).map((r) => ({ userId: r.id, handle: str(r.handle), displayName: str(r.full_name) }));
  }

  // ── transport ──

  private async rpc(name: string, body: Record<string, unknown>, opts: { missingIs?: unknown } = {}): Promise<unknown> {
    return this.request<unknown>(`${this.restBase}/rpc/${name}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    }, `rpc/${name}`, opts);
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.cfg.serviceRoleKey,
      Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(url: string, init: RequestInit, label: string, opts: { missingIs?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new AuthIdentityError("IDENTITY_STORE_ERROR");
    }
    // Never read a failure body: it can echo the request back.
    if (res.status === 404 && "missingIs" in opts) return opts.missingIs as T;
    if (!res.ok) throw new AuthIdentityError("IDENTITY_STORE_ERROR", `${label} HTTP ${res.status}`);
    try {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new AuthIdentityError("IDENTITY_STORE_ERROR", `${label} unreadable`);
    }
  }

  private asResult(value: unknown): StoreResult {
    if (!value || typeof value !== "object" || typeof (value as StoreResult).ok !== "boolean") {
      throw new AuthIdentityError("IDENTITY_STORE_ERROR", "rpc returned an unexpected shape");
    }
    return value as StoreResult;
  }
}
