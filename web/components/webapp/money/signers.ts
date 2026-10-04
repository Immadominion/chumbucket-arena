"use client";

/**
 * The wallet that signs for one of the account's own addresses: the
 * Chumbucket wallet when it is that address, else a browser wallet (Wallet
 * Standard) holding it. Either way the signer is a `checkedSigner`, so a buy,
 * a transfer, a claim or a gasless swap is checked on its own copy of the
 * bytes before the wallet sees them. Nothing here sends a transaction: the
 * BFF checks the signed bytes and broadcasts them.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import { shortWallet } from "@/lib/webapp/format";
import { stopLine, type SignerFor } from "@/lib/webapp/moneyFlow";
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
export function moneyLine(e: unknown): string {
  if (e instanceof NoSigner) return e.message;
  if (e instanceof WalletDeclined) return "Not signed. Nothing was spent.";
  return stopLine(e, actionError(e));
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
