// Phase 1a: two test player keypairs (funded by transfer from our devnet admin
// wallet, since the public faucet is rate-limited) + a test USDC-like SPL mint
// (6 decimals, classic Token program — matches create_pot.rs's anchor_spl::token
// usage, not Token-2022) with balances minted to each player.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";

const RPC = "https://api.devnet.solana.com";
const OUT_DIR = __dirname;

async function main() {
  const adminKeypairPath = process.env.DEVNET_ADMIN_KEYPAIR;
  if (!adminKeypairPath) throw new Error("Set DEVNET_ADMIN_KEYPAIR to the funded devnet admin keypair path");
  const connection = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(adminKeypairPath, "utf8"))));
  console.log("Admin:", admin.publicKey.toBase58());

  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
  fs.writeFileSync(`${OUT_DIR}/player-a.json`, JSON.stringify(Array.from(playerA.secretKey)));
  fs.writeFileSync(`${OUT_DIR}/player-b.json`, JSON.stringify(Array.from(playerB.secretKey)));
  console.log("Player A (HOME bettor):", playerA.publicKey.toBase58());
  console.log("Player B (AWAY bettor):", playerB.publicKey.toBase58());

  // Fund each with 0.05 SOL (rent for ATAs/positions + tx fees) via transfer.
  const fundTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: playerA.publicKey, lamports: 0.05e9 }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: playerB.publicKey, lamports: 0.05e9 }),
  );
  const fundSig = await sendAndConfirmTransaction(connection, fundTx, [admin]);
  console.log("Funded both players:", fundSig);

  // Test USDC-like mint, 6 decimals, admin as mint authority.
  const usdcMint = await createMint(connection, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  fs.writeFileSync(`${OUT_DIR}/test-usdc-mint.json`, JSON.stringify(usdcMint.toBase58()));
  console.log("Test USDC mint:", usdcMint.toBase58());

  for (const [label, kp] of [["A", playerA], ["B", playerB]] as const) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, kp.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
    await mintTo(connection, admin, usdcMint, ata.address, admin, 100_000_000, [], undefined, TOKEN_PROGRAM_ID); // 100 test-USDC
    console.log(`Player ${label} ATA:`, ata.address.toBase58(), "minted 100 test-USDC");
  }

  console.log("\n=== SETUP COMPLETE ===");
}
main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
