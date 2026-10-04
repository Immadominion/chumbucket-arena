"use client";

/**
 * `Collect $9.20`: a won call's winnings, one tap away, on Home, on the call
 * and in the wallet sheet (`money.winnings`). Collecting runs the existing
 * claim path — `pantaTrading.claimPrepare` → the wallet signs the claim,
 * checked first (`claimCheck.ts`) → `claimSubmit` → `pantaTrading.claim` until
 * the payout is proven on chain. Never signed without the tap.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { collectable, usd } from "@/lib/webapp/money";
import { collectWin } from "@/lib/webapp/moneyFlow";
import { useToast } from "../data";
import { Icon } from "../Icon";
import { useApi } from "../session";
import { Spinner } from "../ui";
import { moneyKeys, useMoney, useWinnings } from "./moneyContext";
import { moneyLine, useSignerFor } from "./signers";

const POLL_MS = 3_000;

export function WinningsCard({ callId, compact = false }: { callId?: string; compact?: boolean }) {
  const money = useMoney();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const signerFor = useSignerFor();
  const winnings = useWinnings(money.enabled);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [going, setGoing] = useState<string[]>([]);
  // One key per position, kept across taps, so a dropped reply never builds a second claim.
  const keys = useRef(new Map<string, string>());

  const items = (winnings.data?.items ?? []).filter((i) => !callId || i.callId === callId);
  const open = collectable({ items, totalBaseUnits: "0" });
  const collecting = [...new Set([...items.filter((i) => i.state === "COLLECTING" && i.claimId).map((i) => i.claimId!), ...going])];
  const total = open.reduce((sum, i) => sum + BigInt(i.amountBaseUnits), 0n);
  const pollKey = collecting.join();

  // A claim going through: the BFF's answer until the payout is proven on chain.
  useEffect(() => {
    if (!pollKey) return;
    const ids = pollKey.split(",");
    const t = setInterval(() => {
      for (const id of ids) {
        api
          .claim(id)
          .then((c) => {
            if (c.state !== "CONFIRMED" && c.state !== "FAILED") return;
            setGoing((g) => g.filter((x) => x !== id));
            for (const key of [moneyKeys.winnings, moneyKeys.wallet, moneyKeys.activity]) void qc.invalidateQueries({ queryKey: key });
            if (c.state === "CONFIRMED") toast(`Collected ${usd(c.payoutBaseUnits ?? "0")}`);
            else setLine("It didn’t go through. Try again.");
          })
          .catch(() => undefined);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, pollKey, qc, toast]);

  if (!money.enabled) return null;
  if (!open.length && !collecting.length) return null;

  async function collect() {
    setBusy(true);
    setLine(null);
    try {
      for (const item of open) {
        const key = keys.current.get(item.orderId) ?? crypto.randomUUID();
        keys.current.set(item.orderId, key);
        const claim = await collectWin({ api, signerFor }, item, key);
        if (claim.state === "SUBMITTED" || claim.state === "BUILT") setGoing((g) => [...g, claim.claimId]);
        if (claim.state === "CONFIRMED") void qc.invalidateQueries({ queryKey: moneyKeys.winnings });
      }
      void qc.invalidateQueries({ queryKey: moneyKeys.winnings });
    } catch (e) {
      setLine(moneyLine(e));
    } finally {
      setBusy(false);
    }
  }

  const single = open.length === 1 ? open[0] : null;
  return (
    <section className={`wa-collect${compact ? " wa-collect--compact" : ""}`} aria-label="Winnings">
      <span className="wa-collect-ico">
        <Icon name={open.length ? "award-solid" : "sand-watch"} size={24} />
      </span>
      <span className="wa-collect-text">
        {!callId && single?.question ? <span className="wa-collect-q">{single.question}</span> : null}
        {line ? <span className="wa-hint wa-hint--error">{line}</span> : null}
      </span>
      {open.length ? (
        <button type="button" className="wa-btn wa-btn--primary wa-btn--sm" disabled={busy} onClick={() => void collect()}>
          {busy ? <Spinner /> : null}
          {`Collect ${usd(total)}`}
        </button>
      ) : (
        <span className="wa-chip" role="status">
          <Spinner />
          <span className="wa-sr">Collecting</span>
        </span>
      )}
    </section>
  );
}
