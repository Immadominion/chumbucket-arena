"use client";

/**
 * The Chumbucket wallet in the browser: the account's one wallet (a Privy
 * embedded Solana wallet), the default way to pay for a trade. Two gates:
 * NEXT_PUBLIC_CHUMBUCKET_WALLET_ENABLED and a Privy app id say the bundle
 * can run it (without both nothing here loads), and the server's
 * `wallet.status` says whether it is on for THIS account (admins only during
 * rollout). Until the server says `enabled`, `useChumbucketWallet` answers
 * "off" and Privy is never loaded.
 *
 * One wallet per ACCOUNT: Privy is signed in with the BFF's own ten-minute
 * token (`wallet.privyToken`, sub = the account), never with a Supabase
 * token, so a wallet sign-in and an X sign-in of one account reach the same
 * wallet. The token is fetched again before it expires.
 *
 * What the BFF knows comes first and costs nothing: `wallet.status` names the
 * account's linked Chumbucket wallet. Privy itself (its SDK and a session)
 * loads only on first need, as a sibling of the app rather than around it.
 * Signing out, or another account signing in, logs Privy out first, then
 * unloads it.
 *
 * Privy is imported in exactly one file, `ChumbucketWalletPrivy.tsx`.
 */

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { linkChumbucketWallet } from "@/lib/webapp/chumbucketLink";
import { chumbucketWalletOn } from "@/lib/webapp/rollout";
import { checkedSigner, type TradeSigner } from "@/lib/webapp/trade";
import { accessToken } from "./authClient";
import { useAuth } from "./session";

export const CHUMBUCKET_WALLET_ENABLED = process.env.NEXT_PUBLIC_CHUMBUCKET_WALLET_ENABLED === "true";
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_CHUMBUCKET_PRIVY_APP_ID ?? "";

/** What the Privy bridge offers once it is signed in as this account. */
export interface PrivyBridge {
  /** Signed in as the account; its embedded Solana wallet, if any. */
  ready(): Promise<string | null>;
  createWallet(): Promise<string>;
  signMessage(address: string, message: Uint8Array): Promise<Uint8Array>;
  signTransaction(address: string, transaction: Uint8Array): Promise<Uint8Array>;
  /** Ends the Privy session on this browser. */
  logout(): Promise<void>;
}

/** What the root hands the bridge: who it must be, and how to prove it. */
export interface PrivyBridgeProps {
  appId: string;
  account: string;
  /** The BFF's account token for Privy; undefined (never a throw) when there is none. */
  getToken: () => Promise<string | undefined>;
  register: (b: PrivyBridge) => void;
}

export interface ChumbucketWallet {
  enabled: boolean;
  /** The linked wallet's address; null until the BFF has it linked. */
  address: string | null;
  busy: boolean;
  error: string | null;
  /** First need: made and linked if it isn't yet; answers its signer. */
  ensure(): Promise<TradeSigner>;
}

const OFF: ChumbucketWallet = {
  enabled: false,
  address: null,
  busy: false,
  error: null,
  ensure: () => Promise.reject(new Error("off")),
};

const Ctx = createContext<ChumbucketWallet>(OFF);

export function useChumbucketWallet(): ChumbucketWallet {
  return useContext(Ctx);
}

const PrivyBridgeHost = dynamic(() => import("./ChumbucketWalletPrivy"), { ssr: false });

const SETUP_COPY = "Your wallet isn’t reachable right now. Try again in a moment.";
/** A token this close to expiry is fetched again. */
const TOKEN_SKEW_MS = 60_000;

export function ChumbucketWalletRoot({ children }: { children: React.ReactNode }) {
  if (!CHUMBUCKET_WALLET_ENABLED || !PRIVY_APP_ID) return <>{children}</>;
  return <ChumbucketWalletOn>{children}</ChumbucketWalletOn>;
}

