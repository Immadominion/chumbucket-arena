/**
 * Browser-side Solana plumbing for peer-to-peer SOL transfers (the Friends ->
 * Send flow). @solana/web3.js expects a global `Buffer` (a Node built-in) —
 * polyfill it before anything else in this module touches web3.js, since
 * Next's client bundle doesn't include Node core modules by default.
 */
import { Buffer } from "buffer";

if (typeof window !== "undefined" && !("Buffer" in window)) {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

// Matches the mobile app's default cluster — chumbucket/.env's SOLANA_RPC_URL
// points at devnet, and there's no mainnet override in this repo either.
export const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const SOLANA_CHAIN = "solana:devnet" as const;
export const SOLANA_EXPLORER_CLUSTER = "devnet";

let cachedConnection: Connection | null = null;
export function getConnection(): Connection {
  if (!cachedConnection) cachedConnection = new Connection(SOLANA_RPC_URL, "confirmed");
  return cachedConnection;
}

export const solToLamports = (sol: number): number => Math.round(sol * LAMPORTS_PER_SOL);
export const lamportsToSol = (lamports: number): number => lamports / LAMPORTS_PER_SOL;

export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/** Builds an unsigned, serialized SOL transfer — the caller signs + sends it
 * via Privy's useSignAndSendTransaction (see app/(app)/send/page.tsx). */
export async function buildTransferTransaction(opts: {
  from: string;
  to: string;
  lamports: number;
}): Promise<Uint8Array> {
  const fromPubkey = new PublicKey(opts.from);
  const toPubkey = new PublicKey(opts.to);
  const connection = getConnection();
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: fromPubkey, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey, toPubkey, lamports: opts.lamports }),
  );
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

export const explorerTxUrl = (signature: string): string =>
  `https://explorer.solana.com/tx/${signature}?cluster=${SOLANA_EXPLORER_CLUSTER}`;
