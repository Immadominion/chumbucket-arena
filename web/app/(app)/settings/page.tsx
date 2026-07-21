"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, CaretRight, ChartDonut, DownloadSimple, PencilSimple, PaperPlaneRight, SealCheck, ShieldCheck, SignOut, Users, Wallet } from "@/components/icons";
import { avatar } from "@/lib/data";
import { useSession } from "@/lib/session";
import { fetchSupabaseProfile } from "@/lib/social";
import { profileImageUrl } from "@/lib/supabase";
import EditProfileModal from "@/components/flow/EditProfileModal";

/* eslint-disable @next/next/no-img-element */

export default function SettingsPage() {
  const { session, signOut } = useSession();
  const { user } = usePrivy();
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const handle = session.handle || "Chum";
  const wallet = session.wallet || "";
  const seed = session.handle || "manager";

  const profileQ = useQuery({
    queryKey: ["supabase-profile", wallet],
    queryFn: () => fetchSupabaseProfile(wallet),
    enabled: !!wallet,
    staleTime: 15_000,
  });
  const displayName = profileQ.data?.full_name || handle;
  const pfp = profileImageUrl(profileQ.data?.profile_image_id);

  const method = user?.google
    ? "Google"
    : user?.twitter
      ? "X"
      : user?.apple
        ? "Apple"
        : user?.email
          ? "email"
          : user?.wallet
            ? "your wallet"
            : "—";

  const out = () => {
    signOut();
    router.push("/");
  };

  return (
    <div className="midpad" style={{ maxWidth: 760 }}>
      <div className="cd" style={{ fontSize: 24 }}>Profile</div>

      {/* account */}
      <div className="card" style={{ marginTop: 22, padding: "20px 22px", display: "flex", alignItems: "center", gap: 16 }}>
        <img
          src={pfp ?? avatar(seed, "d9f2e1")}
          style={{ width: 60, height: 60, borderRadius: "50%", background: "#d9f2e1", boxShadow: "0 0 0 2px #fff", objectFit: "cover" }}
          alt=""
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cd" style={{ fontSize: 19 }}>{displayName}</div>
          <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: "#988990", marginTop: 2 }}>{wallet ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}` : "—"}</div>
        </div>
        <button
          onClick={() => setEditOpen(true)}
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#B81540", background: "#FFE7EC", border: "none", padding: "8px 14px", borderRadius: 20, cursor: "pointer", flex: "none" }}
        >
          <PencilSimple size={13} weight="bold" /> Edit
        </button>
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#B3A6AB", margin: "8px 4px 0" }}>Connected via {method}</div>

      <Section title="Your bets & money">
        <NavRow href="/wallet" Icon={Wallet} title="Wallet" desc="Balance, add funds, cash out" />
        <NavRow href="/results" Icon={ChartDonut} title="Your bets" desc="Open positions and settled results" />
        <NavRow href="/proof" Icon={ShieldCheck} title="How it settles" desc="TxLINE proves the score on-chain" />
        <NavRow href="/docs" Icon={BookOpen} title="Technical docs" desc="Architecture, markets, settlement" />
        <NavRow href="https://github.com/Immadominion/Chum-Bucket/releases/latest/download/chumbucket.apk" Icon={DownloadSimple} title="Get the Android app" desc="The full ChumBucket app on your phone" last />
      </Section>

      <Section title="Social">
        <Link href="/friends" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", textDecoration: "none", color: "inherit", borderBottom: "1px solid #F9F3F5" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Users size={17} weight="fill" color="#FF3355" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Friends</div>
              <div style={{ fontSize: 12, color: "#988990", fontWeight: 600 }}>Same friends list as the app</div>
            </div>
          </div>
          <CaretRight size={15} color="#B3A6AB" />
        </Link>
        <Link href="/send" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", textDecoration: "none", color: "inherit" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <PaperPlaneRight size={17} weight="fill" color="#FF3355" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Send &amp; receive SOL</div>
              <div style={{ fontSize: 12, color: "#988990", fontWeight: 600 }}>Peer-to-peer, straight from your wallet</div>
            </div>
          </div>
          <CaretRight size={15} color="#B3A6AB" />
        </Link>
      </Section>

      {/* ownership */}
      <div className="ink" style={{ marginTop: 18, padding: 22 }}>
        <div className="glow" style={{ right: -30, bottom: -30, width: 140, height: 140, background: "radial-gradient(circle,rgba(255,255,255,.2),transparent 70%)" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 9, position: "relative" }}>
          <SealCheck size={20} weight="fill" color="#fff" />
          <span className="cd" style={{ fontSize: 14, letterSpacing: ".5px", color: "#fff" }}>SETTLED ON-CHAIN, NOT BY US</span>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "rgba(255,255,255,.85)", fontWeight: 500, position: "relative" }}>
          Every bet locks in a Solana escrow and pays out from the real match result, proven by TxLINE. It&rsquo;s verifiable on-chain, and no one (not even us) can change who won.
        </p>
        <div className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginTop: 10, position: "relative" }}>{wallet ? `${wallet.slice(0, 10)}…` : ""}</div>
      </div>

      <button onClick={out} style={{ marginTop: 18, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#fff", border: "1.5px solid #F0D6D7", color: "#C2373B", borderRadius: 14, padding: 14, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
        <SignOut size={17} weight="bold" />
        Sign out
      </button>

      <EditProfileModal open={editOpen} onClose={() => setEditOpen(false)} currentHandle={handle} />
    </div>
  );
}

function NavRow({ href, Icon, title, desc, last }: { href: string; Icon: typeof Users; title: string; desc: string; last?: boolean }) {
  const external = href.startsWith("http");
  const inner = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon size={17} weight="fill" color="#FF3355" />
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
          <div style={{ fontSize: 12, color: "#988990", fontWeight: 600 }}>{desc}</div>
        </div>
      </div>
      <CaretRight size={15} color="#B3A6AB" />
    </>
  );
  const style = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", textDecoration: "none", color: "inherit", borderBottom: last ? "none" : "1px solid #F9F3F5" } as const;
  return external ? (
    <a href={href} style={style}>{inner}</a>
  ) : (
    <Link href={href} style={style}>{inner}</Link>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="cd" style={{ fontSize: 16, margin: "26px 0 12px" }}>{title}</div>
      <div className="card" style={{ padding: 6 }}>{children}</div>
    </>
  );
}

