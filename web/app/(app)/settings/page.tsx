"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useQuery } from "@tanstack/react-query";
import { CaretRight, PencilSimple, PaperPlaneRight, SealCheck, SignOut, Users } from "@/components/icons";
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
  const handle = session.handle || "Manager";
  const wallet = session.wallet || "";
  const seed = session.handle || "manager";

  const privyId = user?.id ?? "";
  const profileQ = useQuery({
    queryKey: ["supabase-profile", privyId],
    queryFn: () => fetchSupabaseProfile(privyId),
    enabled: !!privyId,
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

  const [notif, setNotif] = useState({ matchday: true, settle: true, ladder: true, mentions: false });
  const [publicDossier, setPublicDossier] = useState(true);

  const out = () => {
    signOut();
    router.push("/");
  };

  return (
    <div className="midpad" style={{ maxWidth: 760 }}>
      <div className="cd" style={{ fontSize: 24 }}>Settings</div>

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

      <Section title="Social">
        <Link href="/friends" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", textDecoration: "none", color: "inherit", borderBottom: "1px solid #F9F3F5" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Users size={17} weight="fill" color="#F2385A" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Friends</div>
              <div style={{ fontSize: 12, color: "#988990", fontWeight: 600 }}>Same friends list as the app</div>
            </div>
          </div>
          <CaretRight size={15} color="#B3A6AB" />
        </Link>
        <Link href="/send" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", textDecoration: "none", color: "inherit" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <PaperPlaneRight size={17} weight="fill" color="#F2385A" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Send &amp; receive SOL</div>
              <div style={{ fontSize: 12, color: "#988990", fontWeight: 600 }}>Peer-to-peer, straight from your wallet</div>
            </div>
          </div>
          <CaretRight size={15} color="#B3A6AB" />
        </Link>
      </Section>

      <Section title="Notifications">
        <Toggle label="Matchday reminders" desc="A nudge before fixtures lock" on={notif.matchday} set={(v) => setNotif({ ...notif, matchday: v })} />
        <Toggle label="Settlement alerts" desc="When your calls are resolved" on={notif.settle} set={(v) => setNotif({ ...notif, settle: v })} />
        <Toggle label="Promotions & demotions" desc="Moving up (or down) the Squad Ladder" on={notif.ladder} set={(v) => setNotif({ ...notif, ladder: v })} />
        <Toggle label="Verdict mentions" desc="When the squad shares a Verdict about you" on={notif.mentions} set={(v) => setNotif({ ...notif, mentions: v })} last />
      </Section>
      <div style={{ fontSize: 11.5, color: "#B3A6AB", fontWeight: 500, lineHeight: 1.45, margin: "8px 4px 0" }}>
        These surface in-app (the 🔔 bell on the Touchline). Email &amp; push aren&rsquo;t wired up yet — a one-tap &ldquo;add fixtures to calendar&rdquo; export is the planned way to get real match reminders.
      </div>

      <Section title="Privacy">
        <Toggle label="Public profile" desc="Let anyone see your betting record" on={publicDossier} set={setPublicDossier} />
        <Link href={`/p/${wallet}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", textDecoration: "none", color: "inherit" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>View my public page</div>
            <div style={{ fontSize: 12, color: "#988990", fontWeight: 600 }}>What visitors see when you share</div>
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#F2385A" }}>Open ↗</span>
        </Link>
      </Section>

      {/* ownership */}
      <div className="ink" style={{ marginTop: 18, padding: 22 }}>
        <div className="glow" style={{ right: -30, bottom: -30, width: 140, height: 140, background: "radial-gradient(circle,rgba(242,58,92,.2),transparent 70%)" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 9, position: "relative" }}>
          <SealCheck size={20} weight="fill" color="#FFB0C0" />
          <span className="cd" style={{ fontSize: 14, letterSpacing: ".5px", color: "#fff" }}>YOUR MEMORY IS YOURS</span>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "#B8C6BD", fontWeight: 500, position: "relative" }}>
          Every call, trait and Verdict is written to decentralized storage you own — verifiable, and impossible for anyone (even us) to edit.
        </p>
        <div className="mono" style={{ fontSize: 11, color: "#7E8C84", marginTop: 10, position: "relative" }}>cb:{wallet.slice(0, 10)}…</div>
      </div>

      <button onClick={out} style={{ marginTop: 18, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#fff", border: "1.5px solid #F0D6D7", color: "#C2373B", borderRadius: 14, padding: 14, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
        <SignOut size={17} weight="bold" />
        Sign out
      </button>

      <EditProfileModal open={editOpen} onClose={() => setEditOpen(false)} currentHandle={handle} />
    </div>
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

function Toggle({ label, desc, on, set, last }: { label: string; desc: string; on: boolean; set: (v: boolean) => void; last?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: last ? "none" : "1px solid #F9F3F5" }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 12, color: "#988990", fontWeight: 600 }}>{desc}</div>
      </div>
      <button
        onClick={() => set(!on)}
        aria-pressed={on}
        style={{ width: 46, height: 28, borderRadius: 20, border: "none", cursor: "pointer", background: on ? "#F2385A" : "#D7E0D4", position: "relative", transition: ".18s", flex: "none" }}
      >
        <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 22, height: 22, borderRadius: "50%", background: "#fff", boxShadow: "0 2px 5px rgba(0,0,0,.2)", transition: ".18s" }} />
      </button>
    </div>
  );
}
