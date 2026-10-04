"use client";

/**
 * Add funds (`money.depositOptions`), one icon-led sheet:
 *
 *   From your wallet   a USDC transfer from one of the account's own browser
 *                      wallets in one approval (`money.depositFromWalletPrepare`,
 *                      checked inside the signer, then transferSubmit/transferStatus)
 *   Send USDC          the trading wallet's address and QR (a Solana Pay link)
 *   Card               Crossmint (card, Apple Pay, Google Pay), only when the
 *                      server offers it; test money always says Test
 *
 * It watches the balance the whole time it is open. Opened for a call
 * (`need`), the call continues by itself once the balance covers it.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { shortWallet } from "@/lib/webapp/format";
import {
  balanceRose,
  depositTiles,
  fundsLanded,
  parseUsd,
  usd,
  usdDecimal,
  type DepositTile,
  type TransferView,
} from "@/lib/webapp/money";
import { prepareTransfer, sendTransfer } from "@/lib/webapp/moneyFlow";
import { appPath } from "@/lib/webapp/paths";
import { useChumbucketWallet } from "../chumbucketWallet";
import { useToast } from "../data";
import { Icon } from "../Icon";
import { useApi } from "../session";
import { Sheet, Spinner, StateScreen } from "../ui";
import { moneyKeys, useMoneyWallet } from "./moneyContext";
import { moneyLine as lineOf, useSignerFor, useTransactionWallets } from "./signers";

/* eslint-disable @next/next/no-img-element */

type View = { v: "choose" } | { v: "send" } | { v: "wallet" } | { v: "card" };

const POLL_MS = 3_000;

