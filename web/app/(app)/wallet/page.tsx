"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag } from "@/components/Flag";
import AddFundsModal from "@/components/flow/AddFundsModal";
import CashOutModal from "@/components/flow/CashOutModal";
import ClaimableWinnings from "@/components/flow/ClaimableWinnings";
import { ArrowDown, ArrowUp, LockSimple, Trophy, XCircle } from "@/components/icons";
import { type WalletEntry } from "@/lib/data";
import { useGameData } from "@/lib/useGameData";
import { useOpenPositions } from "@/lib/useOnchainPositions";
import { fetchUsdcBalance } from "@/lib/arena-onchain";
import { useSession } from "@/lib/session";
import { shortWallet } from "@/lib/format";

/* eslint-disable @next/next/no-img-element */

const tile: Record<WalletEntry["kind"], { bg: string; node: React.ReactNode }> = {
  stake: { bg: "#FFE7EC", node: <LockSimple size={18} weight="fill" color="#FF3355" /> },
  loss: { bg: "#FBE9EA", node: <XCircle size={18} weight="fill" color="#C2373B" /> },
  win: { bg: "#FFE7EC", node: <Trophy size={18} weight="fill" color="#FF3355" /> },
  deposit: { bg: "#E6EDFF", node: <ArrowDown size={18} weight="fill" color="#2F6BFF" /> },
};

const amtColor: Record<WalletEntry["amountTone"], string | undefined> = {
  neutral: undefined,
  bad: "#C2373B",
  good: "#FF3355",
  blue: "#2F6BFF",
};