function ChumbucketWalletOn({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const api = auth.api;
  const userId = auth.status === "ready" ? (auth.identity?.userId ?? null) : null;
  const [address, setAddress] = useState<string | null>(null);
  /** The server's answer for this account: off until it says so. */
  const [on, setOn] = useState(false);
  const onRef = useRef(false);
  onRef.current = on;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The account the Privy bridge is mounted for; null = not loaded. */
  const [hosted, setHosted] = useState<string | null>(null);
  const bridge = useRef<PrivyBridge | null>(null);
  const waiting = useRef<Array<(b: PrivyBridge) => void>>([]);
  const account = useRef<string | null>(null);
  const token = useRef<{ account: string; token: string; expiresAt: number } | null>(null);

  // Signed out, or another account: log Privy out BEFORE unloading it, and
  // forget the old account's token, wallet and waiters.
  useEffect(() => {
    const previous = account.current;
    account.current = userId;
    if (previous === userId) return;
    setAddress(null);
    setOn(false);
    setError(null);
    token.current = null;
    waiting.current = [];
    const b = bridge.current;
    bridge.current = null;
    // Unload only the old account's bridge; a new account may have asked already.
    const unload = () => setHosted((h) => (h === previous ? null : h));
    if (b) void b.logout().catch(() => undefined).finally(unload);
    else unload();
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    api
      .walletStatus()
      .then((s) => {
        if (!alive || account.current !== userId) return;
        setOn(chumbucketWalletOn(CHUMBUCKET_WALLET_ENABLED, s));
        setAddress(s.account?.chumbucketWallet ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, userId]);

  const getToken = useCallback(async (): Promise<string | undefined> => {
    const owner = account.current;
    if (!owner) return undefined;
    const held = token.current;
    if (held && held.account === owner && held.expiresAt - TOKEN_SKEW_MS > Date.now()) return held.token;
    try {
      const minted = await api.privyToken();
      if (account.current !== owner) return undefined;
      token.current = { account: owner, ...minted };
      return minted.token;
    } catch {
      return undefined;
    }
  }, [api]);

  const register = useCallback((b: PrivyBridge) => {
    bridge.current = b;
    for (const resolve of waiting.current.splice(0)) resolve(b);
  }, []);

  const getBridge = useCallback(
    (owner: string) =>
      new Promise<PrivyBridge>((resolve, reject) => {
        if (bridge.current) return resolve(bridge.current);
        waiting.current.push(resolve);
        setHosted(owner);
        setTimeout(() => reject(new Error("bridge timeout")), 30_000);
      }),
    [],
  );

  // Checked before signing, on its own copy (checkedSigner): nothing else can reach the wallet.
  const signerFor = useCallback(
    (owner: string, wallet: string): TradeSigner =>
      checkedSigner(wallet, async (bytes) => {
        if (account.current !== owner) throw new Error("account changed");
        const b = await getBridge(owner);
        if ((await b.ready()) !== wallet || account.current !== owner) throw new Error("wallet changed");
        return b.signTransaction(wallet, bytes);
      }),
    [getBridge],
  );

  const ensure = useCallback(async (): Promise<TradeSigner> => {
    const owner = account.current;
    if (!owner) throw new Error("signed out");
    // Off for this account: Privy is never loaded.
    if (!onRef.current) throw new Error("off");
    setBusy(true);
    setError(null);
    try {
      const b = await getBridge(owner);
      const wallet = (await b.ready()) ?? (await b.createWallet());
      if (account.current !== owner) throw new Error("account changed");
      if (address !== wallet) {
        const supabase = await accessToken();
        if (!supabase) throw new Error("signed out");
        await linkChumbucketWallet({ api, token: supabase, address: wallet, signMessage: (m) => b.signMessage(wallet, m) });
        if (account.current !== owner) throw new Error("account changed");
        setAddress(wallet);
      }
      return signerFor(owner, wallet);
    } catch (e) {
      setError(SETUP_COPY);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [address, api, getBridge, signerFor]);

  const value = useMemo<ChumbucketWallet>(
    () => (on ? { enabled: true, address, busy, error, ensure } : OFF),
    [address, busy, error, ensure, on],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Mounted for one account only; unmounted after its logout. */}
      {hosted && on ? <PrivyBridgeHost key={hosted} appId={PRIVY_APP_ID} account={hosted} getToken={getToken} register={register} /> : null}
    </Ctx.Provider>
  );
}
