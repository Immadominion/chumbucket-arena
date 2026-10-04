"use client";

/** The only money chrome: the trading wallet's balance in the header (`$12.19`). Tap: the wallet sheet. */

import { balanceUsd } from "@/lib/webapp/money";
import { Icon } from "../Icon";
import { useMoney } from "./moneyContext";

export function BalancePill() {
  const money = useMoney();
  if (!money.enabled) return null;
  const balance = balanceUsd(money.wallet?.balance?.usdcBaseUnits);
  return (
    <button type="button" className="wa-balance" aria-label={`Wallet, ${balance}`} onClick={money.openWallet}>
      <Icon name="wallet-solid" size={16} />
      <span aria-hidden>{balance}</span>
    </button>
  );
}
