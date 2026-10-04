"use client";

/**
 * A real Panta trade on your own call, signed in the browser (behind the
 * Chumbucket wallet flag). Pick an amount and a wallet (the Chumbucket
 * wallet by default, or a browser wallet), see what you pay and what you get
 * if right, confirm, and the BFF does the rest: the wallet signs exactly the
 * checked bytes and the BFF submits them. Only the BFF says a trade went
 * through, after Panta confirms and the chain shows the USDC debit; until
 * then the sheet says it is placing, never that it is done.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BffRejected } from "@/lib/webapp/bff";
import { sideLabel } from "@/lib/webapp/format";
import { appPath } from "@/lib/webapp/paths";
import {
  confirmTrade,
  isFinal,
  reviewTrade,
  TradeError,
  usdToBaseUnits,
  type ReviewedTrade,
  type TradeOrder,
  type TradeSigner,
} from "@/lib/webapp/trade";
import type { CallFeedEntry, Market } from "@/lib/webapp/types";
import { useChumbucketWallet } from "./chumbucketWallet";
import { actionError } from "./data";
import { Icon } from "./Icon";
import { useApi } from "./session";
import { Sheet, Spinner } from "./ui";
import { connect, onWalletsChange, signTransaction, transactionWallets, WalletDeclined, type StandardWallet } from "./wallets";

/* eslint-disable @next/next/no-img-element */

const AMOUNTS = [5, 10, 25] as const;
const OWN = "chumbucket";

type Stage = "idle" | "wallet" | "quoting" | "review" | "signing" | "pending" | "filled" | "failed";

function useBrowserWallets(): StandardWallet[] {
  return useSyncExternalStore(
    onWalletsChange,
    () => snapshot(),
    () => EMPTY,
  );
}
const EMPTY: StandardWallet[] = [];
let last: StandardWallet[] = EMPTY;
function snapshot(): StandardWallet[] {
  const now = transactionWallets();
  if (now.length !== last.length || now.some((w, i) => w !== last[i])) last = now;
  return last;
}

