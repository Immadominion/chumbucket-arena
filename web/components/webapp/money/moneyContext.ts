"use client";

/**
 * What every money surface reads: whether the server runs calls with money
 * (`money.status`; everything money is hidden when it doesn't), the trading
 * wallet's balance, and the handles that open the one call flow, the wallet
 * sheet and the deposit sheet (MoneyProvider renders them). No UI here, so
 * `ui.tsx` can show the balance pill without importing the sheets.
 */

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { Amount, MoneyCallTarget, MoneyCallView, MoneyStatus, MoneyWallet } from "@/lib/webapp/money";
import type { CallIntent } from "@/lib/webapp/moneyFlow";
import type { CallFeedEntry, CallVisibility } from "@/lib/webapp/types";
import { useApi } from "../session";

const MINUTE = 60_000;

export const moneyKeys = {
  status: ["money", "status"] as const,
  wallet: ["money", "wallet"] as const,
  activity: ["money", "activity"] as const,
  winnings: ["money", "winnings"] as const,
  pending: ["money", "pending"] as const,
  deposit: (amount: string | null) => ["money", "deposit", amount ?? ""] as const,
};

/** A call with an amount, as a surface asks for it: one tap. */
export interface StartCall {
  target: MoneyCallTarget;
  intent: CallIntent;
  /** The side as the market names it ("YES", "Lakers"), for the sheet and the toast. */
  label: string;
  thesis?: string | null;
  visibility?: CallVisibility;
}

export interface MoneyValue {
  enabled: boolean;
  /** The server has answered `money.status` for this account (on or off). */
  known: boolean;
  status: MoneyStatus | null;
  wallet: MoneyWallet | null;
  startCall(call: StartCall): void;
  /** The owner's pending call: finish it, keep it free or drop it. */
  resumeCall(item: { moneyCall: MoneyCallView; call: CallFeedEntry }): void;
  openWallet(): void;
  openDeposit(): void;
  /** Remember the amount a call was made with (Free is `null`). */
  remember(amount: Amount): void;
}

const OFF: MoneyValue = {
  enabled: false,
  // No provider: no money at all.
  known: true,
  status: null,
  wallet: null,
  startCall: () => undefined,
  resumeCall: () => undefined,
  openWallet: () => undefined,
  openDeposit: () => undefined,
  remember: () => undefined,
};

export const MoneyContext = createContext<MoneyValue>(OFF);

export function useMoney(): MoneyValue {
  return useContext(MoneyContext);
}

/** Whether this server runs calls with money. A server without `money.*` reads as off. */
export function useMoneyStatus() {
  const api = useApi();
  return useQuery({ queryKey: moneyKeys.status, queryFn: () => api.moneyStatus(), staleTime: 5 * MINUTE });
}

/** The trading wallet's real balance. `watching`: a sheet is waiting for funds to land. */
export function useMoneyWallet(enabled: boolean, watching = false) {
  const api = useApi();
  return useQuery({
    queryKey: moneyKeys.wallet,
    queryFn: () => api.moneyWallet(),
    enabled,
    refetchInterval: watching ? 4_000 : MINUTE,
    staleTime: watching ? 0 : 30_000,
  });
}

export function useMoneyActivity(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: moneyKeys.activity, queryFn: () => api.moneyActivity(20), enabled, refetchInterval: MINUTE });
}

export function useWinnings(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: moneyKeys.winnings, queryFn: () => api.winnings(), enabled, refetchInterval: MINUTE });
}

export function usePendingCalls(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: moneyKeys.pending, queryFn: () => api.pendingCalls(), enabled, refetchInterval: MINUTE });
}
