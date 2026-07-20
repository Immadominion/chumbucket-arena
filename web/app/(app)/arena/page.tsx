"use client";

/**
 * ChumBucket, the hub. Every live World Cup match is a bucket you can put money
 * on two ways: CHALLENGE a mate head-to-head, or BACK the crowd in the pooled
 * market. What makes it ChumBucket and not a bookie: nobody here decides who won.
 * When the match ends, settlement is a pure function of a TxLINE Merkle proof on
 * Solana, the creator can't rig it, and neither can we.
 */

import Link from "next/link";
import { Flag } from "@/components/Flag";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchUsdcBalance } from "@/lib/arena-onchain";
import AddFundsModal from "@/components/flow/AddFundsModal";
import Tour, { type TourStep } from "@/components/tour/Tour";
import ErrorState from "@/components/ErrorState";
import {
  ArrowRight,
  Wallet,
  ShieldCheck,
  LockSimple,
  Fire,
  Trophy,
  CaretRight,
} from "@/components/icons";
import { useGameData } from "@/lib/useGameData";
import { useSession } from "@/lib/session";

/* eslint-disable @next/next/no-img-element */

// ChumBucket brand, coral, distinct from the semantic win/loss greens & reds.
const CORAL = "#FF3355";
const CORAL_BRIGHT = "#FF5A76";
const INK = "#1A1013";
const INK2 = "#26161B";
const BLUSH_SOFT = "#FFE7EC";
const GRAY = "#988990";
const SOFT = "#8C7D82";

// First-run spotlight tour, points at real elements on this page.
const TOUR_KEY = "cb_tour_v1";
const TOUR_STEPS: TourStep[] = [
  { sel: '[data-tour="balance"]', title: "Your balance", body: "Tap the + to grab free test USDC. That's what you bet with, no real money on the practice network." },
  { sel: '[data-tour="matches"]', title: "Back a match", body: "Pick any fixture and choose an outcome, who wins, over/under goals, or a winning margin, then put something on it." },
  { sel: '[data-tour="mybets"]', title: "Track your bets", body: "Every bet you place shows up here and settles the moment the match ends, decided by the real score and proven on-chain." },
];

