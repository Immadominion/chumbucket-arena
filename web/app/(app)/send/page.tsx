"use client";

/**
 * Peer-to-peer SOL — send native SOL to any wallet address, or show your own
 * address as a QR code to receive. This is separate from the in-game USDC
 * balance (the /wallet page's add-funds/cash-out flow) — real SOL, signed with
 * the Privy embedded Solana wallet, same wallet the backend already resolves
 * for this account (see components/Providers.tsx).
 */

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ArrowUpRight, CheckCircle, Copy, PaperPlaneRight, QrCode, WarningCircle } from "@/components/icons";
import { useSession } from "@/lib/session";
import {
  buildTransferTransaction,
  explorerTxUrl,
  getConnection,
  isValidSolanaAddress,
  lamportsToSol,
  solToLamports,
  SOLANA_CHAIN,
} from "@/lib/solana";

/* eslint-disable @next/next/no-img-element */

export default function SendPage() {
  return (
    <Suspense fallback={null}>
      <SendPageInner />
    </Suspense>
  );
}

function SendPageInner() {
  const params = useSearchParams();
  const prefillTo = params.get("to") ?? "";
  const prefillName = params.get("name") ?? "";
  const [tab, setTab] = useState<"send" | "receive">(prefillTo ? "send" : "receive");

  return (
    <div className="midpad" style={{ maxWidth: 560 }}>
      <div className="cd" style={{ fontSize: 24 }}>Send &amp; receive SOL</div>
      <p style={{ fontSize: 13, color: "#7C6D72", marginTop: 4, lineHeight: 1.5 }}>
        Peer-to-peer, straight from your wallet — separate from your ChumBucket balance.
      </p>

      <div style={{ display: "flex", gap: 6, marginTop: 18, background: "#F5EEF1", borderRadius: 14, padding: 4 }}>
        <TabButton active={tab === "send"} onClick={() => setTab("send")} label="Send" Icon={PaperPlaneRight} />
        <TabButton active={tab === "receive"} onClick={() => setTab("receive")} label="Receive" Icon={QrCode} />
      </div>

      {tab === "send" ? (
        <SendPanel prefillTo={prefillTo} prefillName={prefillName} />
      ) : (
        <ReceivePanel />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  Icon: typeof PaperPlaneRight;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        padding: "10px 12px",
        borderRadius: 11,
        border: "none",
        cursor: "pointer",
        fontSize: 13.5,
        fontWeight: 700,
        background: active ? "#fff" : "none",
        color: active ? "#221217" : "#988990",
        boxShadow: active ? "0 2px 8px rgba(8,16,12,.08)" : "none",
      }}
    >
      <Icon size={16} weight={active ? "fill" : "regular"} />
      {label}
    </button>
  );
}

function ReceivePanel() {
  const { session } = useSession();
  const [copied, setCopied] = useState(false);
  const wallet = session.wallet;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — address is still visible to select manually */
    }
  };

  return (
    <div className="card" style={{ marginTop: 18, padding: 26, display: "flex", flexDirection: "column", alignItems: "center" }}>
      {wallet ? (
        <div style={{ background: "#fff", padding: 16, borderRadius: 16, border: "1.5px solid #EFE6E9" }}>
          <QRCodeSVG value={wallet} size={200} level="M" />
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "#988990", fontWeight: 600, padding: "40px 0" }}>
          No wallet address yet — finish setting up your account first.
        </div>
      )}
      {wallet && (
        <>
          <button
            onClick={() => void copy()}
            style={{
              width: "100%",
              marginTop: 18,
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: "#F9F3F5",
              border: "1.5px solid #EFE6E9",
              borderRadius: 12,
              padding: "13px 14px",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span className="mono" style={{ flex: 1, fontSize: 12.5, color: "#221217", wordBreak: "break-all", lineHeight: 1.4 }}>
              {wallet}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#B81540", flex: "none", display: "flex", alignItems: "center", gap: 4 }}>
              {copied ? (
                <>
                  <CheckCircle size={15} weight="fill" /> Copied
                </>
              ) : (
                <>
                  <Copy size={15} weight="bold" /> Copy
                </>
              )}
            </span>
          </button>
          <div style={{ fontSize: 11.5, color: "#B3A6AB", fontWeight: 600, marginTop: 10, textAlign: "center" }}>
            Only send <b>SOL</b> on the <b>Solana</b> network to this address.
          </div>
        </>
      )}
    </div>
  );
}

type SendStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; signature: string }
  | { kind: "error"; message: string };

