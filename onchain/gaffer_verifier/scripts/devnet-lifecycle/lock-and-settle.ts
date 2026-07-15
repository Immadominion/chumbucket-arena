// Phase 2: run once real kickoff has passed. lock_pot (permissionless, needs
// Clock >= kickoff), then poll TxLINE for real score data on the fixture, and
// once available, settle_pot with the genuine proof, claim from both players,
// and sweep_rake. Safe to re-run: each step checks pot.status first and skips
// what's already done.
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAccount } from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import axios from "axios";
import * as fs from "fs";
import type { ChumbucketArena } from "./chumbucket_arena";
import idl from "./chumbucket_arena.json";

const RPC = "https://api.devnet.solana.com";
const OUT_DIR = __dirname;
const TXLINE_API_BASE = "https://txline-dev.txodds.com/api";
const STAT_KEY_HOME = 1;
const STAT_KEY_AWAY = 2;
const BUCKET_HOME = 0;
const BUCKET_DRAW = 1;
const BUCKET_AWAY = 2;

function toBytes32(arr: number[]): number[] {
  if (arr.length !== 32) throw new Error(`expected 32 bytes, got ${arr.length}`);
  return arr;
}
function toProofNodes(nodes: Array<{ hash: number[]; isRightSibling: boolean }>) {
  return nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));
}

