/**
 * Reproduce the original Chumbucket app's public mainnet usage figures.
 *
 * The Pinocchio program logs the stake on create and the collected fee on
 * resolve, so these totals do not depend on Supabase or private analytics.
 *
 * Usage:
 *   bun run analyze:legacy-usage
 *   SOLANA_RPC_URL=https://your-mainnet-rpc bun run analyze:legacy-usage
 */

import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("D6mjMGW1fX8oH3UcwZDh3teWcHEWvghUqaR2aeWD9sF1");
const RPC_URL =
  process.env.SOLANA_MAINNET_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const LAMPORTS_PER_SOL = 1_000_000_000;

const connection = new Connection(RPC_URL, "finalized");
const signatures = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 1000 }, "finalized");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const transactions: Array<Awaited<ReturnType<typeof connection.getTransaction>>> = [];

for (const row of signatures) {
  let transaction = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      transaction = await connection.getTransaction(row.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      break;
    } catch (error) {
      if (!String(error).match(/429|Too many requests/i) || attempt === 5) throw error;
      await sleep(400 * 2 ** attempt);
    }
  }
  transactions.push(transaction);
  await sleep(80);
}

let creates = 0;
let resolves = 0;
let cancels = 0;
let failed = 0;
let createdLamports = 0;
let collectedFeeLamports = 0;
let cancelledLamports = 0;
const signingWallets = new Set<string>();
const blockTimes: number[] = [];

for (const tx of transactions) {
  if (!tx) continue;
  if (tx.blockTime != null) blockTimes.push(tx.blockTime);
  if (tx.meta?.err) {
    failed += 1;
    continue;
  }

  const message = tx.transaction.message;
  const keys = message.getAccountKeys().staticAccountKeys;
  for (let index = 0; index < message.header.numRequiredSignatures; index += 1) {
    const key = keys[index];
    if (key) signingWallets.add(key.toBase58());
  }

  const logs = tx.meta?.logMessages ?? [];
  const createLog = logs.find((line) => line.includes("Creating challenge:"));
  const resolveLog = logs.find((line) => line.includes("Resolving: fee="));
  const cancelLog = logs.find((line) => line.includes("Cancelling: total="));

  if (createLog) {
    const match = /Creating challenge: (\d+) lamports, fee: (\d+) lamports/.exec(createLog);
    if (match) {
      creates += 1;
      createdLamports += Number(match[1]);
    }
  }
  if (resolveLog) {
    const match = /Resolving: fee=(\d+), winner_amount=(\d+)/.exec(resolveLog);
    if (match) {
      resolves += 1;
      collectedFeeLamports += Number(match[1]);
    }
  }
  if (cancelLog) {
    const match = /Cancelling: total=(\d+),/.exec(cancelLog);
    if (match) {
      cancels += 1;
      cancelledLamports += Number(match[1]);
    }
  }
}

const toSol = (lamports: number) => lamports / LAMPORTS_PER_SOL;
const iso = (seconds: number | undefined) => (seconds == null ? null : new Date(seconds * 1000).toISOString());
const firstBlockTime = blockTimes.length ? Math.min(...blockTimes) : undefined;
const lastBlockTime = blockTimes.length ? Math.max(...blockTimes) : undefined;

const report = {
  network: "mainnet-beta",
  programId: PROGRAM_ID.toBase58(),
  explorer: `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}`,
  programTransactions: signatures.length,
  successfulCreates: creates,
  successfulResolves: resolves,
  successfulCancels: cancels,
  failedTransactions: failed,
  uniqueSigningWallets: signingWallets.size,
  solLockedAcrossCreates: toSol(createdLamports),
  solReturnedByCancellation: toSol(cancelledLamports),
  solFeesCollectedOnResolution: toSol(collectedFeeLamports),
  firstObservedAt: iso(firstBlockTime),
  lastObservedAt: iso(lastBlockTime),
};

console.log(JSON.stringify(report, null, 2));
