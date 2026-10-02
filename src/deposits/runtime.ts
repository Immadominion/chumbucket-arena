/**
 * Lazy, per-app composition (contract §6: a new module needs no edit to
 * createApp). Memoised on the AppConfig object, like AuthIdentityRuntime, so
 * two apps in one process — every test file — never share state.
 */

import type { AppConfig } from "../config.ts";
import {
  CachedDepositAccounts,
  GoTrueAccountEmailReader,
  SessionDepositAccounts,
  SupabaseLinkedWalletReader,
  type DepositAccounts,
} from "./accounts.ts";
import { MainnetBalanceReader, type WalletBalanceReader } from "./balance.ts";
import { resolveDeposits, type DepositsReadiness } from "./config.ts";
import { HttpCrossmintTransport } from "./crossmint.ts";
import { DepositRateLimiter, DepositService } from "./service.ts";

export interface DepositsRuntime {
  readiness: DepositsReadiness;
  /** Present only when `readiness.available`. */
  service: DepositService | null;
  accounts: DepositAccounts;
  /** Null when no usable RPC is configured. */
  balances: WalletBalanceReader | null;
  limiter: DepositRateLimiter;
}

const unconfiguredAccounts: DepositAccounts = {
  async resolve(token) {
    return { ok: false, reason: token ? "UNAVAILABLE" : "SIGNED_OUT" };
  },
};

export function buildDepositsRuntime(config: AppConfig, env: Record<string, string | undefined> = process.env): DepositsRuntime {
  const readiness = resolveDeposits(config, env);
  const limiter = new DepositRateLimiter();
  const social = config.social;
  const accounts = social
    ? new CachedDepositAccounts(
        new SessionDepositAccounts(config, new SupabaseLinkedWalletReader(social), new GoTrueAccountEmailReader(social)),
      )
    : unconfiguredAccounts;
  let balances: WalletBalanceReader | null = null;
  try {
    balances = new MainnetBalanceReader(config.solana.rpcUrl);
  } catch {
    balances = null;
  }
  const service = readiness.available && readiness.config
    ? new DepositService({
        config: readiness.config,
        crossmint: new HttpCrossmintTransport(readiness.config.apiBase, readiness.config.serverApiKey),
        limiter,
      })
    : null;
  return { readiness, service, accounts, balances, limiter };
}

const runtimes = new WeakMap<AppConfig, DepositsRuntime>();

export function depositsRuntimeFor(config: AppConfig): DepositsRuntime {
  const held = runtimes.get(config);
  if (held) return held;
  const built = buildDepositsRuntime(config);
  runtimes.set(config, built);
  return built;
}

/** Test seam, scoped to one exact AppConfig object. Never selected by env. */
export function primeDepositsRuntime(config: AppConfig, runtime: DepositsRuntime): void {
  runtimes.set(config, runtime);
}
