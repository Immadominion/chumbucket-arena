"use client";

/**
 * The Chumbucket wallet in the browser: the account's one wallet (a Privy
 * embedded Solana wallet, signed in with the same Supabase session), the
 * default way to pay for a trade. Behind NEXT_PUBLIC_CHUMBUCKET_WALLET_ENABLED
 * and a Privy app id; without both, nothing here loads and `useChumbucketWallet`
 * answers "off".
 *
 * What the BFF knows comes first and costs nothing: `wallet.status` names the
 * account's linked Chumbucket wallet. Privy itself (its SDK and a session)
 * loads only on first need, as a sibling of the app rather than around it,
 * so it never re-mounts a screen and never runs for someone who never pays.
 *
 * Privy is imported in exactly one file, `ChumbucketWalletPrivy.tsx`.
 */

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { linkChumbucketWallet } from "@/lib/webapp/chumbucketLink";
import type { TradeSigner } from "@/lib/webapp/trade";
import { accessToken } from "./authClient";
import { useAuth } from "./session";

export const CHUMBUCKET_WALLET_ENABLED = process.env.NEXT_PUBLIC_CHUMBUCKET_WALLET_ENABLED === "true";
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_CHUMBUCKET_PRIVY_APP_ID ?? "";

/** What the Privy bridge offers once it is signed in as this account. */
export interface PrivyBridge {
  /** Signed in as the current Supabase user; the embedded Solana wallet, if any. */
  ready(): Promise<string | null>;
  createWallet(): Promise<string>;
  signMessage(address: string, message: Uint8Array): Promise<Uint8Array>;
  signTransaction(address: string, transaction: Uint8Array): Promise<Uint8Array>;
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

export function ChumbucketWalletRoot({ children }: { children: React.ReactNode }) {
  if (!CHUMBUCKET_WALLET_ENABLED || !PRIVY_APP_ID) return <>{children}</>;
  return <ChumbucketWalletOn>{children}</ChumbucketWalletOn>;
}

function ChumbucketWalletOn({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const api = auth.api;
  const userId = auth.status === "ready" ? (auth.identity?.userId ?? null) : null;
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);
  const bridge = useRef<PrivyBridge | null>(null);
  const waiting = useRef<Array<(b: PrivyBridge) => void>>([]);
  const account = useRef<string | null>(null);

  // A new account starts over: its own linked wallet, no shared bridge state.
  useEffect(() => {
    account.current = userId;
    setAddress(null);
    setError(null);
    if (!userId) return;
    let alive = true;
    api
      .walletStatus()
      .then((s) => alive && account.current === userId && setAddress(s.account?.chumbucketWallet ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, userId]);

  const register = useCallback((b: PrivyBridge) => {
    bridge.current = b;
    for (const resolve of waiting.current.splice(0)) resolve(b);
  }, []);

  const getBridge = useCallback(
    () =>
      new Promise<PrivyBridge>((resolve, reject) => {
        if (bridge.current) return resolve(bridge.current);
        waiting.current.push(resolve);
        setWanted(true);
        setTimeout(() => reject(new Error("bridge timeout")), 30_000);
      }),
    [],
  );

  const signerFor = useCallback(
    (owner: string, wallet: string): TradeSigner => ({
      address: wallet,
      async sign(unsigned) {
        if (account.current !== owner) throw new Error("account changed");
        const b = await getBridge();
        if ((await b.ready()) !== wallet) throw new Error("wallet changed");
        return b.signTransaction(wallet, unsigned);
      },
    }),
    [getBridge],
  );

  const ensure = useCallback(async (): Promise<TradeSigner> => {
    const owner = account.current;
    if (!owner) throw new Error("signed out");
    setBusy(true);
    setError(null);
    try {
      const b = await getBridge();
      const wallet = (await b.ready()) ?? (await b.createWallet());
      if (account.current !== owner) throw new Error("account changed");
      if (address !== wallet) {
        const token = await accessToken();
        if (!token) throw new Error("signed out");
        await linkChumbucketWallet({ api, token, address: wallet, signMessage: (m) => b.signMessage(wallet, m) });
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
    () => ({ enabled: true, address, busy, error, ensure }),
    [address, busy, error, ensure],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {wanted && userId ? <PrivyBridgeHost appId={PRIVY_APP_ID} register={register} /> : null}
    </Ctx.Provider>
  );
}
