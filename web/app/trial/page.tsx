"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AddFundsModal from "@/components/flow/AddFundsModal";
import { ArrowRight, Coins, Fire, ShieldCheck, Trophy } from "@/components/icons";
import { useSession } from "@/lib/session";

export default function TrialPage() {
  const { session, ready, completeTrial, claimWelcomeGrant } = useSession();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [fundsOpen, setFundsOpen] = useState(false);

  // guard: only signed, not-yet-onboarded players belong here
  useEffect(() => {
    if (!ready) return;
    if (session.status === "guest") router.replace("/contract");
    else if (session.onboarded) router.replace("/arena");
  }, [ready, session.status, session.onboarded, router]);

  const finish = () => {
    completeTrial();
    router.push("/arena");
  };

  return (
    <div style={{ minHeight: "100dvh", background: "radial-gradient(120% 80% at 50% 0%,#EAF0E6,#FAF6F7)", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 20px 48px" }}>
      {/* progress */}
      <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
        {[0, 1, 2].map((n) => (
          <span key={n} style={{ width: step >= n ? 26 : 16, height: 6, borderRadius: 6, background: step >= n ? "#F2385A" : "#D7E0D4", transition: ".25s" }} />
        ))}
      </div>

      <div style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {/* brand badge — clean, illustration-free */}
        <div style={{ width: 64, height: 64, borderRadius: 20, background: "linear-gradient(135deg,#FF5A76,#D81E4A)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 14px 30px rgba(242,58,92,.35)" }}>
          <Fire size={30} weight="fill" color="#fff" />
        </div>

        {/* step body */}
        <div style={{ width: "100%", marginTop: 24 }}>
          {step === 0 && (
            <div className="card" style={{ padding: 24, textAlign: "center" }}>
              <div className="cd" style={{ fontSize: 24 }}>Welcome to ChumBucket</div>
              <p style={{ fontSize: 14, color: "#7C6D72", lineHeight: 1.5, margin: "10px 0 20px" }}>
                Bet your mates on the World Cup. Two ways to play — the match settles every bet, on-chain.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, textAlign: "left" }}>
                <Way icon={<Fire size={18} weight="fill" color="#F2385A" />} title="Challenge a mate" body="1-v-1. Pick a side, they take the other. Winner takes the pot." />
                <Way icon={<Trophy size={18} weight="fill" color="#F2B705" />} title="Back the crowd" body="Join the pooled market and share the winnings with everyone on your side." />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="card" style={{ padding: 24, textAlign: "center" }}>
              <div className="cd" style={{ fontSize: 22 }}>Add a little to play with</div>
              <p style={{ fontSize: 13.5, color: "#7C6D72", lineHeight: 1.5, margin: "8px 0 20px" }}>
                Top up with USDC, or start with a couple on the house. You can add more anytime from your wallet.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <button onClick={() => setFundsOpen(true)} className="btnp" style={{ width: "100%", padding: 15, borderRadius: 15, fontSize: 15 }}>
                  <Coins size={18} weight="fill" />
                  Add funds
                </button>
                <button
                  onClick={() => { void claimWelcomeGrant().catch(() => {}); setStep(2); }}
                  style={{ width: "100%", background: "#fff", border: "1.5px solid #EFE6E9", borderRadius: 15, padding: 14, fontWeight: 700, fontSize: 14, color: "#221217", cursor: "pointer" }}
                >
                  Start with 2 USDC on the house
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="card" style={{ padding: 24, textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
                <ShieldCheck size={34} weight="fill" color="#F2385A" />
              </div>
              <div className="cd" style={{ fontSize: 22, marginTop: 8 }}>You&rsquo;re in.</div>
              <p style={{ fontSize: 13.5, color: "#7C6D72", lineHeight: 1.5, margin: "8px 0 0" }}>
                Balance ready. Pick a match, challenge a mate or back the crowd — the result does the talking.
              </p>
            </div>
          )}
        </div>

        {/* footer action */}
        <div style={{ width: "100%", marginTop: 18 }}>
          {step === 0 && (
            <button onClick={() => setStep(1)} className="btnp" style={{ width: "100%", padding: 15, borderRadius: 15, fontSize: 15 }}>
              Get started <ArrowRight size={16} weight="bold" />
            </button>
          )}
          {step === 2 && (
            <button onClick={finish} className="btnp" style={{ width: "100%", padding: 15, borderRadius: 15, fontSize: 15 }}>
              Enter ChumBucket <ArrowRight size={16} weight="bold" />
            </button>
          )}
        </div>
      </div>

      <AddFundsModal open={fundsOpen} onClose={() => setFundsOpen(false)} onDone={() => setStep(2)} />
    </div>
  );
}

function Way({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#F9F3F5", borderRadius: 14, padding: "13px 15px" }}>
      <div style={{ width: 36, height: 36, borderRadius: 11, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{icon}</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#221217" }}>{title}</div>
        <div style={{ fontSize: 12, color: "#7C6D72", fontWeight: 500, marginTop: 1, lineHeight: 1.35 }}>{body}</div>
      </div>
    </div>
  );
}
