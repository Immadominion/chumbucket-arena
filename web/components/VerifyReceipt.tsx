"use client";

/**
 * The "verify this payout yourself" receipt — the trust centerpiece.
 *
 * The settle transaction already ran on-chain: TxLINE's oracle program proved
 * the final score against its own Merkle root before any payout became claimable.
 * This lets ANYONE re-check that, from their own browser, without trusting us:
 * it POSTs a prebuilt `simulateTransaction` call to a PUBLIC Solana RPC and
 * reads the on-chain program's boolean verdict. We never supply the answer —
 * the raw request is shown so a skeptic can curl it themselves.
 */

import { useState } from "react";
import { CheckCircle, ShieldCheck, ArrowUpRight, ArrowCounterClockwise, XCircle } from "@/components/icons";

export interface Receipt {
  label: string;
  home: string;
  away: string;
  finalScore: { home: number; away: number };
  predicateHuman: string;
  cluster: string;
  rpcUrl: string;
  txoracleProgram: string;
  dailyScoresMerkleRoots: string;
  settleTx: string;
  explorerSettleTx: string;
  explorerOracleProgram: string;
  explorerRootAccount: string;
  rpcRequest: unknown;
}

type State =
  | { k: "idle" }
  | { k: "checking" }
  | { k: "ok"; ms: number; returnData: string }
  | { k: "fail"; reason: string };

const GREEN = "#FF5A76";
const INK = "#1A1013";

