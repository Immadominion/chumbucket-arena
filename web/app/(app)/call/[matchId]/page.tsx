"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import AddFundsModal from "@/components/flow/AddFundsModal";
import { ArrowLeft, ArrowUpRight, Clock, LockSimple, ShieldCheck } from "@/components/icons";
import { flag } from "@/lib/data";
import { toFixture } from "@/lib/adapters";
import { useGameData } from "@/lib/useGameData";
import { useTRPC } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { frostToWal } from "@/lib/format";
import { placeCall, fetchUsdcBalance, type BucketId } from "@/lib/arena-onchain";
import { explorerTxUrl } from "@/lib/solana";

/* eslint-disable @next/next/no-img-element */

const abbr = (s: string) => s.slice(0, 3).toUpperCase();
const RAKE_BPS = 250; // 2.5% — taken from the losers' pool only (must match backend)

const placeholderFixture = (matchId: string) => ({
  matchId,
  home: { name: "…", code: "" },
  away: { name: "…", code: "" },
  group: "",
  ko: "",
  koTag: "",
  pot: 0,
  pct: { home: 0, draw: 0, away: 0 },
});

export default function MakeCallPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { session } = useSession();
  const g = useGameData();
  const trpc = useTRPC();
  const qc = useQueryClient();

  // The money side is real, non-custodial on-chain USDC now (chumbucket_arena's
  // place_call) — same Privy wallet + signing pattern as the Send screen
  // (lib/solana.ts / app/(app)/send/page.tsx). No more off-chain ledger mutation.
  const { wallets, ready: walletsReady } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const myWallet = useMemo(
    () => wallets.find((w) => w.address === session.wallet) ?? wallets[0],
    [wallets, session.wallet],
  );
  const placeCallM = useMutation({
    mutationFn: async (opts: { bucket: BucketId; amountUsdc: number }) => {
      if (!myWallet) throw new Error("Wallet isn't ready yet — try again in a moment.");
      return placeCall({
        matchId: params.matchId,
        bucket: opts.bucket,
        amountUsdc: opts.amountUsdc,
        wallet: myWallet,
        signAndSendTransaction,
      });
    },
  });

  // Live match state — subscribe so pot, odds and status update in real time.
  // Fall back to the cached list on first paint. matchById is unfiltered, so a
  // match that has already kicked off still resolves (instead of vanishing to a
  // placeholder), which is what lets us show a proper "calls closed" state.
  // NOTE: this stays the off-chain read-model (fine for LISTING/DISPLAY — real
  // TxLINE-backed fixtures) — it does not reflect on-chain stake totals from
  // placeCall below, since that path never emits the custodial engine's events.
  const matchSub = useSubscription(trpc.onMatch.subscriptionOptions({ matchId: params.matchId }));
  const match = matchSub.data ?? g.matchById(params.matchId);
  const isOpen = match?.status === "OPEN";
  const fx = match ? toFixture(match) : placeholderFixture(params.matchId);

  // Real on-chain USDC balance — what the player can actually stake, straight
  // from their own wallet (not the custodial off-chain ledger's balance).
  const balanceQ = useQuery({
    queryKey: ["usdc-balance", session.wallet],
    queryFn: () => fetchUsdcBalance(session.wallet),
    enabled: !!session.wallet,
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
  const balance = balanceQ.data ?? 0;

  const buckets: { id: BucketId; label: string; pct: number; team: string }[] = [
    { id: "HOME", label: abbr(fx.home.name), pct: fx.pct.home, team: fx.home.name },
    { id: "DRAW", label: "DRAW", pct: fx.pct.draw, team: "the draw" },
    { id: "AWAY", label: abbr(fx.away.name), pct: fx.pct.away, team: fx.away.name },
  ];

  const [pick, setPick] = useState<BucketId>("HOME");
  const [stake, setStake] = useState(() => Math.min(2, Math.max(0, balance)) || 1);
  const [funds, setFunds] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const sel = buckets.find((b) => b.id === pick)!;

  // ── Real parimutuel projection from the LIVE pool ──────────────────────────
  // If your outcome wins, you get your stake back plus a pro-rata share of the
  // stake on the OTHER outcomes (the losers' pool), less the rake. Empty pool ⇒
  // nothing to win yet.
  const resultMarket = (match?.markets ?? []).find((m) => m.marketId === "RESULT");
  const poolOf = (bucket: string) => {
    const b = resultMarket?.buckets.find((x) => x.bucket === bucket);
    return b ? frostToWal(b.stake) : 0;
  };
  const totalPool = poolOf("HOME") + poolOf("DRAW") + poolOf("AWAY");
  const myBucketPool = poolOf(pick);
  const losersPool = Math.max(0, totalPool - myBucketPool); // your potential winnings come from here
  const newWinnersStake = myBucketPool + stake;
  const distributable = losersPool * (1 - RAKE_BPS / 10000);
  const profit = newWinnersStake > 0 ? (stake / newWinnersStake) * distributable : 0;
  const returnMult = stake > 0 ? (stake + profit) / stake : 1;

  const max = Math.max(balance, 0);
  const insufficient = stake <= 0 || stake > balance;

  const read =
    totalPool === 0
      ? `Nobody's in yet — back ${sel.team} and you set the line.`
      : sel.pct > 45
        ? `The crowd's ${sel.pct}% on ${sel.team}. Safe pick, thin payout.`
        : `${sel.pct}% on ${sel.team} — contrarian. If it lands, you scoop the pool.`;

  const lock = async () => {
    if (!isOpen) {
      setError("This match has kicked off — betting is closed.");
      return;
    }
    if (insufficient) {
      setFunds(true);
      return;
    }
    if (!myWallet) {
      setError("Wallet isn't ready yet — try again in a moment.");
      return;
    }
    setError(null);
    try {
      const { signature } = await placeCallM.mutateAsync({ bucket: pick, amountUsdc: stake });
      setTxSignature(signature);
      // Scoped: just the on-chain USDC balance this screen itself reads — the
      // match pot totals below are the off-chain read-model and never move
      // from an on-chain placeCall (see the note above), so there's nothing
      // else here worth invalidating.
      await qc.invalidateQueries({ queryKey: ["usdc-balance", session.wallet] });
      setDone(true);
      setTimeout(() => router.push("/arena"), 1400);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not lock the call. Try again.");
    }
  };

  const btnLabel = done
    ? "Backed ✓"
    : placeCallM.isPending
      ? "Confirming on-chain…"
      : !match
        ? "Loading…"
        : !isOpen
          ? "Closed · kicked off"
          : !walletsReady
            ? "Connecting wallet…"
            : insufficient
              ? "Add funds to back"
              : `Back it · ${stake} USDC`;
  const btnDisabled = placeCallM.isPending || done || !match || !isOpen || !walletsReady;

  const chips = [1, 2, 5].filter((c) => c <= Math.max(max, 1));

  return (
    <div className="midpad">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link href="/arena" className="back"><ArrowLeft size={17} weight="bold" /></Link>
        <div className="cd" style={{ fontSize: 24 }}>Back an outcome</div>
        <span className="mono" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "#988990" }}>POT {totalPool.toLocaleString(undefined, { maximumFractionDigits: 1 })} USDC</span>
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        {/* LEFT */}
        <div className="col-main">
          <div className="card" style={{ padding: 28, textAlign: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#C57A12", background: "#FBF0DC", padding: "5px 13px", borderRadius: 20 }}>
              <Clock size={13} weight="fill" />
              Kick-off {fx.ko} · {fx.group}
            </span>
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
          </div>

          <div className="lbl" style={{ margin: "24px 0 12px" }}>YOUR PICK</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
            {buckets.map((b) => {
              const on = b.id === pick;
              return (
                <button
                  key={b.id}
                  onClick={() => setPick(b.id)}
                  className={on ? "btnp" : undefined}
                  style={
                    on
                      ? { flexDirection: "column", borderRadius: 16, padding: "18px 6px", gap: 4 }
                      : { background: "#fff", border: "1.5px solid #EFE6E9", borderRadius: 16, padding: "18px 6px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }
                  }
                >
                  <span style={{ fontSize: 13, fontWeight: 700, color: on ? "#fff" : "#221217" }}>{b.label}</span>
                  <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: on ? "#fff" : "#6A5A60" }}>{totalPool > 0 ? `${b.pct}%` : "—"}</span>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11.5, color: "#B3A6AB", fontWeight: 500, marginTop: 8 }}>
            {totalPool > 0 ? "% = share of the pot backing each outcome (the crowd's odds)." : "No bets yet — be the first and you set the crowd's line."}
          </div>

          <div className="ink" style={{ marginTop: 18, padding: "16px 18px" }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: "#F7EEF0", lineHeight: 1.42 }}>{read}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.08)" }}>
              <ShieldCheck size={15} weight="fill" color="#FF5A76" />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#FFB0C0" }}>TxLINE validates the final result on Solana before winners can claim.</span>
            </div>
          </div>
        </div>

        {/* RIGHT STAKE */}
        <div className="col-side w360">
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="lbl">STAKE</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#988990" }}>Balance {balance.toFixed(1)} USDC</span>
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
              <span style={{ fontSize: 13, fontWeight: 600, color: "#7C6D72" }}>If {sel.team === "the draw" ? "it's a draw" : `${sel.team} win`}</span>
              <span className="mono" style={{ fontWeight: 700, fontSize: 15, color: profit > 0 ? "#F2385A" : "#988990" }}>
                {profit > 0 ? `+${profit.toFixed(1)} USDC` : "stake back"}
              </span>
            </div>
            <p style={{ fontSize: 11, color: "#B3A6AB", fontWeight: 500, lineHeight: 1.4, margin: "0 0 16px" }}>
              {losersPool > 0
                ? `≈ ${returnMult.toFixed(2)}× — a pro-rata share of the ${losersPool.toFixed(1)} USDC on the other outcomes, less a 2.5% rake. Grows as more back against you.`
                : "Your winnings come from people who call it wrong — nothing's against you yet. Needs 3+ players or all stakes are refunded."}
            </p>
            <button onClick={() => void lock()} disabled={btnDisabled} className="btnp" style={{ width: "100%", fontSize: 15, padding: 15, borderRadius: 14, opacity: btnDisabled ? 0.7 : 1 }}>
              <LockSimple size={16} weight="fill" />
              {btnLabel}
            </button>
            {placeCallM.isPending && (
              <p style={{ fontSize: 11.5, color: "#B3A6AB", textAlign: "center", marginTop: 10, fontWeight: 600 }}>
                Approve in your wallet, then sit tight — this can take a few seconds on devnet.
              </p>
            )}
            {done && txSignature && (
              <a
                href={explorerTxUrl(txSignature)}
                target="_blank"
                rel="noreferrer"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, fontSize: 11.5, color: "#0A7E40", fontWeight: 700, textAlign: "center", marginTop: 10 }}
              >
                View on Solana Explorer <ArrowUpRight size={12} weight="bold" />
              </a>
            )}
            {error && <p style={{ fontSize: 12, color: "#C2373B", textAlign: "center", marginTop: 10, fontWeight: 600 }}>{error}</p>}
          </div>
        </div>
      </div>

      <AddFundsModal open={funds} onClose={() => setFunds(false)} />
    </div>
  );
}
