"use client";

/**
 * Settings → Sign-in methods: the ways into this account (wallet, X,
 * Google), the one this session used, Link for the ones it hasn't, and
 * unlink for the ones it may lose. Never the last one: the BFF decides what
 * can go, and says so per row.
 *
 * When Supabase can't link (the X/Google is on another account, or the
 * wallet signs in to one), the person proves the other side in a separate
 * window and confirms what happens: a sign-in with no account joins this one;
 * another account moves in (its calls stay as made) — or stays separate when
 * it has trades.
 */

/* eslint-disable @next/next/no-img-element */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { BffRejected, BffSignedOut } from "@/lib/webapp/bff";
import {
  accountName,
  KIND_NAME,
  KINDS,
  linkCopy,
  methodLabel,
  type LinkMethod,
  type LinkPreview,
  type MethodKind,
  type SignInMethodRow,
  type SignInMethods as Methods,
} from "@/lib/webapp/linking";
import { accessToken } from "./authClient";
import { useToast } from "./data";
import { Icon } from "./Icon";
import {
  LinkStopped,
  linkProviderHere,
  linkWalletHere,
  openProofWindow,
  proveWithProvider,
  proveWithWallet,
  releaseProof,
  takeLinkReturn,
  unlinkHere,
} from "./linking";
import { GoogleMark, useWallets } from "./screens/DoorScreens";
import { useAuth } from "./session";
import { Sheet, Spinner } from "./ui";
import { WalletDeclined, type StandardWallet } from "./wallets";

function KindMark({ kind }: { kind: MethodKind }) {
  if (kind === "google") return <GoogleMark />;
  return <Icon name={kind === "x" ? "x-brand" : "wallet"} size={22} />;
}

/** A refusal as one line, whoever refused it. */
function stopLine(e: unknown): string {
  if (e instanceof LinkStopped) return linkCopy(e.code);
  if (e instanceof WalletDeclined) return linkCopy("cancelled");
  if (e instanceof BffRejected || e instanceof BffSignedOut) return linkCopy(e.message);
  return linkCopy("network");
}

type Move =
  | { stage: "conflict"; method: LinkMethod }
  | { stage: "proving"; method: LinkMethod }
  | { stage: "preview"; method: LinkMethod; preview: LinkPreview; ticket: string; proof: string }
  | { stage: "moving"; method: LinkMethod; preview: LinkPreview; ticket: string; proof: string };