export default function WalletPage() {
  const { session } = useSession();
  const g = useGameData();
  const [add, setAdd] = useState(false);
  const [out, setOut] = useState(false);
  const qc = useQueryClient();

  // The REAL money is on-chain USDC (what a bet spends), not the custodial
  // float — so the wallet reads the same on-chain balance as the arena/bet
  // screens, and its "staked" is the sum of the player's open on-chain bets.
  const balanceQ = useQuery({
    queryKey: ["usdc-balance", session.wallet],
    queryFn: () => fetchUsdcBalance(session.wallet),
    enabled: !!session.wallet,
    staleTime: 15_000,
  });
  const available = balanceQ.data ?? 0;
  const { open: openPositions } = useOpenPositions();
  const staked = openPositions.reduce((s, p) => s + Number(p.stake) / 1e6, 0);
  const total = available + staked;

  // Activity is a real ledger: open bets you've placed + settled wins/losses/
  // refunds. Settled entries (g.settledCalls) light up the win/loss tiles that
  // were previously dead scaffolding.
  const openActivity: WalletEntry[] = openPositions.map((p) => {
    const home = p.match?.fixture.home ?? "Home";
    const away = p.match?.fixture.away ?? "Away";
    const pick = p.bucket === 0 ? home : p.bucket === 2 ? away : "Draw";
    return {
      kind: "stake",
      title: `Backed · ${pick}`,
      sub: `${home} v ${away}`,
      amount: `−${(Number(p.stake) / 1e6).toFixed(1)}`,
      amountTone: "neutral",
    };
  });
  const settledActivity: WalletEntry[] = g.settledCalls.map((c) => {
    const won = c.outcome === "WON";
    const voided = c.outcome === "VOID";
    return {
      kind: voided ? "deposit" : won ? "win" : "loss",
      title: `${voided ? "Refunded" : won ? "Won" : "Lost"} · ${c.backed}`,
      sub: `${c.home.name} v ${c.away.name} · ${c.when}`,
      amount: c.pnl,
      amountTone: voided ? "blue" : won ? "good" : "bad",
    };
  });
  const activity = [...openActivity, ...settledActivity];

  return (
    <div className="midpad">
      <div className="cd" style={{ fontSize: 24 }}>Wallet</div>

      <div className="row" style={{ marginTop: 22 }}>
        {/* LEFT */}
        <div className="col-main">
          <div className="ink" style={{ padding: 26 }}>
            <div className="glow" style={{ right: -30, top: -30, width: 150, height: 150, background: "radial-gradient(circle,rgba(255,255,255,.2),transparent 70%)" }} />
            <div className="lbl" style={{ color: "#fff", position: "relative" }}>AVAILABLE BALANCE</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 8, position: "relative" }}>
              <span className="mono" style={{ fontWeight: 700, fontSize: 42 }}>{available.toFixed(1)}</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: "rgba(255,255,255,.85)" }}>USDC</span>
            </div>
            <div className="mono" style={{ fontSize: 12, color: "rgba(255,255,255,.7)", marginTop: 3, position: "relative" }}>
              {session.wallet ? shortWallet(session.wallet) : "your Solana wallet"}
            </div>
            {staked > 0 && (
              <div className="mono" style={{ fontSize: 11, color: "#B8C6BD", marginTop: 4, position: "relative" }}>
                {staked.toFixed(1)} USDC staked in open bets, locked in escrow, not spendable here
              </div>
            )}
            {session.bonus > 0 && (
              <div className="mono" style={{ fontSize: 11, color: "#FFB0C0", marginTop: 4, position: "relative" }}>
                incl. {session.bonus.toFixed(1)} starter bonus · play only, not withdrawable
              </div>
            )}
            <div style={{ display: "flex", gap: 12, marginTop: 22, position: "relative" }}>
              <button onClick={() => setAdd(true)} style={{ background: "#fff", color: "#1A1013", border: "none", fontWeight: 700, fontSize: 14, padding: "12px 24px", borderRadius: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
                <ArrowDown size={16} weight="bold" />
                Deposit
              </button>
              <button onClick={() => setOut(true)} style={{ background: "rgba(255,255,255,.1)", color: "#fff", border: "none", fontWeight: 700, fontSize: 14, padding: "12px 24px", borderRadius: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
                <ArrowUp size={16} weight="bold" />
                Withdraw
              </button>
            </div>
          </div>

          <ClaimableWinnings />

          <div className="card" style={{ marginTop: 18, padding: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px" }}>
              <div className="cd" style={{ fontSize: 16 }}>Activity</div>
            </div>
            <div style={{ height: 1, background: "#F5EEF1", margin: "0 18px" }} />
            {activity.length === 0 && (
              <div style={{ padding: "22px 18px", textAlign: "center", fontSize: 13, fontWeight: 600, color: "#988990" }}>
                No activity yet, place a bet and your stakes show up here.
              </div>
            )}
            {activity.map((e, i) => (
              <div key={`${e.title}-${i}`}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px" }}>
                  <div style={{ width: 38, height: 38, borderRadius: 11, background: tile[e.kind].bg, display: "flex", alignItems: "center", justifyContent: "center" }}>{tile[e.kind].node}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{e.title}</div>
                    <div style={{ fontSize: 12, color: "#988990", fontWeight: 600 }}>{e.sub}</div>
                  </div>
                  <span className="mono" style={{ fontWeight: 700, fontSize: 14, color: amtColor[e.amountTone] }}>{e.amount}</span>
                </div>
                {i < activity.length - 1 && <div style={{ height: 1, background: "#F5EEF1", margin: "0 18px" }} />}
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT */}
        <div className="col-side w320">
          <div style={{ display: "flex", gap: 14 }}>
            <div className="card" style={{ flex: 1, padding: 18 }}>
              <div className="lbl">TOTAL</div>
              <div className="mono" style={{ fontWeight: 700, fontSize: 20, marginTop: 5 }}>{total.toFixed(1)}</div>
            </div>
            <div className="card" style={{ flex: 1, padding: 18 }}>
              <div className="lbl">IN PLAY</div>
              <div className="mono" style={{ fontWeight: 700, fontSize: 20, color: "#FF3355", marginTop: 5 }}>{staked.toFixed(1)}</div>
            </div>
          </div>
          <div className="card" style={{ marginTop: 14, padding: 20 }}>
            <div className="cd" style={{ fontSize: 16, marginBottom: 14 }}>Open stakes</div>
            {openPositions.length > 0 ? (
              openPositions.map((p) => {
                const home = p.match?.fixture.home ?? "Home";
                const away = p.match?.fixture.away ?? "Away";
                const pick = p.bucket === 0 ? home : p.bucket === 2 ? away : "Draw";
                return (
                  <div key={p.matchId} style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <Flag name={home} size={30} style={{ boxShadow: "0 0 0 2px #fff" }} />
                      <Flag name={away} size={30} style={{ boxShadow: "0 0 0 2px #fff", marginLeft: -9 }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{pick}</div>
                      <div style={{ fontSize: 11, color: "#988990", fontWeight: 600 }}>{home} v {away}</div>
                    </div>
                    <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: "#FF3355" }}>{(Number(p.stake) / 1e6).toFixed(1)}</span>
                  </div>
                );
              })
            ) : (
              <div style={{ background: "#F9F3F5", borderRadius: 12, padding: 12, textAlign: "center", fontSize: 12, fontWeight: 600, color: "#988990" }}>No open stakes</div>
            )}
          </div>
        </div>
      </div>

      <AddFundsModal
        open={add}
        onClose={() => setAdd(false)}
        onchain
        onchainAddress={session.wallet}
        onchainBalance={available}
        onRecheck={async () => {
          await qc.invalidateQueries({ queryKey: ["usdc-balance", session.wallet] });
          await balanceQ.refetch();
        }}
      />
      <CashOutModal open={out} onClose={() => setOut(false)} />
    </div>
  );
}
