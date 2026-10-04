"use client";

/**
 * A market: the question, YES and NO with each side's percent, and a free call in
 * one tap. Tap a side, then Call. Once you are on record the community split
 * opens (the BFF sends it only then), and once Panta settles it your result
 * shows there too. A market that no longer takes calls shows no YES / NO and
 * offers no trade (its chip says closed or settled). The rules and the venue
 * sit behind one disclosure. With calls with money on, the lock bar carries
 * the amount row (`Free · $5 · $10 · $25 · +`) and a call with an amount runs
 * the money flow; otherwise trading is in the app.
 */

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  calledAt,
  callMark,
  closesIn,
  closingSoon,
  livePercent,
  outcomeLabel,
  outcomeOf,
  shortDay,
  sideLabel,
  stamp,
  takesCalls,
  topicIcon,
  topicLabel,
  tradableMarket,
} from "@/lib/webapp/format";
import { callCta, sideName } from "@/lib/webapp/money";
import { appPath, publicPath } from "@/lib/webapp/paths";
import { retryAfterPriceRefresh } from "@/lib/webapp/prices";
import type { CallOutcome, CallVisibility, MarketDetail, Side } from "@/lib/webapp/types";
import { GET_APP_HREF } from "@/components/site/config";
import { useShare } from "../cards";
import { useChumbucketWallet } from "../chumbucketWallet";
import { TradeSheet } from "../TradeSheet";
import { actionError, useNow, useToast } from "../data";
import { Icon } from "../Icon";
import { useAfterCall, useMarket } from "../queries";
import { AmountRow, useAmount } from "../money/AmountRow";
import { CallButton } from "../money/CallButton";
import { useMoney } from "../money/moneyContext";
import { useApi } from "../session";
import { CallMarkChip, PantaMark, Sheet, TopBar } from "../ui";
import { screenError } from "./common";

const MAX = 280;
/** Your call's band: on record while open, then the result's own mark (as on the receipt). */
const RESULT_ICON: Record<CallOutcome, string> = { PENDING: "check", CORRECT: "check-solid", INCORRECT: "cross", VOID: "cancel" };

export function MarketScreen({ marketId }: { marketId: string }) {
  const q = useMarket(marketId, { live: true });
  const share = useShare();
  const d = q.data;
  return (
    <>
      <TopBar back>
        {d ? (
          <button
            type="button"
            className="wa-iconbtn"
            aria-label="Share this market"
            onClick={() => share(publicPath.market(d.market.id), d.market.question)}
          >
            <Icon name="share" size={22} />
          </button>
        ) : null}
      </TopBar>
      {d ? (
        <MarketBody detail={d} refetch={() => q.refetch()} />
      ) : q.isPending ? (
        <div className="wa-card wa-hero" aria-hidden style={{ minHeight: 280 }}>
          <div className="wa-skel" style={{ width: "40%", height: 22, borderRadius: 999 }} />
          <div className="wa-skel" style={{ width: "92%", height: 26, marginTop: 18 }} />
          <div className="wa-skel" style={{ width: "70%", height: 26, marginTop: 10 }} />
        </div>
      ) : (
        screenError(q.error, () => void q.refetch(), "This market isn’t here")
      )}
    </>
  );
}

