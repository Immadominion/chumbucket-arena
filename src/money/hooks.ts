/**
 * The seam between the Panta lifecycle and money calls, without an import
 * cycle: the money runtime registers how to build itself when its module
 * loads (src/money/runtime.ts), and the Panta side asks here.
 *
 *   notifyMoneyFill  PantaTradingService's onFilled, once per confirmed fill,
 *                    after the FILLED row is durable: a pending money call
 *                    becomes FUNDED.
 *   moneyHooksFor    the money sweeper, for the Panta reconciler's pass.
 *
 * With MONEY_CALLS_ENABLED off both are no-ops. A fill missed here (a crash,
 * a database blip) is still picked up by the sweeper, which reads the ledger.
 */
import type { AppConfig } from "../config.ts";
import type { PantaTradeSession } from "../prediction/PantaTradingStore.ts";
import { moneyCallsRollout, rolloutActive } from "../rollout.ts";

export interface MoneySweepReport {
  funded: number;
  expired: number;
  transfersConfirmed: number;
  transfersFailed: number;
  errors: string[];
}

export interface MoneyHooks {
  onFilled(row: PantaTradeSession): Promise<void>;
  sweep(): Promise<MoneySweepReport>;
}

let build: ((config: AppConfig) => MoneyHooks) | null = null;

export function registerMoneyHooks(builder: (config: AppConfig) => MoneyHooks): void { build = builder; }

/** The money hooks for this app, or null with money calls off (or not loaded). */
export function moneyHooksFor(config: AppConfig): MoneyHooks | null {
  if (!rolloutActive(moneyCallsRollout(config)) || !build) return null;
  try { return build(config); } catch { return null; }
}

/** Tell money calls about a confirmed fill. Never throws, never blocks the fill. */
export function notifyMoneyFill(config: AppConfig, row: PantaTradeSession): void {
  const hooks = moneyHooksFor(config);
  if (hooks) void hooks.onFilled(row).catch(() => undefined);
}
