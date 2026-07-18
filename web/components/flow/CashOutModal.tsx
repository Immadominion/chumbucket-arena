"use client";

import { useState } from "react";
import Modal from "@/components/ui/Modal";
import { ArrowUp, ShieldCheck } from "@/components/icons";
import { useSession } from "@/lib/session";
import { useWalPrice } from "@/lib/useWalPrice";

/** "Cash out" — no-crypto withdraw. Live: trpc.withdraw.mutate({ amount }). */
export default function CashOutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session, withdraw, busy } = useSession();
  const price = useWalPrice();
  const [amount, setAmount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const max = session.withdrawable; // bonus is not cashable
  // Mirrors the backend fee (max(2%, 0.05 USDC)) so you see the net before cashing out.
  const fee = amount > 0 ? Math.max((amount * 200) / 10000, 0.05) : 0;
  const net = Math.max(0, amount - fee);

  const confirm = async () => {
    if (amount <= 0) {
      onClose();
      return;
    }
    setError(null);
    try {
      await withdraw(Math.min(amount, max));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Withdrawal failed — try again.");
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={420} label="Cash out">
      <div style={{ padding: 26 }}>
        <h2 className="cd" style={{ fontSize: 22, margin: "0 0 4px" }}>Cash out</h2>
        <p style={{ fontSize: 13, color: "#7C6D72", margin: "0 0 18px" }}>
          Available to withdraw: <span className="mono" style={{ fontWeight: 700, color: "#221217" }}>{max.toFixed(1)} USDC</span>
        </p>

        <div style={{ background: "#F9F3F5", borderRadius: 16, padding: "20px 16px", textAlign: "center" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8 }}>
            <input
              type="number"
              value={amount}
              min={0}
              max={max}
              onChange={(e) => setAmount(Math.max(0, Math.min(max, Number(e.target.value))))}
              className="mono"
              style={{ width: 130, textAlign: "right", border: "none", background: "transparent", fontSize: 38, fontWeight: 700, color: "#221217" }}
            />
            <span style={{ fontSize: 16, fontWeight: 700, color: "#988990" }}>USDC</span>
          </div>
          <div className="mono" style={{ fontSize: 12, color: "#988990", marginTop: 4 }}>≈ {price !== null ? `$${(amount * price).toFixed(2)}` : "—"}</div>
        </div>
        {amount > 0 && (
          <div style={{ fontSize: 12, color: "#7C6D72", fontWeight: 600, textAlign: "center", marginTop: 10 }}>
            You receive <span className="mono" style={{ fontWeight: 700, color: "#B81540" }}>{net.toFixed(2)} USDC</span>
            <span style={{ color: "#B3A6AB" }}> · {fee.toFixed(2)} USDC network fee</span>
          </div>
        )}

        <button onClick={() => setAmount(max)} style={{ marginTop: 12, width: "100%", background: "#F9F3F5", border: "none", borderRadius: 11, padding: "10px 0", fontWeight: 700, fontSize: 13, color: "#221217", cursor: "pointer" }}>
          Max · {max.toFixed(1)} USDC
        </button>

        <button onClick={() => void confirm()} disabled={amount <= 0 || busy} className="btnp" style={{ width: "100%", padding: 14, borderRadius: 14, fontSize: 15, marginTop: 14, opacity: amount <= 0 || busy ? 0.5 : 1 }}>
          <ArrowUp size={16} weight="bold" />
          {busy ? "Processing…" : `Cash out${amount > 0 ? ` ${amount} USDC` : ""}`}
        </button>
        {error && <p style={{ fontSize: 12, color: "#C2373B", textAlign: "center", marginTop: 12, fontWeight: 600, lineHeight: 1.4 }}>{error}</p>}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14, fontSize: 11.5, fontWeight: 600, color: "#B3A6AB" }}>
          <ShieldCheck size={14} weight="fill" color="#F2385A" />
          Sent from the ChumBucket wallet to your account
        </div>
      </div>
    </Modal>
  );
}
