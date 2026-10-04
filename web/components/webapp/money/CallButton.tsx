"use client";

/**
 * The one button a call action ends in. Free: the strong ink button with the
 * Free mark (`Call YES`). An amount: the pink money button with its dollars
 * (`Call YES · $5`). Pink is reserved for money.
 */

import type { Amount } from "@/lib/webapp/money";
import { FreeChip, Spinner } from "../ui";
import { Icon } from "../Icon";

export function CallButton({
  label,
  amount,
  busy = false,
  disabled = false,
  icon,
  block = false,
  onClick,
}: {
  label: string;
  amount: Amount;
  busy?: boolean;
  disabled?: boolean;
  icon?: string;
  block?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${amount ? "wa-btn wa-btn--primary" : "wa-btn wa-btn--ink"}${block ? " wa-btn--block" : ""}`}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} size={20} /> : null}
      <span className="wa-btn-label">{label}</span>
      {amount ? null : <FreeChip />}
    </button>
  );
}
