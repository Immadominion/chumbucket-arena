"use client";

/**
 * The cards every list is made of: a call, a market, a person. Compact and
 * icon-led: who, which side, the question, then chips for time and price and
 * the one or two actions that fit. Nothing a person has to read twice.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ago,
  canAnswer,
  closesIn,
  closingSoon,
  isSettled,
  livePrice,
  lockedPrice,
  outcomeOf,
  recordA11y,
  recordToken,
  sideLabel,
  topicIcon,
  topicLabel,
} from "@/lib/webapp/format";
import { appPath, publicPath } from "@/lib/webapp/paths";
import type { CallFeedEntry, Market, PersonCard, PublicRecord, ResponseKind, Side } from "@/lib/webapp/types";
import { actionError, useNow, useToast } from "./data";
import { Icon } from "./Icon";
import { useFollow, useMarket } from "./queries";
import { ResponseSheet } from "./ResponseSheet";
import { useViewer } from "./session";
import { Avatar, OutcomeBadge, SidePill } from "./ui";

/** Share a public link: the system share sheet where there is one, else the clipboard. */
export function useShare() {
  const toast = useToast();
  return async (path: string, title: string) => {
    const url = `${window.location.origin}${path}`;
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      // Dismissing the share sheet is not an error.
    }
  };
}

