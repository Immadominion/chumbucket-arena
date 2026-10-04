"use client";

/**
 * The amount row on every call action: `Free · $5 · $10 · $25 · +`. Free is
 * the outline chip with its gift; money chips are pink. It starts on the last
 * amount this viewer used here (a per-browser convenience), else the
 * server's default, else $5. `+` takes any amount the server allows.
 */

import { useMemo, useState } from "react";
import {
  amountHint,
  customAmount,
  defaultAmount,
  presetAmounts,
  readLastAmount,
  usd,
  writeLastAmount,
  type Amount,
} from "@/lib/webapp/money";
import { browserStorage } from "../data";
import { Icon } from "../Icon";
import { useViewer } from "../session";
import { useMoney } from "./moneyContext";

/**
 * The amount a call action starts on, and its setter. `available`: money can
 * be put on this call at all (a SOL-quoted market takes free calls only).
 * With money off, or unavailable, it is always Free.
 */
export function useAmount(available = true): [Amount, (amount: Amount) => void] {
  const money = useMoney();
  const viewer = useViewer();
  const [picked, setPicked] = useState<Amount | undefined>(undefined);
  const remembered = useMemo(() => readLastAmount(browserStorage(), viewer.userId), [viewer.userId]);
  if (!available || !money.enabled || !money.status) return [null, setPicked];
  return [picked !== undefined ? picked : defaultAmount(money.status, remembered), setPicked];
}

/** Remember what a call was made with, for the next one (never trusted, never required). */
export function rememberAmount(userId: string, amount: Amount) {
  writeLastAmount(browserStorage(), userId, amount);
}

export function AmountRow({
  value,
  onChange,
  available = true,
  disabled = false,
}: {
  value: Amount;
  onChange: (amount: Amount) => void;
  available?: boolean;
  disabled?: boolean;
}) {
  const money = useMoney();
  const [typing, setTyping] = useState<string | null>(null);
  if (!money.enabled || !money.status || !available) return null;
  const status = money.status;
  const presets = presetAmounts(status);
  const custom = value !== null && !presets.includes(value) ? value : null;
  const checked = typing === null ? null : typing.trim() ? customAmount(typing, status) : null;

  if (typing !== null) {
    const apply = () => {
      if (checked?.ok) {
        onChange(checked.amount);
        setTyping(null);
      }
    };
    return (
      <div className="wa-amounts" role="group" aria-label="Amount">
        <div className="wa-input-wrap wa-amount-input">
          <span className="wa-input-prefix" aria-hidden>
            $
          </span>
          <input
            className="wa-input"
            inputMode="decimal"
            autoFocus
            aria-label="Amount in dollars"
            aria-invalid={checked ? !checked.ok : undefined}
            aria-describedby="wa-amount-hint"
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply();
              if (e.key === "Escape") setTyping(null);
            }}
          />
        </div>
        <button type="button" className="wa-amt wa-amt--set" aria-label="Use this amount" disabled={!checked?.ok} onClick={apply}>
          <Icon name="check" size={18} />
        </button>
        <button type="button" className="wa-amt wa-amt--plain" aria-label="Back to amounts" onClick={() => setTyping(null)}>
          <Icon name="cross" size={16} />
        </button>
        <span id="wa-amount-hint" className="wa-sr" aria-live="polite">
          {checked && !checked.ok ? amountHint(checked.problem, status) : ""}
        </span>
        {checked && !checked.ok ? (
          <span className="wa-amount-hint" aria-hidden>
            {amountHint(checked.problem, status)}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="wa-amounts" role="radiogroup" aria-label="Amount">
      <button type="button" role="radio" aria-checked={value === null} className="wa-amt wa-amt--free" disabled={disabled} onClick={() => onChange(null)}>
        <Icon name="present" size={15} />
        Free
      </button>
      {presets.map((p) => (
        <button key={p} type="button" role="radio" aria-checked={value === p} className="wa-amt" disabled={disabled} onClick={() => onChange(p)}>
          {usd(p)}
        </button>
      ))}
      {custom ? (
        <button type="button" role="radio" aria-checked className="wa-amt" disabled={disabled} onClick={() => setTyping(usd(custom).slice(1))}>
          {usd(custom)}
        </button>
      ) : null}
      <button type="button" className="wa-amt wa-amt--more" aria-label="Another amount" disabled={disabled} onClick={() => setTyping("")}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
