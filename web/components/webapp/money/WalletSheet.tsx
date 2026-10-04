"use client";

/**
 * The wallet sheet, behind the balance pill: the balance, add funds, cash
 * out, and recent money activity (`money.activity`, compact rows with
 * icons). Cash out sends USDC to any Solana wallet: an address and an
 * amount, a review of exactly what will be signed (the full address, the
 * amount to the last base unit), then the wallet signs a transfer checked
 * against the contract's rules (`checkedSigner(...).signTransfer`).
 *
 * Once signed, the transfer is a run (`transferRuns.ts`): the same signed
 * bytes are pushed until the chain decides, through lost replies and a
 * closed sheet, and nothing new is prepared meanwhile. Sent means SUBMITTED
 * until the chain shows it landed.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BffRejected } from "@/lib/webapp/bff";
import { ago } from "@/lib/webapp/format";
import { activityRow, balanceUsd, cashOutForm, exactUsd, explorerTx, usd } from "@/lib/webapp/money";
import { prepareTransfer, signTransfer, transferOpen, watchRun, type TransferReady } from "@/lib/webapp/moneyFlow";
import { TradeError } from "@/lib/webapp/trade";
import { useNow, useToast } from "../data";
import { Icon } from "../Icon";
import { useApi, useViewer } from "../session";
import { Sheet, Spinner, StateScreen } from "../ui";
import { moneyKeys, useMoneyActivity, useMoneyWallet } from "./moneyContext";
import { moneyLine, useSignerFor } from "./signers";
import { clearTransferRun, startTransferRun, transferKey, useTransferRun } from "./transferRuns";
import { WinningsCard } from "./Winnings";

type View = { v: "home" } | { v: "cashout" } | { v: "review"; ready: TransferReady };

export function WalletSheet({ open, onClose, onAddFunds }: { open: boolean; onClose: () => void; onAddFunds: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const viewer = useViewer();
  const signerFor = useSignerFor();
  const wallet = useMoneyWallet(open);
  const activity = useMoneyActivity(open);
  const runKey = transferKey(viewer.userId, "cash_out");
  const run = useTransferRun(runKey);
  const [view, setView] = useState<View>({ v: "home" });
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per cash out, kept until its outcome is known: a lost reply asks again with it.
  const intent = useRef<{ key: string; destination: string; amount: string } | null>(null);
  const w = wallet.data ?? null;
  const open_ = transferOpen(run);

  useEffect(() => {
    if (open) return;
    setView({ v: "home" });
    setLine(null);
  }, [open]);

  // The outcome is known (landed, failed, or refused): the balance moves, and the key is spent.
  const outcome = run && !open_ ? `${run.transferId}:${run.view?.state ?? ""}:${run.rejected ?? ""}` : null;
  useEffect(() => {
    if (!outcome) return;
    intent.current = null;
    void qc.invalidateQueries({ queryKey: moneyKeys.wallet });
    void qc.invalidateQueries({ queryKey: moneyKeys.activity });
  }, [outcome, qc]);

  const form = cashOutForm({ address, amount, max }, w);

  async function review() {
    // Nothing new while a signed cash out has no outcome yet.
    if (!form.ok || !w?.wallet || open_) return;
    const from = w.wallet.address;
    setBusy(true);
    setLine(null);
    const same = intent.current && intent.current.destination === form.destination && intent.current.amount === form.amountBaseUnits;
    const key = same ? intent.current!.key : crypto.randomUUID();
    intent.current = { key, destination: form.destination, amount: form.amountBaseUnits };
    try {
      const step = await prepareTransfer(
        () => api.cashOutPrepare({ destination: form.destination, amountBaseUnits: form.amountBaseUnits, idempotencyKey: key }),
        { from, to: form.destination, amountBaseUnits: form.amountBaseUnits },
        { api, signerFor },
      );
      if (step.step === "invalid") setLine(step.message);
      // Already on its way (a signed replay, or another transfer in flight): follow it, never a second.
      else if (step.step === "watch") startTransferRun(runKey, api, watchRun(step.transferId, step.view));
      else setView({ v: "review", ready: step.ready });
    } catch (e) {
      // A refusal (an expired review among them) is an answer: start afresh. A lost reply keeps the key.
      if (e instanceof BffRejected) intent.current = null;
      setLine(moneyLine(e, "transfer"));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (view.v !== "review" || open_) return;
    setBusy(true);
    setLine(null);
    try {
      const signed = await signTransfer(await signerFor(view.ready.review.from), view.ready);
      // From here the signed bytes are pushed until the chain decides.
      startTransferRun(runKey, api, signed);
      setView({ v: "home" });
    } catch (e) {
      // Nothing was signed or sent. A lapsed review is spent; a declined one can be asked for again.
      if (e instanceof TradeError && e.kind === "expired") intent.current = null;
      setLine(moneyLine(e, "transfer"));
      setView({ v: "cashout" });
    } finally {
      setBusy(false);
    }
  }

  const done = () => {
    if (open_) return onClose();
    if (run?.view?.state === "CONFIRMED" && run.amountBaseUnits) toast(`Sent ${exactUsd(run.amountBaseUnits)}`);
    clearTransferRun(runKey);
    setAddress("");
    setAmount("");
    setMax(false);
    setLine(null);
    setView({ v: "home" });
  };

  // Never a made-up number: no answer yet reads "Wallet", not $0.00.
  const balance = w ? balanceUsd(w.balance?.usdcBaseUnits) : null;
  const sending = run !== null;
  const title = sending ? (run.amountBaseUnits ? exactUsd(run.amountBaseUnits) : "Cash out") : view.v === "home" ? (balance ?? "Wallet") : "Cash out";
  const items = activity.data?.items ?? [];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      busy={busy}
      title={title}
      footer={
        sending ? (
          <button type="button" className="wa-btn wa-btn--soft wa-btn--block" onClick={done}>
            Done
          </button>
        ) : view.v === "cashout" ? (
          <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={!form.ok || busy} onClick={() => void review()}>
            {busy ? <Spinner /> : <Icon name="arrow-up" size={20} />}
            <span className="wa-btn-label">{form.ok ? `Cash out ${exactUsd(form.amountBaseUnits)}` : "Cash out"}</span>
          </button>
        ) : view.v === "review" ? (
          <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={busy} onClick={() => void send()}>
            {busy ? <Spinner /> : <Icon name="check-solid" size={20} />}
            <span className="wa-btn-label">{`Send ${exactUsd(view.ready.review.amountBaseUnits)}`}</span>
          </button>
        ) : undefined
      }
    >
      {sending ? (
        run.rejected || run.view?.state === "FAILED" ? (
          <StateScreen art="error" line={run.rejected ?? "It didn’t go through. Nothing was sent."} full={false} compact />
        ) : (
          <div className="wa-state wa-state--compact" role="status" aria-live="polite">
            <span className="wa-wait">
              <Icon name={run.view?.state === "CONFIRMED" ? "check-solid" : "sand-watch"} size={36} />
            </span>
            {run.to ? <p className="wa-state-sub wa-mono wa-addr-full">{run.to}</p> : null}
          </div>
        )
      ) : view.v === "home" ? (
        <>
          <div className="wa-walletacts">
            <button type="button" className="wa-btn wa-btn--primary wa-btn--sm" onClick={onAddFunds}>
              <Icon name="plus" size={18} />
              Add funds
            </button>
            <button
              type="button"
              className="wa-btn wa-btn--soft wa-btn--sm"
              disabled={!w?.balance || w.balance.usdcBaseUnits === "0"}
              onClick={() => {
                setLine(null);
                setView({ v: "cashout" });
              }}
            >
              <Icon name="arrow-up" size={18} />
              Cash out
            </button>
          </div>
          <WinningsCard compact />
          {items.length ? (
            <ul className="wa-activity" aria-label="Money activity">
              {items.map((item) => {
                const row = activityRow(item);
                const body = (
                  <>
                    <span className={`wa-activity-ico wa-activity-ico--${row.tone}`}>
                      <Icon name={row.icon} size={18} />
                    </span>
                    <span className="wa-activity-title">{row.title}</span>
                    <span className="wa-activity-time">{ago(item.at, now)}</span>
                    <b className={`wa-activity-amt wa-activity-amt--${row.tone}`}>{row.amount}</b>
                  </>
                );
                return (
                  <li key={item.id}>
                    {item.signature ? (
                      <a className="wa-activity-row" href={explorerTx(item.signature)} target="_blank" rel="noopener noreferrer">
                        {body}
                      </a>
                    ) : (
                      <span className="wa-activity-row">{body}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : activity.isPending ? null : (
            <StateScreen art="inbox" line="No money moves yet" full={false} compact />
          )}
        </>
      ) : view.v === "cashout" ? (
        <div className="wa-form">
          <button type="button" className="wa-backrow" onClick={() => setView({ v: "home" })}>
            <Icon name="arrow-left" size={18} />
            {balance ?? "Wallet"}
          </button>
          <div className="wa-field">
            <label htmlFor="wa-cashout-to" className="wa-sr">
              Send to
            </label>
            <input
              id="wa-cashout-to"
              className="wa-input wa-input--mono"
              placeholder="Solana address"
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              value={address}
              aria-invalid={!form.ok && form.field === "address" && !!form.line}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div className="wa-cashout-amount">
            <div className="wa-input-wrap">
              <span className="wa-input-prefix" aria-hidden>
                $
              </span>
              <input
                className="wa-input"
                inputMode="decimal"
                aria-label="Amount in dollars"
                value={max ? exactUsd(w?.balance?.usdcBaseUnits).slice(1) : amount}
                disabled={max}
                aria-invalid={!form.ok && form.field === "amount" && !!form.line}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <button type="button" className="wa-amt" role="switch" aria-checked={max} onClick={() => setMax((m) => !m)}>
              Max
            </button>
          </div>
          {line || (!form.ok && form.line) ? (
            <p className="wa-hint wa-hint--error" role="alert">
              {line ?? (!form.ok ? form.line : null)}
            </p>
          ) : null}
        </div>
      ) : view.v === "review" ? (
        // Exactly what will be signed: the whole address, the amount to the last base unit.
        <div className="wa-review" role="group" aria-label="Review">
          <div className="wa-review-row wa-review-row--strong">
            <Icon name="wallet" size={20} />
            <span className="wa-review-label">Amount</span>
            <b>{exactUsd(view.ready.review.amountBaseUnits)}</b>
          </div>
          <div className="wa-review-row wa-review-row--strong wa-review-row--top">
            <Icon name="arrow-up" size={20} />
            <span className="wa-review-label">To</span>
          </div>
          <code className="wa-addr-full wa-mono">{view.ready.review.to}</code>
          {line ? (
            <p className="wa-hint wa-hint--error" role="alert">
              {line}
            </p>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
