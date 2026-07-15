// Phase 1b: init_config (once) + create_pot for a REAL, currently-upcoming
// World Cup fixture (Argentina v Egypt, fixtureId 18202701, kickoff
// 2026-07-07T16:00:00Z = unix 1783440000), so the eventual settle_pot call
// later can use a genuine TxLINE proof rather than a contrived one.
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import type { ChumbucketArena } from "./chumbucket_arena";
import idl from "./chumbucket_arena.json";

const RPC = "https://api.devnet.solana.com";
const ADMIN_KEYPAIR_PATH = "/Users/mac/Documents/codes/opensauce/world/thewalrussessions4/onchain/gaffer_verifier/devnet-wallet.json";
const DEVNET_TXORACLE_PROGRAM = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
const OUT_DIR = __dirname;

// Usage: bun run init-and-create-pot.ts [fixtureId] [kickoffUnixSec] [matchLabel] [outFile]
// Defaults to Argentina v Egypt for backward compatibility.
const FIXTURE_ID = Number(process.argv[2] ?? 18202701);
const KICKOFF_UNIX_SEC = Number(process.argv[3] ?? 1783440000); // default: 2026-07-07T16:00:00Z
const MATCH_LABEL = process.argv[4] ?? "ARG-EGY-20260707";
const OUT_FILE = process.argv[5] ?? "pot-info.json";

function matchIdBytes(label: string): number[] {
  const ascii = Buffer.from(label, "ascii");
  if (ascii.length > 32) throw new Error("label too long");
  const buf = Buffer.concat([Buffer.alloc(32 - ascii.length), ascii]); // left-padded
  return Array.from(buf);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, "utf8"))));
  const usdcMint = new PublicKey(JSON.parse(fs.readFileSync(`${OUT_DIR}/test-usdc-mint.json`, "utf8")));

  const provider = new AnchorProvider(connection, new Wallet(admin), AnchorProvider.defaultOptions());
  anchor.setProvider(provider);
  const program = new Program(idl as unknown as ChumbucketArena, provider);
  console.log("chumbucket_arena program:", program.programId.toBase58());

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  console.log("Config PDA:", configPda.toBase58());

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    console.log("Config already initialized — skipping init_config.");
    const cfg = await (program.account as any).config.fetch(configPda);
    console.log("Existing config:", { admin: cfg.admin.toBase58(), usdcMint: cfg.usdcMint.toBase58(), txoracleProgram: cfg.txoracleProgram.toBase58(), rakeBps: cfg.rakeBps, minParticipants: cfg.minParticipants });
  } else {
    const sig = await program.methods
      .initConfig(250, 1) // 2.5% rake, min_participants=1 (single-wallet-per-side test)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        usdcMint,
        txoracleProgram: new PublicKey(DEVNET_TXORACLE_PROGRAM),
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    console.log("init_config tx:", sig);
  }

  const matchId = matchIdBytes(MATCH_LABEL);
  const [potPda] = PublicKey.findProgramAddressSync([Buffer.from("pot"), Buffer.from(matchId)], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), potPda.toBuffer()], program.programId);
  console.log("Pot PDA:", potPda.toBase58());
  console.log("Vault PDA:", vaultPda.toBase58());

  const existingPot = await connection.getAccountInfo(potPda);
  if (existingPot) {
    console.log("Pot already created — skipping create_pot.");
  } else {
    const sig = await program.methods
      .createPot(matchId, new BN(FIXTURE_ID), new BN(KICKOFF_UNIX_SEC))
      .accounts({
        keeper: admin.publicKey,
        config: configPda,
        pot: potPda,
        vault: vaultPda,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    console.log("create_pot tx:", sig);
  }

  fs.writeFileSync(`${OUT_DIR}/${OUT_FILE}`, JSON.stringify({ matchId, potPda: potPda.toBase58(), vaultPda: vaultPda.toBase58(), configPda: configPda.toBase58(), fixtureId: FIXTURE_ID, kickoff: KICKOFF_UNIX_SEC }, null, 1));
  console.log("\n=== PHASE 1b COMPLETE ===");
}
main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
