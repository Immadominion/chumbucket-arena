"use client";

import Link from "next/link";
import { ArrowRight, ShieldCheck } from "@/components/icons";
import ErrorState from "@/components/ErrorState";
import ClaimableWinnings from "@/components/flow/ClaimableWinnings";
import { flag, type SettledCall } from "@/lib/data";
import { useGameData } from "@/lib/useGameData";

/* eslint-disable @next/next/no-img-element */

const tone: Record<SettledCall["outcome"], { fg: string; bg: string }> = {
  WON: { fg: "#B81540", bg: "#FFE7EC" },
  LOST: { fg: "#C2373B", bg: "#FBE9EA" },
  VOID: { fg: "#6A5A60", bg: "#F5EEF1" },
};

export default function ResultsPage() {
  const g = useGameData();
  const results = g.settledCalls;

  if (g.isError && results.length === 0) {
    return <ErrorState onRetry={g.refetch} title="Couldn't load your results" />;
  }

  return (
    <div className="midpad">
      <div style={{ display: "flex", alignItems: "center" }}>
        <div>
          <div className="cd" style={{ fontSize: 24 }}>Your bets</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#988990", marginTop: 2 }}>Every settled bet, on the record</div>
        </div>
        <Link href="/matchday" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, color: "#F2385A", textDecoration: "none" }}>Find a match</Link>
      </div>

      <ClaimableWinnings />

      {results.length === 0 ? (
        <div className="card" style={{ marginTop: 22, padding: "40px 24px", textAlign: "center" }}>
          <div className="cd" style={{ fontSize: 18 }}>{g.loading ? "Loading your bets…" : "Nothing settled yet"}</div>
          {!g.loading && (
            <>
              <p style={{ fontSize: 14, color: "#7C6D72", margin: "10px 0 18px" }}>
                Place a bet and the match settles it the moment the final whistle blows — win or lose, it goes on your record.
              </p>
              <Link href="/matchday" className="btnp" style={{ padding: "12px 22px", borderRadius: 13, textDecoration: "none" }}>
                Find a match <ArrowRight size={15} weight="bold" />
              </Link>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 22 }}>
          {results.map((r) => {
            const t = tone[r.outcome];
            return (
              <div key={r.id} className="card" style={{ padding: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <img src={flag(r.home.code)} style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff" }} alt="" />
                    <img src={flag(r.away.code)} style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff", marginLeft: -12 }} alt="" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="cd" style={{ fontSize: 16 }}>
                      {r.home.name} <span className="mono" style={{ color: "#6A5A60", fontWeight: 700 }}>{r.score[0]}–{r.score[1]}</span> {r.away.name}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#988990", marginTop: 2 }}>You backed {r.backed} · {r.when}</div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: t.fg, background: t.bg, padding: "6px 12px", borderRadius: 20 }}>{r.outcome}</span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 22, marginTop: 14, paddingTop: 14, borderTop: "1px solid #F5EEF1" }}>
                  <Stat label="P&L" value={r.pnl} tone={r.outcome === "WON" ? "#F2385A" : r.outcome === "LOST" ? "#C2373B" : "#221217"} />
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", fontSize: 12, fontWeight: 600, color: "#988990" }}>
                    <ShieldCheck size={14} weight="fill" color="#F2385A" /> Settled on-chain
                  </div>
                </div>

                {r.outcome !== "VOID" && (
                  <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                    <Link href="/matchday" className="btnp" style={{ fontSize: 13.5, padding: "10px 18px", borderRadius: 12, textDecoration: "none" }}>
                      Bet again <ArrowRight size={14} weight="bold" />
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <div className="lbl">{label}</div>
      <div className="mono" style={{ fontWeight: 700, fontSize: 16, color: tone, marginTop: 3 }}>{value}</div>
    </div>
  );
}