export function SignInMethods() {
  const auth = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const wallets = useWallets();
  const [data, setData] = useState<Methods | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [move, setMove] = useState<Move | null>(null);
  const [unlinking, setUnlinking] = useState<SignInMethodRow | null>(null);
  const [picking, setPicking] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const token = await accessToken();
    if (!token) return;
    try {
      setData(await auth.api.signInMethods(token));
    } catch (e) {
      setLine(stopLine(e));
    }
  }, [auth.api]);

  useEffect(() => {
    void load();
    // Back from linking X or Google: say how it went, or start the move.
    const back = takeLinkReturn();
    if (back?.error === "identity_already_exists") setMove({ stage: "conflict", method: back.method });
    else if (back?.error) setLine(linkCopy(back.error));
    else if (back) toast(`${KIND_NAME[back.method]} linked`);
  }, [load, toast]);

  useEffect(() => () => abort.current?.abort(), []);

  const linkWallet = async (wallet: StandardWallet) => {
    const token = await accessToken();
    if (!token) return;
    setBusy("wallet");
    setLine(null);
    try {
      await linkWalletHere(auth.api, token, wallet);
      toast("Wallet linked");
      await load();
    } catch (e) {
      if (e instanceof BffRejected && e.message === "WALLET_OWNED_BY_ANOTHER_USER") setMove({ stage: "conflict", method: "wallet" });
      else setLine(stopLine(e));
    } finally {
      setBusy(null);
    }
  };

  const link = async (kind: MethodKind) => {
    setLine(null);
    if (kind === "wallet") {
      if (wallets.length === 0) setLine("No Solana wallet in this browser.");
      else if (wallets.length === 1) await linkWallet(wallets[0]!);
      else setPicking(true);
      return;
    }
    setBusy(kind);
    try {
      await linkProviderHere(kind);
    } catch (e) {
      setBusy(null);
      setLine(stopLine(e));
    }
  };

  /** Prove the other side, then show what would happen. The window opens inside the tap. */
  const prove = async (method: LinkMethod, wallet?: StandardWallet) => {
    const popup = method === "wallet" ? null : openProofWindow();
    if (method !== "wallet" && !popup) {
      setLine(linkCopy("popup"));
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setMove({ stage: "proving", method });
    setLine(null);
    let proof: string | null = null;
    try {
      const token = await accessToken();
      if (!token) throw new LinkStopped("cancelled");
      const issued = auth.api.startSignInLink(token, method);
      issued.catch(() => undefined); // awaited below, after the proof
      proof =
        method === "wallet"
          ? await proveWithWallet(wallet ?? wallets[0]!)
          : await proveWithProvider(method, popup!, controller.signal);
      const { ticket } = await issued;
      const preview = await auth.api.previewSignInLink(proof, ticket);
      setMove({ stage: "preview", method, preview, ticket, proof });
    } catch (e) {
      popup?.close();
      releaseProof(proof);
      setMove(null);
      setLine(stopLine(e));
    }
  };

  const finish = async (m: Extract<Move, { stage: "preview" }>) => {
    setMove({ ...m, stage: "moving" });
    try {
      const done = await auth.api.completeSignInLink(m.proof, m.ticket);
      toast(done.outcome === "folded" ? `${accountName(m.preview.from)} moved here` : `${KIND_NAME[m.method]} linked`);
      if (done.outcome === "folded") void qc.invalidateQueries();
      await load();
      setMove(null);
    } catch (e) {
      setMove(null);
      setLine(stopLine(e));
    } finally {
      releaseProof(m.proof);
    }
  };

  const closeMove = () => {
    abort.current?.abort();
    if (move && (move.stage === "preview" || move.stage === "moving")) releaseProof(move.proof);
    setMove(null);
  };

  const unlink = async (row: SignInMethodRow) => {
    if (!row.unlink) return;
    setBusy(row.id);
    setLine(null);
    try {
      if (row.unlink.mode === "native") await unlinkHere(row.unlink.identityId);
      else {
        const token = await accessToken();
        if (!token) throw new LinkStopped("cancelled");
        await auth.api.unlinkSignIn(token, row.unlink.ref);
      }
      setUnlinking(null);
      await load();
    } catch (e) {
      setLine(stopLine(e));
    } finally {
      setBusy(null);
    }
  };

  const rows = data?.methods ?? [];
  const current = rows.find((r) => r.current) ?? null;
  const missing = data?.linking ? KINDS.filter((k) => !rows.some((r) => r.kind === k)) : [];

  return (
    <section className="wa-signins" aria-label="Sign-in methods">
      {current ? (
        <p className="wa-signins-now">
          <span>Signed in with</span>
          <KindMark kind={current.kind} />
          <b>{methodLabel(current)}</b>
        </p>
      ) : null}
      <ul className="wa-menu">
        {data === null ? (
          <li className="wa-signins-loading">
            <Spinner />
          </li>
        ) : null}
        {rows.map((row) => (
          <li key={row.id}>
            <div className="wa-signin">
              <KindMark kind={row.kind} />
              <span className="wa-signin-label">{methodLabel(row)}</span>
              {row.current ? <Icon name="check-solid" size={18} label="Signed in with this" className="wa-signin-now" /> : null}
              {data?.linking && row.unlink && !row.current ? (
                <button
                  type="button"
                  className="wa-iconbtn wa-signin-off"
                  aria-label={`Unlink ${KIND_NAME[row.kind]}`}
                  disabled={busy !== null}
                  onClick={() => setUnlinking(row)}
                >
                  {busy === row.id ? <Spinner /> : <Icon name="cross" size={18} />}
                </button>
              ) : null}
            </div>
          </li>
        ))}
        {missing.map((kind) => (
          <li key={`link-${kind}`}>
            <button type="button" onClick={() => void link(kind)} disabled={busy !== null} aria-busy={busy === kind}>
              <KindMark kind={kind} />
              {KIND_NAME[kind]}
              <span className="wa-menu-end">{busy === kind ? <Spinner /> : "Link"}</span>
            </button>
          </li>
        ))}
      </ul>
      {line ? (
        <p className="wa-signins-line" role="status">
          {line}
        </p>
      ) : null}

      <Sheet open={picking} onClose={() => setPicking(false)} title="Pick a wallet" subtitle="It signs a message, not a transaction.">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 12 }}>
          {wallets.map((w) => (
            <button
              key={w.name}
              type="button"
              className="wa-wallet"
              onClick={() => {
                setPicking(false);
                if (move?.stage === "conflict") void prove("wallet", w);
                else void linkWallet(w);
              }}
            >
              <img src={w.icon} alt="" width={34} height={34} />
              {w.name}
              <Icon name="arrow-right" size={18} className="wa-menu-end" />
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={unlinking !== null}
        onClose={() => setUnlinking(null)}
        busy={busy !== null}
        title={unlinking ? `Unlink ${KIND_NAME[unlinking.kind]}?` : ""}
        subtitle={unlinking?.alsoUnlinks.length ? `${unlinking.alsoUnlinks.map((k) => KIND_NAME[k]).join(" and ")} goes too.` : undefined}
      >
        {unlinking ? (
          <div className="wa-move">
            <div className="wa-move-pair">
              <KindMark kind={unlinking.kind} />
              {unlinking.alsoUnlinks.map((k) => (
                <KindMark key={k} kind={k} />
              ))}
              <b>{methodLabel(unlinking)}</b>
            </div>
            <button type="button" className="wa-btn wa-btn--ink wa-btn--block" disabled={busy !== null} onClick={() => void unlink(unlinking)}>
              {busy === unlinking.id ? <Spinner /> : "Unlink"}
            </button>
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={move !== null}
        onClose={closeMove}
        busy={move?.stage === "moving"}
        title={move ? (move.stage === "preview" || move.stage === "moving" ? moveTitle(move.preview) : `Link ${KIND_NAME[move.method]}`) : ""}
      >
        {move ? <MoveBody move={move} onProve={(m) => (m === "wallet" && wallets.length > 1 ? setPicking(true) : void prove(m))} onFinish={finish} onClose={closeMove} /> : null}
      </Sheet>
    </section>
  );
}

function moveTitle(p: LinkPreview): string {
  if (p.outcome === "fold") return "Move account";
  if (p.outcome === "already") return "Already linked";
  return "Link";
}

function MoveBody({
  move,
  onProve,
  onFinish,
  onClose,
}: {
  move: Move;
  onProve: (method: LinkMethod) => void;
  onFinish: (m: Extract<Move, { stage: "preview" }>) => void;
  onClose: () => void;
}) {
  if (move.stage === "conflict" || move.stage === "proving") {
    return (
      <div className="wa-move">
        <div className="wa-move-pair">
          <KindMark kind={move.method} />
          <Icon name="user" size={22} />
        </div>
        <p className="wa-move-line">This {KIND_NAME[move.method]} is on another account. Sign in with it to bring it here.</p>
        <button
          type="button"
          className="wa-btn wa-btn--primary wa-btn--block"
          disabled={move.stage === "proving"}
          aria-busy={move.stage === "proving"}
          onClick={() => onProve(move.method)}
        >
          {move.stage === "proving" ? <Spinner /> : <KindMark kind={move.method} />}
          {move.stage === "proving" ? "Waiting…" : `Continue with ${KIND_NAME[move.method]}`}
        </button>
      </div>
    );
  }
  const { preview } = move;
  const moving = move.stage === "moving";
  if (preview.outcome === "already") {
    return (
      <div className="wa-move">
        <p className="wa-move-line">It already signs in here.</p>
        <button type="button" className="wa-btn wa-btn--soft wa-btn--block" onClick={onClose}>
          Done
        </button>
      </div>
    );
  }
  const refusal = preview.outcome === "fold" ? preview.refusal : null;
  return (
    <div className="wa-move">
      <div className="wa-move-pair">
        {preview.from ? <b>{accountName(preview.from)}</b> : <KindMark kind={move.method} />}
        <Icon name="arrow-right" size={20} />
        <b>{accountName(preview.into)}</b>
      </div>
      <p className="wa-move-line">
        {refusal
          ? linkCopy(refusal)
          : preview.outcome === "fold"
            ? "Its sign-ins, wallets and follows move here. Its calls stay as made."
            : `${KIND_NAME[move.method]} signs in here from now on.`}
      </p>
      {refusal ? (
        <button type="button" className="wa-btn wa-btn--soft wa-btn--block" onClick={onClose}>
          Done
        </button>
      ) : (
        <button
          type="button"
          className="wa-btn wa-btn--primary wa-btn--block"
          disabled={moving}
          aria-busy={moving}
          onClick={() => move.stage === "preview" && onFinish(move)}
        >
          {moving ? <Spinner /> : preview.outcome === "fold" ? "Move here" : "Link"}
        </button>
      )}
    </div>
  );
}
