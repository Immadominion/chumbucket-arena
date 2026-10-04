/**
 * Lazy, per-app construction of the Packet A runtime.
 *
 * Contract §6 pattern: a new module must not require an edit to `createApp`.
 * So nothing here is wired into the composition root — the router asks for a
 * runtime, keyed on the `AppConfig` object it already has in `ctx.app.config`,
 * and the first ask builds it.
 *
 * The memo is a WeakMap keyed on the config OBJECT, not on a string derived
 * from its values. That matters for two reasons:
 *   * two apps in one process (every test file builds several) never share a
 *     store, so a fixture in one test cannot leak into another;
 *   * a rotated service-role key can never be "remembered" from a stale cache
 *     entry, because a new config object is a new key.
 * WeakMap also means a discarded app's store is collectable — no leak across a
 * long test run.
 */

import type { AppConfig } from "../config.ts";
import { SupabaseAccountLinkStore, type AccountLinkStore } from "./AccountLinkStore.ts";
import { SupabaseExistingAccountStore, type ExistingAccountStore } from "./ExistingAccountStore.ts";
import {
  NoopIdentityStore,
  SupabaseIdentityStore,
  type IdentityStore,
  type IdentityStoreConfig,
} from "./IdentityStore.ts";
import { GoTrueJwtVerifier, UnconfiguredJwtVerifier, type SupabaseJwtVerifier } from "./SupabaseJwt.ts";
import { SIWS_PROOF_VERSION, type SiwsNetwork } from "./SiwsMessage.ts";

export interface AuthIdentityPolicy {
  /** Domains a SIWS proof may name. An allowlist, never a client-supplied hint. */
  allowedDomains: readonly string[];
  allowedUris: readonly string[];
  network: SiwsNetwork;
  nonceTtlSeconds: number;
  proofVersion: number;
}

/**
 * LOCAL FIXTURE — deliberately not read from the environment.
 *
 * The SIWS domain/uri allowlist belongs in `AppConfig`, and `src/config.ts` is
 * integration-owned (contract §6). The exact patch that adds an `authIdentity`
 * block is filed at docs/contracts/integration-requests/packet-a.md in the
 * mobile worktree. Until that lands, this constant is the allowlist, and
 * `resolveAuthIdentityPolicy` already reads the future config shape if it is
 * present — so the integration owner's patch takes effect with no change here.
 *
 * It is a fixture, not a placeholder: shipping with it is safe. It denies every
 * domain except the product's own: chumbucket.fun, the owner's live site and
 * the domain Supabase's Sign in with Solana already uses. (It used to name
 * chumbucket.app, which was never registered: anyone who registered it could
 * have asked people to sign messages this server would accept.) The mobile
 * app pins the same value (existing_account_proof.dart) and refuses to sign
 * when the server's allowlist does not include it.
 */
export const FIXTURE_AUTH_IDENTITY_POLICY = {
  allowedDomains: ["chumbucket.fun"] as const,
  allowedUris: ["https://chumbucket.fun"] as const,
  nonceTtlSeconds: 300,
};

/** The forward-compatible shape this module will read once config.ts gains it. */
interface AuthIdentityConfigBlock {
  siwsDomains?: string[];
  siwsUris?: string[];
  nonceTtlSeconds?: number;
  /** See `resolveWalletProfileCarry`. */
  walletProfileCarryEnabled?: boolean;
}

export interface AuthIdentityRuntime {
  existingAccounts?: ExistingAccountStore;
  store: IdentityStore;
  verifier: SupabaseJwtVerifier;
  policy: AuthIdentityPolicy;
  /** Whether a wallet sign-in carries over the existing account at that wallet. Absent = off. */
  walletProfileCarry?: boolean;
  /** Additional sign-ins (20261004120000). Absent without a Supabase project. */
  accountLinks?: AccountLinkStore;
  /** ACCOUNT_LINKING_ENABLED: link/unlink sign-ins; a linked wallet signs in to its account. Absent = off. */
  accountLinking?: boolean;
  /** ACCOUNT_FOLD_ENABLED: fold another account in, with proof of both. Absent = off. */
  accountFold?: boolean;
}

