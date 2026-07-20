"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import SignContractModal from "@/components/flow/SignContractModal";
import { Fire, LockSimple, SealCheck, ShieldCheck, Trophy } from "@/components/icons";
import { useSession } from "@/lib/session";

/* eslint-disable @next/next/no-img-element */

const perks = [
  { Icon: Fire, text: "Challenge a mate 1-v-1, or back the crowd" },
  { Icon: LockSimple, text: "Stakes lock in a Solana escrow" },
  { Icon: Trophy, text: "A valid TxLINE result makes winning positions claimable" },
];

export default function ContractPage() {
  const { session, ready, authenticated, login } = useSession();
  const router = useRouter();
  const [showHandle, setShowHandle] = useState(false);

  // Fully set up → into the app.
  useEffect(() => {
    if (!ready || session.status !== "signed") return;
    router.replace(session.onboarded ? "/arena" : "/trial");
  }, [ready, session.status, session.onboarded, router]);

  // Authenticated with Privy but no account yet → pick a handle.
  useEffect(() => {
    if (ready && authenticated && session.status === "guest") setShowHandle(true);
  }, [ready, authenticated, session.status]);

  // One action: not logged in → Privy modal; logged in but no handle → name step.
  // Privy only allows listed origins (dashboard → this app). Local dev must be on
  // http://localhost:3000 — other ports look like a dead button.
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const authedRef = useRef(authenticated);
  authedRef.current = authenticated;
  const start = () => {
    if (!ready) return;
    setLoginErr(null);
    if (authenticated && session.status === "guest") {
      setShowHandle(true);
      return;
    }
    try {
      login();
    } catch {
      setLoginErr("We couldn't open sign-in just now. Please try again.");
      return;
    }
    // A blocked pop-up or an unauthorized origin makes Privy open nothing and
    // never throw — the button looks dead. If we're still signed out a few
    // seconds after the click, say so instead of leaving them staring.
    window.setTimeout(() => {
      if (!authedRef.current) {
        setLoginErr("The sign-in window didn't open. Check your browser isn't blocking pop-ups, then try again.");
      }
    }, 6000);
  };

  return (
    <div className="signin">
      <div className="signin-left">
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 28 }}>
          <img src="/img/logo.png" alt="" style={{ width: 30, height: 30, objectFit: "contain" }} />
          <span className="cd" style={{ fontSize: 16, letterSpacing: ".4px" }}>CHUMBUCKET</span>
        </div>

        <h1 className="cd" style={{ fontSize: "clamp(32px,4vw,46px)", lineHeight: 1.05, margin: 0, color: "#221217", letterSpacing: "-.5px" }}>
          Bet your mates.
          <br />
          Let&rsquo;s get you in.
        </h1>

        <p style={{ margin: "20px 0 0", fontSize: 16, lineHeight: 1.5, fontWeight: 500, color: "#594A50", maxWidth: 460 }}>
          Pick a handle, add a little to play with, and put your money where your mouth is. The match settles every bet, proven on-chain, so no one can rig it.
        </p>

        <div className="card" style={{ padding: "6px 4px", marginTop: 22, maxWidth: 460 }}>
          {perks.map((p, i) => (
            <div key={p.text}>
              <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 14px" }}>
                <p.Icon size={18} weight="fill" color="#FF3355" />
                <span style={{ fontSize: 13.5, fontWeight: 500, color: "#2C4A39" }}>{p.text}</span>
              </div>
              {i < perks.length - 1 && <div style={{ height: 1, background: "#F5EEF1", margin: "0 14px" }} />}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 20, maxWidth: 460 }}>
          <button onClick={start} className="btnp" style={{ width: "100%", padding: 15, borderRadius: 15, fontSize: 15 }}>
            <Fire size={18} weight="fill" />
            Get started
          </button>
          {loginErr && (
            <div role="alert" style={{ marginTop: 12, background: "#FDE7EC", border: "1px solid #F7C6D2", borderRadius: 12, padding: "10px 14px", fontSize: 13, fontWeight: 600, color: "#B01030", lineHeight: 1.45 }}>
              {loginErr}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14, fontSize: 12, fontWeight: 600, color: "#B3A6AB" }}>
            <SealCheck size={14} weight="fill" color="#FF3355" />
            Email, Google, X or wallet. No seed phrases. Owned by you, verifiable on-chain.
          </div>
          <div style={{ textAlign: "center", marginTop: 14, fontSize: 13, fontWeight: 600 }}>
            <a href="https://github.com/Immadominion/Chum-Bucket/releases/latest/download/chumbucket.apk" style={{ color: "#FF3355", textDecoration: "underline" }}>
              On Android? Get the mobile app
            </a>
          </div>
        </div>
      </div>

      <div className="signin-right">
        <div style={{ width: "100%", maxWidth: 360, background: "linear-gradient(135deg,#1A1013,#3a0f1c)", borderRadius: 28, padding: 28, color: "#fff", position: "relative", overflow: "hidden", boxShadow: "0 30px 44px rgba(40,16,24,.3)" }}>
          <div style={{ position: "absolute", right: -50, top: -50, width: 200, height: 200, borderRadius: "50%", background: "radial-gradient(circle,rgba(255,90,118,.32),transparent 70%)" }} />
          <div style={{ position: "relative" }}>
            <ShieldCheck size={26} weight="fill" color="#FF5A76" />
            <div className="cd" style={{ fontSize: 24, marginTop: 14, lineHeight: 1.15 }}>The match decides. Not the house.</div>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: "#D9C3C9", marginTop: 12 }}>
              Every stake locks in a Solana escrow. A TxLINE Merkle proof decides the result, and the pot&rsquo;s configured fee is enforced on-chain.
            </p>
          </div>
        </div>
      </div>

      <SignContractModal open={showHandle} onClose={() => setShowHandle(false)} />
    </div>
  );
}
