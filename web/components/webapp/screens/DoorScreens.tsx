"use client";

/**
 * The way in, as on the phone: brand art, one line, and the ways in at the
 * bottom (wallet first, then round Google and X). An account is the way in;
 * there is no "look around first". A new account then claims its @username.
 */

import { useEffect, useRef, useState } from "react";
import { normaliseUsername, USERNAME_FORMAT, WALLET_COPY } from "@/lib/webapp/identity";
import type { UsernameStatus } from "@/lib/webapp/api";
import { bffCall } from "@/lib/webapp/bff";
import { ago, calledAt, closesIn, isSettled, outcomeOf, sideLabel } from "@/lib/webapp/format";
import type { CallFeedEntry, FeedPage } from "@/lib/webapp/types";
import { Icon } from "../Icon";
import { useAuth } from "../session";
import { Avatar, CallMarkChip, OutcomeBadge, Sheet, SidePill, Spinner } from "../ui";
import { onWalletsChange, solanaWallets, type StandardWallet } from "../wallets";

/* eslint-disable @next/next/no-img-element */

function Brand() {
  return (
    <a href="/" className="wa-door-brand" aria-label="chumbucket.fun">
      <img src="/img/logo-192.png" alt="" width={34} height={34} />
      <span>CHUMBUCKET</span>
    </a>
  );
}

function Consent() {
  return (
    <p className="wa-consent">
      By continuing, you agree to the <a href="/terms">Terms of Use</a> and <a href="/privacy">Privacy Policy</a>.
    </p>
  );
}

export function useWallets(): StandardWallet[] {
  const [list, setList] = useState<StandardWallet[]>([]);
  useEffect(() => {
    const read = () => setList([...solanaWallets()]);
    read();
    // Extensions can register a moment after the page loads.
    const t = setTimeout(read, 600);
    const off = onWalletsChange(read);
    return () => {
      clearTimeout(t);
      off();
    };
  }, []);
  return list;
}