/**
 * Carrying an existing account over to a wallet sign-in trusts
 * `public.users.wallet_address`, which the old client paths can still write.
 * Off until those paths are closed in production; then
 * `WALLET_PROFILE_CARRY_ENABLED=true` (exact lowercase) turns it on.
 */
export function resolveWalletProfileCarry(
  config: AppConfig,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const block = (config as AppConfig & { authIdentity?: AuthIdentityConfigBlock }).authIdentity;
  return block?.walletProfileCarryEnabled ?? env.WALLET_PROFILE_CARRY_ENABLED === "true";
}

export function resolveAuthIdentityPolicy(config: AppConfig): AuthIdentityPolicy {
  // Read the future config block defensively: present -> use it, absent -> the
  // fixture. No cast to `any`, no runtime failure if it never arrives.
  const block = (config as AppConfig & { authIdentity?: AuthIdentityConfigBlock }).authIdentity;

  const domains = block?.siwsDomains?.filter((d) => d.length > 0);
  const uris = block?.siwsUris?.filter((u) => u.length > 0);
  const ttl = block?.nonceTtlSeconds;

  return {
    allowedDomains: domains?.length ? domains : [...FIXTURE_AUTH_IDENTITY_POLICY.allowedDomains],
    allowedUris: uris?.length ? uris : [...FIXTURE_AUTH_IDENTITY_POLICY.allowedUris],
    // Network comes from the one place that already owns it. A proof signed for
    // devnet must never verify on a mainnet server.
    network: config.social?.network ?? "devnet",
    // Clamped: a long-lived challenge is a replay window.
    nonceTtlSeconds: Math.min(Math.max(ttl ?? FIXTURE_AUTH_IDENTITY_POLICY.nonceTtlSeconds, 30), 900),
    proofVersion: SIWS_PROOF_VERSION,
  };
}

function storeConfig(config: AppConfig): IdentityStoreConfig | undefined {
  const s = config.social;
  if (!s) return undefined;
  return { supabaseUrl: s.supabaseUrl, serviceRoleKey: s.serviceRoleKey, network: s.network };
}

export function buildAuthIdentityRuntime(config: AppConfig): AuthIdentityRuntime {
  const sc = storeConfig(config);
  return {
    ...(sc ? { existingAccounts: new SupabaseExistingAccountStore(sc) } : {}),
    ...(sc ? { accountLinks: new SupabaseAccountLinkStore(sc) } : {}),
    accountLinking: config.authIdentity?.accountLinkingEnabled === true,
    accountFold: config.authIdentity?.accountFoldEnabled === true,
    store: sc
      ? new SupabaseIdentityStore(sc, fetch, { additionalSignIns: config.authIdentity?.accountLinkingEnabled === true })
      : new NoopIdentityStore(),
    verifier: sc ? new GoTrueJwtVerifier(sc) : new UnconfiguredJwtVerifier(),
    policy: resolveAuthIdentityPolicy(config),
    walletProfileCarry: resolveWalletProfileCarry(config),
  };
}

const runtimes = new WeakMap<AppConfig, AuthIdentityRuntime>();

/** Get (building on first use) the runtime for this app's config. */
export function authIdentityRuntimeFor(config: AppConfig): AuthIdentityRuntime {
  const existing = runtimes.get(config);
  if (existing) return existing;
  const built = buildAuthIdentityRuntime(config);
  runtimes.set(config, built);
  return built;
}

/**
 * Test seam. Installs a runtime for one config object so a test can drive the
 * router against an in-memory store without a Supabase project, a network call,
 * or a service-role key. Scoped to the config object it is given, so it cannot
 * bleed into another test.
 */
export function primeAuthIdentityRuntime(config: AppConfig, runtime: AuthIdentityRuntime): void {
  runtimes.set(config, runtime);
}
