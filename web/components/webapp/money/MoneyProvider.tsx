"use client";

/**
 * Calls with money in the web app, behind the server's own switch
 * (`money.status`, MONEY_CALLS_ENABLED): off, or on a server without
 * `money.*`, nothing money shows and every call is the free call it always
 * was. On, it holds the one call flow, the wallet sheet and the deposit
 * sheet, and every surface opens them through `useMoney()`.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { sideName } from "@/lib/webapp/money";
import { moneyOn } from "@/lib/webapp/rollout";
import { useViewer } from "../session";
import { rememberAmount } from "./AmountRow";
import { DepositSheet } from "./DepositSheet";
import { MoneyCallFlow, type CallRequest } from "./MoneyCallSheet";
import { MoneyContext, useMoneyStatus, useMoneyWallet, type MoneyValue } from "./moneyContext";
import { WalletSheet } from "./WalletSheet";

export function MoneyProvider({ children }: { children: React.ReactNode }) {
  const viewer = useViewer();
  const status = useMoneyStatus();
  // The server's answer for this account (admins only during rollout); anything else is off.
  const enabled = moneyOn(status.data);
  const known = status.isSuccess || status.isError;
  const wallet = useMoneyWallet(enabled);
  const [request, setRequest] = useState<(CallRequest & { id: number }) | null>(null);
  const [sheet, setSheet] = useState<"wallet" | "deposit" | null>(null);
  const seq = useRef(0);
  // Stable handlers: a balance update re-renders this provider, never an open sheet's focus.
  const closeSheet = useCallback(() => setSheet(null), []);
  const addFunds = useCallback(() => setSheet("deposit"), []);
  const callDone = useCallback(() => setRequest(null), []);

  const value = useMemo<MoneyValue>(
    () => ({
      enabled,
      known,
      status: enabled ? (status.data ?? null) : null,
      wallet: enabled ? (wallet.data ?? null) : null,
      startCall: (call) => {
        rememberAmount(viewer.userId, call.intent.amountBaseUnits);
        setSheet(null);
        // One tap, one key: every ask of this call reuses it.
        setRequest({ mode: "new", key: crypto.randomUUID(), ...call, id: ++seq.current });
      },
      resumeCall: ({ moneyCall, call }) => {
        setSheet(null);
        setRequest({ mode: "resume", moneyCall, call, label: sideName(call.market, moneyCall.side), id: ++seq.current });
      },
      openWallet: () => setSheet("wallet"),
      openDeposit: () => setSheet("deposit"),
      remember: (amount) => rememberAmount(viewer.userId, amount),
    }),
    [enabled, known, status.data, viewer.userId, wallet.data],
  );

  return (
    <MoneyContext.Provider value={value}>
      {children}
      {enabled ? (
        <>
          {request ? <MoneyCallFlow key={request.id} request={request} onDone={callDone} /> : null}
          <WalletSheet open={sheet === "wallet"} onClose={closeSheet} onAddFunds={addFunds} />
          <DepositSheet open={sheet === "deposit"} onClose={closeSheet} />
        </>
      ) : null}
    </MoneyContext.Provider>
  );
}
