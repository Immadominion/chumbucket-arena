"use client";

/**
 * The wallet that signs for one of the account's own addresses: the
 * Chumbucket wallet when it is that address, else a browser wallet (Wallet
 * Standard) holding it. Either way the signer is a `checkedSigner`, so a buy,
 * a transfer, a claim or a gasless swap is checked on its own copy of the
 * bytes before the wallet sees them. Nothing here sends a transaction: the
 * BFF checks the signed bytes and broadcasts them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { sessionWallet } from "@/lib/webapp/money";
import { authClient } from "../authClient";
import { useMe } from "../queries";
import { BffFailure } from "@/lib/webapp/bff";
import { shortWallet } from "@/lib/webapp/format";
import { refusalReason, stopLine, type SignerFor } from "@/lib/webapp/moneyFlow";
import { checkedSigner, type TradeSigner } from "@/lib/webapp/trade";
import { useChumbucketWallet } from "../chumbucketWallet";
import { actionError } from "../data";
import {
  connect,
  onWalletsChange,
  signTransaction,
  transactionWallets,
  WalletDeclined,
  type StandardWallet,
  type WalletAccount,
} from "../wallets";

/** No wallet in this browser signs for the address the BFF named. */
export class NoSigner extends Error {
  constructor(readonly address: string) {
    super(`Connect the wallet ${shortWallet(address)} to sign.`);
  }
}

/** One plain line for whatever stopped a money flow: our words, never a provider's. */
export function moneyLine(e: unknown, what: "trade" | "transfer" = "trade"): string {
  if (e instanceof NoSigner) return e.message;
  // A money.* refusal with a reason (PRICE_UNAVAILABLE, UNAVAILABLE, …) is our copy even as a 5xx.
  if (e instanceof BffFailure && refusalReason(e)) return e.message;
  if (e instanceof WalletDeclined) return what === "trade" ? "Not signed. Nothing was spent." : "Not signed. Nothing was sent.";
  return stopLine(e, actionError(e), what);
}

const holds = (w: StandardWallet, address: string) => w.accounts.some((a) => a.address === address);

/** A browser wallet holding `address`: one that already shows it first, then each in turn. */
export async function browserSigner(address: string): Promise<TradeSigner> {
  const wallets = transactionWallets();
  const ordered = [...wallets.filter((w) => holds(w, address)), ...wallets.filter((w) => !holds(w, address))];
  for (const wallet of ordered) {
    let connected: WalletAccount;
    try {
      connected = await connect(wallet);
    } catch (e) {
      if (e instanceof WalletDeclined && holds(wallet, address)) throw e;
      continue;
    }
    const account = connected.address === address ? connected : wallet.accounts.find((a) => a.address === address);
    if (account) return checkedSigner(address, (bytes, slot) => signTransaction(wallet, account, bytes, slot));
  }
  throw new NoSigner(address);
}

/**
 * Who signs for an address of this account. Stable, and it reads the
 * Chumbucket wallet as it is when asked (it may have just been made).
 */
export function useSignerFor(): SignerFor {
  const own = useChumbucketWallet();
  const latest = useRef(own);
  latest.current = own;
  return useCallback(async (address: string) => {
    const wallet = latest.current;
    if (wallet.enabled && wallet.address === address) {
      const signer = await wallet.ensure();
      if (signer.address === address) return signer;
    }
    return browserSigner(address);
  }, []);
}

const NONE: StandardWallet[] = [];
let seen: StandardWallet[] = NONE;
function snapshot(): StandardWallet[] {
  const now = transactionWallets();
  if (now.length !== seen.length || now.some((w, i) => w !== seen[i])) seen = now;
  return seen;
}

/** Browser wallets that can sign a transaction, as they register. */
export function useTransactionWallets(): StandardWallet[] {
  return useSyncExternalStore(onWalletsChange, snapshot, () => NONE);
}

/**
 * This browser's own wallets, read without asking any money.* procedure: the
 * wallet the Supabase session signed in with, the wallets connected in this
 * browser's wallet apps, and the account's own wallet (its profile).
 */
export function useOwnWallets(): { wallets: string[]; known: boolean } {
  const browser = useTransactionWallets();
  const me = useMe();
  const [signedIn, setSignedIn] = useState<{ read: boolean; address: string | null }>({ read: false, address: null });
  useEffect(() => {
    let alive = true;
    authClient()
      .auth.getSession()
      .then(({ data }) => alive && setSignedIn({ read: true, address: sessionWallet(data.session?.user.identities) }))
      .catch(() => alive && setSignedIn({ read: true, address: null }));
    return () => {
      alive = false;
    };
  }, []);
  const profile = me.data?.profile.walletAddress ?? null;
  const wallets = useMemo(
    () => [...new Set([signedIn.address, profile, ...browser.flatMap((w) => w.accounts.map((a) => a.address))].filter((a): a is string => !!a))],
    [browser, profile, signedIn.address],
  );
  return { wallets, known: signedIn.read && (me.isSuccess || me.isError) };
}
