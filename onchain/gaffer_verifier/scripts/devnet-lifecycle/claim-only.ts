// Claim for both players on an already-SETTLED or -VOID pot (the main
// lock-and-settle script gates on status===LOCKED, so this handles the
// after-the-fact claim). On VOID: full refund. On SETTLED: winner pro-rata,
// loser 0. Then sweep rake if any. Usage: bun run claim-only.ts [potInfoFile]
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import * as fs from "fs";
import type { ChumbucketArena } from "./chumbucket_arena";
import idl from "./chumbucket_arena.json";

const RPC = "https://api.devnet.solana.com";
const OUT_DIR = __dirname;

async function main() {
  const potInfoFile = process.argv[2] ?? "pot-info.json";
  const connection = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/Users/mac/Documents/codes/opensauce/world/thewalrussessions4/onchain/gaffer_verifier/devnet-wallet.json", "utf8"))));
  const playerA = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${OUT_DIR}/player-a.json`, "utf8"))));
  const playerB = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${OUT_DIR}/player-b.json`, "utf8"))));
  const usdcMint = new PublicKey(JSON.parse(fs.readFileSync(`${OUT_DIR}/test-usdc-mint.json`, "utf8")));
  const potInfo = JSON.parse(fs.readFileSync(`${OUT_DIR}/${potInfoFile}`, "utf8"));
  const potPda = new PublicKey(potInfo.potPda);
  const vaultPda = new PublicKey(potInfo.vaultPda);
  const configPda = new PublicKey(potInfo.configPda);

  const provider = new AnchorProvider(connection, new Wallet(admin), AnchorProvider.defaultOptions());
  anchor.setProvider(provider);
  const program = new Program(idl as unknown as ChumbucketArena, provider);

  const pot = await (program.account as any).pot.fetch(potPda);
  console.log("Pot status (2=SETTLED 3=VOID):", pot.status, "| winningBucket:", pot.winningBucket, "| rake:", pot.rake.toString(), "| distributable:", pot.distributable.toString());
  const vaultBefore = await getAccount(connection, vaultPda, "confirmed", TOKEN_PROGRAM_ID);
  console.log("Vault balance before claims:", vaultBefore.amount.toString());

  for (const [label, kp] of [["A (HOME/20)", playerA], ["B (AWAY/10)", playerB]] as const) {
    const playerUsdc = getAssociatedTokenAddressSync(usdcMint, kp.publicKey, false, TOKEN_PROGRAM_ID);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), potPda.toBuffer(), kp.publicKey.toBuffer()],
      program.programId,
    );
    const posAcct = await connection.getAccountInfo(positionPda);
    if (!posAcct) { console.log(`Player ${label}: no position (already claimed+closed) — skipping.`); continue; }
    const before = await getAccount(connection, playerUsdc, "confirmed", TOKEN_PROGRAM_ID);
    try {
      const claimProvider = new AnchorProvider(connection, new Wallet(kp), AnchorProvider.defaultOptions());
      const claimProgram = new Program(idl as unknown as ChumbucketArena, claimProvider);
      const sig = await claimProgram.methods
        .claim()
        .accounts({ player: kp.publicKey, pot: potPda, vault: vaultPda, playerUsdc, position: positionPda, tokenProgram: TOKEN_PROGRAM_ID } as any)
        .rpc();
      const after = await getAccount(connection, playerUsdc, "confirmed", TOKEN_PROGRAM_ID);
      console.log(`Player ${label} claim tx:`, sig, `| USDC ${before.amount} -> ${after.amount} (+${after.amount - before.amount})`);
    } catch (e: any) {
      console.log(`Player ${label} claim FAILED:`, e?.message?.slice(0, 120) || e);
    }
  }

  const potAfter = await (program.account as any).pot.fetch(potPda);
  if (potAfter.rake.toString() !== "0") {
    const managerUsdc = getAssociatedTokenAddressSync(usdcMint, admin.publicKey, false, TOKEN_PROGRAM_ID);
    if (!(await connection.getAccountInfo(managerUsdc))) {
      await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountInstruction(admin.publicKey, managerUsdc, admin.publicKey, usdcMint, TOKEN_PROGRAM_ID)), [admin]);
    }
    const before = await getAccount(connection, managerUsdc, "confirmed", TOKEN_PROGRAM_ID);
    const sweepSig = await program.methods
      .sweepRake()
      .accounts({ keeper: admin.publicKey, config: configPda, pot: potPda, vault: vaultPda, managerUsdc, tokenProgram: TOKEN_PROGRAM_ID } as any)
      .rpc();
    const after = await getAccount(connection, managerUsdc, "confirmed", TOKEN_PROGRAM_ID);
    console.log("sweep_rake tx:", sweepSig, `| manager USDC ${before.amount} -> ${after.amount} (+${after.amount - before.amount})`);
  } else {
    console.log("No rake to sweep (void, or already swept).");
  }

  const vaultAfter = await getAccount(connection, vaultPda, "confirmed", TOKEN_PROGRAM_ID);
  console.log("Vault balance after everything:", vaultAfter.amount.toString(), "(dust/residue if any)");
}
main().catch((e) => { console.error("FAILED:", e?.message || e); if (e?.logs) console.error(e.logs); process.exit(1); });
