"use client";

/**
 * The one place the web app talks to Privy (loaded on first need by
 * `chumbucketWallet.tsx`, for one account at a time). Privy signs the person
 * in with the BFF's own account token: JWT-based auth that Privy verifies
 * against the BFF's JWKS, with `sub` = the account, so every sign-in of one
 * account reaches the same wallet. It re-syncs on every Supabase auth change
 * (a refresh, a sign-out). Privy's own login UI and wallet modals are never
 * shown; this file only hands back an embedded Solana wallet that signs
 * exact bytes, after `pantaBuyCheck.ts` has checked them. It never sends
 * anything: the BFF checks and broadcasts every trade.
 */

import { PrivyProvider, usePrivy, useSyncJwtBasedAuthState } from "@privy-io/react-auth";
import { useCreateWallet, useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { useCallback, useEffect, useRef } from "react";
import { authClient } from "./authClient";
import type { PrivyBridgeProps } from "./chumbucketWallet";

const HIDDEN = { uiOptions: { showWalletUIs: false } } as const;

export default function ChumbucketWalletPrivy({ appId, ...bridge }: PrivyBridgeProps) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        // We create the wallet on demand, after the person asked to pay.
        embeddedWallets: { solana: { createOnLogin: "off" }, ethereum: { createOnLogin: "off" }, showWalletUIs: false },
      }}
    >
      <Bridge {...bridge} />
    </PrivyProvider>
  );
}

/** Polls `test` until it answers, up to `ms`. */
async function until<T>(test: () => T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = test();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("wallet not ready");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function Bridge({ account, getToken, register }: Omit<PrivyBridgeProps, "appId">) {
  useSyncJwtBasedAuthState({
    subscribe: useCallback((onChange: () => void) => {
      const { data } = authClient().auth.onAuthStateChange(() => onChange());
      return () => data.subscription.unsubscribe();
    }, []),
    // Must not throw: Privy signs the person out on a throw.
    getExternalJwt: getToken,
  });
  const privy = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();

  // The bridge outlives renders; it reads the latest state through refs.
  const latest = useRef({ privy, wallets, createWallet, signMessage, signTransaction });
  latest.current = { privy, wallets, createWallet, signMessage, signTransaction };

  useEffect(() => {
    const embeddedAddress = (): string | null => {
      const user = latest.current.privy.user;
      const found = user?.linkedAccounts.find(
        (a) => a.type === "wallet" && a.chainType === "solana" && (a.walletClientType ?? "").startsWith("privy"),
      );
      return found && "address" in found ? found.address : null;
    };
    /** Privy is signed in as exactly this account (the token's `sub`). */
    const signedIn = () =>
      until(() => {
        const { ready, authenticated, user } = latest.current.privy;
        if (!ready || !authenticated || !user) return null;
        return user.linkedAccounts.some((a) => a.type === "custom_auth" && a.customUserId === account) ? true : null;
      });
    const standard = (address: string) => until(() => latest.current.wallets.find((w) => w.address === address));

    register({
      async ready() {
        await signedIn();
        return embeddedAddress();
      },
      async createWallet() {
        await signedIn();
        const { wallet } = await latest.current.createWallet();
        return wallet.address;
      },
      async signMessage(address, message) {
        await signedIn();
        const wallet = await standard(address);
        const { signature } = await latest.current.signMessage({ message, wallet, options: HIDDEN });
        return signature;
      },
      async signTransaction(address, transaction) {
        await signedIn();
        const wallet = await standard(address);
        const { signedTransaction } = await latest.current.signTransaction({
          transaction,
          wallet,
          chain: "solana:mainnet",
          options: HIDDEN,
        });
        return signedTransaction;
      },
      async logout() {
        if (latest.current.privy.authenticated) await latest.current.privy.logout();
      },
    });
  }, [account, register]);

  return null;
}
