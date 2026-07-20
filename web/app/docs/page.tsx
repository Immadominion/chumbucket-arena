"use client";

/**
 * Technical documentation — architecture, on-chain program, and the TxLINE
 * settlement flow, for judges/engineers who want the real shape of the
 * system rather than the pitch. Mirrors /proof's visual language.
 */

import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  SoccerBall,
  Wallet,
  ShieldCheck,
  LockSimple,
  ChartDonut,
  GithubLogo,
  Stack,
  BookOpen,
} from "@/components/icons";

const PROGRAM_ID = "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG";
const SETTLE_TX =
  "553CkpvcpddtBzEmPPxvMJHzJXFS73f2aJ79J5BtrrdAUBrhnrLfKQKikUZcDxzRZwz39JR2FxsJFZzUfAVJrAB8";

export default function DocsPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#1A1013", color: "#F7EEF0" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 22px 80px" }}>
        <Link
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 13,
            fontWeight: 700,
            color: "#FFB0C0",
            textDecoration: "none",
            marginBottom: 34,
          }}
        >
          <ArrowLeft size={15} weight="bold" /> ChumBucket
        </Link>

        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            background: "rgba(242,58,92,.12)",
            border: "1px solid rgba(242,58,92,.25)",
            borderRadius: 30,
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 700,
            color: "#FFB0C0",
          }}
        >
          <BookOpen size={14} weight="fill" /> Technical documentation
        </div>
        <h1
          className="cd"
          style={{
            fontSize: 40,
            lineHeight: 1.05,
            color: "#fff",
            margin: "18px 0 0",
            letterSpacing: 0,
            textWrap: "balance",
          }}
        >
          How ChumBucket works.
        </h1>
        <p style={{ fontSize: 15.5, lineHeight: 1.5, color: "#D9C3C9", margin: "14px 0 0", maxWidth: 580 }}>
          A social prediction market for football: predict a match, challenge a friend, and let the real result settle
          it on-chain via TxLINE. This page is the architecture, not the pitch — see{" "}
          <Link href="/proof" style={{ color: "#FFB0C0" }}>
            /proof
          </Link>{" "}
          for a real settlement walked end to end.
        </p>

        {/* stack */}
        <Section title="STACK" icon={<Stack size={14} weight="fill" color="#FFB0C0" />}>
          <Row title="Mobile" body="Flutter, connects via Mobile Wallet Adapter (MWA) — Android/Solana Mobile native." />
          <Row title="Web" body="Next.js (App Router) at chumbucket.fun — the same markets, wallet flow, and settlement, browser-side." />
          <Row title="Backend" body="Bun + tRPC. Event-sourced read model (matches, pools, positions) driven off on-chain + TxLINE data." />
          <Row title="On-chain" body="An Anchor program on Solana devnet — parimutuel pools, per-market settlement, no custody of the settlement decision itself." />
        </Section>

        {/* markets */}
        <Section title="MARKETS" icon={<SoccerBall size={14} weight="fill" color="#FFB0C0" />}>
          <p style={{ fontSize: 13.5, color: "#B3A6AB", lineHeight: 1.6, margin: 0 }}>
            Every fixture opens with a full book — Result (home / draw / away), Total Goals (Over/Under 1.5, 2.5,
            3.5), and Winning Margin (handicap 1.5, 2.5). Every market settles from the same source: the verified
            final score, so nothing here is a market TxLINE can&rsquo;t actually prove.
          </p>
        </Section>

        {/* settlement */}
        <Section title="SETTLEMENT" icon={<ShieldCheck size={14} weight="fill" color="#FFB0C0" />}>
          <Row
            title="1. TxLINE commits the score on-chain"
            body="TxLINE's oracle posts a Merkle-committed score to Solana as the match plays and finishes."
          />
          <Row
            title="2. A Solana program CPIs into TxLINE's validate_stat"
            body="Our program derives a predicate from the market (e.g. total goals > 2) and proves it against TxLINE's on-chain data before any position can be paid — no human decides the winner."
          />
          <Row
            title="3. Anyone can re-check it"
            body="The check is a public on-chain read. See it re-run live against a real settlement at /proof."
          />
        </Section>

        {/* wallet + money */}
        <Section title="MONEY" icon={<Wallet size={14} weight="fill" color="#FFB0C0" />}>
          <p style={{ fontSize: 13.5, color: "#B3A6AB", lineHeight: 1.6, margin: 0 }}>
            Bets are parimutuel — your stake moves into a shared, on-chain pool for that market, never into another
            player&rsquo;s wallet. Winners split the losing side&rsquo;s pool (minus a small platform fee) in proportion to
            their stake. Fewer than 3 entrants in a pool and everyone gets a full refund. This build runs on Solana
            devnet with test USDC; the original ChumBucket challenge product has live mainnet history (see links
            below).
          </p>
        </Section>

        {/* traction */}
        <Section title="TRACTION" icon={<ChartDonut size={14} weight="fill" color="#FFB0C0" />}>
          <p style={{ fontSize: 13.5, color: "#B3A6AB", lineHeight: 1.6, margin: 0 }}>
            185 production profiles and 49 challenge records on the original mainnet product. Its public mainnet
            escrow confirms 15 funded challenge creations locking 0.19 SOL, 13 successful resolutions, and 0.00325
            SOL in protocol fees.
          </p>
        </Section>

        {/* links */}
        <Section title="LINKS" icon={<GithubLogo size={14} weight="fill" color="#FFB0C0" />}>
          <LinkRow href="https://github.com/Immadominion/chumbucket-arena" label="Backend + web + on-chain repo" />
          <LinkRow href="https://github.com/Immadominion/Chum-Bucket" label="Mobile repo (Flutter)" />
          <LinkRow href="https://chumbucket-arena-production.up.railway.app/health" label="Backend health" />
          <LinkRow
            href={`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`}
            label="On-chain program (devnet)"
          />
          <LinkRow
            href={`https://explorer.solana.com/tx/${SETTLE_TX}?cluster=devnet`}
            label="A real TxLINE-settled result (devnet)"
          />
          <LinkRow
            href="https://github.com/Immadominion/Chum-Bucket/releases/latest/download/chumbucket.apk"
            label="Download the Android app (APK)"
          />
        </Section>

        <div style={{ marginTop: 40, display: "flex", alignItems: "center", gap: 8, color: "#7A6B70", fontSize: 12 }}>
          <LockSimple size={13} weight="bold" /> Built for the TxODDS / TxLINE World Cup hackathon.
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 34 }}>
      <div
        className="cd"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 14,
          color: "#FFB0C0",
          letterSpacing: ".4px",
          marginBottom: 14,
        }}
      >
        {icon} {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

function Row({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,.03)", borderRadius: 14, padding: "14px 16px" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>{title}</div>
      <div style={{ fontSize: 13, color: "#B3A6AB", marginTop: 3, lineHeight: 1.45 }}>{body}</div>
    </div>
  );
}

function LinkRow({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "rgba(255,255,255,.03)",
        borderRadius: 14,
        padding: "13px 16px",
        color: "#F7EEF0",
        textDecoration: "none",
        fontSize: 13.5,
        fontWeight: 600,
      }}
    >
      {label}
      <ArrowUpRight size={15} color="#FFB0C0" />
    </a>
  );
}