export default function VerifyReceipt({ receipt }: { receipt: Receipt }) {
  const [state, setState] = useState<State>({ k: "idle" });
  const [showRaw, setShowRaw] = useState(false);

  async function verify() {
    setState({ k: "checking" });
    const started = performance.now();
    try {
      const resp = await fetch(receipt.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(receipt.rpcRequest),
      });
      const json = await resp.json();
      const val = json?.result?.value;
      const rd: string | undefined = val?.returnData?.data?.[0];
      const ms = Math.round(performance.now() - started);
      // 'AQ==' is base64 for a single 0x01 byte — the program's `true`.
      if (val?.err == null && rd === "AQ==") setState({ k: "ok", ms, returnData: rd });
      else setState({ k: "fail", reason: val?.err ? `oracle rejected: ${JSON.stringify(val.err)}` : "unexpected return data" });
    } catch (e) {
      setState({ k: "fail", reason: e instanceof Error ? e.message : "couldn't reach the RPC" });
    }
  }

  const verified = state.k === "ok";

  return (
    <div
      className="ink receipt-card"
      style={{ padding: 0, overflow: "hidden", border: verified ? `1.5px solid ${GREEN}` : "1.5px solid rgba(255,255,255,.06)", transition: "border-color .3s ease" }}
    >
      {/* header */}
      <div style={{ padding: "22px 24px 18px", position: "relative" }}>
        <div className="glow" style={{ right: -30, top: -40, width: 180, height: 180, background: `radial-gradient(circle,rgba(242,58,92,${verified ? ".28" : ".16"}),transparent 70%)`, transition: "opacity .3s" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
          <ShieldCheck size={17} weight="fill" color={GREEN} />
          <span className="cd" style={{ fontSize: 13, letterSpacing: ".5px", color: "#FFB0C0" }}>ON-CHAIN SETTLEMENT PROOF</span>
        </div>
        <div className="cd" style={{ fontSize: 22, color: "#fff", marginTop: 12, position: "relative" }}>
          {receipt.home} <span className="mono" style={{ color: "#FFB0C0" }}>{receipt.finalScore.home}–{receipt.finalScore.away}</span> {receipt.away}
        </div>
        <div style={{ fontSize: 12.5, color: "#B8C6BD", marginTop: 4, position: "relative" }}>
          {receipt.label} · settled by proving <span className="mono" style={{ color: "#F7EEF0" }}>{receipt.predicateHuman}</span> against TxLINE&rsquo;s on-chain Merkle root.
        </div>
      </div>

      {/* verify strip */}
      <div style={{ padding: "18px 24px", background: "rgba(0,0,0,.22)", borderTop: "1px solid rgba(255,255,255,.06)" }}>
        {state.k !== "ok" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <button
                onClick={() => void verify()}
                disabled={state.k === "checking"}
                className="btnp"
                style={{ fontSize: 14, padding: "12px 20px", borderRadius: 12, border: "none", cursor: "pointer", opacity: state.k === "checking" ? 0.7 : 1 }}
              >
                {state.k === "checking" ? (
                  <><Spinner /> Asking Solana…</>
                ) : (
                  <><ShieldCheck size={16} weight="fill" /> Re-run the on-chain check</>
                )}
              </button>
              <span style={{ fontSize: 12.5, color: "#93A69B", fontWeight: 500, maxWidth: 320, lineHeight: 1.4 }}>
                Runs a read-only check on a <b style={{ color: "#B8C6BD" }}>public Solana RPC</b> from your browser. We don&rsquo;t supply the answer.
              </span>
            </div>
            {state.k === "fail" && (
              <div role="alert" style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 12, fontSize: 12.5, fontWeight: 600, color: "#F0A6A6" }}>
                <XCircle size={15} weight="fill" /> {state.reason} — <button onClick={() => void verify()} style={{ background: "none", border: "none", color: "#FFB0C0", cursor: "pointer", padding: 0, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><ArrowCounterClockwise size={12} weight="bold" /> retry</button>
              </div>
            )}
          </>
        ) : (
          <div style={{ animation: "fadein .3s ease" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: GREEN, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", boxShadow: `0 0 0 6px rgba(242,58,92,.18)` }}>
                <CheckCircle size={24} weight="fill" color={INK} />
              </div>
              <div>
                <div className="cd" style={{ fontSize: 16, color: "#fff" }}>Confirmed by TxLINE&rsquo;s on-chain oracle</div>
                <div style={{ fontSize: 12, color: "#FFB0C0", fontWeight: 600, marginTop: 1 }}>
                  Your browser asked Solana directly · returned <span className="mono">true</span> in {state.ms}ms
                </div>
              </div>
              <button onClick={() => setState({ k: "idle" })} title="Run again" style={{ marginLeft: "auto", background: "rgba(255,255,255,.06)", border: "none", borderRadius: 9, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                <ArrowCounterClockwise size={15} weight="bold" color="#FFB0C0" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* on-chain links */}
      <div style={{ padding: "14px 24px", borderTop: "1px solid rgba(255,255,255,.06)", display: "flex", flexWrap: "wrap", gap: 8 }}>
        <ChainLink href={receipt.explorerSettleTx} label="Settle transaction" />
        <ChainLink href={receipt.explorerOracleProgram} label="TxLINE oracle program" />
        <ChainLink href={receipt.explorerRootAccount} label="Merkle-root account" />
      </div>

      {/* raw call, for the skeptic */}
      <div style={{ padding: "0 24px 18px" }}>
        <button onClick={() => setShowRaw((s) => !s)} style={{ background: "none", border: "none", color: "#7E8C84", cursor: "pointer", fontSize: 11.5, fontWeight: 700, letterSpacing: ".4px", padding: "6px 0", textTransform: "uppercase" }}>
          {showRaw ? "▾ Hide the raw call" : "▸ See the exact RPC call"}
        </button>
        {showRaw && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11.5, color: "#93A69B", marginBottom: 6, lineHeight: 1.45 }}>
              POST this to <span className="mono" style={{ color: "#B8C6BD" }}>{receipt.rpcUrl}</span> yourself — {receipt.cluster} is public. A <span className="mono">returnData</span> of <span className="mono" style={{ color: "#FFB0C0" }}>AQ==</span> is the program&rsquo;s <span className="mono">true</span>.
            </div>
            <pre className="mono" style={{ margin: 0, padding: 12, background: "rgba(0,0,0,.35)", borderRadius: 10, fontSize: 10.5, color: "#B8C6BD", overflowX: "auto", lineHeight: 1.4, maxHeight: 220 }}>
              {JSON.stringify(receipt.rpcRequest, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function ChainLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "#FFB0C0", background: "rgba(255,255,255,.05)", padding: "7px 12px", borderRadius: 9, textDecoration: "none" }}>
      {label} <ArrowUpRight size={13} weight="bold" />
    </a>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(6,32,15,.35)", borderTopColor: "#3a0510", display: "inline-block", animation: "spin .7s linear infinite" }}
    />
  );
}
