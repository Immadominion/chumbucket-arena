"use client";

/**
 * The shared Challenge link. Public, anyone with the link sees the wager and can
 * sign in to accept. You take the side the creator DIDN'T; both stakes lock in
 * escrow and pay out to whoever the match proves right, settled on-chain by
 * TxLINE. Standalone (outside the app shell) so it's a clean, forwardable page.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Fire, ShieldCheck, LockSimple, CheckCircle } from "@/components/icons";
import { flag } from "@/lib/data";
import { flagCode, frostToWal } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { useSession } from "@/lib/session";

/* eslint-disable @next/next/no-img-element */

const CORAL = "#FF3355";
const CORAL_BRIGHT = "#FF5A76";
const INK = "#1A1013";
const GRAY = "#988990";

export default function ChallengeLinkPage() {
  const { challengeId } = useParams<{ challengeId: string }>();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { session, authenticated, login } = useSession();
  const acceptM = useMutation(trpc.acceptChallenge.mutationOptions());
  const [error, setError] = useState<string | null>(null);

  const chQ = useQuery({ ...trpc.challenge.queryOptions({ challengeId }), refetchInterval: 5_000 });
  const ch = chQ.data;

  const sideTeam = (s?: string | null) =>
    !ch?.fixture ? "—" : s === "HOME" ? ch.fixture.home : s === "AWAY" ? ch.fixture.away : "the draw";

  const isCreator = authenticated && !!ch && session.wallet === ch.creator;
  const yourSide = ch?.opponentSide;

  const accept = async () => {
    if (!authenticated) return login();
    setError(null);
    try {
      await acceptM.mutateAsync({ challengeId });
      await qc.invalidateQueries({ queryKey: trpc.challenge.queryKey({ challengeId }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't accept. It may already be taken.");
    }
  };

  return (
    <div style={{ minHeight: "100dvh", background: "#FAF6F7", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 20px" }}>
      <div style={{ width: "100%", maxWidth: 520 }}>
        <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: CORAL, textDecoration: "none", marginBottom: 26 }}>
          <ArrowLeft size={15} weight="bold" /> ChumBucket
        </Link>

        {chQ.isLoading ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: GRAY, fontWeight: 600 }}>Loading the challenge…</div>
        ) : !ch ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: GRAY, fontWeight: 600 }}>This challenge doesn&rsquo;t exist or was cancelled.</div>
        ) : (
          <>
            {/* the wager */}
            <div className="card" style={{ padding: 26 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700, color: CORAL }}>
                <Fire size={14} weight="fill" /> 1-v-1 CHALLENGE
              </div>
              <div className="cd" style={{ fontSize: 25, color: INK, margin: "12px 0 4px", letterSpacing: "-.4px" }}>
                {ch.fixture ? `${ch.fixture.home} vs ${ch.fixture.away}` : "Match"}
              </div>
              <div style={{ fontSize: 13, color: GRAY, fontWeight: 600 }}>Bet · <span className="mono" style={{ color: INK }}>{frostToWal(ch.stake).toFixed(1)} USDC</span> each · winner takes the pool</div>

              <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
                <SideCard label="They backed" team={sideTeam(ch.creatorSide)} code={ch.fixture ? (flagCode(sideTeam(ch.creatorSide)) ?? "") : ""} muted />
                <SideCard label="You take" team={sideTeam(yourSide)} code={ch.fixture ? (flagCode(sideTeam(yourSide)) ?? "") : ""} />
              </div>
            </div>

            {/* action by status */}
            <div className="card" style={{ padding: 22, marginTop: 14 }}>
              {ch.status === "OPEN" && !isCreator && (
                <>
                  <button onClick={() => void accept()} disabled={acceptM.isPending} className="btnp" style={{ width: "100%", fontSize: 15.5, padding: 16, borderRadius: 14, opacity: acceptM.isPending ? 0.7 : 1 }}>
                    <LockSimple size={17} weight="fill" />
                    {acceptM.isPending ? "Locking your bet…" : !authenticated ? "Sign in to accept" : `Accept · bet ${frostToWal(ch.stake).toFixed(1)} USDC`}
                  </button>
                  <p style={{ fontSize: 12, color: GRAY, textAlign: "center", fontWeight: 500, margin: "12px 0 0" }}>
                    You back {sideTeam(yourSide)}. Both stakes lock until the match ends.
                  </p>
                  {error && <p style={{ fontSize: 12, color: "#C2373B", textAlign: "center", marginTop: 10, fontWeight: 600 }}>{error}</p>}
                </>
              )}
              {ch.status === "OPEN" && isCreator && (
                <div style={{ textAlign: "center" }}>
                  <div className="cd" style={{ fontSize: 16, color: INK }}>Waiting for a mate to accept</div>
                  <div style={{ fontSize: 12.5, color: GRAY, fontWeight: 600, marginTop: 4 }}>Your {frostToWal(ch.stake).toFixed(1)} USDC on {sideTeam(ch.creatorSide)} is locked. Share the link.</div>
                </div>
              )}
              {ch.status === "MATCHED" && (
                <div style={{ display: "flex", alignItems: "center", gap: 11, justifyContent: "center" }}>
                  <LockSimple size={20} weight="fill" color={CORAL} />
                  <div>
                    <div className="cd" style={{ fontSize: 15.5, color: INK }}>Locked, game on</div>
                    <div style={{ fontSize: 12.5, color: GRAY, fontWeight: 600 }}>Both in. Settles the second the match is proven on-chain.</div>
                  </div>
                </div>
              )}
              {(ch.status === "SETTLED" || ch.status === "VOID") && (
                <div style={{ display: "flex", alignItems: "center", gap: 11, justifyContent: "center" }}>
                  <CheckCircle size={22} weight="fill" color={ch.status === "VOID" ? GRAY : CORAL} />
                  <div>
                    <div className="cd" style={{ fontSize: 15.5, color: INK }}>
                      {ch.status === "VOID" ? "Refunded, no winner" : `${sideTeam(ch.winningBucket)} won it`}
                    </div>
                    <div style={{ fontSize: 12.5, color: GRAY, fontWeight: 600 }}>
                      {ch.status === "VOID" ? "The match didn't land either side, both stakes returned." : "Settled by a TxLINE proof on Solana."}
                    </div>
                  </div>
                </div>
              )}
              {ch.status === "CANCELLED" && (
                <div style={{ textAlign: "center", color: GRAY, fontWeight: 600, fontSize: 14 }}>This challenge was cancelled and the stake refunded.</div>
              )}
            </div>

            <div className="ink" style={{ marginTop: 14, padding: "14px 18px", display: "flex", alignItems: "center", gap: 10 }}>
              <ShieldCheck size={16} weight="fill" color={CORAL_BRIGHT} style={{ flex: "none" }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#FFB0C0", lineHeight: 1.4 }}>Neither player, and not ChumBucket, can decide who won. The match settles it, proven on-chain by TxLINE.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SideCard({ label, team, code, muted }: { label: string; team: string; code: string; muted?: boolean }) {
  return (
    <div style={{ flex: 1, borderRadius: 14, padding: "14px 12px", background: muted ? "#F9F3F5" : "#FFE7EC", border: muted ? "1.5px solid #EFE6E9" : "1.5px solid rgba(242,56,90,.25)", textAlign: "center" }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".5px", color: muted ? "#988990" : "#FF3355" }}>{label.toUpperCase()}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 8 }}>
        {code ? <img src={flag(code)} style={{ width: 26, height: 26, borderRadius: "50%", objectFit: "cover" }} alt="" /> : null}
        <span className="cd" style={{ fontSize: 15, color: "#1A1013" }}>{team}</span>
      </div>
    </div>
  );
}