export default function ArenaPage() {
  const { session } = useSession();
  const g = useGameData();
  const [funds, setFunds] = useState(false);
  const [tour, setTour] = useState(false);

  const featured = g.featured;
  const matchday = g.matchday;
  const openCalls = g.openCalls;
  const handle = session.handle || "there";
  // Show the ON-CHAIN wallet balance, the exact USDC a bet spends, not the
  // custodial float. Funding the float never moved this number, so a judge who
  // topped up the old way saw a balance they couldn't bet with (the dead loop).
  const qc = useQueryClient();
  const balanceQ = useQuery({
    queryKey: ["usdc-balance", session.wallet],
    queryFn: () => fetchUsdcBalance(session.wallet),
    enabled: !!session.wallet,
    staleTime: 15_000,
  });
  const balance = balanceQ.data ?? 0;

  // Run the spotlight tour once, on the first visit that actually has matches to
  // point at (so the targets exist). A localStorage flag keeps it one-and-done.
  useEffect(() => {
    if (!featured) return;
    try {
      if (localStorage.getItem(TOUR_KEY)) return;
    } catch {
      return;
    }
    const t = setTimeout(() => setTour(true), 500);
    return () => clearTimeout(t);
  }, [featured]);
  const finishTour = () => {
    setTour(false);
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch {
      /* private mode, tour just won't persist */
    }
  };

  if (!featured && g.isError) {
    return <ErrorState onRetry={g.refetch} title="Couldn't load ChumBucket" />;
  }
  if (!featured) {
    return (
      <div className="midpad" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh", color: GRAY, fontWeight: 600, fontSize: 14 }}>
        {g.loading ? "Loading live matches…" : "No matches are open right now, check back at kick-off."}
      </div>
    );
  }

  return (
    <div className="midpad">
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: GRAY }}>Hey {handle},</div>
          <div className="cd" style={{ fontSize: 24, lineHeight: 1.05, color: INK }}>
            Who&rsquo;s losing money to you today?
          </div>
        </div>
        <button
          data-tour="balance"
          onClick={() => setFunds(true)}
          style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", borderRadius: 30, padding: "9px 15px", boxShadow: "0 2px 8px rgba(40,16,24,.06)", border: "none", cursor: "pointer" }}
        >
          <Wallet size={17} weight="fill" color={CORAL} />
          <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: INK }}>{balance.toFixed(1)} USDC</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: CORAL, marginLeft: 2 }}>+</span>
        </button>
      </div>

      <div className="row row-26" style={{ marginTop: 22 }}>
        {/* MAIN */}
        <div className="col-main">
          {/* HERO, featured match, two ways to play */}
          <div data-tour="matches" style={{ background: "linear-gradient(140deg, #FF3355 0%, #D81E4A 55%, #B81540 100%)", borderRadius: 26, padding: "30px 32px", position: "relative", overflow: "hidden" }}>
            <div className="glow" style={{ right: -40, top: -60, width: 260, height: 260, background: "radial-gradient(circle, rgba(255,255,255,.2), transparent 70%)" }} />
            <div style={{ position: "relative" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#fff", color: CORAL, fontSize: 12, fontWeight: 700, padding: "5px 12px", borderRadius: 20 }}>
                <Fire size={13} weight="fill" /> Featured
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.08)", color: "#D9C3C9", fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 20, marginLeft: 8 }}>
                {featured.group} · {featured.koTag}
              </span>

              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
                <Flag code={featured.home.code} name={featured.home.name} size={44} style={{ boxShadow: "0 0 0 2px rgba(255,255,255,.2)" }} />
                <Flag code={featured.away.code} name={featured.away.name} size={44} style={{ boxShadow: "0 0 0 2px rgba(255,255,255,.2)", marginLeft: -14 }} />
              </div>
              <h1 className="cd" style={{ fontSize: 38, lineHeight: 1.03, color: "#fff", margin: "14px 0 0", letterSpacing: "-.5px" }}>
                {featured.home.name} <span style={{ color: "rgba(255,255,255,.6)", fontWeight: 600 }}>vs</span> {featured.away.name}
              </h1>
              <p style={{ fontSize: 14.5, lineHeight: 1.45, color: "rgba(255,255,255,.9)", margin: "10px 0 0", maxWidth: 440 }}>
                Put your money where your mouth is. The <b style={{ color: "#fff" }}>match</b> ends, TxLINE proves the result, and winners can claim from the pool.
              </p>

              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
                <Link href={`/challenge/${featured.matchId}`} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 700, background: "#fff", color: CORAL, fontSize: 15, padding: "13px 24px", borderRadius: 13, textDecoration: "none" }}>
                  <Fire size={16} weight="fill" /> Challenge a mate
                </Link>
                <Link href={`/bet/${featured.matchId}`} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, color: "#fff", background: "rgba(255,255,255,.1)", padding: "13px 22px", borderRadius: 13, textDecoration: "none" }}>
                  Back the crowd <ArrowRight size={16} weight="bold" />
                </Link>
                <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.14)", borderRadius: 30, padding: "10px 15px" }}>
                  <Trophy size={15} weight="fill" color="#F2B705" />
                  <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: "#fff" }}>{featured.pot.toLocaleString()} USDC in the pool</span>
                </div>
              </div>
            </div>
          </div>

          {/* TRUST STRIP, the whole pitch, in three beats */}
          <div className="grid3" style={{ gap: 12, marginTop: 16 }}>
            {[
              { icon: <Fire size={16} weight="fill" color={CORAL} />, t: "1. Pick your side", s: "Challenge a mate 1-v-1, or back an outcome in the pool." },
              { icon: <LockSimple size={16} weight="fill" color={CORAL} />, t: "2. Funds go on-chain", s: "Both bets lock in a Solana escrow. Nobody can touch them." },
              { icon: <ShieldCheck size={16} weight="fill" color={CORAL} />, t: "3. TxLINE proves it", s: "The final score is validated on-chain before a winning position becomes claimable." },
            ].map((c) => (
              <div key={c.t} className="card" style={{ padding: "15px 16px" }}>
                <div style={{ width: 32, height: 32, borderRadius: 10, background: BLUSH_SOFT, display: "flex", alignItems: "center", justifyContent: "center" }}>{c.icon}</div>
                <div className="cd" style={{ fontSize: 14, marginTop: 10, color: INK }}>{c.t}</div>
                <div style={{ fontSize: 12.5, color: SOFT, fontWeight: 500, marginTop: 3, lineHeight: 1.4 }}>{c.s}</div>
              </div>
            ))}
          </div>

          {/* LIVE MATCHES */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "26px 0 14px" }}>
            <div className="cd" style={{ fontSize: 20, color: INK }}>Today&rsquo;s matches</div>
            <Link href="/matchday" style={{ fontSize: 13, fontWeight: 700, color: CORAL, textDecoration: "none" }}>See all</Link>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {matchday.map((m) => (
              <div key={m.matchId} className="card" style={{ padding: "16px 18px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <Flag code={m.home.code} name={m.home.name} size={40} style={{ boxShadow: "0 0 0 2px #fff" }} />
                  <Flag code={m.away.code} name={m.away.name} size={40} style={{ boxShadow: "0 0 0 2px #fff", marginLeft: -12 }} />
                </div>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div className="cd" style={{ fontWeight: 600, fontSize: 15.5, color: INK }}>{m.home.name} v {m.away.name}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: GRAY, marginTop: 2 }}>
                    {m.koTag} · <span className="mono">{m.pot.toLocaleString()} USDC</span> in the pool
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Link href={`/challenge/${m.matchId}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#fff", background: CORAL, padding: "9px 15px", borderRadius: 11, textDecoration: "none" }}>
                    <Fire size={13} weight="fill" /> Challenge
                  </Link>
                  <Link href={`/bet/${m.matchId}`} style={{ fontSize: 12.5, fontWeight: 700, color: CORAL, background: BLUSH_SOFT, padding: "9px 15px", borderRadius: 11, textDecoration: "none" }}>
                    Back it
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT */}
        <div className="col-side w320" data-tour="mybets">
          {/* your open stakes */}
          <div className="cd" style={{ fontSize: 20, color: INK, marginBottom: 14 }}>Your bets</div>
          {openCalls.length === 0 ? (
            <div className="card" style={{ padding: "20px 18px", textAlign: "center" }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: SOFT, lineHeight: 1.45 }}>
                No live bets yet. Pick a match and challenge someone.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {openCalls.map((oc) => (
                <div key={oc.matchId} className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <Flag code={oc.home.code} name={oc.home.name} size={34} style={{ boxShadow: "0 0 0 2px #fff" }} />
                    <Flag code={oc.away.code} name={oc.away.name} size={34} style={{ boxShadow: "0 0 0 2px #fff", marginLeft: -10 }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: INK }}>{oc.pick}</div>
                    <div style={{ fontSize: 11.5, color: GRAY, fontWeight: 600, marginTop: 1 }}>
                      <span className="mono">{oc.staked.toFixed(1)}</span> backed · locks {oc.lock}
                    </div>
                  </div>
                  <LockSimple size={14} weight="fill" color={CORAL} />
                </div>
              ))}
            </div>
          )}

          {/* how settlement works, the differentiator, always visible */}
          <Link href="/proof" className="ink" style={{ display: "block", padding: 22, textDecoration: "none", marginTop: 20 }}>
            <div className="glow" style={{ right: -30, top: -30, width: 140, height: 140, background: "radial-gradient(circle,rgba(255,255,255,.2),transparent 70%)" }} />
            <div style={{ position: "relative" }}>
              <ShieldCheck size={22} weight="fill" color="#fff" />
              <div className="cd" style={{ fontSize: 17, color: "#fff", marginTop: 10 }}>No more arguing who won.</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,.9)", fontWeight: 500, marginTop: 6, lineHeight: 1.5 }}>
                Old ChumBucket made someone pick the winner. Now the match does: TxLINE proves the result on Solana, then the winner claims from the pool.
              </div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#fff", marginTop: 12 }}>
                See how it settles <CaretRight size={13} weight="bold" />
              </div>
            </div>
          </Link>
        </div>
      </div>

      <AddFundsModal
        open={funds}
        onClose={() => setFunds(false)}
        onchain
        onchainAddress={session.wallet}
        onchainBalance={balance}
        onRecheck={async () => {
          await qc.invalidateQueries({ queryKey: ["usdc-balance", session.wallet] });
          await balanceQ.refetch();
        }}
      />

      {tour && <Tour steps={TOUR_STEPS} onDone={finishTour} />}
    </div>
  );
}
