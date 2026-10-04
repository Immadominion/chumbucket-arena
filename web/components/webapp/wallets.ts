/**
 * Browser Solana wallets, through the Wallet Standard (Phantom, Solflare,
 * Backpack and the rest register themselves this way). Three features are
 * used: `standard:connect`, to learn the address; `solana:signMessage`, to
 * sign the sign-in message; and `solana:signTransaction`, to sign a Panta
 * trade the BFF built. Never `signAndSendTransaction`: the BFF checks the
 * signed bytes against the trade it reviewed and broadcasts them itself.
 *
 * The registry protocol is a pair of window events (the
 * `@wallet-standard/app` handshake), small enough to speak directly rather
 * than add a dependency for it.
 */

import { sameBytes } from "@/lib/webapp/siws";
import { signedOnlyInSlot } from "@/lib/webapp/solanaTx";

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

type SignTransactionFeature = {
  supportedTransactionVersions?: ReadonlyArray<"legacy" | 0>;
  signTransaction: (
    ...inputs: Array<{ account: WalletAccount; transaction: Uint8Array; chain?: string }>
  ) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;
};

/** Panta trades are mainnet USDC. */
export const SOLANA_MAINNET = "solana:mainnet";

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

/** Wallets that can sign a v0 Solana transaction (a Panta trade), not only a message. */
export function transactionWallets(): StandardWallet[] {
  return solanaWallets().filter((w) => {
    const feature = w.features["solana:signTransaction"] as SignTransactionFeature | undefined;
    return !!feature && typeof feature.signTransaction === "function" && (feature.supportedTransactionVersions ?? [0]).includes(0);
  });
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

/**
 * `account`'s signature on exactly `transaction`, as the full signed bytes.
 * A wallet that changed the transaction (added an instruction, swapped the
 * fee payer, signed another slot) is refused here; the BFF would refuse it
 * anyway, but the person hears it from the wallet step, not as a failed trade.
 */
export async function signTransaction(
  wallet: StandardWallet,
  account: WalletAccount,
  transaction: Uint8Array,
): Promise<Uint8Array> {
  const feature = wallet.features["solana:signTransaction"] as SignTransactionFeature | undefined;
  if (!feature) throw new WalletDeclined("no signTransaction");
  let out: ReadonlyArray<{ signedTransaction: Uint8Array }>;
  try {
    out = await feature.signTransaction({ account, transaction, chain: SOLANA_MAINNET });
  } catch {
    throw new WalletDeclined("sign refused");
  }
  const signed = out[0]?.signedTransaction;
  if (!signed || !signedOnlyInSlot(transaction, signed, 0)) throw new WalletDeclined("unexpected transaction");
  return signed;
}
