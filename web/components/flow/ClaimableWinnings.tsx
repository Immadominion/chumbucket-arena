"use client";

/**
 * Unclaimed on-chain positions — chumbucket_arena's claim() is pull-based (the
 * program never pushes a payout to you), so once a Pot settles or voids, the
 * player has to sign one more transaction to actually pull their USDC out of
 * the vault. Shown on both Wallet and Results, same card, same claim flow.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import { ArrowUpRight, CheckCircle, Trophy } from "@/components/icons";
import { useSession } from "@/lib/session";
import { flag } from "@/lib/data";
import { flagCode } from "@/lib/format";
import { explorerTxUrl } from "@/lib/solana";
import { claim, POT_STATUS_VOID } from "@/lib/arena-onchain";
import { useClaimablePositions, type ClaimablePosition } from "@/lib/useOnchainPositions";

/* eslint-disable @next/next/no-img-element */

const usdcFromBaseUnits = (v: bigint) => Number(v) / 1_000_000;

const pickLabel = (bucket: number, home: string, away: string) => (bucket === 0 ? home : bucket === 2 ? away : "Draw");

export default function ClaimableWinnings() {
  const { session } = useSession();
  const { claimable, refetch } = useClaimablePositions();
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null); // matchId being claimed
  const [txByMatch, setTxByMatch] = useState<Record<string, string>>({});
  const [errByMatch, setErrByMatch] = useState<Record<string, string>>({});

  const myWallet = wallets.find((w) => w.address === session.wallet) ?? wallets[0];

  const claimM = useMutation({
    mutationFn: async (matchId: string) => {
      if (!myWallet) throw new Error("Wallet isn't ready yet — try again in a moment.");
      return claim({ matchId, wallet: myWallet, signAndSendTransaction });
    },
  });

  if (claimable.length === 0) return null;

  const doClaim = async (p: ClaimablePosition) => {
    setPending(p.matchId);
    setErrByMatch((m) => ({ ...m, [p.matchId]: "" }));
    try {
      const { signature } = await claimM.mutateAsync(p.matchId);
      setTxByMatch((m) => ({ ...m, [p.matchId]: signature }));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["usdc-balance", session.wallet] }),
        refetch(),
      ]);
    } catch (e) {
      setErrByMatch((m) => ({ ...m, [p.matchId]: e instanceof Error ? e.message : "Couldn't claim just now — try again." }));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="card" style={{ marginTop: 18, padding: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px" }}>
        <Trophy size={17} weight="fill" color="#F2385A" style={{ flex: "none" }} />
        <div>
          <div className="cd" style={{ fontSize: 16 }}>Winnings to collect</div>
          <div style={{ fontSize: 11.5, color: "#988990", fontWeight: 600, marginTop: 1 }}>
            You won — tap Claim to send it to your balance.
          </div>
        </div>
      </div>
      <div style={{ height: 1, background: "#F5EEF1", margin: "0 18px" }} />
      {claimable.map((p, i) => {
        const home = p.match?.fixture.home ?? "Home";
        const away = p.match?.fixture.away ?? "Away";
        const payout = usdcFromBaseUnits(p.payout);
        const tx = txByMatch[p.matchId];
        const err = errByMatch[p.matchId];
        const isVoid = p.pot.status === POT_STATUS_VOID;
        return (
          <div key={p.matchId}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px" }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <img src={flag(flagCode(home) ?? "")} style={{ width: 34, height: 34, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff" }} alt="" />
                <img src={flag(flagCode(away) ?? "")} style={{ width: 34, height: 34, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff", marginLeft: -9 }} alt="" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                  {isVoid ? "Void · refund" : payout > 0 ? "You won" : "Settled"} · {pickLabel(p.position.bucket, home, away)}
                </div>
                <div style={{ fontSize: 11.5, color: "#988990", fontWeight: 600 }}>{home} v {away}</div>
                {tx && (
                  <a
                    href={explorerTxUrl(tx)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 11, color: "#0A7E40", fontWeight: 700, display: "flex", alignItems: "center", gap: 3, marginTop: 3 }}
                  >
                    View transaction <ArrowUpRight size={11} weight="bold" />
                  </a>
                )}
                {err && <div style={{ fontSize: 11, color: "#C2373B", fontWeight: 600, marginTop: 3 }}>{err}</div>}
              </div>
              {tx ? (
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 700, color: "#0A7E40", flex: "none" }}>
                  <CheckCircle size={15} weight="fill" /> Claimed
                </span>
              ) : (
                <button
                  onClick={() => void doClaim(p)}
                  disabled={pending === p.matchId}
                  className="btnp"
                  style={{ fontSize: 12.5, padding: "9px 16px", borderRadius: 11, opacity: pending === p.matchId ? 0.7 : 1, flex: "none" }}
                >
                  {pending === p.matchId ? "Claiming…" : payout > 0 ? `Claim ${payout.toFixed(1)} USDC` : "Claim"}
                </button>
              )}
            </div>
            {i < claimable.length - 1 && <div style={{ height: 1, background: "#F5EEF1", margin: "0 18px" }} />}
          </div>
        );
      })}
    </div>
  );
}
