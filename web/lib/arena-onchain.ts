/**
 * Browser-side client for chumbucket_arena — the REAL, non-custodial on-chain
 * escrow (devnet program AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG). This is
 * a net-new, separate money path from the custodial Engine (deposit/withdraw/
 * makeCall/createChallenge/acceptChallenge in lib/session.tsx + lib/trpc.ts) —
 * it never reads from or writes to that off-chain ledger. Money moves directly
 * between the player's own Privy Solana wallet and the program's on-chain vault.
 *
 * Mirrors, byte-for-byte where it matters, the proven server-side keeper client
 * (src/keeper/onchainDriver.ts) for PDA derivation + Anchor Program setup, and
 * the proven Privy signing pattern already used for peer-to-peer SOL transfers
 * (lib/solana.ts + app/(app)/send/page.tsx): build an unsigned, serialized
 * transaction here, then the caller signs + sends it via Privy's
 * useSignAndSendTransaction — this module never holds a private key.
 */
import { Buffer } from "buffer";

if (typeof window !== "undefined" && !("Buffer" in window)) {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import type { ConnectedStandardSolanaWallet, UseSignAndSendTransaction } from "@privy-io/react-auth/solana";
import type { ChumbucketArena } from "@/vendor/chumbucket_arena/chumbucket_arena";
import idl from "@/vendor/chumbucket_arena/chumbucket_arena.json";
import { getConnection, SOLANA_CHAIN } from "@/lib/solana";

// ── Program + mint ──────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey(idl.address);

// The devnet test-USDC mint chumbucket_arena's Config is pinned to (see
// onchain/gaffer_verifier/scripts/devnet-lifecycle/test-usdc-mint.json —
// verified against the live on-chain Config account, not guessed).
export const CHUMBUCKET_USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_CHUMBUCKET_USDC_MINT ?? "3r7XYUxoGZ57Fm91zbTw8GtmwCYzPV5CdmabqgDwtdhY",
);

// ── PDA seeds + derivation (byte-exact with state.rs / onchainDriver.ts) ────

const POT_SEED = Buffer.from("pot");
const VAULT_SEED = Buffer.from("vault");
const POSITION_SEED = Buffer.from("position");

/** ASCII bytes of a MatchId, LEFT-padded with zeros to exactly 32 bytes. */
export function matchIdBytes(matchId: string): Buffer {
  const ascii = Buffer.from(matchId, "ascii");
  if (ascii.length > 32) throw new Error(`[arena-onchain] matchId too long (>32 bytes): ${matchId}`);
  return Buffer.concat([Buffer.alloc(32 - ascii.length), ascii]);
}

export function derivePotPda(matchId: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([POT_SEED, matchIdBytes(matchId)], PROGRAM_ID);
  return pda;
}

export function deriveVaultPda(potPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([VAULT_SEED, potPda.toBuffer()], PROGRAM_ID);
  return pda;
}

export function derivePositionPda(potPda: PublicKey, player: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([POSITION_SEED, potPda.toBuffer(), player.toBuffer()], PROGRAM_ID);
  return pda;
}

export function playerUsdcAta(player: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(CHUMBUCKET_USDC_MINT, player, false, TOKEN_PROGRAM_ID);
}

// ── Buckets ──────────────────────────────────────────────────────────────

export type BucketId = "HOME" | "DRAW" | "AWAY";
const BUCKET_INDEX: Record<BucketId, number> = { HOME: 0, DRAW: 1, AWAY: 2 };
export const bucketToIndex = (b: BucketId): number => BUCKET_INDEX[b];
export const bucketFromIndex = (i: number): BucketId => (i === 0 ? "HOME" : i === 1 ? "DRAW" : "AWAY");

// Pot.status, mirrors state.rs STATUS_* constants.
export const POT_STATUS_OPEN = 0;
export const POT_STATUS_LOCKED = 1;
export const POT_STATUS_SETTLED = 2;
export const POT_STATUS_VOID = 3;

// ── Anchor Program (read/build only — never signs; the wallet's own key never
//    touches this module, only the account addresses derived from it) ───────

