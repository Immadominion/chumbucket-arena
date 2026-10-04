"use client";

/**
 * The one place the web app talks to Privy (loaded on first need by
 * `chumbucketWallet.tsx`). Privy signs the person in with our own Supabase
 * session: JWT-based auth, verified by Privy against Supabase's JWKS, kept in
 * step with every Supabase auth change (sign-in, refresh, sign-out). Privy's
 * own login UI and wallet modals are never shown; this file only hands back
 * an embedded Solana wallet that signs exact bytes. It never sends anything:
 * the BFF checks and broadcasts every trade.
 */

import { PrivyProvider, usePrivy, useSyncJwtBasedAuthState } from "@privy-io/react-auth";
import { useCreateWallet, useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { useCallback, useEffect, useRef } from "react";
import { accessToken, authClient } from "./authClient";
import type { PrivyBridge } from "./chumbucketWallet";

const HIDDEN = { uiOptions: { showWalletUIs: false } } as const;

export default function ChumbucketWalletPrivy({ appId, register }: { appId: string; register: (b: PrivyBridge) => void }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        // We create the wallet on demand, after the person asked to pay.
        embeddedWallets: { solana: { createOnLogin: "off" }, ethereum: { createOnLogin: "off" }, showWalletUIs: false },
      }}
    >
      <Bridge register={register} />
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

function Bridge({ register }: { register: (b: PrivyBridge) => void }) {
  useSyncJwtBasedAuthState({
    subscribe: useCallback((onChange: () => void) => {
      const { data } = authClient().auth.onAuthStateChange(() => onChange());
      return () => data.subscription.unsubscribe();
    }, []),
    // Must not throw: Privy signs the person out on a throw.
    getExternalJwt: useCallback(async () => (await accessToken()) ?? undefined, []),
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
      const account = user?.linkedAccounts.find(
        (a) => a.type === "wallet" && a.chainType === "solana" && (a.walletClientType ?? "").startsWith("privy"),
      );
      return account && "address" in account ? account.address : null;
    };
    /** Privy is signed in as exactly the Supabase user this browser holds. */
    const signedIn = async (): Promise<void> => {
      const { data } = await authClient().auth.getSession();
      const sub = data.session?.user.id;
      if (!sub) throw new Error("signed out");
      await until(() => {
        const { ready, authenticated, user } = latest.current.privy;
        if (!ready || !authenticated || !user) return null;
        return user.linkedAccounts.some((a) => a.type === "custom_auth" && a.customUserId === sub) ? true : null;
      });
    };
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
        const wallet = await standard(address);
        const { signature } = await latest.current.signMessage({ message, wallet, options: HIDDEN });
        return signature;
      },
      async signTransaction(address, transaction) {
        const wallet = await standard(address);
        const { signedTransaction } = await latest.current.signTransaction({
          transaction,
          wallet,
          chain: "solana:mainnet",
          options: HIDDEN,
        });
        return signedTransaction;
      },
    });
  }, [register]);

  return null;
}
