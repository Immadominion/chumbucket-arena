"use client";

/** The only money chrome: the trading wallet's balance in the header (`$12.19`). Tap: the wallet sheet. */

import { balanceUsd } from "@/lib/webapp/money";
import { Icon } from "../Icon";
import { useMoney } from "./moneyContext";

export function BalancePill() {
  const money = useMoney();
  if (!money.enabled) return null;
  // Never a made-up number: until the balance is read, the pill is the wallet alone.
  const balance = money.wallet ? balanceUsd(money.wallet.balance?.usdcBaseUnits) : null;
  return (
    <button type="button" className="wa-balance" aria-label={balance ? `Wallet, ${balance}` : "Wallet"} onClick={money.openWallet}>
      <Icon name="wallet-solid" size={16} />
      {balance ? <span aria-hidden>{balance}</span> : null}
    </button>
  );
}
