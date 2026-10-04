/**
 * Who is adding funds, and which wallets are provably theirs.
 *
 * The person comes from the GoTrue-verified Supabase session through Packet A's
 * runtime — the same `person()` path Panta trading uses. `ctx.wallet`,
 * `x-wallet` and DevAuth are never credentials here.
 *
 * A deposit wallet is one of:
 *   - the session's Sign-in-with-Solana address (Supabase Auth verified the
 *     signature that created this very session), or
 *   - an active, proven `linked_wallets` row for this person
 *     (`revoked_at IS NULL AND verified_at IS NOT NULL`).
 * A client may NAME one of these; it can never ADD one.
 */

import { createHash } from "node:crypto";
import { authIdentityRuntimeFor } from "../auth/AuthIdentityRuntime.ts";
import { resolveAccountOutcome } from "../auth/accountResolver.ts";
import type { AppConfig } from "../config.ts";

export interface DepositWallet {
  address: string;
  /** mwa | embedded | imported | web3 (session-only) */
  walletType: string;
  primary: boolean;
  /** The address this very session signed in with. */
  session: boolean;
}

export interface DepositPerson {
  userId: string;
  authUserId: string;
  wallets: DepositWallet[];
  /** A confirmed email from Supabase Auth, or null. */
  email: string | null;
}

export interface LinkedWalletReader {
  /** Active and proven rows only. */
  activeVerified(userId: string): Promise<Array<{ address: string; walletType: string; primary: boolean }>>;
}

export interface AccountEmailReader {
  confirmedEmail(authUserId: string): Promise<string | null>;
}

export type PersonResolution =
  | { ok: true; person: DepositPerson }
  | { ok: false; reason: "SIGNED_OUT" | "NOT_LINKED" | "UNAVAILABLE" };

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

interface SupabaseAdmin {
  supabaseUrl: string;
  serviceRoleKey: string;
}

/** PostgREST read with the service role. Fixed labels only in failures. */
export class SupabaseLinkedWalletReader implements LinkedWalletReader {
  constructor(
    private readonly cfg: SupabaseAdmin,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async activeVerified(userId: string) {
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      revoked_at: "is.null",
      verified_at: "not.is.null",
      select: "wallet_address,wallet_type,is_primary",
      order: "is_primary.desc,verified_at.desc",
      limit: "20",
    });
    const res = await this.fetchImpl(`${this.cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/linked_wallets?${params}`, {
      headers: { apikey: this.cfg.serviceRoleKey, Authorization: `Bearer ${this.cfg.serviceRoleKey}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("linked_wallets read failed");
    const rows = (await res.json()) as Array<{ wallet_address?: unknown; wallet_type?: unknown; is_primary?: unknown }>;
    if (!Array.isArray(rows)) throw new Error("linked_wallets read failed");
    return rows
      .filter((r) => typeof r.wallet_address === "string" && SOLANA_ADDRESS.test(r.wallet_address))
      .map((r) => ({
        address: r.wallet_address as string,
        walletType: typeof r.wallet_type === "string" ? r.wallet_type : "mwa",
        primary: r.is_primary === true,
      }));
  }
}

/**
 * The issuer's own record of a confirmed email (GoTrue admin API, service
 * role). Contact data for Crossmint's required receipt — not an identity
 * input, and failure is non-fatal: the app then asks the person for one.
 */
export class GoTrueAccountEmailReader implements AccountEmailReader {
  constructor(
    private readonly cfg: SupabaseAdmin,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async confirmedEmail(authUserId: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(authUserId)) return null;
    try {
      const res = await this.fetchImpl(
        `${this.cfg.supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users/${authUserId}`,
        {
          headers: { apikey: this.cfg.serviceRoleKey, Authorization: `Bearer ${this.cfg.serviceRoleKey}` },
          redirect: "manual",
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) return null;
      const user = (await res.json()) as { email?: unknown; email_confirmed_at?: unknown; confirmed_at?: unknown } | null;
      const confirmed = Boolean(user?.email_confirmed_at ?? user?.confirmed_at);
      const email = typeof user?.email === "string" ? user.email.trim() : "";
      return confirmed && EMAIL.test(email) ? email : null;
    } catch {
      return null;
    }
  }
}

export interface DepositAccounts {
  /** `email` is looked up only when asked: order polling never needs it. */
  resolve(accessToken: string | undefined, opts?: { email?: boolean }): Promise<PersonResolution>;
}

export class SessionDepositAccounts implements DepositAccounts {
  constructor(
    private readonly config: AppConfig,
    private readonly wallets: LinkedWalletReader,
    private readonly emails: AccountEmailReader,
  ) {}

  async resolve(accessToken: string | undefined, opts: { email?: boolean } = {}): Promise<PersonResolution> {
    const identity = authIdentityRuntimeFor(this.config);
    if (!accessToken) return { ok: false, reason: "SIGNED_OUT" };
    if (!identity.store.enabled) return { ok: false, reason: "UNAVAILABLE" };
    // The one account resolver (src/auth/accountResolver.ts).
    const resolved = await resolveAccountOutcome(this.config, accessToken);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const { userId, session } = resolved.account;

    let rows: Awaited<ReturnType<LinkedWalletReader["activeVerified"]>>;
    try {
      rows = await this.wallets.activeVerified(userId);
    } catch {
      return { ok: false, reason: "UNAVAILABLE" };
    }
    const wallets: DepositWallet[] = [];
    const sessionWallet = session.solanaWallet && SOLANA_ADDRESS.test(session.solanaWallet) ? session.solanaWallet : undefined;
    if (sessionWallet) {
      const row = rows.find((r) => r.address === sessionWallet);
      wallets.push({ address: sessionWallet, walletType: row?.walletType ?? "web3", primary: row?.primary ?? false, session: true });
    }
    for (const row of rows) {
      if (row.address === sessionWallet) continue;
      wallets.push({ ...row, session: false });
    }
    const email = opts.email ? await this.emails.confirmedEmail(session.authUserId) : null;
    return { ok: true, person: { userId, authUserId: session.authUserId, wallets, email } };
  }
}

/**
 * A 3-second order poll should not re-verify the session, re-read wallets and
 * re-ask GoTrue every time. Successful resolutions are reused for a short TTL,
 * keyed by a hash of the token (the token itself is never a map key).
 */
export class CachedDepositAccounts implements DepositAccounts {
  private readonly hits = new Map<string, { at: number; person: DepositPerson; withEmail: boolean }>();

  constructor(
    private readonly inner: DepositAccounts,
    private readonly ttlMs = 15_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 2_000,
  ) {}

  async resolve(accessToken: string | undefined, opts: { email?: boolean } = {}): Promise<PersonResolution> {
    if (!accessToken) return this.inner.resolve(accessToken, opts);
    const key = createHash("sha256").update(accessToken).digest("hex");
    const hit = this.hits.get(key);
    if (hit && this.now() - hit.at < this.ttlMs && (hit.withEmail || !opts.email)) {
      return { ok: true, person: hit.person };
    }
    const result = await this.inner.resolve(accessToken, opts);
    if (result.ok) {
      if (this.hits.size >= this.maxEntries) {
        const oldest = this.hits.keys().next().value;
        if (oldest !== undefined) this.hits.delete(oldest);
      }
      this.hits.delete(key);
      this.hits.set(key, { at: this.now(), person: result.person, withEmail: Boolean(opts.email) });
    }
    return result;
  }
}
