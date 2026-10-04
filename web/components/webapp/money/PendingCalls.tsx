"use client";

/**
 * The owner's calls with money that aren't funded yet (`money.pending`):
 * never public, never counted, never a ghost. Each opens the call's sheet —
 * going through, or the choice to finish it, keep it free or drop it.
 */

import { progressOf, sideName, usd } from "@/lib/webapp/money";
import { Icon } from "../Icon";
import { useMoney, usePendingCalls } from "./moneyContext";

export function PendingCalls() {
  const money = useMoney();
  const pending = usePendingCalls(money.enabled);
  if (!money.enabled) return null;
  const calls = pending.data?.calls ?? [];
  if (!calls.length) return null;
  return (
    <ul className="wa-pending" aria-label="Your calls waiting on money">
      {calls.map(({ moneyCall, call }) => (
        <li key={moneyCall.callId}>
          <button type="button" className="wa-pending-row" onClick={() => money.resumeCall({ moneyCall, call })}>
            <span className="wa-pending-ico">
              <Icon name={progressOf(moneyCall) === "pending" ? "sand-watch" : "wallet"} size={18} />
            </span>
            <span className="wa-pending-q">{call.market.question}</span>
            {/* Not funded: the grey mark with the amount and side, never the "$5 on YES" a fill earns. */}
            <span className="wa-chip wa-chip--pending">{`${usd(moneyCall.amountBaseUnits)} · ${sideName(call.market, moneyCall.side)}`}</span>
            <Icon name="arrow-right" size={18} />
          </button>
        </li>
      ))}
    </ul>
  );
}
