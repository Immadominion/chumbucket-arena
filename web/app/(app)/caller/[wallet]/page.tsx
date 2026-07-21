"use client";

/**
 * A caller's public profile — inspect who you're about to follow or copy. Real
 * data from trpc.profile: prediction record, win rate, P&L, streak, follower
 * counts. This is what makes the feed's names worth tapping (mobile has it; the
 * web feed's names were dead text).
 */

import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { useWalletProfiles } from "@/lib/useWalletProfiles";
import { useSession } from "@/lib/session";
import { FollowButton } from "@/components/FollowButton";
import { avatar } from "@/lib/data";
import { shortWallet } from "@/lib/format";
import { ArrowLeft, Fire, Trophy } from "@/components/icons";

/* eslint-disable @next/next/no-img-element */

export default function CallerProfilePage() {
  const params = useParams<{ wallet: string }>();
  const wallet = params.wallet;
  const trpc = useTRPC();
  const { session } = useSession();
  const q = useQuery({ ...trpc.profile.queryOptions({ wallet, limit: 20 }), enabled: !!wallet, retry: false });
  const profiles = useWalletProfiles([wallet]);
  const handle = profiles.labelFor(wallet);

  const stats = q.data?.stats;
  const counts = q.data?.counts as { followers?: number; following?: number } | undefined;
  const isMe = session.wallet === wallet;

  const made = stats?.calls_made ?? 0;
  const won = stats?.calls_won ?? 0;
  const lost = stats?.calls_lost ?? 0;
  const settled = won + lost;
  const winRate = settled > 0 ? Math.round((won / settled) * 100) : null;
  const pnl = stats ? Number(stats.pnl_base_units) / 1e6 : 0;
  const streak = stats?.current_streak ?? 0;

  const name = handle ?? shortWallet(wallet);

  return (
    <div className="midpad" style={{ maxWidth: 620 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link href="/predictions" className="back"><ArrowLeft size={17} weight="bold" /></Link>
        <div className="cd" style={{ fontSize: 22 }}>Profile</div>
      </div>

      <div className="card" style={{ marginTop: 22, padding: 24, display: "flex", alignItems: "center", gap: 16 }}>
        <img src={avatar(wallet, "d9f2e1")} alt="" style={{ width: 64, height: 64, borderRadius: "50%", background: "#d9f2e1", flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cd" style={{ fontSize: 20 }}>{name}</div>
          <div className="mono" style={{ fontSize: 12, color: "#988990", marginTop: 2 }}>{shortWallet(wallet)}</div>
          <div style={{ fontSize: 12.5, color: "#7C6D72", fontWeight: 600, marginTop: 7 }}>
            <b style={{ color: "#221217" }}>{counts?.followers ?? 0}</b> followers · <b style={{ color: "#221217" }}>{counts?.following ?? 0}</b> following
          </div>
        </div>
        {!isMe && <FollowButton target={wallet} />}
      </div>

      <div className="grid3" style={{ gap: 12, marginTop: 16 }}>
        <Stat label="Predictions" value={String(made)} />
        <Stat label="Win rate" value={winRate == null ? "—" : `${winRate}%`} sub={settled > 0 ? `${won}W · ${lost}L` : "none settled"} />
        <Stat label="P&L" value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}`} sub="USDC" color={pnl > 0 ? "#0A7E40" : pnl < 0 ? "#C2373B" : undefined} />
      </div>

      {streak !== 0 && (
        <div className="card" style={{ marginTop: 14, padding: "16px 18px", display: "flex", alignItems: "center", gap: 10 }}>
          {streak > 0 ? <Fire size={18} weight="fill" color="#FF3355" /> : <Trophy size={18} weight="fill" color="#988990" />}
          <span style={{ fontSize: 13.5, fontWeight: 700, color: "#221217" }}>
            {streak > 0 ? `On a ${streak}-win streak` : `${Math.abs(streak)} in a row lost`}
          </span>
        </div>
      )}

      {made === 0 && (
        <div className="card" style={{ marginTop: 14, padding: "24px 18px", textAlign: "center", fontSize: 13.5, fontWeight: 600, color: "#988990" }}>
          No settled predictions yet.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card" style={{ padding: "16px 16px" }}>
      <div className="lbl">{label}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 6, color: color ?? "#221217" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#988990", fontWeight: 600, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