export function CallCard({ entry, showAuthor = true }: { entry: CallFeedEntry; showAuthor?: boolean }) {
  const viewer = useViewer();
  const now = useNow();
  const share = useShare();
  const [responding, setResponding] = useState<ResponseKind | null>(null);
  const { call, author, market } = entry;
  const settled = isSettled(entry);
  const left = closesIn(market.closesAt, now);
  const price = lockedPrice(call);
  const answerable = canAnswer(entry, viewer.userId, now);
  const own = call.userId === viewer.userId;
  const side = sideLabel(market, call.side);

  return (
    <article className="wa-card wa-call wa-linkcard">
      <Link
        href={appPath.call(call.id)}
        className="wa-call-link"
        aria-label={`${own ? "Your" : `${author.displayName}’s`} call: ${side} on ${market.question}`}
      />
      {showAuthor ? (
        <div className="wa-call-head">
          <Link href={appPath.person(author.handle)} className="wa-person">
            <Avatar person={author} size={42} />
            <span className="wa-person-text">
              <span className="wa-person-name">{own ? "You" : author.displayName}</span>
              <span className="wa-person-meta">
                @{author.handle} · {ago(call.createdAt, now)}
              </span>
            </span>
          </Link>
          {settled ? (
            <span style={{ marginLeft: "auto" }}>
              <OutcomeBadge outcome={outcomeOf(entry)} />
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="wa-call-q">
        <SidePill side={call.side} label={side} />
        <h3 className="wa-question">{market.question}</h3>
      </div>
      {call.thesis ? <p className="wa-thesis">{call.thesis}</p> : null}
      <div className="wa-call-foot">
        <div className="wa-chips">
          {!showAuthor && settled ? <OutcomeBadge outcome={outcomeOf(entry)} /> : null}
          {!settled && left ? (
            <span className={`wa-chip${closingSoon(market.closesAt, now) ? " wa-chip--hot" : ""}`} title="Closes in">
              <Icon name="timer" size={14} />
              <span className="wa-sr">Closes in </span>
              {left}
            </span>
          ) : null}
          {price ? (
            <span className="wa-chip" title={`Locked at ${price}`}>
              <Icon name="lock" size={14} />
              <span className="wa-sr">Locked at </span>
              {price}
            </span>
          ) : null}
          {call.visibility === "followers" ? (
            <span className="wa-chip" title="Followers only">
              <Icon name="group-151" size={14} />
              <span className="wa-sr">Followers only</span>
            </span>
          ) : null}
          {entry.funding ? (
            <span className="wa-chip wa-chip--ok" title="Traded on Panta">
              <Icon name="wallet" size={14} />
              Traded
            </span>
          ) : null}
          {!showAuthor ? <span className="wa-chip wa-chip--plain">{ago(call.createdAt, now)}</span> : null}
        </div>
        <div className="wa-actions">
          {answerable ? (
            <>
              <button type="button" className="wa-act wa-act--back" onClick={() => setResponding("back")}>
                <Icon name="plus" size={16} />
                Back
              </button>
              <button type="button" className="wa-act wa-act--fade" onClick={() => setResponding("fade")}>
                <Icon name="exchange" size={16} />
                Fade
              </button>
            </>
          ) : entry.viewerHasCalled && !own && !settled ? (
            <span className="wa-chip wa-chip--ok">
              <Icon name="check" size={14} />
              Called
            </span>
          ) : null}
          {settled && call.visibility === "public" ? (
            <button
              type="button"
              className="wa-iconbtn"
              aria-label="Share the receipt"
              onClick={() => share(publicPath.receipt(call.id), `${author.displayName} called ${side}`)}
            >
              <Icon name="share" size={20} />
            </button>
          ) : null}
        </div>
      </div>
      <ResponseSheet entry={entry} kind={responding} onClose={() => setResponding(null)} />
    </article>
  );
}

/** Starts loading a market's prices only once its card is near the screen. */
function useNearScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !ref.current) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setNear(true), { rootMargin: "300px 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near]);
  return [ref, near] as const;
}

export function MarketCard({ market }: { market: Market }) {
  const now = useNow();
  const [ref, near] = useNearScreen<HTMLElement>();
  const detail = useMarket(market.id, { enabled: near });
  const snapshot = detail.data?.sharePrice ?? null;
  const left = closesIn(market.closesAt, now);
  const mine = detail.data?.viewerCall ?? null;

  const pick = (side: Side) => {
    const price = livePrice(snapshot, side, now);
    return (
      <Link
        href={`${appPath.market(market.id)}?pick=${side}`}
        className={`wa-pick wa-pick--${side}`}
        aria-label={`Call ${side} on ${market.question}${price ? `, ${price} a share on Panta` : ""}`}
      >
        <span>{sideLabel(market, side)}</span>
        <span className="wa-pick-price">{price ?? "—"}</span>
      </Link>
    );
  };

  return (
    <article ref={ref} className="wa-card wa-market wa-linkcard">
      <Link href={appPath.market(market.id)} className="wa-call-link" aria-label={market.question} />
      <div className="wa-market-top">
        <div className="wa-chips">
          <span className="wa-chip">
            <Icon name={topicIcon(market.category)} size={14} />
            {topicLabel(market.category)}
          </span>
          {left ? (
            <span className={`wa-chip${closingSoon(market.closesAt, now) ? " wa-chip--hot" : ""}`}>
              <Icon name="timer" size={14} />
              <span className="wa-sr">Closes in </span>
              {left}
            </span>
          ) : null}
        </div>
        {mine ? (
          <span className="wa-chip wa-chip--ok">
            <Icon name="check" size={14} />
            {mine.call.side}
          </span>
        ) : null}
      </div>
      <h3 className="wa-question">{market.question}</h3>
      {mine ? null : (
        <div className="wa-market-prices">
          {pick("YES")}
          {pick("NO")}
        </div>
      )}
    </article>
  );
}

export function RecordChip({ record }: { record: PublicRecord | null | undefined }) {
  const token = recordToken(record);
  if (!token) return null;
  return (
    <span className="wa-record" title={recordA11y(record)}>
      <Icon name="check-solid" size={14} />
      <span className="wa-sr">{recordA11y(record)}</span>
      <span aria-hidden>{token}</span>
    </span>
  );
}

export function FollowButton({ person, following }: { person: { id: string; handle: string; displayName: string }; following: boolean }) {
  const follow = useFollow();
  const toast = useToast();
  const [on, setOn] = useState(following);
  useEffect(() => setOn(following), [following]);
  return (
    <button
      type="button"
      className="wa-follow"
      aria-pressed={on}
      aria-label={on ? `Following ${person.displayName}. Unfollow` : `Follow ${person.displayName}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !on;
        setOn(next);
        follow.mutate(
          { ref: person.id, follow: next },
          {
            onError: (err) => {
              setOn(!next);
              toast(actionError(err), "error");
            },
          },
        );
      }}
    >
      {on ? <Icon name="check" size={15} /> : <Icon name="user-plus" size={15} />}
      <span className="wa-follow-label">{on ? "Following" : "Follow"}</span>
    </button>
  );
}

export function PersonRow({
  person,
  rank,
  showFollow = true,
  extra,
}: {
  person: Pick<PersonCard, "id" | "handle" | "displayName" | "avatarUrl" | "avatarId"> & {
    record?: PublicRecord | null;
    viewerIsFollowing?: boolean;
  };
  rank?: number | null;
  showFollow?: boolean;
  /** One more fact for the line under the name (an X handle). */
  extra?: React.ReactNode;
}) {
  const viewer = useViewer();
  const self = person.id === viewer.userId;
  return (
    <li className="wa-row">
      {rank !== undefined ? <span className="wa-row-rank">{rank ?? "·"}</span> : null}
      <Link href={appPath.person(person.handle)} className="wa-person">
        <Avatar person={person} size={44} />
        <span className="wa-person-text">
          <span className="wa-person-name">{self ? "You" : person.displayName}</span>
          <span className="wa-person-meta wa-person-meta--row">
            <span>@{person.handle}</span>
            <RecordChip record={person.record} />
            {extra}
          </span>
        </span>
      </Link>
      {showFollow && !self ? <FollowButton person={person} following={!!person.viewerIsFollowing} /> : null}
    </li>
  );
}