function SendPanel({ prefillTo, prefillName }: { prefillTo: string; prefillName: string }) {
  const { session } = useSession();
  const { user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();

  const [to, setTo] = useState(prefillTo);
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<SendStatus>({ kind: "idle" });

  const myWallet = useMemo(
    () => wallets.find((w) => w.address === session.wallet) ?? wallets[0],
    [wallets, session.wallet],
  );

  const balanceQ = useQuery({
    queryKey: ["sol-balance", session.wallet],
    queryFn: async () => {
      const lamports = await getConnection().getBalance(new PublicKey(session.wallet));
      return lamportsToSol(lamports);
    },
    enabled: !!session.wallet,
    staleTime: 10_000,
    refetchInterval: 20_000,
  });

  const addressError = to.trim().length > 0 && !isValidSolanaAddress(to.trim()) ? "That doesn't look like a valid Solana address." : null;
  const amountNum = parseFloat(amount);
  const amountError = amount.trim().length > 0 && (!Number.isFinite(amountNum) || amountNum <= 0) ? "Enter a valid amount." : null;

  const canSend =
    !!user?.id &&
    !!myWallet &&
    to.trim().length > 0 &&
    !addressError &&
    amount.trim().length > 0 &&
    !amountError &&
    status.kind !== "pending";

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend || !myWallet) return;
    setStatus({ kind: "pending" });
    try {
      const lamports = solToLamports(amountNum);
      const transaction = await buildTransferTransaction({ from: myWallet.address, to: to.trim(), lamports });
      const { signature } = await signAndSendTransaction({
        transaction,
        wallet: myWallet,
        chain: SOLANA_CHAIN,
      });
      const sigBase58 = bs58.encode(signature);
      setStatus({ kind: "success", signature: sigBase58 });
      setAmount("");
      void balanceQ.refetch();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Couldn't send that transaction. Try again.",
      });
    }
  };

  return (
    <form onSubmit={(e) => void send(e)} className="card" style={{ marginTop: 18, padding: 22 }}>
      {prefillName && (
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#7C6D72", marginBottom: 12 }}>
          Sending to <span style={{ color: "#221217" }}>{prefillName}</span>
        </div>
      )}

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".6px", color: "#988990", marginBottom: 8 }}>
        RECIPIENT WALLET ADDRESS
      </div>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value.trim())}
        placeholder="Solana wallet address"
        className="mono"
        style={{ width: "100%", border: "1.5px solid #EFE6E9", borderRadius: 12, padding: "12px 14px", fontSize: 13, fontWeight: 600, color: "#221217" }}
      />
      {addressError && <p style={{ fontSize: 11.5, color: "#C2373B", marginTop: 6, fontWeight: 600 }}>{addressError}</p>}

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 16, marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".6px", color: "#988990" }}>AMOUNT · SOL</div>
        {session.wallet && (
          <div style={{ fontSize: 11.5, color: "#988990", fontWeight: 600 }}>
            {balanceQ.isLoading ? "Loading balance…" : balanceQ.data !== undefined ? `Balance: ${balanceQ.data.toFixed(4)} SOL` : ""}
          </div>
        )}
      </div>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.00"
        inputMode="decimal"
        style={{ width: "100%", border: "1.5px solid #EFE6E9", borderRadius: 12, padding: "12px 14px", fontSize: 16, fontWeight: 700, color: "#221217" }}
      />
      {amountError && <p style={{ fontSize: 11.5, color: "#C2373B", marginTop: 6, fontWeight: 600 }}>{amountError}</p>}

      <button
        type="submit"
        disabled={!canSend}
        className="btnp"
        style={{ width: "100%", padding: 14, borderRadius: 14, fontSize: 15, marginTop: 18, opacity: canSend ? 1 : 0.5 }}
      >
        <PaperPlaneRight size={17} weight="fill" />
        {status.kind === "pending" ? "Sending…" : "Send SOL"}
      </button>

      {!walletsReady && (
        <p style={{ fontSize: 11.5, color: "#B3A6AB", textAlign: "center", marginTop: 12, fontWeight: 600 }}>
          Connecting your wallet…
        </p>
      )}

      {status.kind === "success" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, padding: "12px 14px", background: "#E7F6EC", borderRadius: 12 }}>
          <CheckCircle size={18} weight="fill" color="#0A7E40" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#0A7E40" }}>Sent</div>
            <a
              href={explorerTxUrl(status.signature)}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11.5, color: "#0A7E40", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
            >
              View on Solana Explorer <ArrowUpRight size={12} weight="bold" />
            </a>
          </div>
        </div>
      )}
      {status.kind === "error" && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 14, padding: "12px 14px", background: "#FBE9EA", borderRadius: 12 }}>
          <WarningCircle size={18} weight="fill" color="#C2373B" style={{ flex: "none", marginTop: 1 }} />
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "#C2373B", lineHeight: 1.4 }}>{status.message}</div>
        </div>
      )}
    </form>
  );
}
