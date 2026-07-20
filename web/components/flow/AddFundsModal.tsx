"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Modal from "@/components/ui/Modal";
import { ArrowDown, CheckCircle, Coins, ShieldCheck } from "@/components/icons";
import { useTRPC } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { frostToWal } from "@/lib/format";

/**
 * "Add funds", two distinct money paths, chosen by the caller:
 *
 *  • Default (custodial): the deposit sweeps into the ChumBucket float and
 *    credits the off-chain balance (session.balance). Used by the Challenge /
 *    Wallet / Trial flows, which spend from that float.
 *
 *  • `onchain` mode: the "Back the crowd" bet (placeCall) spends real USDC
 *    straight from the player's OWN on-chain wallet, and reads that wallet's
 *    balance directly, the custodial float never touches it. So funding that
 *    bet means sending USDC to the exact wallet placeCall spends from (the
 *    player's own address) with NO sweep. This mode shows that address and a
 *    "check my balance" button that just re-reads the on-chain balance, so a
 *    deposit here actually raises the balance the bet screen checks (fixes the
 *    old dead loop where float deposits never moved the on-chain balance).
 */
export default function AddFundsModal({
  open,
  onClose,
  onDone,
  onchain = false,
  onchainAddress,
  onchainBalance,
  onRecheck,
}: {
  open: boolean;
  onClose: () => void;
  onDone?: (amount: number) => void;
  /** On-chain funding mode, point deposits at the player's own bet wallet, no sweep. */
  onchain?: boolean;
  /** The exact wallet placeCall spends from (= session.wallet). Required in onchain mode. */
  onchainAddress?: string;
  /** Current on-chain USDC balance, to show live. */
  onchainBalance?: number;
  /** Re-read the on-chain balance (invalidate/refetch the bet screen's balance query). */
  onRecheck?: () => Promise<void> | void;
}) {
  const trpc = useTRPC();
  const { refresh } = useSession();
  // Custodial-only: don't hit the deposit-address endpoint in on-chain mode.
  const addrQ = useQuery({ ...trpc.depositAddress.queryOptions(), enabled: open && !onchain });
  const syncM = useMutation(trpc.syncDeposit.mutationOptions());
  // Self-serve devnet faucet, mints the program's pinned test-USDC mint to the
  // player's own wallet (the exact mint the bet reads), so a tester/judge can
  // fund themselves without hunting for the right mint. Play money on devnet.
  const faucetM = useMutation(trpc.faucet.mutationOptions());
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const custodialAddress = addrQ.data?.address ?? "";
  const available = addrQ.data?.available ?? false;
  const address = onchain ? onchainAddress ?? "" : custodialAddress;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked, the address is visible to select manually */
    }
  };

  const check = async () => {
    setMsg(null);
    try {
      const r = await syncM.mutateAsync();
      const credited = frostToWal(r.credited);
      if (credited > 0) {
        setMsg({ ok: true, text: `Credited ${credited.toFixed(2)} USDC` });
        await refresh();
        onDone?.(credited);
      } else {
        setMsg({ ok: false, text: "No new deposit found yet, give it a moment after sending, then check again." });
      }
    } catch {
      setMsg({ ok: false, text: "Couldn't check just now, try again in a moment." });
    }
  };

  const recheckOnchain = async () => {
    setMsg(null);
    setChecking(true);
    try {
      await onRecheck?.();
      setMsg({ ok: true, text: "Balance updated. If your USDC has arrived, you can place your bet now." });
    } finally {
      setChecking(false);
    }
  };

  const getTestUsdc = async () => {
    if (!address) return;
    setMsg(null);
    try {
      const r = await faucetM.mutateAsync({ wallet: address });
      // Pull the new balance into the bet screen so it updates without a reload.
      await onRecheck?.();
      setMsg(
        r.funded
          ? { ok: true, text: "Added 100 test USDC, you can place a bet now." }
          : { ok: true, text: "You already have test USDC." },
      );
    } catch {
      setMsg({ ok: false, text: "Couldn't get test USDC just now, try again in a moment." });
    }
  };

  // ── On-chain bet funding (no sweep, the bet spends from this exact wallet) ──
  if (onchain) {
    return (
      <Modal open={open} onClose={onClose} width={440} label="Add funds to bet">
        <div style={{ padding: 26 }}>
          <h2 className="cd" style={{ fontSize: 22, margin: "0 0 4px" }}>Add funds to bet</h2>
          <p style={{ fontSize: 13, color: "#7C6D72", margin: "0 0 14px", lineHeight: 1.5 }}>
            This is play money on a practice network, nothing here costs real cash. Send test USDC (Solana)
            to your own wallet below, then check your balance.
          </p>

          {address ? (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".6px", color: "#988990" }}>YOUR WALLET · SOLANA</div>
              <button
                onClick={() => void copy()}
                style={{ width: "100%", marginTop: 8, display: "flex", alignItems: "center", gap: 12, background: "#F9F3F5", border: "1.5px solid #EFE6E9", borderRadius: 12, padding: "13px 14px", cursor: "pointer", textAlign: "left" }}
              >
                <span className="mono" style={{ flex: 1, fontSize: 12.5, color: "#221217", wordBreak: "break-all", lineHeight: 1.4 }}>{address}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#B81540", flex: "none", display: "flex", alignItems: "center", gap: 4 }}>
                  {copied ? <><CheckCircle size={15} weight="fill" /> Copied</> : "Copy"}
                </span>
              </button>
              <div style={{ fontSize: 11.5, color: "#B3A6AB", fontWeight: 600, marginTop: 8 }}>
                Send USDC on the <b>Solana</b> network to this exact wallet, it&rsquo;s the same wallet your bet is paid from.
              </div>
              {typeof onchainBalance === "number" && (
                <div style={{ fontSize: 12.5, color: "#7C6D72", fontWeight: 600, marginTop: 10 }}>
                  On-chain balance now: <b style={{ color: "#221217" }}>{onchainBalance.toFixed(2)} USDC</b>
                </div>
              )}

              {/* Self-serve faucet, the fastest path, and it hands out the exact
                  test USDC this app reads (a faucet elsewhere gives the wrong one). */}
              <button
                onClick={() => void getTestUsdc()}
                disabled={faucetM.isPending}
                className="btnp"
                style={{ width: "100%", padding: 14, borderRadius: 14, fontSize: 15, marginTop: 18, opacity: faucetM.isPending ? 0.6 : 1 }}
              >
                <Coins size={16} weight="fill" />
                {faucetM.isPending ? "Minting…" : "Get test USDC"}
              </button>
              <div style={{ fontSize: 11.5, color: "#B3A6AB", fontWeight: 600, textAlign: "center", marginTop: 8 }}>
                Drops 100 test USDC into your wallet, no charge, it&rsquo;s play money.
              </div>

              <button
                onClick={() => void recheckOnchain()}
                disabled={checking}
                style={{ width: "100%", padding: 12, borderRadius: 14, fontSize: 13.5, marginTop: 12, background: "transparent", border: "1.5px solid #EFE6E9", color: "#7C6D72", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: checking ? 0.6 : 1 }}
              >
                <ArrowDown size={15} weight="bold" />
                {checking ? "Checking…" : "I've sent it, check my balance"}
              </button>
              {msg && (
                <p style={{ fontSize: 12.5, textAlign: "center", marginTop: 12, fontWeight: 700, lineHeight: 1.4, color: msg.ok ? "#B81540" : "#7C6D72" }}>
                  {msg.text}
                </p>
              )}
            </>
          ) : (
            <div style={{ background: "#FBF6E9", borderRadius: 12, padding: 14, fontSize: 13, color: "#7A6A2E", fontWeight: 600 }}>
              Connecting your wallet… reopen this in a moment.
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 16, fontSize: 11.5, fontWeight: 600, color: "#B3A6AB" }}>
            <ShieldCheck size={14} weight="fill" color="#FF3355" /> Your funds stay in your own wallet until you bet
          </div>
        </div>
      </Modal>
    );
  }

  // ── Custodial float deposit (Challenge / Wallet / Trial) ────────────────────
  return (
    <Modal open={open} onClose={onClose} width={440} label="Add funds">
      <div style={{ padding: 26 }}>
        <h2 className="cd" style={{ fontSize: 22, margin: "0 0 4px" }}>Add funds</h2>
        <p style={{ fontSize: 13, color: "#7C6D72", margin: "0 0 18px" }}>
          Send USDC to your deposit address from any Solana wallet or exchange, it&rsquo;s credited to your balance automatically.
        </p>

        {!available ? (
          <div style={{ background: "#FBF6E9", borderRadius: 12, padding: 14, fontSize: 13, color: "#7A6A2E", fontWeight: 600 }}>
            {addrQ.isLoading ? "Loading your deposit address…" : "Deposits aren't enabled for this account yet."}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".6px", color: "#988990" }}>YOUR DEPOSIT ADDRESS · SOLANA</div>
            <button
              onClick={() => void copy()}
              style={{ width: "100%", marginTop: 8, display: "flex", alignItems: "center", gap: 12, background: "#F9F3F5", border: "1.5px solid #EFE6E9", borderRadius: 12, padding: "13px 14px", cursor: "pointer", textAlign: "left" }}
            >
              <span className="mono" style={{ flex: 1, fontSize: 12.5, color: "#221217", wordBreak: "break-all", lineHeight: 1.4 }}>{address}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#B81540", flex: "none", display: "flex", alignItems: "center", gap: 4 }}>
                {copied ? <><CheckCircle size={15} weight="fill" /> Copied</> : "Copy"}
              </span>
            </button>
            <div style={{ fontSize: 11.5, color: "#B3A6AB", fontWeight: 600, marginTop: 8 }}>
              Only send <b>USDC</b> on the <b>Solana</b> network to this address.
            </div>

            <button
              onClick={() => void check()}
              disabled={syncM.isPending}
              className="btnp"
              style={{ width: "100%", padding: 14, borderRadius: 14, fontSize: 15, marginTop: 18, opacity: syncM.isPending ? 0.6 : 1 }}
            >
              <ArrowDown size={16} weight="bold" />
              {syncM.isPending ? "Checking…" : "I've sent it, check for my deposit"}
            </button>
            {msg && (
              <p style={{ fontSize: 12.5, textAlign: "center", marginTop: 12, fontWeight: 700, lineHeight: 1.4, color: msg.ok ? "#B81540" : "#7C6D72" }}>
                {msg.text}
              </p>
            )}
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 16, fontSize: 11.5, fontWeight: 600, color: "#B3A6AB" }}>
          <ShieldCheck size={14} weight="fill" color="#FF3355" /> Held in the ChumBucket float · cash out anytime
        </div>
      </div>
    </Modal>
  );
}
