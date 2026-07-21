"use client";

/**
 * Social proof for a fixture — the "who's predicting" strip the mobile app shows
 * and the web didn't. Renders an avatar stack + "N predictions on this" from the
 * public trpc.matchCallers endpoint. Returns nothing when there are no callers
 * yet (honest empty, not a fake count).
 */

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { avatar } from "@/lib/data";

export function MatchCallers({ matchId, tone = "light" }: { matchId: string; tone?: "light" | "dark" }) {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.matchCallers.queryOptions({ matchId, limit: 24 }),
    staleTime: 15_000,
    refetchInterval: 20_000,
  });
  const callers = q.data ?? [];
  if (callers.length === 0) return null;

  const shown = callers.slice(0, 4);
  const ringBg = tone === "dark" ? "rgba(255,255,255,.9)" : "#fff";
  const textColor = tone === "dark" ? "rgba(255,255,255,.9)" : "#988990";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ display: "flex" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {shown.map((c, i) => (
          <img
            key={c.wallet_address}
            src={avatar(c.wallet_address, "ffe0b2")}
            alt=""
            style={{ width: 22, height: 22, borderRadius: "50%", boxShadow: `0 0 0 1.5px ${ringBg}`, marginLeft: i ? -7 : 0, background: "#eee" }}
          />
        ))}
      </div>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: textColor }}>
        {callers.length} {callers.length === 1 ? "prediction" : "predictions"} on this
      </span>
    </div>
  );
}
