"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { useSignAndSendTransaction, useSignMessage, useWallets } from "@privy-io/react-auth/solana";
import AddFundsModal from "@/components/flow/AddFundsModal";
import { LiveScoreStrip } from "@/components/LiveScoreStrip";
import { ArrowLeft, ArrowUpRight, CheckCircle, Clock, LockSimple, ShieldCheck, WarningCircle } from "@/components/icons";
import { flag } from "@/lib/data";
import { toFixture, toCallMarkets, type CallMarket } from "@/lib/adapters";
import { useGameData } from "@/lib/useGameData";
import { signCallProof } from "@/lib/walletSign";
import { useTRPC } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { placeCall, fetchUsdcBalance } from "@/lib/arena-onchain";
import { explorerTxUrl } from "@/lib/solana";

/* eslint-disable @next/next/no-img-element */

const RAKE_BPS = 250; // 2.5%, taken from the losers' pool only (must match backend)

/**
 * Map a raw place-bet exception to one plain sentence a newcomer understands.
 * The real error only ever goes to the console, never to the screen.
 */
function betErrorMessage(e: unknown): string {
  console.error("[chumbucket] place bet failed:", e);
  const raw = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (/reject|declin|cancel|denied|user did not|dismiss/.test(raw))
    return "You cancelled in your wallet, nothing was taken.";
  if (/insufficient|not enough|debit an account|exceeds balance/.test(raw))
    return "Not enough USDC to cover this bet.";
  if (/lock|closed|kicked off|not open|already started/.test(raw))
    return "This match already kicked off, bets are closed.";
  if (/blockhash|network|fetch|timeout|timed out|connection|rpc|econn|failed to send/.test(raw))
    return "Couldn't reach the network, please try again.";
  return "Something went wrong placing your bet, please try again.";
}

