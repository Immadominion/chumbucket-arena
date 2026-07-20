"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Modal from "@/components/ui/Modal";
import { Signature } from "@/components/icons";
import { useSession } from "@/lib/session";

/* eslint-disable @next/next/no-img-element */

/**
 * The pick-your-handle step, shown AFTER Privy authentication. Privy's own modal
 * handles method selection (Google / X / email / wallet), so there's no custom
 * provider UI here, just the handle, then trpc.signContract.
 */
export default function SignContractModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { signContract, busy } = useSession();
  const router = useRouter();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    setError(null);
    try {
      await signContract(handle.trim() || "Chum");
      onClose();
      router.push("/trial");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't set up your account. Try again.");
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={420} label="Pick a handle">
      <div style={{ padding: 28 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
          <img src="/img/logo.png" alt="" style={{ width: 40, height: 40, objectFit: "contain" }} />
        </div>
        <h2 className="cd" style={{ fontSize: 24, textAlign: "center", margin: "0 0 6px" }}>Pick your handle</h2>
        <p style={{ textAlign: "center", fontSize: 13.5, color: "#7C6D72", lineHeight: 1.45, margin: "0 0 20px" }}>
          You&rsquo;re in. This is the name your mates see when you challenge them and back the crowd.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); if (!busy) void finish(); }}>
          <input
            autoFocus
            value={handle}
            onChange={(e) => setHandle(e.target.value.slice(0, 24))}
            placeholder="Your handle"
            style={{ width: "100%", border: "1.5px solid #EFE6E9", borderRadius: 13, padding: "14px 16px", fontSize: 16, fontWeight: 700, color: "#221217", fontFamily: "var(--font-display)", marginBottom: 16 }}
          />
          <button type="submit" disabled={busy} className="btnp" style={{ width: "100%", padding: 14, borderRadius: 14, fontSize: 15, opacity: busy ? 0.6 : 1 }}>
            <Signature size={18} weight="fill" />
            {busy ? "Setting up…" : "Let's go"}
          </button>
        </form>
        {error && <p style={{ fontSize: 12, color: "#C2373B", textAlign: "center", marginTop: 12, fontWeight: 600 }}>{error}</p>}
        <p style={{ fontSize: 11.5, color: "#B3A6AB", textAlign: "center", marginTop: 14, lineHeight: 1.4 }}>
          Your wallet is created for you, no seed phrases. Owned by you, verifiable on-chain.
        </p>
      </div>
    </Modal>
  );
}
