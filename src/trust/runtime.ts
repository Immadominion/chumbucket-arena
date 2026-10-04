/**
 * Lazy, per-app construction of the trust runtime — the contract §6 pattern
 * the calls, notifications and identity runtimes use: memoised on the
 * AppConfig OBJECT, built on first use, nothing at import time, and nothing
 * wired into createApp.
 *
 * Durable when Supabase is configured (`config.social`); otherwise in memory,
 * and it says so at boot rather than pretending.
 */

import type { AppConfig } from "../config.ts";
import { callsRuntimeFor } from "../calls/runtime.ts";
import { resolveTrustConfig, type TrustConfig } from "./config.ts";
import { WriteRateLimiter } from "./rateLimit.ts";
import { InMemoryTrustStore, UnconfiguredAuthUserAdmin, type AuthUserAdmin, type TrustStore } from "./store.ts";
import { GoTrueAuthUserAdmin, SupabaseTrustStore } from "./supabaseStore.ts";
import type { AccountDeletionGuard } from "./deletionGuards.ts";
import { TrustService } from "./TrustService.ts";

export interface TrustRuntime {
  config: TrustConfig;
  store: TrustStore;
  authAdmin: AuthUserAdmin;
  limiter: WriteRateLimiter;
  service: TrustService;
}

export interface BuildTrustRuntimeOverrides {
  config?: TrustConfig;
  store?: TrustStore;
  authAdmin?: AuthUserAdmin;
  now?: () => number;
  /** Test seam; production uses src/trust/deletionGuards.ts. */
  deletionGuards?: readonly AccountDeletionGuard[];
}

export function buildTrustRuntime(appConfig: AppConfig, overrides: BuildTrustRuntimeOverrides = {}): TrustRuntime {
  const config = overrides.config ?? resolveTrustConfig(appConfig);
  const social = appConfig.social;
  const store = overrides.store ?? (social ? new SupabaseTrustStore(social) : new InMemoryTrustStore());
  const authAdmin = overrides.authAdmin ?? (social ? new GoTrueAuthUserAdmin(social) : new UnconfiguredAuthUserAdmin());
  const now = overrides.now ?? Date.now;
  const limiter = new WriteRateLimiter(config.rateLimits, now);
  const service = new TrustService({
    config,
    store,
    authAdmin,
    limiter,
    calls: () => callsRuntimeFor(appConfig),
    now,
    ...(overrides.deletionGuards ? { deletionGuards: overrides.deletionGuards } : {}),
  });
  if (social && !overrides.store) {
    console.log(
      `[trust] store: ${store.durable ? "supabase" : "in-memory"}; admins: ${config.adminUserIds.size}; terms ${config.termsVersion}`,
    );
  }
  return { config, store, authAdmin, limiter, service };
}

const runtimes = new WeakMap<AppConfig, TrustRuntime>();

export function trustRuntimeFor(appConfig: AppConfig): TrustRuntime {
  let rt = runtimes.get(appConfig);
  if (!rt) {
    rt = buildTrustRuntime(appConfig);
    runtimes.set(appConfig, rt);
  }
  return rt;
}

/** Test seam, scoped to one AppConfig object. */
export function setTrustRuntime(appConfig: AppConfig, runtime: TrustRuntime): void {
  runtimes.set(appConfig, runtime);
}
