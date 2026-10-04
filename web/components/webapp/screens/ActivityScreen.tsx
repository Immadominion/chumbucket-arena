"use client";

/**
 * Activity: what happened to your calls. Someone backed or faded one, Panta
 * settled one, or someone dared you. Opening it marks everything read.
 */

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { ago } from "@/lib/webapp/format";
import { appPath } from "@/lib/webapp/paths";
import type { NotificationView } from "@/lib/webapp/types";
import { useNow } from "../data";
import { Icon } from "../Icon";
import { keys, useInbox } from "../queries";
import { useApi } from "../session";
import { Avatar, LoadMore, StateScreen, TopBar } from "../ui";
import { screenError } from "./common";

function kindMark(n: NotificationView): { icon: string; tone: string; label: string } {
  switch (n.kind) {
    case "BACKED":
      return { icon: "plus", tone: "yes", label: "Backed" };
    case "FADED":
      return { icon: "exchange", tone: "no", label: "Faded" };
    case "RESOLVED":
      return n.outcome === "CORRECT"
        ? { icon: "check-solid", tone: "yes", label: "Correct" }
        : n.outcome === "INCORRECT"
          ? { icon: "cross", tone: "no", label: "Incorrect" }
          : { icon: "cancel", tone: "void", label: "Void" };
    case "REMATCH":
      return { icon: "lightning", tone: "dare", label: "Dare" };
  }
}

const TONES: Record<string, { bg: string; fg: string }> = {
  yes: { bg: "var(--wa-yes-bg)", fg: "var(--wa-yes-ink)" },
  no: { bg: "var(--wa-no-bg)", fg: "var(--wa-no-ink)" },
  void: { bg: "#f3f4f6", fg: "var(--wa-muted)" },
  dare: { bg: "var(--wa-pink-wash)", fg: "var(--wa-pink-ink)" },
};

export function ActivityScreen() {
  const api = useApi();
  const qc = useQueryClient();
  const now = useNow();
  const inbox = useInbox();
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];
  const marked = useRef(false);
  const hasUnread = items.some((n) => n.readAt === null);

  useEffect(() => {
    if (!hasUnread || marked.current) return;
    marked.current = true;
    api
      .markAllRead()
      .then(() => qc.setQueryData(keys.unread, { unread: 0 }))
      .catch(() => {
        marked.current = false;
      });
  }, [hasUnread, api, qc]);

  return (
    <>
      <TopBar title="Activity" />
      {items.length ? (
        <section className="wa-card">
          <ul className="wa-rows">
            {items.map((n) => {
              const mark = kindMark(n);
              const tone = TONES[mark.tone]!;
              const target = n.kind === "REMATCH" && n.rivalCallId ? n.rivalCallId : n.subjectCallId;
              return (
                <li key={n.id}>
                  <Link href={appPath.call(target)} className="wa-row" style={{ alignItems: "flex-start" }}>
                    <span style={{ position: "relative", flex: "none" }}>
                      {n.actor ? (
                        <Avatar person={n.actor} size={44} />
                      ) : (
                        <span className="wa-avatar" style={{ width: 44, height: 44, background: tone.bg, color: tone.fg }} aria-hidden>
                          <Icon name={mark.icon} size={22} />
                        </span>
                      )}
                      {n.actor ? (
                        <span
                          aria-hidden
                          style={{
                            position: "absolute",
                            right: -4,
                            bottom: -4,
                            width: 22,
                            height: 22,
                            borderRadius: 8,
                            display: "grid",
                            placeItems: "center",
                            background: tone.bg,
                            color: tone.fg,
                            boxShadow: "0 0 0 2px #fff",
                          }}
                        >
                          <Icon name={mark.icon} size={13} />
                        </span>
                      ) : null}
                    </span>
                    <span className="wa-person-text" style={{ flex: 1, gap: 2 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.35 }}>{n.title}</span>
                      {n.marketQuestion ? (
                        <span className="wa-person-meta" style={{ whiteSpace: "normal" }}>
                          {n.marketQuestion}
                        </span>
                      ) : null}
                    </span>
                    <span className="wa-person-meta" style={{ flex: "none", display: "flex", alignItems: "center", gap: 6 }}>
                      {ago(n.createdAt, now)}
                      {n.readAt === null ? (
                        <span aria-label="New" style={{ width: 8, height: 8, borderRadius: 4, background: "var(--wa-coral)" }} />
                      ) : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <LoadMore onVisible={() => inbox.hasNextPage && !inbox.isFetchingNextPage && inbox.fetchNextPage()} disabled={!inbox.hasNextPage} />
        </section>
      ) : inbox.isPending ? (
        <section className="wa-card" aria-hidden style={{ padding: 12 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: 8 }}>
              <div className="wa-skel" style={{ width: 44, height: 44, borderRadius: "50%" }} />
              <div style={{ flex: 1 }}>
                <div className="wa-skel" style={{ width: "70%", height: 12 }} />
                <div className="wa-skel" style={{ width: "45%", height: 10, marginTop: 8 }} />
              </div>
            </div>
          ))}
        </section>
      ) : inbox.isError ? (
        screenError(inbox.error, () => void inbox.refetch())
      ) : (
        <StateScreen art="inbox" line="Nothing here yet" action={{ label: "Make a call", href: appPath.markets }} />
      )}
    </>
  );
}