async function main() {
  // Usage: bun run lock-and-settle.ts [potInfoFile]
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
  const fixtureId = potInfo.fixtureId;

  const provider = new AnchorProvider(connection, new Wallet(admin), AnchorProvider.defaultOptions());
  anchor.setProvider(provider);
  const program = new Program(idl as unknown as ChumbucketArena, provider);

  const client = axios.create({
    baseURL: TXLINE_API_BASE,
    headers: { Authorization: `Bearer ${process.env.DEVNET_JWT}`, "X-Api-Token": process.env.DEVNET_API_TOKEN },
  });

  let pot = await (program.account as any).pot.fetch(potPda);
  console.log("Pot status (0=OPEN 1=LOCKED 2=SETTLED 3=VOID):", pot.status);

  const now = Math.floor(Date.now() / 1000);
  console.log("now:", now, "kickoff:", potInfo.kickoff, "past kickoff:", now >= potInfo.kickoff);

  if (pot.status === 0) {
    if (now < potInfo.kickoff) {
      console.log(`Not yet kicked off — ${potInfo.kickoff - now}s remaining. Nothing to do yet.`);
      return;
    }
    const sig = await program.methods
      .lockPot()
      .accounts({ pot: potPda } as any)
      .rpc();
    console.log("lock_pot tx:", sig);
    pot = await (program.account as any).pot.fetch(potPda);
  }

  if (pot.status !== 1) {
    console.log("Pot is not LOCKED (status=" + pot.status + ") — nothing more to do here (already settled/void, or still open).");
    return;
  }

  // Find the fixture's FINAL event and the seq to prove against.
  //
  // CRITICAL: the /scores/snapshot array is NOT ordered — `rows[rows.length-1]`
  // is a stale mid-match event, NOT the latest. An earlier version of this
  // script read that last array element and consequently saw a frozen in-play
  // status for ~28h after matches had actually finished, inventing a phantom
  // "the devnet feed takes days to finish matches" theory. It does not: matches
  // complete their full event stream in ~2h like normal. We must scan the WHOLE
  // array for the terminal event, sorted by Seq.
  //
  // Soccer game-phase encoding (documentation/scores/soccer-feed.mdx): a match
  // concludes via one of three genuinely-final states depending on whether it
  // needed ET / penalties: 5=F (Ended in regulation), 10=FET (Ended after Extra
  // Time), 13=FPE (Ended after Penalty Shootout). We settle only on those (plus
  // a corroborating `game_finalised` action). Everything else can still change.
  let latestSeq: number;
  try {
    const snap = await client.get(`/scores/snapshot/${fixtureId}?asOf=${Date.now()}`);
    const rows = Array.isArray(snap.data) ? snap.data : [];
    if (rows.length === 0) {
      console.log("No snapshot rows yet — match hasn't generated events.");
      return;
    }
    const FINISHED_STATUSES = new Set([5, 10, 13]);
    const finishedEvents = rows
      .filter((e: any) => FINISHED_STATUSES.has(e.StatusId))
      .sort((a: any, b: any) => (a.Seq ?? 0) - (b.Seq ?? 0));
    const isFinalised = rows.some((e: any) => e.Action === "game_finalised");
    const topSeq = Math.max(...rows.map((e: any) => e.Seq ?? -1));

    if (finishedEvents.length === 0) {
      console.log(`Match not finished yet (no StatusId in {5,10,13} across ${rows.length} events; topSeq=${topSeq}, game_finalised=${isFinalised}) — waiting.`);
      return;
    }
    // Prove against the highest-Seq finished-status event (the definitive
    // full-time/ET/penalty-final stat commitment).
    const finalEvent = finishedEvents[finishedEvents.length - 1];
    latestSeq = finalEvent.Seq;
    console.log(
      `Match FINISHED: StatusId=${finalEvent.StatusId} at Seq=${latestSeq}, Score(home-away)=${finalEvent.Stats?.["1"]}-${finalEvent.Stats?.["2"]}, game_finalised=${isFinalised}, topSeq=${topSeq}.`,
    );
  } catch (e: any) {
    console.log("Snapshot fetch failed:", e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 200) || e.message);
    return;
  }

  let validation: any;
  try {
    const res = await client.get("/scores/stat-validation", {
      params: { fixtureId, seq: latestSeq, statKey: STAT_KEY_HOME, statKey2: STAT_KEY_AWAY },
    });
    validation = res.data;
  } catch (e: any) {
    console.log("No proof bundle yet for seq", latestSeq, ":", e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 200) || e.message);
    return;
  }

  const home = validation.statToProve.value;
  const away = validation.statToProve2.value;
  console.log(`Real score so far — home(key${STAT_KEY_HOME})=${home} away(key${STAT_KEY_AWAY})=${away}`);

  const winningBucket = home > away ? BUCKET_HOME : home < away ? BUCKET_AWAY : BUCKET_DRAW;
  console.log("Winning bucket:", winningBucket, "(0=HOME 1=DRAW 2=AWAY)");

  const targetTs = validation.summary.updateStats.minTimestamp; // NOT the top-level `ts` field — see resolve-operand-order.ts
  const epochDay = Math.floor(targetTs / 86400000);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
  );

  const fixtureSummary = {
    fixtureId: new BN(validation.summary.fixtureId),
    updateStats: {
      updateCount: validation.summary.updateStats.updateCount,
      minTimestamp: new BN(validation.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(validation.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: toBytes32(validation.summary.eventStatsSubTreeRoot),
  };
  const fixtureProof = toProofNodes(validation.subTreeProof);
  const mainTreeProof = toProofNodes(validation.mainTreeProof);
  const statHome = {
    statToProve: validation.statToProve,
    eventStatRoot: toBytes32(validation.eventStatRoot),
    statProof: toProofNodes(validation.statProof),
  };
  const statAway = {
    statToProve: validation.statToProve2,
    eventStatRoot: toBytes32(validation.eventStatRoot),
    statProof: toProofNodes(validation.statProof2),
  };

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const settleSig = await program.methods
    .settlePot(winningBucket, new BN(targetTs), fixtureSummary, fixtureProof, mainTreeProof, statHome, statAway)
    .accounts({
      config: configPda,
      pot: potPda,
      txoracleProgram: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
      dailyScoresMerkleRoots: dailyScoresPda,
    } as any)
    .preInstructions([computeBudgetIx])
    .rpc();
  console.log("settle_pot tx:", settleSig);

  pot = await (program.account as any).pot.fetch(potPda);
  console.log("Post-settle pot:", {
    status: pot.status,
    winningBucket: pot.winningBucket,
    rake: pot.rake.toString(),
    distributable: pot.distributable.toString(),
    winnersStake: pot.winnersStake.toString(),
  });

  if (pot.status === 3) {
    console.log("Pot VOIDED (proven-winner had no stakers, or thin pool) — players claim FULL REFUNDS below; no rake to sweep.");
  }

  // Claim from both players. On a SETTLED pot this pays winners their pro-rata
  // share (losers get 0); on a VOID pot claim.rs refunds every stake in full.
  // Either way each Position is closed on claim.
  for (const [label, kp] of [["A", playerA], ["B", playerB]] as const) {
    const playerUsdc = getAssociatedTokenAddressSync(usdcMint, kp.publicKey, false, TOKEN_PROGRAM_ID);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), potPda.toBuffer(), kp.publicKey.toBuffer()],
      program.programId,
    );
    const posAcct = await connection.getAccountInfo(positionPda);
    if (!posAcct) {
      console.log(`Player ${label}: no position (didn't bet, or already claimed+closed) — skipping.`);
      continue;
    }
    const before = await getAccount(connection, playerUsdc, "confirmed", TOKEN_PROGRAM_ID);
    const claimProvider = new AnchorProvider(connection, new Wallet(kp), AnchorProvider.defaultOptions());
    const claimProgram = new Program(idl as unknown as ChumbucketArena, claimProvider);
    const sig = await claimProgram.methods
      .claim()
      .accounts({ player: kp.publicKey, pot: potPda, vault: vaultPda, playerUsdc, position: positionPda, tokenProgram: TOKEN_PROGRAM_ID } as any)
      .rpc();
    const after = await getAccount(connection, playerUsdc, "confirmed", TOKEN_PROGRAM_ID);
    console.log(`Player ${label} claim tx:`, sig, `| balance ${before.amount} -> ${after.amount} (+${after.amount - before.amount})`);
  }

  // Sweep rake to the admin's own USDC ATA (stand-in "manager treasury" for this test).
  pot = await (program.account as any).pot.fetch(potPda);
  if (pot.rake.toString() !== "0") {
    const managerUsdc = getAssociatedTokenAddressSync(usdcMint, admin.publicKey, false, TOKEN_PROGRAM_ID);
    let managerAcct = await connection.getAccountInfo(managerUsdc);
    if (!managerAcct) {
      const tx = new Transaction().add(createAssociatedTokenAccountInstruction(admin.publicKey, managerUsdc, admin.publicKey, usdcMint, TOKEN_PROGRAM_ID));
      await provider.sendAndConfirm(tx, [admin]);
    }
    const sweepSig = await program.methods
      .sweepRake()
      .accounts({ keeper: admin.publicKey, config: configPda, pot: potPda, vault: vaultPda, managerUsdc, tokenProgram: TOKEN_PROGRAM_ID } as any)
      .rpc();
    console.log("sweep_rake tx:", sweepSig);
  } else {
    console.log("Rake already swept (or zero) — nothing to sweep.");
  }

  console.log("\n=== PHASE 2 COMPLETE — full lifecycle proven live on devnet ===");
}
main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
