"use client";

/** Home: calls from people you follow, or from everyone. */

import Link from "next/link";
import { useEffect, useState } from "react";
import { readPref, writePref } from "@/lib/webapp/cache";
import { BffOffline } from "@/lib/webapp/bff";
import { appPath } from "@/lib/webapp/paths";
import { CallCard } from "../cards";
import { browserStorage } from "../data";
import { Icon } from "../Icon";
import { useFeed, useUnread } from "../queries";
import { LoadMore, Segmented, SkeletonCards, StateScreen, TopBar } from "../ui";

type Mode = "following" | "global";
const MODES = [
  { id: "following", label: "Following" },
  { id: "global", label: "Global" },
] as const;

export function HomeScreen() {
  const [mode, setMode] = useState<Mode>(() =>
    readPref<Mode>(browserStorage(), "homeTab", (v) => (v === "following" ? "following" : "global"), "global"),
  );
  useEffect(() => writePref(browserStorage(), "homeTab", mode), [mode]);
  const unread = useUnread().data ?? 0;
  const feed = useFeed(mode);
  const entries = feed.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <>
      <TopBar title="Home">
        <Link href={appPath.activity} className="wa-iconbtn wa-phone-only" aria-label={unread ? `Activity, ${unread} new` : "Activity"}>
          <Icon name="notification" size={24} />
          {unread ? <span className="wa-badge">{unread > 99 ? "99+" : unread}</span> : null}
        </Link>
      </TopBar>
      <div style={{ marginBottom: 14 }}>
        <Segmented options={MODES} value={mode} onChange={setMode} label="Feed" />
      </div>
      {entries.length ? (
        <>
          <ul className="wa-list">
            {entries.map((e) => (
              <li key={e.call.id}>
                <CallCard entry={e} />
              </li>
            ))}
          </ul>
          <LoadMore onVisible={() => feed.hasNextPage && !feed.isFetchingNextPage && feed.fetchNextPage()} disabled={!feed.hasNextPage} />
        </>
      ) : feed.isPending ? (
        <SkeletonCards />
      ) : feed.isError ? (
        <StateScreen
          art={feed.error instanceof BffOffline ? "offline" : "error"}
          line={feed.error instanceof BffOffline ? "You’re offline" : "Couldn’t load calls"}
          action={{ label: "Try again", onClick: () => void feed.refetch() }}
        />
      ) : mode === "following" ? (
        <StateScreen art="people" line="Follow people to see their calls" action={{ label: "Find people", href: appPath.friends }} />
      ) : (
        <StateScreen art="empty_calls" line="No calls yet" action={{ label: "Make the first call", href: appPath.markets }} />
      )}
    </>
  );
}