export function DepositSheet({
  open,
  onClose,
  need = null,
  onFunded,
}: {
  open: boolean;
  onClose: () => void;
  /** A call waiting for funds: what it needs in all, and the shortfall when the server knew it. */
  need?: { neededBaseUnits: string; shortfallBaseUnits: string | null } | null;
  onFunded?: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const own = useChumbucketWallet();
  const browser = useTransactionWallets();
  const wallet = useMoneyWallet(open, true);
  const balance = wallet.data?.balance?.usdcBaseUnits ?? null;
  const shortfall = need
    ? (need.shortfallBaseUnits ??
      (balance !== null && BigInt(need.neededBaseUnits) > BigInt(balance) ? (BigInt(need.neededBaseUnits) - BigInt(balance)).toString() : need.neededBaseUnits))
    : null;
  const options = useQuery({
    queryKey: moneyKeys.deposit(shortfall),
    queryFn: () => api.depositOptions(shortfall),
    enabled: open,
    staleTime: 60_000,
  });
  const tiles = depositTiles(options.data, browser.length > 0);
  const [view, setView] = useState<View>({ v: "choose" });
  const before = useRef<string | null>(null);
  const funded = useRef(false);
  const openedAt = useRef(0);

  useEffect(() => {
    if (open) {
      openedAt.current = Date.now();
      return;
    }
    setView({ v: "choose" });
    before.current = null;
    funded.current = false;
  }, [open]);

  // Only balances read since the sheet opened count (never a cached one): the
  // first is the baseline; a waiting call continues once one covers it.
  useEffect(() => {
    if (!open || !wallet.data?.balance || wallet.dataUpdatedAt <= openedAt.current || funded.current) return;
    if (before.current === null) {
      before.current = wallet.data.balance.usdcBaseUnits;
      if (!need) return;
    }
    if (need ? fundsLanded(wallet.data, need.neededBaseUnits) : balanceRose(before.current, wallet.data)) {
      funded.current = true;
      void qc.invalidateQueries({ queryKey: moneyKeys.activity });
      if (need) {
        onFunded?.();
      } else {
        toast(`Added ${usd(BigInt(wallet.data.balance.usdcBaseUnits) - BigInt(before.current))}`);
        onClose();
      }
    }
  }, [need, onClose, onFunded, open, qc, toast, wallet.data, wallet.dataUpdatedAt]);

  // No trading wallet yet: the Chumbucket wallet is made on first need.
  const making = useRef(false);
  useEffect(() => {
    if (!open || !options.data || options.data.tradingWallet || !own.enabled || making.current) return;
    making.current = true;
    own
      .ensure()
      .then(() => options.refetch())
      .catch(() => undefined);
  }, [open, options, own]);

  const title = shortfall ? `Add ${usd(shortfall)}` : "Add funds";
  const back = view.v === "choose" ? undefined : () => setView({ v: "choose" });
  const tile = (id: DepositTile["id"]) => tiles.find((t) => t.id === id);

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {options.isPending ? (
        <div className="wa-state wa-state--compact" aria-busy="true">
          <Spinner />
        </div>
      ) : options.isError ? (
        <StateScreen art="error" line={lineOf(options.error)} full={false} compact action={{ label: "Try again", onClick: () => void options.refetch() }} />
      ) : !options.data?.tradingWallet ? (
        own.enabled ? (
          <div className="wa-state wa-state--compact" aria-busy="true">
            <Spinner />
          </div>
        ) : (
          <StateScreen art="search" line="Link a wallet first" full={false} compact action={{ label: "Link a wallet", href: appPath.signInMethods }} />
        )
      ) : view.v === "choose" ? (
        tiles.length ? (
          <div className="wa-tiles" role="group" aria-label="Add funds with">
            {tiles.map((t) => (
              <button key={t.id} type="button" className="wa-tile" onClick={() => setView({ v: t.id })}>
                {t.id === "wallet" ? (
                  browser.length === 1 ? (
                    <img src={browser[0]!.icon} alt="" width={28} height={28} />
                  ) : (
                    <Icon name="wallet" size={28} />
                  )
                ) : (
                  <Icon name={t.id === "send" ? "arrow-down" : "card"} size={28} />
                )}
                <span>{t.id === "wallet" ? (browser.length === 1 ? browser[0]!.name : "Your wallet") : t.id === "send" ? "Send USDC" : "Card"}</span>
                {t.id === "card" && t.test ? <span className="wa-chip wa-chip--test">Test</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <StateScreen art="error" line="Adding funds isn’t available right now" full={false} compact />
        )
      ) : view.v === "send" && tile("send")?.id === "send" ? (
        <SendUsdc tile={tile("send") as Extract<DepositTile, { id: "send" }>} onBack={back!} />
      ) : view.v === "wallet" && tile("wallet")?.id === "wallet" ? (
        <FromWallet
          tile={tile("wallet") as Extract<DepositTile, { id: "wallet" }>}
          to={options.data.tradingWallet.address}
          suggested={shortfall}
          onBack={back!}
          onDone={(amount) => {
            void qc.invalidateQueries({ queryKey: moneyKeys.wallet });
            void qc.invalidateQueries({ queryKey: moneyKeys.activity });
            if (!need) {
              funded.current = true;
              toast(`Added ${usd(amount)}`);
              onClose();
            }
          }}
        />
      ) : view.v === "card" && tile("card")?.id === "card" ? (
        <CardPay tile={tile("card") as Extract<DepositTile, { id: "card" }>} limits={options.data.card.limits} suggested={shortfall} onBack={back!} />
      ) : null}
    </Sheet>
  );
}

function BackRow({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button type="button" className="wa-backrow" onClick={onBack}>
      <Icon name="arrow-left" size={18} />
      {label}
    </button>
  );
}

/** "Send USDC": the address, its QR, copy. The sheet watches the balance meanwhile. */
function SendUsdc({ tile, onBack }: { tile: Extract<DepositTile, { id: "send" }>; onBack: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tile.address);
      toast("Address copied");
    } catch {
      // Selecting the address by hand still works.
    }
  };
  return (
    <div className="wa-send">
      <BackRow onBack={onBack} label="Send USDC" />
      <div className="wa-qr">
        <QRCodeSVG value={tile.uri} size={184} level="M" marginSize={0} title="Send USDC to this address" />
      </div>
      <div className="wa-addr">
        <code>{tile.address}</code>
        <button type="button" className="wa-iconbtn" aria-label="Copy address" onClick={() => void copy()}>
          <Icon name="copy" size={20} />
        </button>
      </div>
      <span className="wa-chip">
        <Icon name="lightning" size={14} />
        USDC · Solana
      </span>
      <span className="wa-watch" role="status">
        <span className="wa-watch-dot" aria-hidden />
        <span className="wa-sr">Waiting for your USDC</span>
      </span>
    </div>
  );
}

/** "From your wallet": one approval in the browser wallet, checked before it signs. */
function FromWallet({
  tile,
  to,
  suggested,
  onBack,
  onDone,
}: {
  tile: Extract<DepositTile, { id: "wallet" }>;
  to: string;
  suggested: string | null;
  onBack: () => void;
  onDone: (amountBaseUnits: string) => void;
}) {
  const api = useApi();
  const signerFor = useSignerFor();
  const [from, setFrom] = useState(tile.wallets[0]!.address);
  const [text, setText] = useState(suggested ? usdDecimal(roundUpToCent(suggested)) : "");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [sending, setSending] = useState<TransferView | null>(null);
  const intent = useRef<{ key: string; from: string; amount: string } | null>(null);
  const units = parseUsd(text);
  const amount = units && units > 0n ? units.toString() : null;

  // Submitted: the BFF's answer until the chain shows it (CONFIRMED) or says it failed.
  useEffect(() => {
    if (!sending || sending.state === "CONFIRMED" || sending.state === "FAILED") return;
    const t = setInterval(() => {
      api
        .transferStatus(sending.transferId)
        .then((v) => {
          if (v.state === "CONFIRMED") onDone(v.amountBaseUnits);
          if (v.state === "CONFIRMED" || v.state === "FAILED") setSending(v);
          if (v.state === "FAILED") setLine("It didn’t go through. Nothing was sent.");
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, onDone, sending]);

  async function add() {
    if (!amount) return;
    setBusy(true);
    setLine(null);
    const same = intent.current && intent.current.from === from && intent.current.amount === amount;
    const key = same ? intent.current!.key : crypto.randomUUID();
    intent.current = { key, from, amount };
    try {
      const deps = { api, signerFor };
      const step = await prepareTransfer(
        () => api.depositFromWalletPrepare({ fromWallet: from, amountBaseUnits: amount, idempotencyKey: key }),
        { from, to, amountBaseUnits: amount },
        deps,
      );
      if (step.step === "invalid") {
        setLine(step.message);
        return;
      }
      const view = await sendTransfer(api, await signerFor(from), step.ready);
      intent.current = null;
      setSending(view);
    } catch (e) {
      setLine(lineOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (sending && sending.state !== "FAILED") {
    return (
      <div className="wa-state wa-state--compact" role="status" aria-live="polite">
        <span className="wa-pulse">
          <Icon name={sending.state === "CONFIRMED" ? "check-solid" : "sand-watch"} size={36} />
        </span>
        <p>{usd(sending.amountBaseUnits)}</p>
      </div>
    );
  }
  return (
    <div className="wa-form">
      <BackRow onBack={onBack} label="From your wallet" />
      {tile.wallets.length > 1 ? (
        <div className="wa-seg wa-seg--block" role="group" aria-label="From">
          {tile.wallets.map((w) => (
            <button key={w.address} type="button" aria-pressed={from === w.address} onClick={() => setFrom(w.address)}>
              <Icon name="wallet" size={16} />
              {shortWallet(w.address)}
            </button>
          ))}
        </div>
      ) : (
        <span className="wa-chip">
          <Icon name="wallet" size={14} />
          {shortWallet(from)}
        </span>
      )}
      <div className="wa-input-wrap">
        <span className="wa-input-prefix" aria-hidden>
          $
        </span>
        <input className="wa-input" inputMode="decimal" aria-label="Amount in dollars" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {line ? (
        <p className="wa-hint wa-hint--error" role="alert">
          {line}
        </p>
      ) : null}
      <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={!amount || busy} onClick={() => void add()}>
        {busy ? <Spinner /> : <Icon name="arrow-down" size={20} />}
        <span className="wa-btn-label">{amount ? `Add ${usd(amount)}` : "Add"}</span>
      </button>
    </div>
  );
}

/** Card / Apple Pay / Google Pay through Crossmint's own checkout, in a new tab. */
function CardPay({
  tile,
  limits,
  suggested,
  onBack,
}: {
  tile: Extract<DepositTile, { id: "card" }>;
  limits: { minUsd: string; maxUsd: string } | null;
  suggested: string | null;
  onBack: () => void;
}) {
  const api = useApi();
  const choices = cardChoices(tile.presetsUsd, suggested, limits);
  const [pick, setPick] = useState(choices[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [order, setOrder] = useState<{ orderId: string; url: string } | null>(null);
  const key = useRef<{ key: string; amount: string } | null>(null);

  useEffect(() => {
    if (!order) return;
    const t = setInterval(() => {
      api
        .cardOrder(order.orderId)
        .then((o) => {
          if (o.terminal && o.failure) setLine(o.failure.message ?? "The payment didn’t go through.");
          if (o.walletProofMessage) setLine("Finish this payment in the Chumbucket app.");
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, order]);

  async function pay() {
    if (!pick) return;
    setBusy(true);
    setLine(null);
    // Opened in the tap itself, so the browser lets it through.
    const tab = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    const k = key.current?.amount === pick ? key.current.key : crypto.randomUUID();
    key.current = { key: k, amount: pick };
    try {
      const created = await api.cardDeposit(pick, k);
      if (!/^https:\/\//.test(created.checkoutUrl)) throw new Error("checkout");
      if (tab) {
        tab.opener = null;
        tab.location.href = created.checkoutUrl;
      }
      setOrder({ orderId: created.order.orderId, url: created.checkoutUrl });
    } catch (e) {
      tab?.close();
      setLine(lineOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (order) {
    return (
      <div className="wa-state wa-state--compact" role="status" aria-live="polite">
        <span className="wa-pulse">
          <Icon name="card" size={36} />
        </span>
        <p>{`$${pick}`}</p>
        {line ? <p className="wa-hint wa-hint--error">{line}</p> : null}
        <a className="wa-btn wa-btn--soft wa-btn--sm" href={order.url} target="_blank" rel="noopener noreferrer">
          <Icon name="share-box" size={16} />
          Checkout
        </a>
      </div>
    );
  }
  return (
    <div className="wa-form">
      <BackRow onBack={onBack} label="Card" />
      <div className="wa-amounts" role="radiogroup" aria-label="Amount">
        {choices.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={pick === c} className="wa-amt" onClick={() => setPick(c)}>
            ${c}
          </button>
        ))}
      </div>
      {line ? (
        <p className="wa-hint wa-hint--error" role="alert">
          {line}
        </p>
      ) : null}
      <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={!pick || busy} onClick={() => void pay()}>
        {busy ? <Spinner /> : <Icon name="card" size={20} />}
        <span className="wa-btn-label">{pick ? `Pay $${pick}` : "Pay"}</span>
        {tile.test ? <span className="wa-chip wa-chip--test">Test</span> : null}
      </button>
    </div>
  );
}

/** Base units rounded up to the next cent (a shortfall of $3.501 asks for $3.51). */
function roundUpToCent(baseUnits: string): string {
  const v = BigInt(baseUnits);
  return (((v + 9_999n) / 10_000n) * 10_000n).toString();
}

/** The card's amounts: what a waiting call is short (in whole dollars, within limits) first, then the presets. */
export function cardChoices(presets: string[], shortfall: string | null, limits: { minUsd: string; maxUsd: string } | null): string[] {
  const out: string[] = [];
  if (shortfall) {
    let dollars = (BigInt(shortfall) + 999_999n) / 1_000_000n;
    const min = limits ? BigInt(Math.ceil(Number(limits.minUsd))) : 1n;
    const max = limits ? BigInt(Math.floor(Number(limits.maxUsd))) : null;
    if (dollars < min) dollars = min;
    if (max === null || dollars <= max) out.push(dollars.toString());
  }
  for (const p of presets) if (/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/.test(p) && !out.includes(p)) out.push(p);
  return out.slice(0, 4);
}