export default function MakeCallPage() {
  const params = useParams<{ matchId: string }>();
  const { session } = useSession();
  const g = useGameData();
  const trpc = useTRPC();
  const qc = useQueryClient();

  // The money side is real, non-custodial on-chain USDC now (chumbucket_arena's
  // place_call), same Privy wallet + signing pattern as the Send screen
  // (lib/solana.ts / app/(app)/send/page.tsx). No more off-chain ledger mutation.
  const { wallets, ready: walletsReady } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { signMessage } = useSignMessage();
  // Optimistic social mirror: after the on-chain bet lands, record it so it shows
  // instantly in "Your bets" and the feed (mobile does the same). Best-effort —
  // the indexer reconciles by tx signature regardless (see lock()).
  const recordCallM = useMutation(trpc.recordPredictionCall.mutationOptions());
  const myWallet = useMemo(
    () => wallets.find((w) => w.address === session.wallet) ?? wallets[0],
    [wallets, session.wallet],
  );
  const placeCallM = useMutation({
    // MONEY ROUTING: potMatchId is the on-chain match_id of the SELECTED market's
    // pot (Result == fixture matchId; line markets e.g. "…#OU25"), and bucketIndex
    // is that market's on-chain slot. Both come from the selected market below —
    // never the fixture matchId for a line market.
    mutationFn: async (opts: { potMatchId: string; bucketIndex: number; amountUsdc: number }) => {
      if (!myWallet) throw new Error("Wallet isn't ready yet, try again in a moment.");
      return placeCall({
        potMatchId: opts.potMatchId,
        bucketIndex: opts.bucketIndex,
        amountUsdc: opts.amountUsdc,
        wallet: myWallet,
        signAndSendTransaction,
      });
    },
  });

  // Live match state, subscribe so pool, odds and status update in real time.
  // Fall back to the cached list on first paint. matchById is unfiltered, so a
  // match that has already kicked off still resolves (instead of vanishing to a
  // placeholder), which is what lets us show a proper "bets closed" state.
  // NOTE: this stays the off-chain read-model (fine for LISTING/DISPLAY, real
  // TxLINE-backed fixtures), it does not reflect on-chain stake totals from
  // placeCall below, since that path never emits the custodial engine's events.
  const matchSub = useSubscription(trpc.onMatch.subscriptionOptions({ matchId: params.matchId }));
  const match = matchSub.data ?? g.matchById(params.matchId);
  const isOpen = match?.status === "OPEN";

  // Real on-chain USDC balance, what the player can actually bet, straight
  // from their own wallet (not the custodial off-chain ledger's balance).
  const balanceQ = useQuery({
    queryKey: ["usdc-balance", session.wallet],
    queryFn: () => fetchUsdcBalance(session.wallet),
    enabled: !!session.wallet,
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
  const balance = balanceQ.data ?? 0;
  const balanceLoading = balanceQ.isLoading && !!session.wallet;

  // Every backable market on this fixture (Result 1X2, Over/Under, Handicap).
  // Result is always first, the default tab.
  const markets = useMemo<CallMarket[]>(() => (match ? toCallMarkets(match) : []), [match]);
  const [marketIdx, setMarketIdx] = useState(0);
  const [pick, setPick] = useState<string>("HOME");

  const selectedMarket = markets[marketIdx] ?? markets[0];
  const marketBuckets = selectedMarket?.buckets ?? [];
  const sel = marketBuckets.find((b) => b.bucket === pick) ?? marketBuckets[0];

  const [stake, setStake] = useState(() => Math.min(2, Math.max(0, balance)) || 1);
  const [funds, setFunds] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  // ── Real parimutuel projection from the LIVE pool (the SELECTED market's) ────
  // If your outcome wins, you get your bet back plus a share of the money bet on
  // the OTHER outcomes (the losers' pool), split by how much you put in, less the
  // fee. Empty pool ⇒ nothing to win yet.
  const totalPool = marketBuckets.reduce((s, b) => s + b.pool, 0);
  const myBucketPool = sel?.pool ?? 0;
  const losersPool = Math.max(0, totalPool - myBucketPool); // your potential winnings come from here
  const newWinnersStake = myBucketPool + stake;
  const distributable = losersPool * (1 - RAKE_BPS / 10000);
  const profit = newWinnersStake > 0 ? (stake / newWinnersStake) * distributable : 0;
  const returnMult = stake > 0 ? (stake + profit) / stake : 1;

  const max = Math.max(balance, 0);
  // M4: an empty amount and "not enough money" are DIFFERENT states, never
  // collapse them into one button that shoves a funded user at Add funds.
  const amountEmpty = stake <= 0;
  const notEnough = !amountEmpty && stake > balance;

  const subject = sel?.subject ?? match?.fixture.home ?? "this outcome";
  const pct = sel?.pct ?? 0;
  const read =
    totalPool === 0
      ? `Nobody's in yet, back ${subject} and you're the first in this pool.`
      : pct > 45
        ? `The crowd's ${pct}% on ${subject}, a safe pick with a thinner payout.`
        : `Only ${pct}% are on ${subject}, you'd be going against the crowd. If it lands, you take a big share of the pool.`;

  const switchMarket = (i: number) => {
    setMarketIdx(i);
    setPick(markets[i]?.buckets[0]?.bucket ?? "HOME");
    setError(null);
  };

  const lock = async () => {
    if (!isOpen) {
      setError("This match already kicked off, bets are closed.");
      return;
    }
    if (!selectedMarket || !sel) {
      setError("Still loading this match, try again in a moment.");
      return;
    }
    if (amountEmpty) return; // button is disabled in this state; never open the modal
    if (notEnough) {
      setFunds(true);
      return;
    }
    if (!myWallet) {
      setError("Wallet isn't ready yet, try again in a moment.");
      return;
    }
    // The on-chain pot for THIS market: Result falls back to the fixture matchId
    // (they're byte-identical), but a line market MUST use its own potMatchId or
    // the money would land in the wrong pot.
    const potMatchId =
      selectedMarket.kind === "RESULT" ? selectedMarket.potMatchId ?? params.matchId : selectedMarket.potMatchId;
    if (!potMatchId) {
      setError("This bet type isn't available yet, try the Match result bet.");
      return;
    }
    setError(null);
    try {
      const { signature } = await placeCallM.mutateAsync({
        potMatchId,
        bucketIndex: sel.index,
        amountUsdc: stake,
      });
      setTxSignature(signature);
      // Scoped: just the on-chain USDC balance this screen itself reads, the
      // match pool totals below are the off-chain read-model and never move
      // from an on-chain placeCall (see the note above), so there's nothing
      // else here worth invalidating.
      await qc.invalidateQueries({ queryKey: ["usdc-balance", session.wallet] });
      setDone(true);
      // Best-effort optimistic mirror so this bet appears immediately in "Your
      // bets" / the feed (mobile does the same via signAndRecordCallProof). A
      // second lightweight signature, NOT another money tx. Any failure or a
      // user-cancelled signature is harmless, the indexer reconciles by tx
      // signature, so it must never surface as a failed bet. Scoped to Result
      // markets, whose HOME/DRAW/AWAY buckets match the recordPredictionCall
      // contract; line-market (Over/Under, Handicap) bets appear via the
      // on-chain reconciler instead.
      if (myWallet && selectedMarket.kind === "RESULT") {
        const bucket = sel.bucket as "HOME" | "DRAW" | "AWAY";
        const stakeBaseUnits = String(Math.round(stake * 1_000_000));
        void (async () => {
          try {
            const proof = await signCallProof({
              matchId: params.matchId,
              bucket,
              stakeBaseUnits,
              txSignature: signature,
              wallet: myWallet,
              signMessage,
            });
            await recordCallM.mutateAsync({
              wallet: myWallet.address,
              matchId: params.matchId,
              marketId: selectedMarket.marketId,
              bucket,
              stakeBaseUnits,
              txSignature: signature,
              timestamp: proof.timestamp,
              signature: proof.signature,
              metadata: { home: fx?.home.name, away: fx?.away.name },
            });
            // Refresh the player summary so this bet shows in arena "Your bets".
            await qc.invalidateQueries({ queryKey: trpc.me.queryKey() });
          } catch {
            /* non-fatal: the reconciler still records this bet from the chain */
          }
        })();
      }
      // M3: no 1.4s bounce to /arena, the player stays on a confirmation they
      // can actually read (and reach the Explorer link + their bets from).
    } catch (e) {
      setError(betErrorMessage(e));
    }
  };

  const fx = match ? toFixture(match) : null;

  // ── H4: honest loading / not-found states, before any interactive form ──────
  // The public list has resolved but this match isn't in it (or the fetch
  // errored), don't sit on a fake "…" fixture forever.
  if (!match && !g.loading) {
    return (
      <div className="midpad">
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/arena" className="back"><ArrowLeft size={17} weight="bold" /></Link>
          <div className="cd" style={{ fontSize: 24 }}>Match unavailable</div>
        </div>
        <div className="card" style={{ marginTop: 24, padding: "40px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "#FBE9EA", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <WarningCircle size={30} weight="fill" color="#C2373B" />
          </div>
          <div>
            <div className="cd" style={{ fontSize: 20, color: "#221217" }}>We couldn&rsquo;t load this match</div>
            <p style={{ fontSize: 13.5, fontWeight: 500, color: "#988990", margin: "6px auto 0", maxWidth: 340, lineHeight: 1.45 }}>
              It may have finished or the link is out of date.
            </p>
          </div>
          <Link href="/arena" className="btnp" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, padding: "11px 20px", borderRadius: 12, textDecoration: "none", marginTop: 2 }}>
            <ArrowLeft size={15} weight="bold" /> Back to matches
          </Link>
        </div>
      </div>
    );
  }

  // Still fetching, skeleton tiles, no fake fixture and no live controls.
  if (!match || !fx) {
    return (
      <div className="midpad">
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/arena" className="back"><ArrowLeft size={17} weight="bold" /></Link>
          <div className="cd" style={{ fontSize: 24 }}>Back an outcome</div>
        </div>
        <div className="row" style={{ marginTop: 24 }}>
          <div className="col-main">
            <div className="card" style={{ padding: 28, display: "flex", alignItems: "center", justifyContent: "center", gap: 46 }}>
              {[0, 1].map((i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#F1E8EC" }} />
                  <div style={{ width: 72, height: 14, borderRadius: 7, background: "#F1E8EC" }} />
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginTop: 24 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ height: 78, borderRadius: 16, background: "#F5EEF1" }} />
              ))}
            </div>
          </div>
          <div className="col-side w360">
            <div className="card" style={{ padding: 24 }}>
              <div style={{ height: 44, borderRadius: 10, background: "#F5EEF1" }} />
              <div style={{ height: 48, borderRadius: 14, background: "#F1E8EC", marginTop: 20 }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const btnLabel = done
    ? "Bet placed ✓"
    : placeCallM.isPending
      ? "Placing your bet…"
      : !isOpen
        ? "Closed · kicked off"
        : !walletsReady
          ? "Connecting wallet…"
          : balanceLoading
            ? "Balance …"
            : amountEmpty
              ? "Enter an amount"
              : notEnough
                ? "Add funds to back"
                : `Back it · ${stake} USDC`;
  // amountEmpty & balanceLoading are DISABLED (no modal); notEnough is clickable
  // (opens Add funds). Everything else disables while a bet is mid-flight/closed.
  const btnDisabled =
    placeCallM.isPending || done || !isOpen || !walletsReady || balanceLoading || amountEmpty;

  const chips = [1, 2, 5].filter((c) => c <= Math.max(max, 1));

  return (
    <div className="midpad">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link href="/arena" className="back"><ArrowLeft size={17} weight="bold" /></Link>
        <div className="cd" style={{ fontSize: 24 }}>Back an outcome</div>
        <span className="mono" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "#988990" }}>IN THIS POOL {totalPool.toLocaleString(undefined, { maximumFractionDigits: 1 })} USDC</span>
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        {/* LEFT */}
        <div className="col-main">
          <div className="card" style={{ padding: 28, textAlign: "center" }}>
            {fx.ko && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#C57A12", background: "#FBF0DC", padding: "5px 13px", borderRadius: 20 }}>
                <Clock size={13} weight="fill" />
                Kick-off {fx.ko}{fx.group ? ` · ${fx.group}` : ""}
              </span>
            )}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 46, marginTop: 22 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                <img src={flag(fx.home.code, 160)} style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff,0 4px 12px rgba(40,16,24,.14)" }} alt="" />
                <span className="cd" style={{ fontSize: 18 }}>{fx.home.name}</span>
              </div>
              <span className="cd" style={{ fontSize: 20, color: "#CBBFC3" }}>VS</span>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                <img src={flag(fx.away.code, 160)} style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff,0 4px 12px rgba(40,16,24,.14)" }} alt="" />
                <span className="cd" style={{ fontSize: 18 }}>{fx.away.name}</span>
              </div>
            </div>
            <LiveScoreStrip matchId={params.matchId} />
          </div>

          {/* Bet-type switcher, only when this fixture has more than the Result market. */}
          {markets.length > 1 && (
            <>
              <div className="lbl" style={{ margin: "24px 0 12px" }}>WHAT TO PREDICT</div>
              <div style={{ overflowX: "auto", maxWidth: "100%", WebkitOverflowScrolling: "touch" }}>
                <div style={{ display: "inline-flex", gap: 4, background: "#F5EEF1", borderRadius: 13, padding: 4, width: "max-content" }}>
                  {markets.map((mk, i) => {
                    const on = i === marketIdx;
                    return (
                      <button
                        key={mk.marketId}
                        onClick={() => switchMarket(i)}
                        className="mono"
                        style={{
                          border: "none",
                          cursor: "pointer",
                          borderRadius: 10,
                          padding: "9px 18px",
                          fontSize: 13,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                          background: on ? "#fff" : "transparent",
                          color: on ? "#221217" : "#988990",
                          boxShadow: on ? "0 1px 3px rgba(40,16,24,.14)" : "none",
                        }}
                      >
                        {mk.tab}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          <div className="lbl" style={{ margin: "24px 0 12px" }}>YOUR PICK</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(marketBuckets.length, 1)}, 1fr)`, gap: 14 }}>
            {marketBuckets.map((b) => {
              const on = b.bucket === (sel?.bucket ?? pick);
              return (
                <button
                  key={b.bucket}
                  onClick={() => setPick(b.bucket)}
                  className={on ? "btnp" : undefined}
                  style={
                    on
                      ? { flexDirection: "column", borderRadius: 16, padding: "18px 6px", gap: 4 }
                      : { background: "#fff", border: "1.5px solid #EFE6E9", borderRadius: 16, padding: "18px 6px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }
                  }
                >
                  <span style={{ fontSize: 13, fontWeight: 700, color: on ? "#fff" : "#221217" }}>{b.tile}</span>
                  <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: on ? "#fff" : "#6A5A60" }}>{totalPool > 0 ? `${b.pct}%` : "—"}</span>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11.5, color: "#B3A6AB", fontWeight: 500, marginTop: 8 }}>
            {totalPool > 0 ? "% = the share of the pool backing each outcome (how the crowd is leaning)." : "No bets yet, back an outcome and you're the first in this pool."}
          </div>

          <div className="ink" style={{ marginTop: 18, padding: "16px 18px" }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: "#F7EEF0", lineHeight: 1.42 }}>{read}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.08)" }}>
              <ShieldCheck size={15} weight="fill" color="#FF5A76" />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#FFB0C0" }}>The real match result is checked automatically before anyone gets paid, no one can fake it.</span>
            </div>
          </div>
        </div>

        {/* RIGHT, YOUR BET */}
        <div className="col-side w360">
          <div className="card" style={{ padding: 24 }}>
            {done ? (
              /* M3: dismissible post-bet confirmation, no bounce, real summary. */
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#FF3355", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                    <CheckCircle size={24} weight="fill" color="#fff" />
                  </div>
                  <div className="cd" style={{ fontSize: 18, color: "#221217" }}>Bet placed</div>
                </div>
                <p style={{ fontSize: 13.5, fontWeight: 500, color: "#4A3B40", lineHeight: 1.5, marginTop: 14 }}>
                  You backed <b>{subject}</b> with <b>{stake} USDC</b>
                  {profit > 0 ? <> · if it lands you win <b>~{(stake + profit).toFixed(1)} USDC</b></> : null}. We&rsquo;ll check the
                  result after the match and pay winners.
                </p>
                <p style={{ fontSize: 11.5, color: "#B3A6AB", fontWeight: 500, marginTop: 8 }}>
                  Your bet is in, the pool figures on this page update shortly.
                </p>
                {txSignature && (
                  <a
                    href={explorerTxUrl(txSignature)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, fontSize: 12, color: "#0A7E40", fontWeight: 700, textAlign: "center", marginTop: 14 }}
                  >
                    View on Solana Explorer <ArrowUpRight size={12} weight="bold" />
                  </a>
                )}
                <Link href="/results" className="btnp" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", fontSize: 14.5, padding: 14, borderRadius: 14, textDecoration: "none", marginTop: 16 }}>
                  See your bets <ArrowUpRight size={15} weight="bold" />
                </Link>
                <button
                  onClick={() => { setDone(false); setTxSignature(null); }}
                  style={{ width: "100%", background: "transparent", border: "none", color: "#988990", fontSize: 12.5, fontWeight: 700, cursor: "pointer", marginTop: 12 }}
                >
                  Place another bet
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className="lbl">YOUR BET</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#988990" }}>
                    {balanceLoading ? "Balance …" : `Balance ${balance.toFixed(1)} USDC`}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8, margin: "18px 0" }}>
                  <input
                    type="number"
                    value={stake}
                    min={0}
                    step={0.5}
                    onChange={(e) => setStake(Math.max(0, Number(e.target.value)))}
                    className="mono"
                    style={{ width: 120, textAlign: "right", border: "none", background: "transparent", fontSize: 44, fontWeight: 700, color: "#221217" }}
                  />
                  <span style={{ fontSize: 16, fontWeight: 700, color: "#988990" }}>USDC</span>
                </div>
                <div style={{ fontSize: 11, color: "#B3A6AB", fontWeight: 500, textAlign: "center", marginTop: -8, marginBottom: 14 }}>
                  USDC, digital US dollars, 1 USDC ≈ $1
                </div>
                <div style={{ height: 6, background: "#F5EEF1", borderRadius: 6, position: "relative", marginBottom: 16 }}>
                  <div style={{ position: "absolute", left: 0, top: 0, height: 6, width: `${Math.min(100, max ? (stake / max) * 100 : 0)}%`, background: "linear-gradient(90deg,#FF5A76,#D81E4A)", borderRadius: 6 }} />
                </div>
                <div style={{ display: "flex", gap: 9 }}>
                  {chips.map((c) => (
                    <button key={c} onClick={() => setStake(c)} className="mono" style={{ flex: 1, background: stake === c ? "#FFE7EC" : "#F9F3F5", color: stake === c ? "#B81540" : "#221217", border: "none", borderRadius: 11, padding: 10, cursor: "pointer" }}>
                      <b>{c}</b>
                    </button>
                  ))}
                  <button onClick={() => setStake(Math.round(max * 100) / 100)} className="mono" style={{ flex: 1, background: "#F9F3F5", border: "none", borderRadius: 11, padding: 10, cursor: "pointer" }}><b>MAX</b></button>
                </div>
                <div style={{ height: 1, background: "#F5EEF1", margin: "20px 0" }} />
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#7C6D72" }}>Backing other outcomes</span>
                  <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>{losersPool.toFixed(1)} USDC</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#7C6D72" }}>If {sel?.settle ?? "it lands"}</span>
                  <span className="mono" style={{ fontWeight: 700, fontSize: 15, color: profit > 0 ? "#FF3355" : "#988990" }}>
                    {profit > 0 ? `+${profit.toFixed(1)} USDC` : "your bet back"}
                  </span>
                </div>
                <p style={{ fontSize: 11, color: "#B3A6AB", fontWeight: 500, lineHeight: 1.4, margin: "0 0 12px" }}>
                  {losersPool > 0
                    ? `≈ ${returnMult.toFixed(2)}× if it lands. You'd get a share of the ${losersPool.toFixed(1)} USDC bet on the other outcomes, split by how much you put in, minus a 2.5% fee. The more people bet against you, the bigger it gets.`
                    : "Your winnings come from people who bet the other way, nobody has yet."}
                </p>
                {/* M6: the refund rule always shows near the confirm button. */}
                <p style={{ fontSize: 11.5, color: "#7C6D72", fontWeight: 600, lineHeight: 1.4, margin: "0 0 12px", padding: "9px 11px", background: "#F9F3F5", borderRadius: 10 }}>
                  If fewer than 3 people join this pool, everyone gets their money back, you risk nothing.
                </p>
                <button onClick={() => void lock()} disabled={btnDisabled} className="btnp" style={{ width: "100%", fontSize: 15, padding: 15, borderRadius: 14, opacity: btnDisabled ? 0.7 : 1 }}>
                  <LockSimple size={16} weight="fill" />
                  {btnLabel}
                </button>
                {/* H5: state plainly, at the moment of betting, that it's play money. */}
                <p style={{ fontSize: 11, color: "#B3A6AB", textAlign: "center", marginTop: 10, fontWeight: 500, lineHeight: 1.4 }}>
                  This is play money on a practice network, nothing here costs real cash.
                </p>
                {placeCallM.isPending && (
                  <p style={{ fontSize: 11.5, color: "#B3A6AB", textAlign: "center", marginTop: 8, fontWeight: 600 }}>
                    Approve in your wallet, then sit tight, this can take a few seconds.
                  </p>
                )}
                {error && <p style={{ fontSize: 12, color: "#C2373B", textAlign: "center", marginTop: 10, fontWeight: 600 }}>{error}</p>}
              </>
            )}
          </div>
        </div>
      </div>

      {/* H1: fund the EXACT on-chain wallet the bet spends from, no custodial
          float sweep, so a deposit actually raises the balance checked above. */}
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
    </div>
  );
}
