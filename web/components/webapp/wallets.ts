/**
 * Browser Solana wallets, through the Wallet Standard (Phantom, Solflare,
 * Backpack and the rest register themselves this way). Only two features
 * are used: `standard:connect`, to learn the address, and
 * `solana:signMessage`, to sign the sign-in message. Nothing here can sign a
 * transaction: the web app never asks for one.
 *
 * The registry protocol is a pair of window events (the
 * `@wallet-standard/app` handshake), small enough to speak directly rather
 * than add a dependency for it.
 */

import { sameBytes } from "@/lib/webapp/siws";

export interface WalletAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
}

export interface StandardWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, unknown>;
}

type ConnectFeature = { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }> };
type SignMessageFeature = {
  signMessage: (
    ...inputs: Array<{ account: WalletAccount; message: Uint8Array }>
  ) => Promise<ReadonlyArray<{ signedMessage: Uint8Array; signature: Uint8Array }>>;
};

const wallets: StandardWallet[] = [];
const listeners = new Set<() => void>();
let started = false;

function register(...added: StandardWallet[]) {
  for (const w of added) if (!wallets.includes(w)) wallets.push(w);
  listeners.forEach((l) => l());
  return () => {
    for (const w of added) {
      const i = wallets.indexOf(w);
      if (i >= 0) wallets.splice(i, 1);
    }
    listeners.forEach((l) => l());
  };
}

const api = Object.freeze({ register });

/** Start listening (idempotent). Wallets that loaded first answer the app-ready event. */
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("wallet-standard:register-wallet", ((event: CustomEvent<(a: typeof api) => void>) => {
    try {
      event.detail(api);
    } catch {
      // A broken wallet must not break sign-in for the others.
    }
  }) as EventListener);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } catch {
    // Old browsers without CustomEvent: no wallets, Google and X still work.
  }
}

/** Wallets that can sign a Solana message. */
export function solanaWallets(): StandardWallet[] {
  start();
  return wallets.filter(
    (w) =>
      w.chains.some((c) => c.startsWith("solana:")) && "standard:connect" in w.features && "solana:signMessage" in w.features,
  );
}

export function onWalletsChange(cb: () => void): () => void {
  start();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export class WalletDeclined extends Error {}

/** Connect and return the account that will sign. */
export async function connect(wallet: StandardWallet): Promise<WalletAccount> {
  const feature = wallet.features["standard:connect"] as ConnectFeature | undefined;
  if (!feature) throw new WalletDeclined("no connect");
  let accounts: readonly WalletAccount[];
  try {
    accounts = (await feature.connect()).accounts;
  } catch {
    throw new WalletDeclined("connect refused");
  }
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
  if (!account || account.publicKey.length !== 32) throw new WalletDeclined("no account");
  return account;
}

/** The 64-byte signature over exactly `message`, by exactly `account`. */
export async function signMessage(wallet: StandardWallet, account: WalletAccount, message: Uint8Array): Promise<Uint8Array> {
  const feature = wallet.features["solana:signMessage"] as SignMessageFeature | undefined;
  if (!feature) throw new WalletDeclined("no signMessage");
  let out: ReadonlyArray<{ signedMessage: Uint8Array; signature: Uint8Array }>;
  try {
    out = await feature.signMessage({ account, message });
  } catch {
    throw new WalletDeclined("sign refused");
  }
  const signed = out[0];
  if (!signed || signed.signature.length !== 64 || !sameBytes(signed.signedMessage, message)) {
    throw new WalletDeclined("unexpected signature");
  }
  return signed.signature;
}