// A Provider needs *some* wallet to construct, but every instruction below
// passes its own accounts explicitly, so this identity is never actually used
// for signing or account resolution.
class UnsignedWallet {
  publicKey = PublicKey.default;
  async signTransaction(): Promise<never> {
    throw new Error("[arena-onchain] this Program instance is build/read-only — sign via Privy's signAndSendTransaction");
  }
  async signAllTransactions(): Promise<never> {
    throw new Error("[arena-onchain] this Program instance is build/read-only — sign via Privy's signAndSendTransaction");
  }
}

let cachedProgram: Program<ChumbucketArena> | null = null;
function getProgram(): Program<ChumbucketArena> {
  if (cachedProgram) return cachedProgram;
  const provider = new AnchorProvider(getConnection(), new UnsignedWallet(), AnchorProvider.defaultOptions());
  // Anchor 0.32 derives Program.programId strictly from idl.address; override it
  // to PROGRAM_ID so this always targets the deployed devnet program even if the
  // vendored IDL's address field ever drifts (same reasoning as the keeper).
  cachedProgram = new Program(
    { ...(idl as unknown as Record<string, unknown>), address: PROGRAM_ID.toBase58() } as unknown as ChumbucketArena,
    provider,
  );
  return cachedProgram;
}

// ── Privy signing plumbing ──────────────────────────────────────────────────

type SignAndSendTransaction = UseSignAndSendTransaction["signAndSendTransaction"];

async function sendUnsigned(
  ixs: TransactionInstruction[],
  feePayer: PublicKey,
  wallet: ConnectedStandardSolanaWallet,
  signAndSendTransaction: SignAndSendTransaction,
): Promise<{ signature: string }> {
  const connection = getConnection();
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(...ixs);
  const serialized = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const { signature } = await signAndSendTransaction({ transaction: serialized, wallet, chain: SOLANA_CHAIN });
  return { signature: bs58.encode(signature) };
}

// ── Writes ───────────────────────────────────────────────────────────────

/**
 * Stake `amountUsdc` USDC on `bucket` for `matchId`'s Pot — moves real USDC
 * from the player's own wallet into the program's vault, on-chain, now.
 * Creates the player's USDC ATA idempotently in the same transaction if it
 * doesn't exist yet.
 */
