/**
 * Client-side wallet-signature proofs for public (session-free) social writes
 * — add-friend-by-@handle today, the same primitive follow/unfollow would use.
 *
 * Mirrors src/auth/WalletSignature.ts's `socialActionMessage` byte-for-byte.
 * That module lives in the backend's separate Bun/TS package — web only
 * receives its generated .d.ts types (server-types/), not the runtime code —
 * so the exact string template is duplicated here on purpose. If the backend
 * message format ever changes, this must change with it.
 *
 * Signing uses Privy's `useSignMessage` (@privy-io/react-auth/solana), the
 * sibling hook to `useSignAndSendTransaction` already used for on-chain calls
 * in lib/arena-onchain.ts / lib/solana.ts. It forwards straight to the
 * Wallet-Standard `solana:signMessage` feature: a raw ed25519 signature over
 * the exact bytes handed to it, no domain-separation prefix — the same
 * contract `verifyWalletSignature`'s `nodeVerify` expects.
 */

import bs58 from "bs58";
import type { ConnectedStandardSolanaWallet, UseSignMessage } from "@privy-io/react-auth/solana";
import { SOLANA_EXPLORER_CLUSTER } from "@/lib/solana";

/** Matches src/config.ts's SocialStoreConfig.network — devnet during the hackathon. */
export const SOCIAL_NETWORK = SOLANA_EXPLORER_CLUSTER; // "devnet"

/** Mirrors src/auth/WalletSignature.ts's SocialAction. */
export type SocialAction = "follow" | "unfollow" | "add_pending_target";

/** Byte-for-byte port of src/auth/WalletSignature.ts's socialActionMessage(). */
export function socialActionMessage(action: SocialAction, target: string, timestamp: number): string {
  return `ChumBucket: ${action} ${target}\nnet:${SOCIAL_NETWORK}\nts:${timestamp}`;
}

/** Lowercase, strip a leading '@' — the exact form the backend signs and stores. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

export type SocialActionProof = {
  wallet: string;
  timestamp: number;
  signature: string; // base58
};

/**
 * Sign a social-graph action proof with the caller's own connected Solana
 * wallet — the exact shape `verifySocialAction` (src/auth/WalletSignature.ts)
 * checks server-side. `signMessage` is the function returned by Privy's
 * `useSignMessage()`; that hook must be called at component top level (rules
 * of hooks), so it's passed through here rather than invoked inside.
 */
export async function signSocialAction(opts: {
  action: SocialAction;
  target: string; // already normalized — see normalizeHandle()
  wallet: ConnectedStandardSolanaWallet;
  signMessage: UseSignMessage["signMessage"];
}): Promise<SocialActionProof> {
  const timestamp = Date.now();
  const message = socialActionMessage(opts.action, opts.target, timestamp);
  const { signature } = await opts.signMessage({
    message: new TextEncoder().encode(message),
    wallet: opts.wallet,
  });
  return {
    wallet: opts.wallet.address,
    timestamp,
    signature: bs58.encode(signature),
  };
}
