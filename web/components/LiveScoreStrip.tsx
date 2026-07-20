"use client";

/**
 * Live score for a fixture, polled from the same TxLINE snapshot the mobile app
 * reads (trpc.liveScore). Renders nothing until the match has actually kicked off
 * (null snapshot), then shows the running score with a pulsing LIVE badge, and a
 * FULL-TIME badge once a terminal event exists. Purely additive, the bet screen
 * keeps its kick-off pill for not-yet-started matches.
 */

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

export function LiveScoreStrip({ matchId }: { matchId: string }) {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.liveScore.queryOptions({ matchId }),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const live = q.data;
  if (!live) return null;

  const finished = live.finished;

  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <style>{`@keyframes cbLivePulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: ".08em",
          color: finished ? "#5B6B62" : "#B01030",
          background: finished ? "#EEF2EB" : "#FDE7EC",
          padding: "5px 12px",
          borderRadius: 20,
        }}
      >
        {!finished && (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#E01243",
              animation: "cbLivePulse 1.1s ease-in-out infinite",
            }}
          />
        )}
        {finished ? "FULL-TIME" : "LIVE"}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontVariantNumeric: "tabular-nums" }}>
        <span className="cd" style={{ fontSize: 34, lineHeight: 1 }}>{live.score.home}</span>
        <span style={{ fontSize: 22, fontWeight: 700, color: "#CBBFC3" }}>–</span>
        <span className="cd" style={{ fontSize: 34, lineHeight: 1 }}>{live.score.away}</span>
      </div>
    </div>
  );
}
