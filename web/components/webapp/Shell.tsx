"use client";

/**
 * The frame around every signed-in screen. Phones get the app's floating
 * bottom bar (Home, Markets, Friends, Profile) and a call button; wider
 * screens get a rail with the same places plus Activity and the
 * leaderboard, and from 1180px a column of people worth following.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { appPath } from "@/lib/webapp/paths";
import { RecordChip } from "./cards";
import { Icon } from "./Icon";
import { useLeaderboard, useMe, useSuggested, useUnread } from "./queries";
import { useViewer } from "./session";
import { Avatar, useTrail } from "./ui";

/* eslint-disable @next/next/no-img-element */

type Place = "home" | "markets" | "friends" | "activity" | "leaderboard" | "profile";

function placeOf(path: string, handle: string | null): Place | null {
  if (path === appPath.home) return "home";
  if (path.startsWith(appPath.markets) || path.startsWith("/app/m/")) return "markets";
  if (path.startsWith(appPath.friends)) return "friends";
  if (path.startsWith(appPath.activity)) return "activity";
  if (path.startsWith(appPath.leaderboard)) return "leaderboard";
  if (path.startsWith(appPath.me)) return "profile";
  if (handle && path.toLowerCase() === appPath.person(handle).toLowerCase()) return "profile";
  return null;
}

const NAV: ReadonlyArray<{ id: Place; label: string; href: string; icon: string; solid: string; phone: boolean }> = [
  { id: "home", label: "Home", href: appPath.home, icon: "home-outline", solid: "home-solid", phone: true },
  { id: "markets", label: "Markets", href: appPath.markets, icon: "chart-pie-alt-outline", solid: "chart-pie-alt-solid", phone: true },
  { id: "friends", label: "Friends", href: appPath.friends, icon: "group-151-outline", solid: "group-151-outline", phone: true },
  { id: "activity", label: "Activity", href: appPath.activity, icon: "notification-outline", solid: "notification-solid", phone: false },
  { id: "leaderboard", label: "Leaderboard", href: appPath.leaderboard, icon: "award-outline", solid: "award-solid", phone: false },
  { id: "profile", label: "Profile", href: appPath.me, icon: "user-outline", solid: "user-solid", phone: true },
];

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="wa-badge" aria-hidden>
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const viewer = useViewer();
  const path = usePathname() ?? appPath.home;
  const here = placeOf(path, viewer.handle);
  useTrail(path);
  const unread = useUnread().data ?? 0;
  const me = useMe().data?.profile;
  const meCard = {
    displayName: me?.displayName ?? viewer.handle ?? "You",
    avatarUrl: null,
    avatarId: me?.avatarId ?? null,
  };

  return (
    <div className="wa-shell">
      <nav className="wa-rail" aria-label="Main">
        <Link href={appPath.home} className="wa-brand" aria-label="Chumbucket home">
          <img src="/img/logo-192.png" alt="" width={36} height={36} />
          <span>CHUMBUCKET</span>
        </Link>
        <div className="wa-railnav">
          {NAV.map((n) => (
            <Link
              key={n.id}
              href={n.href}
              aria-current={here === n.id ? "page" : undefined}
              aria-label={n.id === "activity" && unread ? `Activity, ${unread} new` : n.label}
              title={n.label}
            >
              <Icon name={here === n.id ? n.solid : n.icon} size={24} />
              <span className="wa-navlabel">{n.label}</span>
              {n.id === "activity" ? <Badge count={unread} /> : null}
            </Link>
          ))}
        </div>
        <Link href={appPath.markets} className="wa-btn wa-btn--primary wa-railcta" aria-label="Make a call" title="Make a call">
          <Icon name="plus" size={22} />
          <span className="wa-navlabel">Make a call</span>
        </Link>
        <Link href={appPath.me} className="wa-railme" aria-label="Your profile">
          <Avatar person={meCard} size={40} />
          <span className="wa-railme-text">
            <span className="wa-person-name" style={{ display: "block" }}>
              {meCard.displayName}
            </span>
            {viewer.handle ? <span className="wa-person-meta">@{viewer.handle}</span> : null}
          </span>
        </Link>
      </nav>

      <main className="wa-main" id="main">
        <div className="wa-page">{children}</div>
      </main>

      <Aside />

      <nav className="wa-bottomnav" aria-label="Main">
        {NAV.filter((n) => n.phone).map((n) => (
          <Link key={n.id} href={n.href} aria-current={here === n.id ? "page" : undefined}>
            <Icon name={here === n.id ? n.solid : n.icon} size={22} />
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
      {here === "home" || here === "friends" || here === "profile" ? (
        <Link href={appPath.markets} className="wa-fab" aria-label="Make a call">
          <Icon name="plus" size={26} />
        </Link>
      ) : null}
    </div>
  );
}

/** People worth following and the best records, beside the page on wide screens. */
function Aside() {
  const suggested = useSuggested();
  const board = useLeaderboard("30d");
  const people = [...(suggested.data?.friends ?? []), ...(suggested.data?.people ?? [])]
    .filter((p) => !p.viewerIsFollowing)
    .slice(0, 4);
  const top = (board.data?.ranked.length ? board.data.ranked : (board.data?.building ?? [])).slice(0, 5);
  return (
    <aside className="wa-aside" aria-label="People">
      {people.length ? (
        <section className="wa-aside-card">
          <h2 className="wa-aside-title">
            Who to follow
            <Link href={appPath.friends} aria-label="Find more people">
              <Icon name="arrow-right" size={20} />
            </Link>
          </h2>
          <ul className="wa-rows" style={{ padding: 0 }}>
            {people.map((p) => (
              <AsidePerson key={p.id} person={p} />
            ))}
          </ul>
        </section>
      ) : null}
      {top.length ? (
        <section className="wa-aside-card">
          <h2 className="wa-aside-title">
            Top callers
            <Link href={appPath.leaderboard} aria-label="Open the leaderboard">
              <Icon name="arrow-right" size={20} />
            </Link>
          </h2>
          <ol className="wa-rows" style={{ padding: 0 }}>
            {top.map((row, i) => (
              <li key={row.person.id} className="wa-row">
                <span className="wa-row-rank">{row.rank ?? i + 1}</span>
                <Link href={appPath.person(row.person.handle)} className="wa-person">
                  <Avatar person={row.person} size={38} />
                  <span className="wa-person-text">
                    <span className="wa-person-name">{row.person.displayName}</span>
                    <span className="wa-person-meta">@{row.person.handle}</span>
                  </span>
                </Link>
                <RecordChip record={row.record} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <footer className="wa-aside-foot">
        <Link href="/">chumbucket.fun</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <span>Calls are free. Trades on Panta use real USDC and can lose money.</span>
      </footer>
    </aside>
  );
}

function AsidePerson({
  person,
}: {
  person: { id: string; handle: string; displayName: string; avatarUrl: string | null; avatarId?: number | null; record: import("@/lib/webapp/types").PublicRecord };
}) {
  return (
    <li className="wa-row">
      <Link href={appPath.person(person.handle)} className="wa-person">
        <Avatar person={person} size={38} />
        <span className="wa-person-text">
          <span className="wa-person-name">{person.displayName}</span>
          <span className="wa-person-meta">@{person.handle}</span>
        </span>
      </Link>
      <RecordChip record={person.record} />
    </li>
  );
}
