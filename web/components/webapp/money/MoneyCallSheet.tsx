"use client";

/**
 * One call with an amount, from the tap to the fill (docs/money-api.md §a):
 *
 *   prepareCall ─┬─ NEEDS_FUNDS → the deposit sheet; when funds land, the same ask again
 *                ├─ NEEDS_GAS   → a silent gasless top-up, then the same ask again
 *                └─ READY       → the compact review (pay · get if right · fee, dollars only)
 *                                 → confirm: the wallet signs the checked buy → pantaTrading.submit
 *                                 → pending, until the BFF says FUNDED (never earlier)
 *   failed or abandoned → the person chooses: try again, keep it free, or drop it
 *
 * One key per tap, reused on every ask of that tap, so a dropped reply or a
 * deposit in between never builds a second call. Closing a pending sheet
 * only hides it: the call keeps going, and its owner sees it on Home.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BffRejected } from "@/lib/webapp/bff";
import { callCta, onSide, progressOf, usd, type MoneyCallView } from "@/lib/webapp/money";
import { advanceCall, confirmCall, type CallIntent, type CallStep } from "@/lib/webapp/moneyFlow";
import { TradeError } from "@/lib/webapp/trade";
import type { CallFeedEntry, CallVisibility } from "@/lib/webapp/types";
import { useChumbucketWallet } from "../chumbucketWallet";
import { useToast } from "../data";
import { Icon } from "../Icon";
import { useAfterCall } from "../queries";
import { useApi } from "../session";
import { FreeChip, PantaMark, Sheet, Spinner, StateScreen } from "../ui";
import { DepositSheet } from "./DepositSheet";
import { moneyKeys, type StartCall } from "./moneyContext";
import { moneyLine as lineOf, useSignerFor } from "./signers";

/** What the flow was asked to do: a new call (one tap, one key), or the owner's pending one. */
export type CallRequest =
  | ({ mode: "new"; key: string } & StartCall)
  | { mode: "resume"; moneyCall: MoneyCallView; call: CallFeedEntry; label: string };

type View =
  | { v: "working"; line: string }
  | { v: "funds"; neededBaseUnits: string; shortfallBaseUnits: string | null }
  | { v: "review"; step: Extract<CallStep, { step: "review" }>; signing: boolean }
  | { v: "pending"; moneyCall: MoneyCallView }
  | { v: "stuck"; moneyCall: MoneyCallView; line: string | null; busy: "retry" | "free" | "drop" | null }
  | { v: "error"; line: string };

const POLL_MS = 3_000;