export function SignInScreen() {
  const auth = useAuth();
  const wallets = useWallets();
  const [picking, setPicking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = auth.busy;
  const error = localError ?? auth.error;

  const startWallet = () => {
    setLocalError(null);
    auth.clearError();
    if (wallets.length === 0) setLocalError(WALLET_COPY.none);
    else if (wallets.length === 1) void auth.signInWithWallet(wallets[0]!);
    else setPicking(true);
  };
  const lone = wallets.length === 1 ? wallets[0]! : null;

  return (
    <div className="wa-door">
      <main className="wa-door-panel">
        <Brand />
        <div className="wa-door-hero">
          <img src="/img/states/record.webp" alt="" width={184} height={184} />
          <h1>Sign in to go on record</h1>
          <p>One account. Wallet, Google or X.</p>
        </div>
        <div className="wa-door-ways">
          {error ? (
            <p className="wa-door-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="button" className="wa-btn wa-btn--primary wa-btn--block" onClick={startWallet} disabled={!!busy} aria-busy={busy === "wallet"}>
            {busy === "wallet" ? (
              <Spinner />
            ) : lone ? (
              <img src={lone.icon} alt="" width={22} height={22} style={{ borderRadius: 6 }} />
            ) : (
              <Icon name="wallet" size={22} />
            )}
            {busy === "wallet" ? "Check your wallet…" : "Continue with wallet"}
            {auth.lastMethod === "wallet" && !busy ? <span className="wa-lastused">Last used</span> : null}
          </button>
          <div className="wa-door-round">
            <button
              type="button"
              className="wa-roundbtn"
              aria-label="Continue with Google"
              disabled={!!busy}
              onClick={() => void auth.signInWithProvider("google")}
            >
              {busy === "google" ? <Spinner /> : <GoogleMark />}
              {auth.lastMethod === "google" && !busy ? <span className="wa-lastused">Last used</span> : null}
            </button>
            <button
              type="button"
              className="wa-roundbtn"
              aria-label="Continue with X"
              disabled={!!busy}
              onClick={() => void auth.signInWithProvider("x")}
            >
              {busy === "x" ? <Spinner /> : <Icon name="x-brand" size={22} />}
              {auth.lastMethod === "x" && !busy ? <span className="wa-lastused">Last used</span> : null}
            </button>
          </div>
          <Consent />
        </div>
      </main>
      <LivePreview />
      <Sheet open={picking} onClose={() => setPicking(false)} title="Pick a wallet" subtitle="It signs a message, not a transaction.">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 12 }}>
          {wallets.map((w) => (
            <button
              key={w.name}
              type="button"
              className="wa-wallet"
              onClick={() => {
                setPicking(false);
                void auth.signInWithWallet(w);
              }}
            >
              <img src={w.icon} alt="" width={34} height={34} />
              {w.name}
              <Icon name="arrow-right" size={18} className="wa-menu-end" />
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

/**
 * Beside the way in on wide screens: real calls people are making right now,
 * from the public feed (no session needed). The brand art stands in when the
 * feed is empty or unreachable. Decorative: the sign-in is the content.
 */
function LivePreview() {
  const [entries, setEntries] = useState<CallFeedEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    bffCall<FeedPage>({ path: "calls.feed", input: { mode: "global", limit: 12 }, kind: "query" })
      .then((page) => {
        if (!alive) return;
        // One call per person, open calls first: who is calling what, now.
        const seen = new Set<string>();
        const picked = [...page.entries]
          .sort((a, b) => Number(isSettled(a)) - Number(isSettled(b)))
          .filter((e) => !seen.has(e.author.id) && seen.add(e.author.id))
          .slice(0, 3);
        setEntries(picked);
      })
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, []);
  const now = Date.now();
  return (
    <div className="wa-door-show" aria-hidden>
      {entries?.length ? (
        <div className="wa-door-stack">
          {entries.map((e) => {
            const left = closesIn(e.market.closesAt, now);
            const price = calledAt(e.call);
            return (
              <div key={e.call.id} className="wa-card wa-call wa-door-card">
                <div className="wa-call-head">
                  <span className="wa-person">
                    <Avatar person={e.author} size={40} />
                    <span className="wa-person-text">
                      <span className="wa-person-name">{e.author.displayName}</span>
                      <span className="wa-person-meta">
                        @{e.author.handle} · {ago(e.call.createdAt, now)}
                      </span>
                    </span>
                  </span>
                </div>
                <div className="wa-call-q">
                  <SidePill side={e.call.side} label={sideLabel(e.market, e.call.side)} />
                  <span className="wa-question">{e.market.question}</span>
                </div>
                <div className="wa-chips" style={{ marginTop: 12 }}>
                  {isSettled(e) ? <OutcomeBadge outcome={outcomeOf(e)} /> : null}
                  {!isSettled(e) && left ? (
                    <span className="wa-chip">
                      <Icon name="timer" size={14} />
                      {left}
                    </span>
                  ) : null}
                  <CallMarkChip entry={e} />
                  {price ? (
                    <span className="wa-chip">
                      <Icon name="chart-pie" size={14} />
                      {price}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : entries ? (
        <img src="/img/states/people.webp" alt="" width={320} height={320} style={{ width: 320, height: 320 }} />
      ) : null}
    </div>
  );
}

/** Google's "G", in its own colours. */
export function GoogleMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}

type Check = { state: "idle" | "checking" | UsernameStatus | "format" | "error" };

/** Live, debounced "is it free?" for a @username: the BFF decides, credential-free. */
function useUsernameCheck(handle: string): Check {
  const auth = useAuth();
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (!handle) return setCheck({ state: "idle" });
    if (!USERNAME_FORMAT.test(handle)) return setCheck({ state: "format" });
    setCheck({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const res = await auth.api.usernameStatus(handle);
        if (mine === seq.current) setCheck({ state: res.status });
      } catch {
        if (mine === seq.current) setCheck({ state: "error" });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [handle, auth.api]);
  return check;
}

const CHECK_COPY: Record<Check["state"], { text: string; tone: "" | "ok" | "error" }> = {
  idle: { text: "3–20 letters, numbers or _", tone: "" },
  checking: { text: "Checking…", tone: "" },
  available: { text: "Available", tone: "ok" },
  taken: { text: "Taken", tone: "error" },
  reserved: { text: "Not available", tone: "error" },
  invalid: { text: "3–20 letters, numbers or _", tone: "error" },
  format: { text: "3–20 letters, numbers or _", tone: "error" },
  error: { text: "Couldn’t check. You can still try.", tone: "" },
};

export function ClaimScreen({ mode }: { mode: "new" | "handle" }) {
  const auth = useAuth();
  const [name, setName] = useState(auth.hints.name);
  const [raw, setRaw] = useState(auth.hints.username);
  const [error, setError] = useState<string | null>(null);
  const handle = normaliseUsername(raw);
  const check = useUsernameCheck(handle);
  const copy = CHECK_COPY[check.state];
  const busy = auth.busy === "claim";
  const canSubmit =
    !busy &&
    USERNAME_FORMAT.test(handle) &&
    check.state !== "taken" &&
    check.state !== "reserved" &&
    (mode === "handle" || name.trim().length > 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    const failure = mode === "new" ? await auth.completeProfile(name, handle) : await auth.claimUsername(handle);
    if (failure) setError(failure);
  };

  return (
    <div className="wa-door">
      <main className="wa-door-panel">
        <Brand />
        <form className="wa-door-hero" style={{ justifyContent: "flex-start", paddingTop: 24 }} onSubmit={submit} noValidate>
          <img src="/img/states/people.webp" alt="" width={150} height={150} style={{ width: 150, height: 150 }} />
          <h1>{mode === "new" ? "Claim your @username" : "Pick your @username"}</h1>
          <p>Usernames can’t be changed yet.</p>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 14, marginTop: 22, textAlign: "left" }}>
            {mode === "new" ? (
              <div className="wa-field">
                <label htmlFor="claim-name">Name</label>
                <input
                  id="claim-name"
                  className="wa-input"
                  value={name}
                  maxLength={60}
                  autoComplete="name"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            ) : null}
            <div className="wa-field">
              <label htmlFor="claim-handle">Username</label>
              <div className="wa-input-wrap">
                <span className="wa-input-prefix" aria-hidden>
                  @
                </span>
                <input
                  id="claim-handle"
                  className="wa-input"
                  value={raw}
                  maxLength={21}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="username"
                  aria-describedby="claim-handle-hint"
                  aria-invalid={copy.tone === "error"}
                  onChange={(e) => setRaw(e.target.value)}
                />
                <span className="wa-input-status" aria-hidden>
                  {check.state === "checking" ? (
                    <Spinner />
                  ) : check.state === "available" ? (
                    <Icon name="check-solid" size={20} className="wa-hint--ok" />
                  ) : copy.tone === "error" ? (
                    <Icon name="cross" size={20} className="wa-hint--error" />
                  ) : null}
                </span>
              </div>
              <span id="claim-handle-hint" className={`wa-hint${copy.tone ? ` wa-hint--${copy.tone}` : ""}`} aria-live="polite">
                {copy.text}
              </span>
            </div>
            {error ? (
              <p className="wa-door-error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className="wa-btn wa-btn--primary wa-btn--block" disabled={!canSubmit}>
              {busy ? <Spinner /> : null}
              {handle && USERNAME_FORMAT.test(handle) ? `Claim @${handle}` : "Claim username"}
            </button>
            {mode === "handle" ? (
              <button type="button" className="wa-btn wa-btn--block" onClick={auth.skipHandle} disabled={busy}>
                Later
              </button>
            ) : (
              <button type="button" className="wa-btn wa-btn--block" onClick={() => void auth.signOut()} disabled={busy}>
                Use a different sign-in
              </button>
            )}
          </div>
        </form>
      </main>
      <LivePreview />
    </div>
  );
}
