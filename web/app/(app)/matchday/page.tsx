"use client";

import Link from "next/link";
import { ArrowRight, CaretRight, CheckCircle, Clock, DownloadSimple, Fire, LockSimple, Trophy } from "@/components/icons";
import ErrorState from "@/components/ErrorState";
import { flag } from "@/lib/data";
import { useGameData } from "@/lib/useGameData";
import type { MatchView } from "@/lib/adapters";
import { flagCode, frostToWal, kickoffLabel } from "@/lib/format";
import { downloadIcs } from "@/lib/ics";

/* eslint-disable @next/next/no-img-element */

const resultMarket = (m: MatchView) => m.markets.find((mk) => mk.marketId === "RESULT") ?? m.markets[0];
const potOf = (m: MatchView) => {
  const mk = resultMarket(m);
  return mk ? frostToWal(mk.grossPot) : 0;
};
const winnerOf = (m: MatchView): string | null => {
  const wb = resultMarket(m)?.winningBucket;
  return wb === "HOME" ? m.fixture.home : wb === "AWAY" ? m.fixture.away : wb === "DRAW" ? "Draw" : null;
};
// How many markets you can back on this fixture (Result + any line markets).
const marketCount = (m: MatchView) => m.markets.length;

export default function MatchdayPage() {
  const g = useGameData();
  const all = g.matches;
  const open = all.filter((m) => m.status === "OPEN");
  const live = all.filter((m) => m.status === "LOCKED");
  const played = all.filter((m) => m.status === "RESOLVED");
  const featured = open[0];
  const called = g.calledMatchIds;

  // A failed fetch must not masquerade as "no fixtures open" — show the real error.
  if (g.isError && all.length === 0) {
    return <ErrorState onRetry={g.refetch} />;
  }

  if (g.loading && all.length === 0) {
    return (
      <div className="midpad" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh", color: "#988990", fontWeight: 600, fontSize: 14 }}>
        Loading fixtures…
      </div>
    );
  }

  return (
    <div className="midpad">
      <div style={{ display: "flex", alignItems: "center" }}>
        <div>
          <div className="cd" style={{ fontSize: 24 }}>Matchday</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#988990", marginTop: 2 }}>
            {open.length} to predict · {live.length} in play · {played.length} finished
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {open.length > 0 && (
            <button onClick={() => downloadIcs(open)} title="Download open fixtures as a calendar file" style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: "1.5px solid #EFE6E9", borderRadius: 11, padding: "8px 13px", fontWeight: 700, fontSize: 12.5, color: "#221217", cursor: "pointer" }}>
              <DownloadSimple size={15} weight="bold" color="#FF3355" /> Add to calendar
            </button>
          )}
          {called.size > 0 && (
            <span style={{ fontSize: 12, fontWeight: 700, color: "#B81540", background: "#FFE7EC", padding: "7px 13px", borderRadius: 20 }}>
              You&rsquo;re in {called.size} {called.size === 1 ? "match" : "matches"}
            </span>
          )}
        </div>
      </div>

      {/* featured (first open) */}
      {featured && (
        <Link href={`/call/${featured.fixture.matchId}`} style={{ display: "block", textDecoration: "none", color: "inherit", marginTop: 22 }}>
          <div style={{ background: "linear-gradient(120deg,#1A1013,#26161B 70%)", borderRadius: 24, padding: "22px 24px", position: "relative", overflow: "hidden", display: "flex", alignItems: "center", gap: 20 }}>
            <div style={{ position: "absolute", right: -30, top: -30, width: 160, height: 160, borderRadius: "50%", background: "radial-gradient(circle,rgba(255, 51, 85,.25),transparent 70%)" }} />
            <div style={{ display: "flex", alignItems: "center", position: "relative" }}>
              <img src={flag(flagCode(featured.fixture.home) ?? "", 160)} style={{ width: 52, height: 52, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px rgba(255,255,255,.2)" }} alt="" />
              <img src={flag(flagCode(featured.fixture.away) ?? "", 160)} style={{ width: 52, height: 52, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px rgba(255,255,255,.2)", marginLeft: -16 }} alt="" />
            </div>
            <div style={{ flex: 1, position: "relative" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#FF5A76", color: "#3a0510", fontSize: 11, fontWeight: 700, padding: "4px 11px", borderRadius: 20 }}>
                <Fire size={12} weight="fill" /> Featured
              </span>
              <div className="cd" style={{ fontSize: 26, color: "#fff", marginTop: 10 }}>{featured.fixture.home} <span style={{ color: "#6A5A60" }}>vs</span> {featured.fixture.away}</div>
              <div style={{ fontSize: 12.5, color: "#B8C6BD", fontWeight: 600, marginTop: 4 }}>{featured.fixture.group ?? featured.fixture.stage} · {kickoffLabel(featured.fixture.kickoff).koTag}{marketCount(featured) > 1 ? ` · ${marketCount(featured)} ways to predict` : ""}</div>
            </div>
            <div style={{ position: "relative", textAlign: "right" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", color: "#fff" }}>
                <Trophy size={15} weight="fill" color="#F2B705" />
                <span className="mono" style={{ fontWeight: 700, fontSize: 14 }}>{Math.round(potOf(featured)).toLocaleString()}</span>
              </div>
              <span className="btnp" style={{ fontSize: 13.5, padding: "10px 18px", borderRadius: 12, marginTop: 12 }}>
                {called.has(featured.fixture.matchId) ? "You're in" : "Predict"} <ArrowRight size={15} weight="bold" />
              </span>
            </div>
          </div>
        </Link>
      )}

      {open.length === 0 && live.length === 0 && played.length === 0 ? (
        <div className="card" style={{ marginTop: 26, padding: "40px 24px", textAlign: "center", fontSize: 14, fontWeight: 600, color: "#988990" }}>
          No matches scheduled yet — check back before the next round.
        </div>
      ) : (
        <>
          <Group title="Open to predict" count={open.length}>
            {open.map((m) => <Row key={m.fixture.matchId} m={m} called={called.has(m.fixture.matchId)} kind="open" />)}
            {open.length === 0 && <Empty>No matches open to predict right now.</Empty>}
          </Group>

          {live.length > 0 && (
            <Group title="In play" count={live.length}>
              {live.map((m) => <Row key={m.fixture.matchId} m={m} called={called.has(m.fixture.matchId)} kind="live" />)}
            </Group>
          )}

          {played.length > 0 && (
            <Group title="Finished" count={played.length}>
              {played.map((m) => <Row key={m.fixture.matchId} m={m} called={called.has(m.fixture.matchId)} kind="played" />)}
            </Group>
          )}
        </>
      )}
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <>
      <div className="cd" style={{ fontSize: 16, margin: "26px 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
        {title} <span style={{ fontSize: 12, fontWeight: 700, color: "#988990" }}>{count}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card" style={{ padding: "20px 18px", textAlign: "center", fontSize: 13, fontWeight: 600, color: "#988990" }}>{children}</div>;
}

function Row({ m, called, kind }: { m: MatchView; called: boolean; kind: "open" | "live" | "played" }) {
  const f = m.fixture;
  const inner = (
    <>
      <div style={{ display: "flex", alignItems: "center" }}>
        <img src={flag(flagCode(f.home) ?? "")} style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff" }} alt="" />
        <img src={flag(flagCode(f.away) ?? "")} style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", boxShadow: "0 0 0 2px #fff", marginLeft: -12 }} alt="" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="cd" style={{ fontSize: 16 }}>
          {f.home} {kind === "played" && m.score ? <span className="mono" style={{ color: "#6A5A60", fontWeight: 700 }}>{m.score.home}–{m.score.away}</span> : "v"} {f.away}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#988990", marginTop: 2 }}>
          {kind === "open" && <><Clock size={13} weight="fill" /> {kickoffLabel(f.kickoff).ko} · {f.group ?? f.stage}{marketCount(m) > 1 ? ` · ${marketCount(m)} ways to predict` : ""}</>}
          {kind === "live" && <span style={{ color: "#C2373B", fontWeight: 700 }}>● Started — predictions closed</span>}
          {kind === "played" && <>{winnerOf(m) ? `${winnerOf(m)} ${winnerOf(m) === "Draw" ? "" : "won"}` : "Settled"} · {f.group ?? f.stage}</>}
        </div>
      </div>
      {called && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: "#B81540", background: "#FFE7EC", padding: "5px 10px", borderRadius: 20 }}>
          <CheckCircle size={12} weight="fill" /> In
        </span>
      )}
      <div style={{ textAlign: "right", minWidth: 70 }}>
        <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: "#988990" }}>{Math.round(potOf(m)).toLocaleString()} USDC</div>
        {kind === "open" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, fontWeight: 700, color: "#B81540", marginTop: 4 }}>
            {called ? "Add a pick" : "Predict"} <CaretRight size={13} weight="bold" />
          </span>
        )}
        {kind === "live" && (
          <span title="Predictions closed" aria-label="Predictions closed" style={{ display: "inline-flex", marginTop: 6 }}>
            <LockSimple size={15} weight="fill" color="#CBBFC3" />
          </span>
        )}
        {kind === "played" && called && (
          <Link href="/results" style={{ fontSize: 12, fontWeight: 700, color: "#FF3355", textDecoration: "none" }}>Result</Link>
        )}
      </div>
    </>
  );

  const style = { padding: "16px 18px", display: "flex", alignItems: "center", gap: 16, color: "inherit" } as const;
  return kind === "open" ? (
    <Link href={`/call/${f.matchId}`} className="card" style={{ ...style, textDecoration: "none" }}>{inner}</Link>
  ) : (
    <div className="card" style={{ ...style, opacity: kind === "played" ? 0.85 : 1 }}>{inner}</div>
  );
}
