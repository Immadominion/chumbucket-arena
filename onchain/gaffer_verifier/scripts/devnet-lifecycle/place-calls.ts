// Phase 1c: player A stakes on HOME (Argentina), player B stakes on AWAY
// (Egypt) — a genuine losers'/winners' split so settlement actually exercises
// the rake + pro-rata payout math, not a degenerate single-side pool.
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import type { ChumbucketArena } from "./chumbucket_arena";
import idl from "./chumbucket_arena.json";

const RPC = "https://api.devnet.solana.com";
const OUT_DIR = __dirname;
const BUCKET_HOME = 0;
const BUCKET_AWAY = 2;

async function placeCall(program: Program<ChumbucketArena>, player: Keypair, potPda: PublicKey, vaultPda: PublicKey, usdcMint: PublicKey, bucket: number, amount: number, label: string) {
  const playerUsdc = getAssociatedTokenAddressSync(usdcMint, player.publicKey, false, TOKEN_PROGRAM_ID);
  const [positionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), potPda.toBuffer(), player.publicKey.toBuffer()],
    program.programId,
  );
  const sig = await program.methods
    .placeCall(bucket, new BN(amount))
    .accounts({
      player: player.publicKey,
      pot: potPda,
      vault: vaultPda,
      playerUsdc,
      position: positionPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([player])
    .rpc();
  console.log(`${label} place_call (bucket=${bucket}, amount=${amount}):`, sig);
  return positionPda;
}

async function main() {
  // Usage: bun run place-calls.ts [potInfoFile]
  const potInfoFile = process.argv[2] ?? "pot-info.json";
  const connection = new Connection(RPC, "confirmed");
  const playerA = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${OUT_DIR}/player-a.json`, "utf8"))));
  const playerB = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${OUT_DIR}/player-b.json`, "utf8"))));
  const usdcMint = new PublicKey(JSON.parse(fs.readFileSync(`${OUT_DIR}/test-usdc-mint.json`, "utf8")));
  const potInfo = JSON.parse(fs.readFileSync(`${OUT_DIR}/${potInfoFile}`, "utf8"));
  const potPda = new PublicKey(potInfo.potPda);
  const vaultPda = new PublicKey(potInfo.vaultPda);

  // Provider wallet doesn't matter for signing (each call passes its own
  // signer explicitly), but AnchorProvider needs *a* wallet to construct.
  const provider = new AnchorProvider(connection, new Wallet(playerA), AnchorProvider.defaultOptions());
  anchor.setProvider(provider);
  const program = new Program(idl as unknown as ChumbucketArena, provider);

  await placeCall(program, playerA, potPda, vaultPda, usdcMint, BUCKET_HOME, 20_000_000, "Player A (HOME/Argentina, 20 test-USDC)");
  await placeCall(program, playerB, potPda, vaultPda, usdcMint, BUCKET_AWAY, 10_000_000, "Player B (AWAY/Egypt, 10 test-USDC)");

  const pot = await (program.account as any).pot.fetch(potPda);
  console.log("\nPot state after calls:", {
    status: pot.status,
    participants: pot.participants,
    bucketTotals: pot.bucketTotals.map((b: BN) => b.toString()),
    totalStake: pot.totalStake.toString(),
  });
  console.log("\n=== PHASE 1c COMPLETE — pot funded, waiting for real kickoff ===");
}
main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