export function MoneyCallFlow({ request, onDone }: { request: CallRequest; onDone: () => void }) {
  const api = useApi();
  const toast = useToast();
  const qc = useQueryClient();
  const afterCall = useAfterCall();
  const own = useChumbucketWallet();
  const signerFor = useSignerFor();
  const [hidden, setHidden] = useState(false);
  const [view, setView] = useState<View>(() =>
    request.mode === "resume"
      ? progressOf(request.moneyCall) === "pending"
        ? { v: "pending", moneyCall: request.moneyCall }
        : { v: "stuck", moneyCall: request.moneyCall, line: null, busy: null }
      : { v: "working", line: "Getting your price…" },
  );
  const callId = useRef<string | null>(request.mode === "resume" ? request.moneyCall.callId : null);
  const alive = useRef(true);
  const reasks = useRef(0);
  // Funds that landed by our reading but not the server's: stop asking on our own after a few.
  const fundRounds = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const intent: CallIntent = useMemo(
    () =>
      request.mode === "new"
        ? request.intent
        : { amountBaseUnits: request.moneyCall.amountBaseUnits, side: request.moneyCall.side, marketId: request.moneyCall.marketId },
    [request],
  );
  const kind = request.mode === "new" ? request.target.kind : request.moneyCall.kind;
  const title = callCta(kind, request.label, intent.amountBaseUnits);
  const deps = useMemo(() => ({ api, signerFor }), [api, signerFor]);

  const refreshMoney = useCallback(() => {
    for (const key of [moneyKeys.wallet, moneyKeys.activity, moneyKeys.pending]) void qc.invalidateQueries({ queryKey: key });
  }, [qc]);

  const finish = useCallback(
    (how: "funded" | "free" | "dropped", entry: CallFeedEntry | null) => {
      if (!alive.current) return;
      refreshMoney();
      if (how !== "dropped") afterCall(entry, intent.marketId);
      toast(how === "funded" ? `Called ${request.label} · ${usd(intent.amountBaseUnits)}` : how === "free" ? `Called ${request.label} · Free` : "Nothing was spent");
      onDone();
    },
    [afterCall, intent, onDone, refreshMoney, request.label, toast],
  );

  /** Where the call stands now, from the BFF: pending, stuck (with a line), or finished. */
  const settle = useCallback(
    async (line: string | null) => {
      const id = callId.current;
      if (!id) {
        setView({ v: "error", line: line ?? "Couldn’t reach Chumbucket. Try again." });
        return;
      }
      try {
        const { moneyCall } = await api.moneyCallStatus(id);
        if (!alive.current) return;
        const p = progressOf(moneyCall);
        if (p === "funded") finish("funded", null);
        else if (p === "free") finish("free", null);
        else if (p === "expired") finish("dropped", null);
        else if (p === "pending") setView({ v: "pending", moneyCall });
        else setView({ v: "stuck", moneyCall, line, busy: null });
      } catch {
        if (alive.current) setView({ v: "error", line: line ?? "Couldn’t reach Chumbucket. Try again." });
      }
    },
    [api, finish],
  );

  /** Ask (prepareCall with this tap's key, or retry for a call that already exists) and walk to what needs the person. */
  const run = useCallback(
    async (retry: boolean) => {
      setView({ v: "working", line: "Getting your price…" });
      try {
        // The Chumbucket wallet is made on first need, so it is the wallet that pays.
        if (!retry && own.enabled && !own.address) {
          setView({ v: "working", line: "Setting up your wallet…" });
          await own.ensure();
          setView({ v: "working", line: "Getting your price…" });
        }
        const ask =
          retry && callId.current
            ? () => api.retryCall(callId.current!)
            : request.mode === "new"
              ? () =>
                  api.prepareCall({
                    ...request.target,
                    amountBaseUnits: request.intent.amountBaseUnits,
                    idempotencyKey: request.key,
                    thesis: request.thesis ?? null,
                    visibility: (request.visibility ?? "public") as CallVisibility,
                  })
              : () => api.retryCall(request.moneyCall.callId);
        const step = await advanceCall(ask, intent, deps);
        if (!alive.current) return;
        if (step.step === "funds") {
          setView({ v: "funds", neededBaseUnits: step.neededBaseUnits, shortfallBaseUnits: step.shortfallBaseUnits });
        } else if (step.step === "review") {
          callId.current = step.moneyCall.callId;
          setView({ v: "review", step, signing: false });
        } else {
          callId.current = step.moneyCall.callId;
          const p = progressOf(step.moneyCall);
          if (p === "funded") finish("funded", step.call);
          else if (p === "free") finish("free", step.call);
          else finish("dropped", null);
        }
      } catch (e) {
        if (!alive.current) return;
        // A quote that lapsed on the way: ask again with the same key (the BFF re-quotes a pending call).
        if (e instanceof TradeError && e.kind === "expired" && reasks.current++ < 2) return void run(retry);
        await settle(lineOf(e));
      }
    },
    [api, deps, finish, intent, own, request, settle],
  );

  // A new call starts at once; a resumed one waits for the person's choice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || request.mode !== "new") return;
    started.current = true;
    void run(false);
  }, [request.mode, run]);

  async function confirm() {
    if (view.v !== "review") return;
    const step = view.step;
    setView({ v: "review", step, signing: true });
    try {
      await confirmCall(api, step.reviewed);
      if (!alive.current) return;
      setView({ v: "pending", moneyCall: { ...step.moneyCall, trade: "SUBMITTED" } });
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof TradeError && e.kind === "expired" && reasks.current++ < 2) return void run(request.mode === "resume");
      // An order already going through is pending, not a failure.
      if (e instanceof BffRejected && e.code === "CONFLICT") return void settle(null);
      setView({ v: "stuck", moneyCall: step.moneyCall, line: lineOf(e), busy: null });
    }
  }

  // Pending: the BFF's own answer, until it is final. Funded only when it says FUNDED.
  const pendingId = view.v === "pending" ? view.moneyCall.callId : null;
  useEffect(() => {
    if (!pendingId) return;
    const t = setInterval(() => {
      api
        .moneyCallStatus(pendingId)
        .then(({ moneyCall }) => {
          if (!alive.current) return;
          const p = progressOf(moneyCall);
          if (p === "funded") finish("funded", null);
          else if (p === "free") finish("free", null);
          else if (p === "expired") finish("dropped", null);
          else if (p === "stuck") {
            setHidden(false);
            setView({ v: "stuck", moneyCall, line: "It didn’t go through. Nothing was spent.", busy: null });
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, finish, pendingId]);

  async function choose(choice: "retry" | "free" | "drop") {
    if (view.v !== "stuck") return;
    const { moneyCall } = view;
    if (choice === "retry") {
      callId.current = moneyCall.callId;
      return void run(true);
    }
    setView({ ...view, busy: choice });
    try {
      if (choice === "free") {
        const kept = await api.keepFree(moneyCall.callId);
        finish("free", kept.call);
      } else {
        await api.discardCall(moneyCall.callId);
        finish("dropped", null);
      }
    } catch (e) {
      if (alive.current) setView({ v: "stuck", moneyCall, line: lineOf(e), busy: null });
    }
  }

  // Waiting for funds: the deposit sheet, for exactly what this call needs.
  if (view.v === "funds") {
    return (
      <DepositSheet
        open
        need={{ neededBaseUnits: view.neededBaseUnits, shortfallBaseUnits: view.shortfallBaseUnits }}
        onFunded={
          fundRounds.current < 3
            ? () => {
                fundRounds.current++;
                void run(false);
              }
            : undefined
        }
        onClose={onDone}
      />
    );
  }

  const busy = view.v === "working" || (view.v === "review" && view.signing) || (view.v === "stuck" && view.busy !== null);
  const close = () => {
    if (busy) return;
    // Pending keeps going behind; an abandoned review is a choice, not a ghost.
    if (view.v === "pending") setHidden(true);
    else if (view.v === "review") setView({ v: "stuck", moneyCall: view.step.moneyCall, line: null, busy: null });
    else onDone();
  };
  const stamp = onSide(intent.amountBaseUnits, request.label);

  return (
    <Sheet
      open={!hidden}
      onClose={close}
      busy={busy}
      title={title}
      footer={
        view.v === "review" ? (
          <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={view.signing} onClick={() => void confirm()}>
            {view.signing ? <Spinner /> : <Icon name="check-solid" size={20} />}
            <span className="wa-btn-label">{view.signing ? "Placing…" : `Confirm ${usd(intent.amountBaseUnits)}`}</span>
          </button>
        ) : view.v === "stuck" ? (
          <div className="wa-choices">
            {view.moneyCall.canRetry ? (
              <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={view.busy !== null} onClick={() => void choose("retry")}>
                {view.busy === "retry" ? <Spinner /> : <Icon name="wallet" size={20} />}
                <span className="wa-btn-label">{`Try again · ${usd(intent.amountBaseUnits)}`}</span>
              </button>
            ) : null}
            <div className="wa-choices-row">
              {view.moneyCall.canKeepFree ? (
                <button type="button" className="wa-btn wa-btn--ink" disabled={view.busy !== null} onClick={() => void choose("free")}>
                  {view.busy === "free" ? <Spinner /> : null}
                  <span className="wa-btn-label">Keep it</span>
                  <FreeChip />
                </button>
              ) : null}
              {view.moneyCall.canDiscard ? (
                <button
                  type="button"
                  className="wa-btn wa-btn--soft wa-btn--icon"
                  disabled={view.busy !== null}
                  onClick={() => void choose("drop")}
                  aria-label="Drop this call"
                  title="Drop"
                >
                  {view.busy === "drop" ? <Spinner /> : <Icon name="trash" size={20} />}
                </button>
              ) : null}
            </div>
          </div>
        ) : view.v === "pending" ? (
          <button type="button" className="wa-btn wa-btn--soft wa-btn--block" onClick={close}>
            Done
          </button>
        ) : view.v === "error" ? (
          <button type="button" className="wa-btn wa-btn--soft wa-btn--block" onClick={() => void run(false)}>
            Try again
          </button>
        ) : undefined
      }
    >
      {view.v === "working" ? (
        <div className="wa-state wa-state--compact" role="status" aria-live="polite">
          <Spinner />
          <p className="wa-state-sub">{view.line}</p>
        </div>
      ) : view.v === "review" ? (
        // What it costs and what it pays, in dollars only: never a per-share price.
        <div className="wa-review" role="group" aria-label="Review">
          <div className="wa-review-row wa-review-row--strong">
            <Icon name="wallet" size={20} />
            <span className="wa-review-label">You pay</span>
            <b>{usd(intent.amountBaseUnits)}</b>
          </div>
          <div className="wa-review-row wa-review-row--strong">
            <Icon name="award" size={20} />
            <span className="wa-review-label">If right</span>
            <b>{view.step.reviewed.win}</b>
          </div>
          <div className="wa-review-row">
            <span aria-hidden className="wa-review-gap" />
            <span className="wa-review-label">Fee</span>
            <span>{view.step.reviewed.fee}</span>
          </div>
          <div className="wa-review-mark">
            <PantaMark />
          </div>
        </div>
      ) : view.v === "pending" ? (
        <div className="wa-state wa-state--compact" role="status" aria-live="polite">
          <span className="wa-pulse">
            <Icon name="sand-watch" size={36} />
          </span>
          <p>{stamp}</p>
          <p className="wa-state-sub">Going through</p>
        </div>
      ) : view.v === "stuck" ? (
        view.line ? (
          <StateScreen art="error" line={view.line} full={false} compact />
        ) : (
          <div className="wa-state wa-state--compact" role="status">
            <Icon name="sand-watch" size={36} />
            <p>{stamp}</p>
          </div>
        )
      ) : view.v === "error" ? (
        <StateScreen art="error" line={view.line} full={false} compact />
      ) : null}
    </Sheet>
  );
}
