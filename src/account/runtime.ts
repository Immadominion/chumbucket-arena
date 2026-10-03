/**
 * Lazy, per-app construction of the account runtime (store + push sender),
 * memoised on the AppConfig OBJECT like every other packet runtime here, so
 * two apps in one test process never share a store and nothing is built at
 * import time.
 */

import type { AppConfig } from "../config.ts";
import { resolvePushConfig, type PushConfig } from "../push/config.ts";
import { FcmHttpV1Sender, type PushSender } from "../push/fcm.ts";
import { SupabaseAccountStore, UnconfiguredAccountStore, type AccountStore } from "./store.ts";

export interface AccountRuntime {
  store: AccountStore;
  push: PushConfig;
  /** null when FIREBASE_SERVICE_ACCOUNT_JSON is absent or unusable. */
  sender: PushSender | null;
}

export function buildAccountRuntime(
  config: AppConfig,
  env: Record<string, string | undefined> = process.env,
): AccountRuntime {
  const store: AccountStore = config.social
    ? new SupabaseAccountStore({ supabaseUrl: config.social.supabaseUrl, serviceRoleKey: config.social.serviceRoleKey })
    : new UnconfiguredAccountStore();
  const push = resolvePushConfig(env);
  return { store, push, sender: push.enabled ? new FcmHttpV1Sender(push.account) : null };
}

/**
 * Whether this server actually delivers pushes: a store that keeps device
 * tokens, a configured FCM sender, and the notification scheduler running
 * (it is what derives and dispatches them; src/index.ts). The app asks for
 * notification permission only when this is true, so it never promises a
 * push nobody sends (onboarding spec §8).
 */
export function pushDelivers(rt: AccountRuntime, env: Record<string, string | undefined> = process.env): boolean {
  return rt.store.enabled && rt.sender !== null && env.NOTIFICATIONS_SCHEDULER_ENABLED !== "false";
}

let RUNTIMES = new WeakMap<AppConfig, AccountRuntime>();

export function accountRuntimeFor(config: AppConfig): AccountRuntime {
  let rt = RUNTIMES.get(config);
  if (!rt) {
    rt = buildAccountRuntime(config);
    RUNTIMES.set(config, rt);
  }
  return rt;
}

/** Test seam: pin a runtime for one AppConfig. */
export function setAccountRuntime(config: AppConfig, rt: AccountRuntime): void {
  RUNTIMES.set(config, rt);
}

/** Test seam. */
export function resetAccountRuntimes(): void {
  RUNTIMES = new WeakMap<AppConfig, AccountRuntime>();
}
