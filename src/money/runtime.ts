/**
 * Lazy, per-app composition of money (docs/money-api.md), memoised on the
 * AppConfig object like every other runtime. Nothing starts at import time;
 * importing this module only registers how to build it (src/money/hooks.ts),
 * so the Panta fill transition and reconciler can reach money calls without
 * importing them.
 */
import type { AppConfig } from "../config.ts";
import { callsRuntimeFor } from "../calls/runtime.ts";
import { depositsRuntimeFor } from "../deposits/runtime.ts";
import { pantaLifecycleFor, pantaTradingFor } from "../prediction/PantaTradingRuntime.ts";
import { RpcRentReader } from "../solTopUp/need.ts";
import { solTopUpRuntimeFor } from "../solTopUp/runtime.ts";
import { chumbucketWalletEnabled } from "../wallet/tradingWallet.ts";
import { RpcUsdcCredits, type UsdcCreditsReader } from "./activity.ts";
import { MoneyGas, type GasPort } from "./gas.ts";
import { registerMoneyHooks, type MoneyHooks, type MoneySweepReport } from "./hooks.ts";
import { MoneyCallsService, type BalancePort } from "./MoneyCallsService.ts";
import { InMemoryWalletTransferStore, SupabaseWalletTransferStore } from "./store.ts";
import { RpcTransferChain, TransferService } from "./transfers.ts";
import { moneyCallIndexFor, moneyCallStoreFor, moneyCallsEnabled } from "./visibility.ts";

export interface MoneyRuntime extends MoneyHooks {
  calls: MoneyCallsService;
  transfers: TransferService;
  credits: UsdcCreditsReader | null;
  balances: BalancePort | null;
  gas: GasPort;
}

const runtimes = new WeakMap<AppConfig, MoneyRuntime>();

function tryBuild<T>(build: () => T): T | null {
  try { return build(); } catch { return null; }
}

export function buildMoneyRuntime(config: AppConfig): MoneyRuntime {
  const calls = callsRuntimeFor(config);
  const deposits = depositsRuntimeFor(config);
  const balances = deposits.balances;
  const gas = new MoneyGas({
    rent: tryBuild(() => new RpcRentReader(config.solana.rpcUrl)),
    topUp: () => solTopUpRuntimeFor(config).service,
  });
  const maxRaw = config.predictions?.maxAmountBaseUnits;
  const moneyCalls = new MoneyCallsService({
    store: moneyCallStoreFor(config),
    index: moneyCallIndexFor(config),
    calls: { service: calls.service, store: calls.store, flush: async () => { await calls.durable?.flush(); } },
    trading: forRead => pantaTradingFor(config, forRead),
    ledger: () => tryBuild(() => pantaLifecycleFor(config, true).ledger),
    balances,
    gas,
    maxBaseUnits: maxRaw && /^[1-9][0-9]{0,15}$/.test(maxRaw) ? BigInt(maxRaw) : null,
    chumbucketWallet: chumbucketWalletEnabled(config),
  });
  const transfers = new TransferService({
    store: config.social ? new SupabaseWalletTransferStore(config.social) : new InMemoryWalletTransferStore(),
    chain: tryBuild(() => new RpcTransferChain(config.solana.rpcUrl)),
    balances,
    gas,
  });
  return {
    calls: moneyCalls,
    transfers,
    credits: tryBuild(() => new RpcUsdcCredits(config.solana.rpcUrl)),
    balances,
    gas,
    onFilled: row => moneyCalls.onFilled(row),
    async sweep(): Promise<MoneySweepReport> {
      // The calls mirror (and which calls are private) must be read first.
      await calls.ready;
      const swept = await moneyCalls.sweep();
      const moved = await transfers.sweep();
      return { funded: swept.funded, expired: swept.expired, transfersConfirmed: moved.confirmed, transfersFailed: moved.failed,
        errors: [...swept.errors, ...moved.errors] };
    },
  };
}

/** The money runtime for this app. Only with MONEY_CALLS_ENABLED; callers check first. */
export function moneyRuntimeFor(config: AppConfig): MoneyRuntime {
  const held = runtimes.get(config);
  if (held) return held;
  const built = buildMoneyRuntime(config);
  runtimes.set(config, built);
  return built;
}

/** Test seam, scoped to the exact AppConfig object. Never selected by env. */
export function setMoneyRuntime(config: AppConfig, runtime: MoneyRuntime): void { runtimes.set(config, runtime); }

registerMoneyHooks(config => {
  if (!moneyCallsEnabled(config)) throw new Error("money calls are off");
  return moneyRuntimeFor(config);
});