function MarketBody({ detail, refetch }: { detail: MarketDetail; refetch: () => Promise<unknown> }) {
  const api = useApi();
  const toast = useToast();
  const now = useNow();
  const afterCall = useAfterCall();
  const params = useSearchParams();
  const { market, sharePrice, viewerCall, crowdSplit } = detail;
  const open = takesCalls(market, now, detail.callsCloseAt);
  const initial = params?.get("pick");
  const [pick, setPick] = useState<Side | null>(open && !viewerCall && (initial === "YES" || initial === "NO") ? initial : null);
  const [writing, setWriting] = useState(false);
  const [thesis, setThesis] = useState("");
  const [visibility, setVisibility] = useState<CallVisibility>("public");
  const [trading, setTrading] = useState(false);
  const chumbucket = useChumbucketWallet();
  const money = useMoney();
  // Money only where Chumbucket can trade: a SOL-quoted market takes free calls.
  const [amount, setAmount] = useAmount(open && tradableMarket(market));
  const left = closesIn(market.closesAt, now);

  useEffect(() => {
    if (viewerCall) setPick(null);
  }, [viewerCall]);

  const lock = useMutation({
    // A price that just lapsed: re-read the market quietly and lock once more,
    // as the app does. Only a second refusal says anything (one quiet line).
    mutationFn: () =>
      retryAfterPriceRefresh(
        () => api.createCall({ marketId: market.id, side: pick!, thesis: thesis.trim() || null, visibility }),
        refetch,
      ),
    onSuccess: (entry) => {
      afterCall(entry, market.id);
      toast(`Called ${sideLabel(market, entry.call.side)}${callMark(entry) === "free" ? " · Free" : ""}`);
      setPick(null);
      setThesis("");
      setWriting(false);
    },
    onError: (e) => toast(actionError(e), "error"),
  });

  /** Free: the call, as always. An amount: the money flow (deposit, review, fill) takes it from here. */
  const callIt = () => {
    if (!pick) return;
    if (amount) {
      money.startCall({
        target: { kind: "own", marketId: market.id, side: pick },
        intent: { amountBaseUnits: amount, side: pick, marketId: market.id },
        label: sideName(market, pick),
        thesis: thesis.trim() || null,
        visibility,
      });
      return;
    }
    money.remember(null);
    lock.mutate();
  };

  const big = (side: Side) => {
    const pct = livePercent(sharePrice, side, now);
    return (
      <button
        type="button"
        className={`wa-bigpick wa-bigpick--${side}`}
        aria-pressed={pick === side}
        disabled={!open || !!viewerCall || lock.isPending}
        onClick={() => setPick((p) => (p === side ? null : side))}
        aria-label={`${side}${pct ? `, ${pct}` : ""}`}
      >
        <span className="wa-bigpick-side">{side}</span>
        {sideLabel(market, side).toUpperCase() !== side ? <span className="wa-bigpick-label">{sideLabel(market, side)}</span> : null}
        <span className="wa-bigpick-price">{pct ?? "—"}</span>
      </button>
    );
  };

  const total = crowdSplit ? crowdSplit.yesCalls + crowdSplit.noCalls : 0;
  /** Your call's result here, once Panta settles the market. */
  const mine = viewerCall ? outcomeOf(viewerCall) : "PENDING";

  return (
    <>
      <section className="wa-card wa-hero">
        <div className="wa-chips">
          <span className="wa-chip">
            <Icon name={topicIcon(market.category)} size={14} />
            {topicLabel(market.category)}
          </span>
          {!open ? (
            <span className="wa-chip">
              <Icon name="lock" size={14} />
              {market.status === "RESOLVED" ? "Settled" : "Closed"}
            </span>
          ) : left ? (
            <span className={`wa-chip${closingSoon(market.closesAt, now) ? " wa-chip--hot" : ""}`}>
              <Icon name="timer" size={14} />
              <span className="wa-sr">Closes in </span>
              {left}
            </span>
          ) : null}
        </div>
        <h1 className="wa-question">{market.question}</h1>

        {viewerCall ? (
          <>
            <div className={`wa-onrecord wa-onrecord--${mine}`}>
              <Icon name={RESULT_ICON[mine]} size={22} />
              <div className="wa-onrecord-text">
                <span className="wa-onrecord-head">
                  <strong>
                    You called {sideLabel(market, viewerCall.call.side)}
                    {calledAt(viewerCall.call) ? ` · ${calledAt(viewerCall.call)}` : ""}
                  </strong>
                  <CallMarkChip entry={viewerCall} />
                </span>
                <span>
                  {mine !== "PENDING" ? <b className="wa-onrecord-result">{outcomeLabel(mine)} · </b> : null}
                  <time dateTime={new Date(viewerCall.call.lockedAt).toISOString()} title={stamp(viewerCall.call.lockedAt)}>
                    <span className="wa-sr">Called </span>
                    {shortDay(viewerCall.call.lockedAt, now)}
                  </time>
                </span>
              </div>
              <Link className="wa-iconbtn" href={appPath.call(viewerCall.call.id)} aria-label="Open your call">
                <Icon name="arrow-right" size={20} />
              </Link>
            </div>
            {crowdSplit && total > 0 ? (
              <div className="wa-split" aria-label={`${crowdSplit.yesCalls} called YES, ${crowdSplit.noCalls} called NO`}>
                <div className="wa-split-bar" aria-hidden>
                  <span style={{ width: `${(crowdSplit.yesCalls / total) * 100}%` }} />
                </div>
                <div className="wa-split-legend" aria-hidden>
                  <span style={{ color: "var(--wa-yes-ink)" }}>YES {crowdSplit.yesCalls}</span>
                  <span style={{ color: "var(--wa-no-ink)" }}>NO {crowdSplit.noCalls}</span>
                </div>
              </div>
            ) : null}
          </>
        ) : open ? (
          <div className="wa-bigpicks">
            {big("YES")}
            {big("NO")}
          </div>
        ) : null}

        {pick ? (
          <div className="wa-lockbar">
            <AmountRow value={amount} onChange={setAmount} available={tradableMarket(market)} disabled={lock.isPending} />
            {writing ? (
              <div className="wa-field">
                <label htmlFor="wa-thesis" className="wa-sr">
                  Your reason
                </label>
                <textarea
                  id="wa-thesis"
                  autoFocus
                  value={thesis}
                  maxLength={MAX + 20}
                  placeholder="Why?"
                  aria-describedby="wa-thesis-count"
                  onChange={(e) => setThesis(e.target.value)}
                />
                <span id="wa-thesis-count" className={`wa-counter${thesis.length > MAX ? " wa-counter--over" : ""}`} aria-live="polite">
                  {thesis.length}/{MAX}
                </span>
              </div>
            ) : null}
            <div className="wa-lockbar-row">
              <button
                type="button"
                className="wa-iconbtn"
                aria-label={writing ? "Remove your reason" : "Add a reason"}
                aria-pressed={writing}
                onClick={() => {
                  setWriting((w) => !w);
                  if (writing) setThesis("");
                }}
              >
                <Icon name="comment" size={22} />
              </button>
              <button
                type="button"
                className="wa-iconbtn"
                aria-label={visibility === "public" ? "Everyone can see it. Show followers only" : "Followers only. Show everyone"}
                aria-pressed={visibility === "followers"}
                title={visibility === "public" ? "Everyone" : "Followers only"}
                onClick={() => setVisibility((v) => (v === "public" ? "followers" : "public"))}
              >
                <Icon name={visibility === "public" ? "globe" : "group-151"} size={22} />
              </button>
              {/* Free: the strong ink button with the Free mark. An amount: pink, with its dollars. */}
              <CallButton
                label={callCta("own", sideName(market, pick), amount)}
                amount={amount}
                busy={lock.isPending}
                disabled={thesis.length > MAX}
                onClick={callIt}
              />
            </div>
          </div>
        ) : null}
      </section>

      <details className="wa-disclosure">
        <summary>
          <Icon name="book-open" size={20} />
          Rules
          <Icon name="caret-down" size={18} className="wa-caret" />
        </summary>
        <div className="wa-disclosure-body">
          {market.rulesText}
          <div className="wa-venue">
            <Icon name="check-solid" size={14} />
            Settled by
            {market.venue === "panta" ? (
              <a href={`https://panta.market/market/${encodeURIComponent(market.venueMarketId)}`} target="_blank" rel="noopener">
                Panta
              </a>
            ) : (
              <span>the venue</span>
            )}
            {market.closesAt ? <span>· closes {stamp(market.closesAt)}</span> : null}
          </div>
        </div>
      </details>

      {/* Trading is offered only while the market is open (a settled or closed market has nothing to trade),
          and only where Chumbucket can trade: a SOL-quoted Panta market takes free calls, never a trade. */}
      {/* Never for a call with money (pending, expired, kept free or funded through money.*): only the
          server's answer that money is off for this account, and a call with no money row, show it. */}
      {viewerCall && open && tradableMarket(market) && !money.enabled && money.known && !viewerCall.money ? (
        <button type="button" className="wa-disclosure" style={{ width: "100%", textAlign: "left" }} onClick={() => setTrading(true)}>
          <span style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 52, padding: "0 16px", fontWeight: 600, width: "100%" }}>
            <Icon name="wallet" size={20} />
            Trade
            <PantaMark />
            <Icon name="arrow-right" size={18} className="wa-caret" />
          </span>
        </button>
      ) : null}

      {/* With the Chumbucket wallet on, the trade happens here, signed in the browser. */}
      {chumbucket.enabled && viewerCall ? (
        <TradeSheet open={trading} onClose={() => setTrading(false)} market={market} call={viewerCall} />
      ) : (
        <Sheet
          open={trading}
          onClose={() => setTrading(false)}
          title="Trade in the app"
          subtitle="Real USDC from your own wallet, on Panta."
          footer={
            <a href={GET_APP_HREF} className="wa-btn wa-btn--primary wa-btn--block">
              <Icon name="android-solid" size={20} />
              Get the Android app
            </a>
          }
        >
          <p style={{ margin: "0 0 8px", color: "var(--wa-muted)", fontSize: 14 }}>
            Trading is optional and you can lose what you put in. Your free call stays on your record either way.
          </p>
        </Sheet>
      )}
    </>
  );
}
