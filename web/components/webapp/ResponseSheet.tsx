"use client";

/**
 * Back, Fade or Dare someone's call: one sheet, one tap. Back and Fade make
 * the viewer's own free call (same side, or the other side); Dare sends the
 * author a free invitation to go on record. None of them moves money.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { callMark, opposite, sideLabel } from "@/lib/webapp/format";
import type { CallFeedEntry, ResponseKind } from "@/lib/webapp/types";
import { actionError, useToast } from "./data";
import { Icon } from "./Icon";
import { useAfterCall } from "./queries";
import { useApi } from "./session";
import { FreeChip, Sheet, SidePill, Spinner } from "./ui";

const MAX = 280;

export function ResponseSheet({
  entry,
  kind,
  onClose,
}: {
  entry: CallFeedEntry;
  kind: ResponseKind | null;
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const afterCall = useAfterCall();
  const [text, setText] = useState("");
  const [writing, setWriting] = useState(false);
  const { call, author, market } = entry;
  const mySide = kind === "fade" ? opposite(call.side) : call.side;

  const send = useMutation({
    mutationFn: () =>
      api.respond({
        targetCallId: call.id,
        kind: kind!,
        ...(kind === "challenge" ? { note: text.trim() || null } : { thesis: text.trim() || null }),
      }),
    onSuccess: (res) => {
      afterCall(res.resultingCall, market.id);
      const free = res.resultingCall && callMark(res.resultingCall) === "free";
      toast(kind === "challenge" ? "Dare sent" : `Called ${sideLabel(market, mySide)}${free ? " · Free" : ""}`);
      setText("");
      setWriting(false);
      onClose();
    },
    onError: (e) => toast(actionError(e), "error"),
  });

  if (!kind) return null;
  const first = author.displayName.split(/\s+/)[0] || author.displayName;
  const title = kind === "back" ? `Back ${first}` : kind === "fade" ? `Fade ${first}` : `Dare ${first}`;
  const cta =
    kind === "challenge" ? "Send dare" : `${kind === "back" ? "Back" : "Fade"} · ${sideLabel(market, mySide)}`;

  return (
    <Sheet
      open
      onClose={() => !send.isPending && onClose()}
      busy={send.isPending}
      title={title}
      subtitle={kind === "challenge" ? "A dare to call it." : undefined}
      footer={
        // Back, Fade and a dare are all free: ink, never pink (pink is money).
        <button
          type="button"
          className="wa-btn wa-btn--ink wa-btn--block"
          disabled={send.isPending || text.length > MAX}
          onClick={() => send.mutate()}
        >
          {send.isPending ? <Spinner /> : <Icon name={kind === "back" ? "plus" : kind === "fade" ? "exchange" : "lightning"} size={20} />}
          {cta}
          <FreeChip />
        </button>
      }
    >
      <div className="wa-call-q" style={{ marginTop: 0 }}>
        {kind === "challenge" ? (
          <SidePill side={call.side} label={sideLabel(market, call.side)} />
        ) : (
          <SidePill side={mySide} label={sideLabel(market, mySide)} />
        )}
        <p className="wa-question" style={{ fontSize: 17 }}>
          {market.question}
        </p>
      </div>
      {writing ? (
        <div className="wa-field" style={{ marginTop: 14 }}>
          <label htmlFor={`why-${call.id}`} className="wa-sr">
            {kind === "challenge" ? "A note" : "Your reason"}
          </label>
          <textarea
            id={`why-${call.id}`}
            data-autofocus
            maxLength={MAX + 20}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={kind === "challenge" ? "Say something…" : "Why?"}
          />
          <span className={`wa-counter${text.length > MAX ? " wa-counter--over" : ""}`} aria-live="polite">
            {text.length}/{MAX}
          </span>
        </div>
      ) : (
        <button type="button" className="wa-btn wa-btn--soft wa-btn--sm" style={{ marginTop: 14 }} onClick={() => setWriting(true)}>
          <Icon name="comment" size={16} />
          {kind === "challenge" ? "Add a note" : "Add a reason"}
        </button>
      )}
    </Sheet>
  );
}
