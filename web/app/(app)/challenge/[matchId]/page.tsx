"use client";

/**
 * Create a 1-v-1 Challenge on a match. You back one side; your mate gets the
 * other. Both stakes lock in escrow and pay out to whoever the MATCH proves
 * right — settled on-chain by TxLINE, no one picks the winner. Creating returns
 * a shareable link your mate opens to accept and fund.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import AddFundsModal from "@/components/flow/AddFundsModal";
import { ArrowLeft, Clock, Fire, ShieldCheck, CheckCircle, LockSimple } from "@/components/icons";
import { flag } from "@/lib/data";
import { useGameData } from "@/lib/useGameData";
import { useTRPC } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { walToFrost } from "@/lib/format";

/* eslint-disable @next/next/no-img-element */

const CORAL = "#FF3355";
const INK = "#221217";
const GRAY = "#988990";
const RAKE_BPS = 250; // 2.5% off the loser's stake (matches backend/on-chain)

// Which side your mate is handed when you pick yours (HOME↔AWAY, DRAW→HOME).
const counter = (s: string) => (s === "HOME" ? "AWAY" : s === "AWAY" ? "HOME" : "HOME");

export default function CreateChallengePage() {
  const params = useParams<{ matchId: string }>();
  const { session } = useSession();
  const trpc = useTRPC();
  const g = useGameData();
  const createM = useMutation(trpc.createChallenge.mutationOptions());

  const fx = g.fixtureById(params.matchId);
  const balance = session.balance;

  const [side, setSide] = useState<"HOME" | "DRAW" | "AWAY">("HOME");
  const [stake, setStake] = useState(() => Math.min(2, Math.max(1, balance)) || 1);
  const [funds, setFunds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const teams: Record<string, string> = {
    HOME: fx?.home.name ?? "Home",
    AWAY: fx?.away.name ?? "Away",
    DRAW: "the draw",
  };
  const yourTeam = teams[side];
  const theirTeam = teams[counter(side)];
  const winnerTakes = useMemo(() => stake * 2 - stake * (RAKE_BPS / 10000), [stake]);

  const link = created ? `${typeof window !== "undefined" ? window.location.origin : ""}/c/${created}` : "";
  const insufficient = stake <= 0 || stake > balance;

  const create = async () => {
    if (insufficient) return setFunds(true);
    setError(null);
    try {
      const res = await createM.mutateAsync({ matchId: params.matchId, side, stake: walToFrost(stake) });
      setCreated(res.challengeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the challenge. Try again.");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the field is selectable */
    }
  };

  const chips = [1, 2, 5].filter((c) => c <= Math.max(balance, 1));

  return (
    <div className="midpad" style={{ maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link href="/arena" className="back"><ArrowLeft size={17} weight="bold" /></Link>
        <div className="cd" style={{ fontSize: 24, color: INK }}>{created ? "Challenge sent" : "Challenge a mate"}</div>
      </div>

      {/* match card */}
      <div className="card" style={{ padding: 24, textAlign: "center", marginTop: 22 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#C57A12", background: "#FBF0DC", padding: "5px 13px", borderRadius: 20 }}>
          <Clock size={13} weight="fill" /> Kick-off {fx?.ko ?? "—"} · {fx?.group ?? ""}
        </span>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 40, marginTop: 20 }}>
          <TeamBadge name={fx?.home.name ?? "…"} code={fx?.home.code ?? ""} />
          <span className="cd" style={{ fontSize: 18, color: "#CBBFC3" }}>vs</span>
          <TeamBadge name={fx?.away.name ?? "…"} code={fx?.away.code ?? ""} />
        </div>
      </div>

      {created ? (
        /* ---------- created: share the link ---------- */
        <div className="card" style={{ padding: 24, marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: CORAL, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
              <CheckCircle size={24} weight="fill" color="#fff" />
            </div>
            <div>
              <div className="cd" style={{ fontSize: 16, color: INK }}>You backed {yourTeam} · {stake} USDC</div>
              <div style={{ fontSize: 12.5, color: GRAY, fontWeight: 600, marginTop: 1 }}>Locked in escrow. Waiting for your mate to take {theirTeam}.</div>
            </div>
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: GRAY, letterSpacing: ".4px", margin: "20px 0 8px" }}>SEND THEM THIS LINK</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="mono" style={{ flex: 1, minWidth: 0, border: "1.5px solid #EFE6E9", borderRadius: 12, padding: "12px 14px", fontSize: 12.5, color: INK, background: "#FAF6F7" }} />
            <button onClick={() => void copy()} className="btnp" style={{ padding: "0 18px", borderRadius: 12, border: "none", fontSize: 13.5, whiteSpace: "nowrap" }}>
              {copied ? "Copied ✓" : "Copy link"}
            </button>
          </div>
          <Link href={`/c/${created}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: CORAL, textDecoration: "none", marginTop: 16 }}>
            Track this challenge →
          </Link>
        </div>
      ) : (
        /* ---------- form: pick side + stake ---------- */
        <>
          <div className="lbl" style={{ margin: "22px 0 12px" }}>YOU BACK</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {(["HOME", "DRAW", "AWAY"] as const).map((b) => {
              const on = b === side;
              return (
                <button key={b} onClick={() => setSide(b)} className={on ? "btnp" : undefined}
                  style={on
                    ? { flexDirection: "column", borderRadius: 14, padding: "16px 6px", gap: 3 }
                    : { background: "#fff", border: "1.5px solid #EFE6E9", borderRadius: 14, padding: "16px 6px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: on ? "#fff" : INK }}>{b === "DRAW" ? "DRAW" : (b === "HOME" ? fx?.home.name : fx?.away.name)?.slice(0, 3).toUpperCase() ?? b}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: on ? "rgba(255,255,255,.85)" : GRAY }}>{b === "DRAW" ? "level" : "to win"}</span>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: GRAY, fontWeight: 500, marginTop: 8 }}>
            Your mate automatically takes <b style={{ color: INK }}>{theirTeam}</b>. Any other result refunds you both.
          </div>

          <div className="card" style={{ padding: 22, marginTop: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="lbl">YOUR BET</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: GRAY }}>Balance {balance.toFixed(1)} USDC</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8, margin: "14px 0" }}>
              <input type="number" value={stake} min={0} step={0.5} onChange={(e) => setStake(Math.max(0, Number(e.target.value)))} className="mono"
                style={{ width: 130, textAlign: "right", border: "none", background: "transparent", fontSize: 42, fontWeight: 700, color: INK }} />
              <span style={{ fontSize: 16, fontWeight: 700, color: GRAY }}>USDC</span>
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              {chips.map((c) => (
                <button key={c} onClick={() => setStake(c)} className="mono" style={{ flex: 1, background: stake === c ? "#FFE7EC" : "#F9F3F5", color: stake === c ? CORAL : INK, border: "none", borderRadius: 11, padding: 10, cursor: "pointer" }}><b>{c}</b></button>
              ))}
              <button onClick={() => setStake(Math.round(Math.max(balance, 0) * 100) / 100)} className="mono" style={{ flex: 1, background: "#F9F3F5", border: "none", borderRadius: 11, padding: 10, cursor: "pointer" }}><b>MAX</b></button>
            </div>
            <div style={{ height: 1, background: "#F5EEF1", margin: "18px 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#7C6D72" }}>Winner gets</span>
              <span className="mono" style={{ fontWeight: 700, fontSize: 15, color: "#FF3355" }}>{winnerTakes.toFixed(1)} USDC total</span>
            </div>
            <p style={{ fontSize: 11, color: "#B3A6AB", fontWeight: 500, lineHeight: 1.4, margin: "6px 0 16px" }}>
              You each bet {stake} USDC. Win and you get {winnerTakes.toFixed(1)} USDC total — your {stake} back plus {(winnerTakes - stake).toFixed(1)} profit, after a 2.5% fee. A level match refunds you both.
            </p>
            <button onClick={() => void create()} disabled={createM.isPending} className="btnp" style={{ width: "100%", fontSize: 15, padding: 15, borderRadius: 14, opacity: createM.isPending ? 0.7 : 1 }}>
              <Fire size={16} weight="fill" />
              {createM.isPending ? "Creating…" : insufficient ? "Add funds to challenge" : `Create challenge · ${stake} USDC`}
            </button>
            {error && <p style={{ fontSize: 12, color: "#C2373B", textAlign: "center", marginTop: 10, fontWeight: 600 }}>{error}</p>}
          </div>
        </>
      )}

      <div className="ink" style={{ marginTop: 16, padding: "14px 18px", display: "flex", alignItems: "center", gap: 10 }}>
        <ShieldCheck size={16} weight="fill" color="#FF5A76" style={{ flex: "none" }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#FFB0C0", lineHeight: 1.4 }}>The real match result is checked automatically before anyone gets paid — no one can fake it.</span>
      </div>

      <AddFundsModal open={funds} onClose={() => setFunds(false)} />
    </div>
  );
}

function TeamBadge({ name, code }: { name: string; code: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <img src={flag(code, 160)} style={{ width: 58, height: 58, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff,0 4px 12px rgba(40,16,24,.14)" }} alt="" />
      <span className="cd" style={{ fontSize: 16, color: "#221217" }}>{name}</span>
    </div>
  );
}
