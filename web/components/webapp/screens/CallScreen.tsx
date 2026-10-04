"use client";

/**
 * A call: who said what, when, at what price, and — once Panta settles —
 * whether they were right. Answer it with Back, Fade or Dare (three big
 * icons); your own call takes timestamped updates and shares as a receipt.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  ago,
  canAnswer,
  closesIn,
  isSettled,
  lockedPrice,
  outcomeLabel,
  outcomeOf,
  shortDay,
  sideLabel,
  stamp,
  takesCalls,
} from "@/lib/webapp/format";
import { appPath, publicPath } from "@/lib/webapp/paths";
import type { CallDetail, ResponseKind } from "@/lib/webapp/types";
import { CallCard, useShare } from "../cards";
import { actionError, useNow, useToast } from "../data";
import { Icon } from "../Icon";
import { keys, useCallDetail } from "../queries";
import { ResponseSheet } from "../ResponseSheet";
import { useApi, useViewer } from "../session";
import { Avatar, Sheet, SidePill, Spinner, TopBar } from "../ui";
import { screenError } from "./common";

export function CallScreen({ callId }: { callId: string }) {
  const q = useCallDetail(callId);
  const share = useShare();
  const d = q.data;
  const shareable = d && d.entry.call.visibility === "public";
  return (
    <>
      <TopBar back>
        {shareable ? (
          <button
            type="button"
            className="wa-iconbtn"
            aria-label={isSettled(d.entry) ? "Share the receipt" : "Share this call"}
            onClick={() =>
              share(publicPath.receipt(d.entry.call.id), `${d.entry.author.displayName} called ${sideLabel(d.entry.market, d.entry.call.side)}`)
            }
          >
            <Icon name="share" size={22} />
          </button>
        ) : null}
      </TopBar>
      {d ? (
        <CallBody detail={d} />
      ) : q.isPending ? (
        <div className="wa-card wa-hero" aria-hidden style={{ minHeight: 300 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div className="wa-skel" style={{ width: 48, height: 48, borderRadius: "50%" }} />
            <div className="wa-skel" style={{ width: "40%", height: 14 }} />
          </div>
          <div className="wa-skel" style={{ width: "90%", height: 26, marginTop: 22 }} />
          <div className="wa-skel" style={{ width: "66%", height: 26, marginTop: 10 }} />
        </div>
      ) : (
        screenError(q.error, () => void q.refetch(), "This call isn’t here")
      )}
    </>
  );
}

function CallBody({ detail }: { detail: CallDetail }) {
  const viewer = useViewer();
  const now = useNow();
  const [responding, setResponding] = useState<ResponseKind | null>(null);
  const [updating, setUpdating] = useState(false);
  const { entry, parent } = detail;
  const { call, author, market, result } = entry;
  const own = call.userId === viewer.userId;
  const settled = isSettled(entry);
  const outcome = outcomeOf(entry);
  const open = takesCalls(market, now) && !settled;
  const answerable = canAnswer(entry, viewer.userId, now);
  const price = lockedPrice(call);
  const left = closesIn(market.closesAt, now);
  const updates = detail.updates ?? [];

  return (
    <>
      <section className="wa-card wa-hero">
        <div className="wa-call-head">
          <Link href={appPath.person(author.handle)} className="wa-person">
            <Avatar person={author} size={48} />
            <span className="wa-person-text">
              <span className="wa-person-name" style={{ fontSize: 16 }}>
                {own ? "You" : author.displayName}
              </span>
              <span className="wa-person-meta">
                @{author.handle} · {ago(call.createdAt, now)}
              </span>
            </span>
          </Link>
        </div>

        <div className="wa-call-q" style={{ marginTop: 14 }}>
          <SidePill side={call.side} label={sideLabel(market, call.side)} />
        </div>
        <h1 className="wa-question">
          <Link href={appPath.market(market.id)}>{market.question}</Link>
        </h1>
        {call.thesis ? (
          <p className="wa-thesis" style={{ WebkitLineClamp: "unset", fontSize: 15, marginTop: 12 }}>
            {call.thesis}
          </p>
        ) : null}
        {updates.length ? (
          <ol className="wa-thread" aria-label="Updates">
            {updates.map((u) => (
              <li key={u.id}>
                <time dateTime={new Date(u.createdAt).toISOString()}>{stamp(u.createdAt)}</time>
                {u.body}
              </li>
            ))}
          </ol>
        ) : null}

        <div className="wa-chips" style={{ marginTop: 14 }}>
          <span className="wa-chip" title="Locked">
            <Icon name="lock" size={14} />
            <span className="wa-sr">Locked </span>
            {stamp(call.lockedAt)}
            {price ? ` · ${price}` : ""}
          </span>
          {!settled && left ? (
            <span className="wa-chip">
              <Icon name="timer" size={14} />
              <span className="wa-sr">Closes in </span>
              {left}
            </span>
          ) : null}
          {call.visibility === "followers" ? (
            <span className="wa-chip">
              <Icon name="group-151" size={14} />
              Followers
            </span>
          ) : null}
          {entry.funding ? (
            <span className="wa-chip wa-chip--ok">
              <Icon name="wallet" size={14} />
              Traded
            </span>
          ) : null}
          {entry.viewerHasCalled || own ? (
            <span className="wa-counts" aria-label={`${entry.backCount} backed, ${entry.fadeCount} faded`}>
              <span aria-hidden>
                <Icon name="plus" size={15} />
                {entry.backCount}
              </span>
              <span aria-hidden>
                <Icon name="exchange" size={15} />
                {entry.fadeCount}
              </span>
            </span>
          ) : null}
        </div>

        {settled ? (
          <div className={`wa-receipt wa-receipt--${outcome}`}>
            <Icon name={outcome === "CORRECT" ? "check-solid" : outcome === "INCORRECT" ? "cross" : "cancel"} size={28} />
            <div className="wa-receipt-text">
              <strong>{outcomeLabel(outcome)}</strong>
              <span>
                Panta settled {result?.resolution === "VOID" ? "it void" : result?.resolution ? sideLabel(market, result.resolution) : "it"}
                {result?.resolvedAt ? (
                  // The day here; the exact instant on hover, to a screen reader, and on the receipt.
                  <>
                    {" · "}
                    <time dateTime={new Date(result.resolvedAt).toISOString()} title={stamp(result.resolvedAt)} style={{ whiteSpace: "nowrap" }}>
                      {shortDay(result.resolvedAt, now)}
                    </time>
                  </>
                ) : null}
              </span>
            </div>
            {call.visibility === "public" ? (
              <a className="wa-btn wa-btn--soft wa-btn--sm" href={publicPath.receipt(call.id)} target="_blank" rel="noopener">
                <Icon name="document" size={16} />
                Receipt
              </a>
            ) : null}
          </div>
        ) : null}

        {!own && open ? (
          // Back and Fade only where the BFF takes them: once you have a call
          // on this market, that tile opens the market (your call is there).
          <div className={`wa-respond${answerable ? "" : " wa-respond--two"}`}>
            {answerable ? (
              <>
                <button type="button" className="wa-respond-btn wa-respond-btn--back" onClick={() => setResponding("back")}>
                  <span className="wa-respond-ico">
                    <Icon name="plus" size={22} />
                  </span>
                  Back
                  <small>{sideLabel(market, call.side)}</small>
                </button>
                <button type="button" className="wa-respond-btn wa-respond-btn--fade" onClick={() => setResponding("fade")}>
                  <span className="wa-respond-ico">
                    <Icon name="exchange" size={22} />
                  </span>
                  Fade
                  <small>{sideLabel(market, call.side === "YES" ? "NO" : "YES")}</small>
                </button>
              </>
            ) : entry.viewerHasCalled ? (
              <Link href={appPath.market(market.id)} className="wa-respond-btn wa-respond-btn--back" aria-label="You’ve called this market. Open it">
                <span className="wa-respond-ico">
                  <Icon name="check-solid" size={22} />
                </span>
                Called
                <small>See market</small>
              </Link>
            ) : null}
            <button type="button" className="wa-respond-btn wa-respond-btn--dare" onClick={() => setResponding("challenge")}>
              <span className="wa-respond-ico">
                <Icon name="lightning" size={22} />
              </span>
              Dare
              <small>Free</small>
            </button>
          </div>
        ) : null}
        {own && detail.updatesAvailable && !settled ? (
          <button type="button" className="wa-btn wa-btn--soft wa-btn--sm" style={{ marginTop: 16 }} onClick={() => setUpdating(true)}>
            <Icon name="edit" size={16} />
            Add an update
          </button>
        ) : null}
      </section>

      {parent ? (
        <>
          <h2 className="wa-section-title">
            {call.side === parent.call.side ? "Backing" : "Fading"}
          </h2>
          <CallCard entry={parent} />
        </>
      ) : null}

      <ResponseSheet entry={entry} kind={responding} onClose={() => setResponding(null)} />
      <UpdateSheet callId={call.id} open={updating} onClose={() => setUpdating(false)} />
    </>
  );
}

function UpdateSheet({ callId, open, onClose }: { callId: string; open: boolean; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState("");
  const add = useMutation({
    mutationFn: () => api.addUpdate(callId, body.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.call(callId) });
      toast("Update added");
      setBody("");
      onClose();
    },
    onError: (e) => toast(actionError(e), "error"),
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      busy={add.isPending}
      title="Add an update"
      subtitle="Your original call stays as it was."
      footer={
        <button
          type="button"
          className="wa-btn wa-btn--primary wa-btn--block"
          disabled={!body.trim() || body.length > 280 || add.isPending}
          onClick={() => add.mutate()}
        >
          {add.isPending ? <Spinner /> : <Icon name="send" size={20} />}
          Post update
        </button>
      }
    >
      <div className="wa-field">
        <label htmlFor="wa-update" className="wa-sr">
          Update
        </label>
        <textarea id="wa-update" data-autofocus value={body} maxLength={300} onChange={(e) => setBody(e.target.value)} placeholder="What changed?" />
        <span className="wa-counter">{body.length}/280</span>
      </div>
    </Sheet>
  );
}
