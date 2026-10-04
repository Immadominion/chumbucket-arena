"use client";

/**
 * The wallet sheet, behind the balance pill: the balance, add funds, cash
 * out, and recent money activity (`money.activity`, compact rows with
 * icons). Cash out sends USDC to any Solana wallet: an address and an
 * amount, a review, then the wallet signs a transfer checked against the
 * contract's rules (`checkedSigner(...).signTransfer`) and the BFF submits
 * it. Sent means SUBMITTED until the chain shows it landed.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ago, shortWallet } from "@/lib/webapp/format";
import { BffRejected } from "@/lib/webapp/bff";
import { activityRow, balanceUsd, cashOutForm, explorerTx, usd, type TransferView } from "@/lib/webapp/money";
import { prepareTransfer, sendTransfer, type TransferReady } from "@/lib/webapp/moneyFlow";
import { useNow, useToast } from "../data";
import { Icon } from "../Icon";
import { useApi } from "../session";
import { Sheet, Spinner, StateScreen } from "../ui";
import { moneyKeys, useMoneyActivity, useMoneyWallet } from "./moneyContext";
import { moneyLine, useSignerFor } from "./signers";
import { WinningsCard } from "./Winnings";

type View =
  | { v: "home" }
  | { v: "cashout" }
  | { v: "review"; ready: TransferReady }
  | { v: "sending"; transfer: TransferView };

const POLL_MS = 3_000;

export function WalletSheet({ open, onClose, onAddFunds }: { open: boolean; onClose: () => void; onAddFunds: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const signerFor = useSignerFor();
  const wallet = useMoneyWallet(open);
  const activity = useMoneyActivity(open);
  const [view, setView] = useState<View>({ v: "home" });
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const intent = useRef<{ key: string; destination: string; amount: string } | null>(null);
  const w = wallet.data ?? null;

  useEffect(() => {
    if (open) return;
    setView({ v: "home" });
    setLine(null);
  }, [open]);

  // Sent: the BFF's answer until the chain shows it landed, or says it failed.
  const sendingId = view.v === "sending" && view.transfer.state === "SUBMITTED" ? view.transfer.transferId : null;
  useEffect(() => {
    if (!sendingId) return;
    const t = setInterval(() => {
      api
        .transferStatus(sendingId)
        .then((v) => {
          if (v.state === "SUBMITTED") return;
          setView({ v: "sending", transfer: v });
          void qc.invalidateQueries({ queryKey: moneyKeys.wallet });
          void qc.invalidateQueries({ queryKey: moneyKeys.activity });
          if (v.state === "FAILED") setLine("It didn’t go through. Nothing was sent.");
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, qc, sendingId]);

  const form = cashOutForm({ address, amount, max }, w);

  async function review() {
    if (!form.ok || !w?.wallet) return;
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
      if (step.step === "invalid") {
        setLine(step.message);
      } else {
        // A review lives 60 s and its key is spent: the next review starts afresh.
        intent.current = null;
        setView({ v: "review", ready: step.ready });
      }
    } catch (e) {
      // A dropped reply keeps the key (the same review comes back); a refusal starts afresh.
      if (e instanceof BffRejected) intent.current = null;
      setLine(moneyLine(e, "transfer"));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (view.v !== "review") return;
    setBusy(true);
    setLine(null);
    try {
      const transfer = await sendTransfer(api, await signerFor(view.ready.review.from), view.ready);
      setView({ v: "sending", transfer });
    } catch (e) {
      setLine(moneyLine(e, "transfer"));
      // A lapsed quote is built again from the form.
      setView({ v: "cashout" });
    } finally {
      setBusy(false);
    }
  }

  const done = () => {
    setAddress("");
    setAmount("");
    setMax(false);
    setLine(null);
    if (view.v === "sending" && view.transfer.state === "CONFIRMED") toast(`Sent ${usd(view.transfer.amountBaseUnits)}`);
    setView({ v: "home" });
  };

  // Never a made-up number: no answer yet reads "Wallet", not $0.00.
  const balance = w ? balanceUsd(w.balance?.usdcBaseUnits) : null;
  const title = view.v === "home" ? (balance ?? "Wallet") : view.v === "sending" ? usd(view.transfer.amountBaseUnits) : "Cash out";
  const items = activity.data?.items ?? [];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      busy={busy}
      title={title}
      footer={
        view.v === "cashout" ? (
          <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={!form.ok || busy} onClick={() => void review()}>
            {busy ? <Spinner /> : <Icon name="arrow-up" size={20} />}
            <span className="wa-btn-label">{form.ok ? `Cash out ${usd(form.amountBaseUnits)}` : "Cash out"}</span>
          </button>
        ) : view.v === "review" ? (
          <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={busy} onClick={() => void send()}>
            {busy ? <Spinner /> : <Icon name="check-solid" size={20} />}
            <span className="wa-btn-label">{`Send ${usd(view.ready.review.amountBaseUnits)}`}</span>
          </button>
        ) : view.v === "sending" ? (
          <button type="button" className="wa-btn wa-btn--soft wa-btn--block" onClick={done}>
            Done
          </button>
        ) : undefined
      }
    >
      {view.v === "home" ? (
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
                value={max ? balanceUsd(w?.balance?.usdcBaseUnits).slice(1) : amount}
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
        <div className="wa-review" role="group" aria-label="Review">
          <div className="wa-review-row wa-review-row--strong">
            <Icon name="arrow-up" size={20} />
            <span className="wa-review-label">To</span>
            <b className="wa-mono">{shortWallet(view.ready.review.to)}</b>
          </div>
          <div className="wa-review-row wa-review-row--strong">
            <Icon name="wallet" size={20} />
            <span className="wa-review-label">Amount</span>
            <b>{usd(view.ready.review.amountBaseUnits)}</b>
          </div>
          {line ? (
            <p className="wa-hint wa-hint--error" role="alert">
              {line}
            </p>
          ) : null}
        </div>
      ) : view.v === "sending" ? (
        view.transfer.state === "FAILED" ? (
          <StateScreen art="error" line={line ?? "It didn’t go through. Nothing was sent."} full={false} compact />
        ) : (
          <div className="wa-state wa-state--compact" role="status" aria-live="polite">
            <span className="wa-pulse">
              <Icon name={view.transfer.state === "CONFIRMED" ? "check-solid" : "sand-watch"} size={36} />
            </span>
            <p className="wa-mono">{shortWallet(view.transfer.to)}</p>
          </div>
        )
      ) : null}
    </Sheet>
  );
}
