"use client";

/**
 * Friends: add someone by @username, X handle or wallet (you see who it is
 * before you follow), the people you follow, and people worth following.
 */

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { readPref, writePref } from "@/lib/webapp/cache";
import { appPath } from "@/lib/webapp/paths";
import type { PersonLookup } from "@/lib/webapp/types";
import { PersonRow, useShare } from "../cards";
import { actionError, browserStorage, useToast } from "../data";
import { Icon } from "../Icon";
import { useFollowing, useSuggested } from "../queries";
import { useApi } from "../session";
import { Avatar, Segmented, Spinner, StateScreen, TopBar } from "../ui";
import { screenError } from "./common";

type Tab = "following" | "foryou";

export function FriendsScreen() {
  const [tab, setTab] = useState<Tab>(() =>
    readPref<Tab>(browserStorage(), "friendsTab", (v) => (v === "following" ? "following" : "foryou"), "foryou"),
  );
  useEffect(() => writePref(browserStorage(), "friendsTab", tab), [tab]);
  return (
    <>
      <TopBar title="Friends">
        <Link href={appPath.leaderboard} className="wa-iconbtn wa-phone-only" aria-label="Leaderboard">
          <Icon name="award" size={24} />
        </Link>
      </TopBar>
      <AddFriend />
      <div style={{ margin: "18px 0 12px" }}>
        <Segmented
          options={[
            { id: "foryou", label: "For you" },
            { id: "following", label: "Following" },
          ]}
          value={tab}
          onChange={setTab}
          label="People"
        />
      </div>
      {tab === "following" ? <FollowingList onFind={() => setTab("foryou")} /> : <SuggestedList />}
    </>
  );
}

function AddFriend() {
  const api = useApi();
  const toast = useToast();
  const share = useShare();
  const [query, setQuery] = useState("");
  const find = useMutation<PersonLookup, Error, string>({
    mutationFn: (q) => api.find(q),
    onError: (e) => toast(actionError(e), "error"),
  });
  const result = find.data;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) find.mutate(q);
  };

  return (
    <>
      <form className="wa-searchrow" onSubmit={submit} role="search">
        <Icon name="user-plus" size={20} />
        <label htmlFor="wa-find" className="wa-sr">
          Add a friend by @username, X handle or wallet
        </label>
        <input
          id="wa-find"
          type="text"
          placeholder="@username, X handle or wallet"
          value={query}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => {
            setQuery(e.target.value);
            if (find.data) find.reset();
          }}
        />
        <button type="submit" className="wa-filterbtn" data-active={!!query.trim()} aria-label="Find" disabled={!query.trim() || find.isPending}>
          {find.isPending ? <Spinner /> : <Icon name="arrow-right" size={20} />}
        </button>
      </form>
      {result ? (
        <section className="wa-card" style={{ marginTop: 10 }} aria-live="polite">
          {result.matches.length ? (
            <ul className="wa-rows">
              {result.matches.map((m) => (
                <PersonRow
                  key={m.person.id}
                  person={{ ...m.person, record: null }}
                  showFollow={!m.isViewer}
                  extra={
                    m.xHandle ? (
                      <span className="wa-xhandle" title={`@${m.xHandle} on X`}>
                        <Icon name="x-brand" size={12} />
                        <span className="wa-sr">X account </span>
                        {m.xHandle}
                      </span>
                    ) : null
                  }
                />
              ))}
            </ul>
          ) : result.notOnChumbucket ? (
            <div className="wa-row">
              <Avatar person={{ displayName: result.notOnChumbucket.xHandle, avatarUrl: result.notOnChumbucket.xAvatarUrl }} size={44} />
              <span className="wa-person-text" style={{ flex: 1 }}>
                <span className="wa-person-name">@{result.notOnChumbucket.xHandle}</span>
                <span className="wa-person-meta">Not on Chumbucket yet</span>
              </span>
              <button type="button" className="wa-follow" onClick={() => share("/", "Chumbucket")}>
                <Icon name="send" size={15} />
                Invite
              </button>
            </div>
          ) : (
            <StateScreen art="search" line="No one by that name" full={false} compact />
          )}
        </section>
      ) : null}
    </>
  );
}

function FollowingList({ onFind }: { onFind: () => void }) {
  const q = useFollowing();
  const people = q.data?.people ?? [];
  if (people.length)
    return (
      <section className="wa-card">
        <ul className="wa-rows">
          {people.map((p) => (
            <PersonRow key={p.id} person={{ ...p, viewerIsFollowing: true }} />
          ))}
        </ul>
      </section>
    );
  if (q.isPending) return <RowsSkeleton />;
  if (q.isError) return screenError(q.error, () => void q.refetch());
  return <StateScreen art="people" line="You don’t follow anyone yet" action={{ label: "See who to follow", onClick: onFind }} full={false} />;
}

function SuggestedList() {
  const q = useSuggested();
  const people = [...(q.data?.friends ?? []), ...(q.data?.people ?? [])];
  if (people.length)
    return (
      <section className="wa-card">
        <ul className="wa-rows">
          {people.map((p) => (
            <PersonRow key={p.id} person={p} />
          ))}
        </ul>
      </section>
    );
  if (q.isPending) return <RowsSkeleton />;
  if (q.isError) return screenError(q.error, () => void q.refetch());
  return <StateScreen art="people" line="No one to suggest yet" full={false} />;
}

export function RowsSkeleton() {
  return (
    <section className="wa-card" aria-hidden style={{ padding: 12 }}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: 8 }}>
          <div className="wa-skel" style={{ width: 44, height: 44, borderRadius: "50%" }} />
          <div style={{ flex: 1 }}>
            <div className="wa-skel" style={{ width: "45%", height: 12 }} />
            <div className="wa-skel" style={{ width: "25%", height: 10, marginTop: 8 }} />
          </div>
          <div className="wa-skel" style={{ width: 84, height: 36, borderRadius: 12 }} />
        </div>
      ))}
    </section>
  );
}
