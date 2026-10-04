"use client";

/**
 * Back, Fade or Dare someone's call: one sheet, one tap. Back and Fade make
 * the viewer's own call (same side, or the other side): free, or — with
 * calls with money on — with an amount, which makes it a real Tail / Fade
 * run by the money flow. Dare sends the author a free invitation to go on
 * record and never moves money.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { callMark, opposite, sideLabel, tradableMarket } from "@/lib/webapp/format";
import { callCta, sideName } from "@/lib/webapp/money";
import type { CallFeedEntry, ResponseKind } from "@/lib/webapp/types";
import { actionError, useToast } from "./data";
import { Icon } from "./Icon";
import { AmountRow, useAmount } from "./money/AmountRow";
import { CallButton } from "./money/CallButton";
import { useMoney } from "./money/moneyContext";
import { useAfterCall } from "./queries";
import { useApi } from "./session";
import { Sheet, SidePill } from "./ui";

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
  const money = useMoney();
  const { call, author, market } = entry;
  const mySide = kind === "fade" ? opposite(call.side) : call.side;
  // Money on Back and Fade only, and only where Chumbucket can trade.
  const withMoney = kind === "back" || kind === "fade" ? tradableMarket(market) : false;
  const [amount, setAmount] = useAmount(withMoney);

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
  const title = kind === "back" ? `${amount ? "Tail" : "Back"} ${first}` : kind === "fade" ? `Fade ${first}` : `Dare ${first}`;
  const cta = kind === "challenge" ? "Send dare" : callCta(kind, sideName(market, mySide), amount);

  /** Free: the response, as always. An amount: the money flow takes it from here, and this sheet closes. */
  const go = () => {
    if (kind !== "challenge" && amount) {
      money.startCall({
        target: { kind, targetCallId: call.id },
        intent: { amountBaseUnits: amount, side: mySide, marketId: market.id },
        label: sideName(market, mySide),
        thesis: text.trim() || null,
      });
      setText("");
      setWriting(false);
      onClose();
      return;
    }
    if (kind !== "challenge") money.remember(null);
    send.mutate();
  };

  return (
    <Sheet
      open
      onClose={() => !send.isPending && onClose()}
      busy={send.isPending}
      title={title}
      subtitle={kind === "challenge" ? "A dare to call it." : undefined}
      footer={
        // Free (a dare always is): ink with the Free mark. An amount: pink, with its dollars.
        <CallButton
          block
          label={cta}
          amount={kind === "challenge" ? null : amount}
          busy={send.isPending}
          disabled={text.length > MAX}
          icon={kind === "back" ? "plus" : kind === "fade" ? "exchange" : "lightning"}
          onClick={go}
        />
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
      <AmountRow value={amount} onChange={setAmount} available={withMoney} disabled={send.isPending} />
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
