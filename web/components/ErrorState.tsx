"use client";

/**
 * Shown when public game data genuinely failed to load (not just empty). Keeps a
 * failed fetch from masquerading as a truthful "you have nothing here", the
 * player sees the real problem and can retry without a full page reload.
 */

import { ArrowCounterClockwise, WarningCircle } from "@/components/icons";

export default function ErrorState({
  onRetry,
  title = "Couldn't reach ChumBucket",
  detail = "We couldn't load live fixtures just now. Check your connection and try again.",
}: {
  onRetry?: () => void;
  title?: string;
  detail?: string;
}) {
  return (
    <div
      role="alert"
      className="midpad"
      style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", textAlign: "center", gap: 14 }}
    >
      <div style={{ width: 56, height: 56, borderRadius: 16, background: "#FBE9EA", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <WarningCircle size={30} weight="fill" color="#C2373B" />
      </div>
      <div>
        <div className="cd" style={{ fontSize: 20, color: "#221217" }}>{title}</div>
        <p style={{ fontSize: 13.5, fontWeight: 500, color: "#988990", margin: "6px auto 0", maxWidth: 340, lineHeight: 1.45 }}>{detail}</p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="btnp"
          style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, padding: "11px 20px", borderRadius: 12, border: "none", cursor: "pointer", marginTop: 2 }}
        >
          <ArrowCounterClockwise size={15} weight="bold" /> Try again
        </button>
      )}
    </div>
  );
}
