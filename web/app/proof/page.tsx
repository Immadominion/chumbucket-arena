"use client";

/**
 * How a result settles, a real on-chain settlement, shown end to end. When a
 * ChumBucket match ends, the final score is proven against TxLINE's Merkle-
 * committed data on Solana before a payout becomes claimable. This page shows a real one
 * and lets you re-run the exact on-chain check yourself.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import VerifyReceipt, { type Receipt } from "@/components/VerifyReceipt";
import { ArrowLeft, Brain, ShieldCheck, LockSimple } from "@/components/icons";

export default function ProofPage() {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetch("/receipts/argentina-egypt.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setReceipt)
      .catch(() => setErr(true));
  }, []);

  return (
    <div className="proof-page" style={{ minHeight: "100vh", background: "#1A1013", color: "#F7EEF0" }}>
      <div className="proof-shell" style={{ maxWidth: 720, margin: "0 auto", padding: "40px 22px 80px" }}>
        <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "#FFB0C0", textDecoration: "none", marginBottom: 34 }}>
          <ArrowLeft size={15} weight="bold" /> ChumBucket
        </Link>

        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255, 51, 85,.12)", border: "1px solid rgba(255, 51, 85,.25)", borderRadius: 30, padding: "6px 14px", fontSize: 12, fontWeight: 700, color: "#FFB0C0" }}>
          <ShieldCheck size={14} weight="fill" /> Real on-chain settlement
        </div>
        <h1 className="cd proof-title" style={{ fontSize: 40, lineHeight: 1.05, color: "#fff", margin: "18px 0 0", letterSpacing: "0", textWrap: "balance" }}>
          How a result settles.
        </h1>
        <p className="proof-copy" style={{ fontSize: 15.5, lineHeight: 1.5, color: "#D9C3C9", margin: "14px 0 0", maxWidth: 560 }}>
          When a match ends, ChumBucket proves the final score against{" "}
          <b style={{ color: "#F7EEF0" }}>TxLINE&rsquo;s Merkle-committed data on Solana</b>, and only then makes the winning position claimable. No
          human decides. Here&rsquo;s a real settlement and the exact on-chain check that authorized the claim.
        </p>

        <div style={{ marginTop: 30 }}>
          {receipt ? (
            <VerifyReceipt receipt={receipt} />
          ) : err ? (
            <div className="ink" style={{ padding: 24, color: "#F0A6A6", fontSize: 14, fontWeight: 600 }}>Couldn&rsquo;t load the settlement.</div>
          ) : (
            <div className="ink" style={{ padding: 24, color: "#FFB0C0", fontSize: 14, fontWeight: 600 }}>Loading the settlement…</div>
          )}
        </div>

        {/* how it works */}
        <div style={{ marginTop: 36 }}>
          <div className="cd" style={{ fontSize: 15, color: "#FFB0C0", letterSpacing: ".4px", marginBottom: 16 }}>HOW SETTLEMENT WORKS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Step icon={<Brain size={18} weight="fill" color="#FFB0C0" />} title="TxLINE commits the score on-chain" body="Every score update is hashed into a Merkle tree whose root is posted to a Solana account by TxLINE's oracle, tamper-evident and public." />
            <Step icon={<LockSimple size={18} weight="fill" color="#FFB0C0" />} title="The proof unlocks the claim" body="Settlement runs a Merkle proof of the final score through TxLINE's oracle on-chain. No valid proof, no claim, and no human chooses the result." />
            <Step icon={<ShieldCheck size={18} weight="fill" color="#FFB0C0" />} title="Same check, anytime" body="The verdict is computed by TxLINE's program on Solana. The button above re-runs that exact check against a public RPC, the same one that settled the pool." />
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", background: "rgba(255,255,255,.03)", borderRadius: 14, padding: "16px 18px" }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255, 51, 85,.12)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{icon}</div>
      <div>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: "#fff" }}>{title}</div>
        <div style={{ fontSize: 13, color: "#B3A6AB", marginTop: 3, lineHeight: 1.45 }}>{body}</div>
      </div>
    </div>
  );
}
