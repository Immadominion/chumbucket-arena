"use client";

/**
 * The leaderboard: people ranked by their public call record, never by
 * money. Nobody gets a rank (or a percentage) before enough of their calls
 * have settled; they appear underneath, still building one.
 */

import { useEffect, useState } from "react";
import { readPref, writePref } from "@/lib/webapp/cache";
import { RecordChip, PersonRow } from "../cards";
import { browserStorage } from "../data";
import { useLeaderboard } from "../queries";
import { useViewer } from "../session";
import { Avatar, Segmented, StateScreen, TopBar } from "../ui";
import { screenError } from "./common";
import { RowsSkeleton } from "./FriendsScreen";

type Window = "7d" | "30d" | "all";
const WINDOWS = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
] as const;

export function LeaderboardScreen() {
  const viewer = useViewer();
  const [window, setWindow] = useState<Window>(() =>
    readPref<Window>(browserStorage(), "boardWindow", (v) => (v === "7d" || v === "all" ? v : "30d"), "30d"),
  );
  useEffect(() => writePref(browserStorage(), "boardWindow", window), [window]);
  const q = useLeaderboard(window);
  const d = q.data;
  const rows = d ? [...d.ranked, ...d.building] : [];
  const meInList = rows.some((r) => r.person.id === viewer.userId);

  return (
    <>
      <TopBar title="Leaderboard" back />
      <div style={{ marginBottom: 14 }}>
        <Segmented options={WINDOWS} value={window} onChange={setWindow} label="Window" block />
      </div>
      {rows.length ? (
        <>
          <section className="wa-card">
            <ol className="wa-rows">
              {d!.ranked.map((r) => (
                <PersonRow key={r.person.id} person={{ ...r.person, record: r.record }} rank={r.rank} showFollow={false} />
              ))}
              {d!.building.length ? (
                <li className="wa-chip wa-chip--plain" style={{ padding: "10px 12px 2px", height: "auto" }} aria-hidden>
                  Building a record
                </li>
              ) : null}
              {d!.building.map((r) => (
                <PersonRow key={r.person.id} person={{ ...r.person, record: r.record }} rank={null} showFollow={false} />
              ))}
            </ol>
          </section>
          {d!.viewer && !meInList ? (
            <section className="wa-card" style={{ position: "sticky", bottom: 96, marginTop: 12 }} aria-label="Your place">
              <div className="wa-row">
                <span className="wa-row-rank">{d!.viewer.rank ?? "·"}</span>
                <span className="wa-person" style={{ flex: 1 }}>
                  <Avatar person={d!.viewer.person} size={44} />
                  <span className="wa-person-text">
                    <span className="wa-person-name">You</span>
                    <span className="wa-person-meta">
                      {d!.viewer.decidedToRank > 0 ? `${d!.viewer.decidedToRank} more settled to rank` : `@${d!.viewer.person.handle}`}
                    </span>
                  </span>
                </span>
                <RecordChip record={d!.viewer.record} />
              </div>
            </section>
          ) : null}
        </>
      ) : q.isPending ? (
        <RowsSkeleton />
      ) : q.isError ? (
        screenError(q.error, () => void q.refetch())
      ) : (
        <StateScreen art="record" line="No settled calls yet" action={{ label: "Make a call", href: "/app/markets" }} />
      )}
    </>
  );
}
