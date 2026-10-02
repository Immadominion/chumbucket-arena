/**
 * Lazy, per-app composition, memoised on the AppConfig object (the deposits
 * pattern): nothing starts at import time, and two apps in one process never
 * share state. Accounts and balances are the deposits runtime's: the same
 * session-verified person and the same genesis-pinned mainnet reads.
 */

import type { AppConfig } from "../config.ts";
import { depositsRuntimeFor } from "../deposits/runtime.ts";
import { resolveSolTopUp, type SolTopUpReadiness } from "./config.ts";
import { RpcSwapInspector } from "./inspect.ts";
import { HttpJupiterTransport } from "./jupiter.ts";
import { RpcRentReader } from "./need.ts";
import { SolTopUpService } from "./service.ts";

export interface SolTopUpRuntime {
  readiness: SolTopUpReadiness;
  /** Present only when available AND this server can read mainnet. */
  service: SolTopUpService | null;
}

export function buildSolTopUpRuntime(config: AppConfig, env: Record<string, string | undefined> = process.env): SolTopUpRuntime {
  const readiness = resolveSolTopUp(config, env);
  const deposits = depositsRuntimeFor(config);
  if (!readiness.available || !readiness.config) return { readiness, service: null };
  if (!deposits.balances) {
    return {
      readiness: { available: false, reason: { code: "MISCONFIGURED", message: "Swapping USDC for SOL needs a mainnet connection this server doesn't have." }, config: null },
      service: null,
    };
  }
  let inspector: RpcSwapInspector;
  let rent: RpcRentReader;
  try {
    inspector = new RpcSwapInspector(config.solana.rpcUrl);
    rent = new RpcRentReader(config.solana.rpcUrl);
  } catch {
    return {
      readiness: { available: false, reason: { code: "MISCONFIGURED", message: "Swapping USDC for SOL needs a mainnet connection this server doesn't have." }, config: null },
      service: null,
    };
  }
  const cfg = readiness.config;
  return {
    readiness,
    service: new SolTopUpService({
      config: cfg,
      jupiter: new HttpJupiterTransport(cfg.apiBase, cfg.apiKey, fetch, 12_000, cfg.minIntervalMs),
      inspector,
      rent,
      balances: deposits.balances,
    }),
  };
}

const runtimes = new WeakMap<AppConfig, SolTopUpRuntime>();

export function solTopUpRuntimeFor(config: AppConfig): SolTopUpRuntime {
  const held = runtimes.get(config);
  if (held) return held;
  const built = buildSolTopUpRuntime(config);
  runtimes.set(config, built);
  return built;
}

/** Test seam, scoped to one exact AppConfig object. Never selected by env. */
export function primeSolTopUpRuntime(config: AppConfig, runtime: SolTopUpRuntime): void {
  runtimes.set(config, runtime);
}