export function TradeSheet({
  open,
  onClose,
  market,
  call,
}: {
  open: boolean;
  onClose: () => void;
  market: Market;
  call: CallFeedEntry;
}) {
  const api = useApi();
  const own = useChumbucketWallet();
  const browser = useBrowserWallets();
  const [usd, setUsd] = useState<(typeof AMOUNTS)[number]>(5);
  const [payWith, setPayWith] = useState<string>(OWN);
  const [stage, setStage] = useState<Stage>("idle");
  const [order, setOrder] = useState<TradeOrder | null>(null);
  const [reviewed, setReviewed] = useState<ReviewedTrade | null>(null);
  const [problem, setProblem] = useState<{ text: string; link?: boolean } | null>(null);
  // One intent per amount and wallet: a retry after a lost reply reuses its key.
  const intent = useRef<{ key: string; usd: number; payWith: string } | null>(null);
  const side = sideLabel(market, call.call.side);

  // An order already placed for this call shows instead of a second buy.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .callOrder(call.call.id)
      .then(({ order: placed }) => {
        if (!alive || !placed || placed.fundingState === "FAILED") return;
        setOrder(placed);
        setStage(placed.fundingState === "FILLED" ? "filled" : "pending");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, call.call.id, open]);

  // The BFF's reconciler decides; the sheet just asks for its answer.
  useEffect(() => {
    if (stage !== "pending" || !order) return;
    const t = setInterval(() => {
      api
        .tradeOrder(order.orderId)
        .then((o) => {
          if (!isFinal(o)) return;
          setOrder(o);
          setStage(o.fundingState === "FILLED" ? "filled" : "failed");
        })
        .catch(() => undefined);
    }, 4_000);
    return () => clearInterval(t);
  }, [api, order, stage]);

  async function signer(): Promise<TradeSigner> {
    if (payWith === OWN) {
      setStage("wallet");
      return own.ensure();
    }
    const wallet = browser.find((w) => w.name === payWith);
    if (!wallet) throw new WalletDeclined("gone");
    const account = await connect(wallet);
    return { address: account.address, sign: (bytes) => signTransaction(wallet, account, bytes) };
  }

  function failed(e: unknown) {
    setStage("idle");
    setReviewed(null);
    if (e instanceof BffRejected && e.code === "UNPROCESSABLE_CONTENT") {
      setProblem({ text: e.message, link: true });
    } else if (e instanceof TradeError) {
      // An expired quote is never renewed under the same key.
      if (e.kind === "expired") intent.current = null;
      setProblem({
        text:
          e.kind === "declined"
            ? "Not signed. Nothing was spent."
            : e.kind === "expired"
              ? "The price moved. Try again."
              : e.kind === "unsafe"
                ? "This trade didn’t check out. Nothing was signed."
                : "Your wallet changed the trade. Nothing was sent.",
      });
    } else if (e instanceof WalletDeclined) {
      setProblem({ text: "Not signed. Nothing was spent." });
    } else if (e instanceof BffRejected) {
      setProblem({ text: e.message });
    } else {
      setProblem({ text: payWith === OWN && own.error ? own.error : actionError(e) });
    }
  }

  /** Step one: the quote, checked to be exactly this buy, then shown. Nothing is signed yet. */
  async function review() {
    setProblem(null);
    const same = intent.current && intent.current.usd === usd && intent.current.payWith === payWith;
    const key = same ? intent.current!.key : crypto.randomUUID();
    intent.current = { key, usd, payWith };
    try {
      const pay = await signer();
      setStage("quoting");
      const checked = await reviewTrade({
        api,
        callId: call.call.id,
        venueMarketId: market.venueMarketId,
        side: call.call.side,
        amountBaseUnits: usdToBaseUnits(usd),
        idempotencyKey: key,
        signer: pay,
      });
      setReviewed(checked);
      setStage("review");
    } catch (e) {
      failed(e);
    }
  }

  /** Step two, after the person confirmed: sign those bytes, submit them. */
  async function confirm() {
    if (!reviewed) return;
    setProblem(null);
    setStage("signing");
    try {
      const placed = await confirmTrade({ api, reviewed });
      intent.current = null;
      setReviewed(null);
      setOrder(placed);
      setStage(placed.fundingState === "FILLED" ? "filled" : placed.fundingState === "FAILED" ? "failed" : "pending");
    } catch (e) {
      failed(e);
    }
  }

  const busy = stage === "wallet" || stage === "quoting" || stage === "signing";
  const done = stage === "pending" || stage === "filled" || stage === "failed";
  return (
    <Sheet
      open={open}
      onClose={onClose}
      busy={busy}
      title={done ? side : "Trade"}
      footer={
        done ? (
          <button type="button" className="wa-btn wa-btn--soft wa-btn--block" onClick={onClose}>
            Done
          </button>
        ) : stage === "review" || stage === "signing" ? (
          <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Spinner /> : <Icon name="check-solid" size={20} />}
            {busy ? "Placing…" : `Confirm ${reviewed?.pay ?? ""}`}
          </button>
        ) : (
          <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={busy} onClick={() => void review()}>
            {busy ? <Spinner /> : <Icon name="wallet" size={20} />}
            {stage === "wallet" ? "Setting up wallet…" : stage === "quoting" ? "Getting your price…" : `Buy ${side} · $${usd}`}
          </button>
        )
      }
    >
      {done ? (
        <div className="wa-state wa-state--compact" role="status" aria-live="polite">
          <Icon name={stage === "filled" ? "check-solid" : stage === "failed" ? "cancel" : "sand-watch"} size={40} />
          <p>
            {stage === "filled"
              ? `$${Number(order?.amountBaseUnits ?? 0) / 1_000_000} on ${side}`
              : stage === "failed"
                ? "It didn’t go through"
                : "Placing your trade"}
          </p>
        </div>
      ) : reviewed && (stage === "review" || stage === "signing") ? (
        // What it costs and what it pays, in dollars only: no per-share price.
        <div role="group" aria-label="Review" style={{ display: "grid", gap: 12 }}>
          {[
            { icon: "wallet", label: "You pay", value: reviewed.pay, strong: true },
            { icon: "award", label: "You get if right", value: reviewed.win, strong: true },
            { icon: null, label: "Fee", value: reviewed.fee, strong: false },
          ].map((row) => (
            <div
              key={row.label}
              style={{ display: "flex", alignItems: "center", gap: 10, ...(row.strong ? {} : { color: "var(--wa-muted)", fontSize: 13 }) }}
            >
              {row.icon ? <Icon name={row.icon} size={20} /> : <span style={{ width: 20 }} aria-hidden />}
              <span style={{ flex: 1 }}>{row.label}</span>
              <span style={row.strong ? { fontWeight: 700 } : undefined}>{row.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="wa-seg wa-seg--block" role="group" aria-label="Amount">
            {AMOUNTS.map((a) => (
              <button key={a} type="button" aria-pressed={usd === a} disabled={busy} onClick={() => setUsd(a)}>
                ${a}
              </button>
            ))}
          </div>
          <div className="wa-seg wa-seg--block" role="group" aria-label="Pay with" style={{ marginTop: 10 }}>
            <button type="button" aria-pressed={payWith === OWN} disabled={busy} onClick={() => setPayWith(OWN)}>
              <Icon name="wallet" size={16} />
              Wallet
            </button>
            {browser.map((w) => (
              <button key={w.name} type="button" aria-pressed={payWith === w.name} disabled={busy} onClick={() => setPayWith(w.name)}>
                <img src={w.icon} alt="" width={16} height={16} />
                {w.name}
              </button>
            ))}
          </div>
          {problem ? (
            <p className="wa-hint wa-hint--error" role="alert" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
              <Icon name="wallet" size={16} />
              <span>{problem.text}</span>
              {problem.link ? (
                <a href={appPath.me} style={{ marginLeft: "auto", fontWeight: 600 }}>
                  Link
                </a>
              ) : null}
            </p>
          ) : null}
          <p style={{ margin: "12px 0 0", color: "var(--wa-muted)", fontSize: 13 }}>Trading is optional and you can lose what you put in.</p>
        </>
      )}
    </Sheet>
  );
}