export async function placeCall(opts: {
  matchId: string;
  bucket: BucketId;
  amountUsdc: number;
  wallet: ConnectedStandardSolanaWallet;
  signAndSendTransaction: SignAndSendTransaction;
}): Promise<{ signature: string }> {
  const { matchId, bucket, amountUsdc, wallet, signAndSendTransaction } = opts;
  // USDC has 6 decimals — base units, NOT the backend's unrelated FROST/WAL
  // accounting unit (see lib/format.ts's walToFrost, which must not be reused
  // here).
  const amountBaseUnits = BigInt(Math.round(amountUsdc * 1_000_000));
  if (amountBaseUnits <= 0n) throw new Error("Stake must be greater than zero.");

  const player = new PublicKey(wallet.address);
  const potPda = derivePotPda(matchId);
  const vaultPda = deriveVaultPda(potPda);
  const positionPda = derivePositionPda(potPda, player);
  const playerUsdc = playerUsdcAta(player);

  const program = getProgram();
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    player,
    playerUsdc,
    player,
    CHUMBUCKET_USDC_MINT,
    TOKEN_PROGRAM_ID,
  );
  const placeCallIx = await program.methods
    .placeCall(bucketToIndex(bucket), new BN(amountBaseUnits.toString()))
    .accounts({
      player,
      pot: potPda,
      vault: vaultPda,
      playerUsdc,
      position: positionPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();

  return sendUnsigned([createAtaIx, placeCallIx], player, wallet, signAndSendTransaction);
}

/**
 * Pull your own payout (winner's stake + pro-rata share) or void refund for
 * `matchId`'s Pot. Closes the Position account (rent back to the player).
 * Safe to call even with nothing owed (e.g. a settled losing position) — it
 * just closes the position for zero USDC movement.
 */
export async function claim(opts: {
  matchId: string;
  wallet: ConnectedStandardSolanaWallet;
  signAndSendTransaction: SignAndSendTransaction;
}): Promise<{ signature: string }> {
  const { matchId, wallet, signAndSendTransaction } = opts;
  const player = new PublicKey(wallet.address);
  const potPda = derivePotPda(matchId);
  const vaultPda = deriveVaultPda(potPda);
  const positionPda = derivePositionPda(potPda, player);
  const playerUsdc = playerUsdcAta(player);

  const program = getProgram();
  // The player's ATA should already exist from place_call, but create it
  // idempotently anyway — cheap, and guards a void-refund path where a
  // position could theoretically exist without one (e.g. a future admin flow).
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    player,
    playerUsdc,
    player,
    CHUMBUCKET_USDC_MINT,
    TOKEN_PROGRAM_ID,
  );
  const claimIx = await program.methods
    .claim()
    .accounts({
      player,
      pot: potPda,
      vault: vaultPda,
      playerUsdc,
      position: positionPda,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .instruction();

  return sendUnsigned([createAtaIx, claimIx], player, wallet, signAndSendTransaction);
}

// ── Reads ────────────────────────────────────────────────────────────────

export type OnchainPot = {
  matchId: string;
  status: number;
  winningBucket: number;
  bucketTotals: [bigint, bigint, bigint];
  totalStake: bigint;
  distributable: bigint;
  winnersStake: bigint;
  paidOut: bigint;
  kickoff: number;
};

export async function fetchPot(matchId: string): Promise<OnchainPot | null> {
  const program = getProgram();
  const potPda = derivePotPda(matchId);
  const raw = await (program.account as any).pot.fetchNullable(potPda);
  if (!raw) return null;
  const totals = raw.bucketTotals as [BN, BN, BN];
  return {
    matchId,
    status: raw.status as number,
    winningBucket: raw.winningBucket as number,
    bucketTotals: [BigInt(totals[0].toString()), BigInt(totals[1].toString()), BigInt(totals[2].toString())],
    totalStake: BigInt((raw.totalStake as BN).toString()),
    distributable: BigInt((raw.distributable as BN).toString()),
    winnersStake: BigInt((raw.winnersStake as BN).toString()),
    paidOut: BigInt((raw.paidOut as BN).toString()),
    kickoff: Number((raw.kickoff as BN).toString()),
  };
}

export type OnchainPosition = {
  bucket: number;
  stake: bigint;
  claimed: boolean;
};

export async function fetchPosition(matchId: string, playerWallet: string): Promise<OnchainPosition | null> {
  const program = getProgram();
  const player = new PublicKey(playerWallet);
  const potPda = derivePotPda(matchId);
  const positionPda = derivePositionPda(potPda, player);
  const raw = await (program.account as any).position.fetchNullable(positionPda);
  if (!raw) return null;
  return { bucket: raw.bucket as number, stake: BigInt((raw.stake as BN).toString()), claimed: raw.claimed as boolean };
}

/** The player's own on-chain USDC balance (UI amount, i.e. already /1e6). */
export async function fetchUsdcBalance(walletAddress: string): Promise<number> {
  try {
    const ata = playerUsdcAta(new PublicKey(walletAddress));
    const bal = await getConnection().getTokenAccountBalance(ata);
    return bal.value.uiAmount ?? 0;
  } catch {
    return 0; // ATA doesn't exist yet (no USDC ever received) — zero balance
  }
}

export function isClaimablePot(pot: OnchainPot): boolean {
  return pot.status === POT_STATUS_SETTLED || pot.status === POT_STATUS_VOID;
}

/** Payout a claim() call would move, in USDC base units (mirrors claim.rs). */
export function estimateClaimPayout(pot: OnchainPot, position: OnchainPosition): bigint {
  if (pot.status === POT_STATUS_VOID) return position.stake;
  if (pot.status === POT_STATUS_SETTLED && position.bucket === pot.winningBucket) {
    if (pot.winnersStake === 0n) return position.stake;
    return position.stake + (pot.distributable * position.stake) / pot.winnersStake;
  }
  return 0n;
}
