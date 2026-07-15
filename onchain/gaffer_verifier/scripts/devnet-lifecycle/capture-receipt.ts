// Capture a durable, self-contained "verify-it-yourself" receipt payload for a
// real on-chain settlement: the exact TxLINE Merkle proof bundle + the args
// validate_stat needs + the on-chain settle tx + fixture metadata. This is the
// ground-truth data the browser receipt re-verifies against the on-chain oracle.
// Re-runs validate_stat.view() to CONFIRM the captured payload verifies true,
// so we know the receipt is complete and self-contained.
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import axios from "axios";
import * as fs from "fs";
import txIdl from "./chumbucket_arena.json" assert { type: "json" }; // unused for txoracle; kept for path parity
// The txoracle IDL lives in the tx-on-chain clone; load the vendored copy in the backend instead.
const TXORACLE_IDL = JSON.parse(
  fs.readFileSync("/Users/mac/Documents/codes/opensauce/world/thewalrussessions4/vendor/txline/idl/txoracle.json", "utf8"),
);

const RPC = "https://api.devnet.solana.com";
const TXLINE_API = "https://txline-dev.txodds.com/api";
const DEVNET_TXORACLE = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
const OUT_DIR = __dirname;

// The real Argentina v Egypt 8th-finals settlement (see pot-info.json / memory).
const RECEIPT = {
  fixtureId: 18202701,
  seq: 1042, // the StatusId=5 (Ended) full-time event
  label: "Argentina v Egypt — World Cup 8th Finals",
  home: "Argentina",
  away: "Egypt",
  finalScore: { home: 3, away: 2 },
  winningBucket: 0, // HOME
  settleTx: "553CkpvcpddtBzEmPPxvMJHzJXFS73f2aJ79J5BtrrdAUBrhnrLfKQKikUZcDxzRZwz39JR2FxsJFZzUfAVJrAB8",
  cluster: "devnet",
};

async function main() {
  const jwt = process.env.DEVNET_JWT!;
  const apiToken = process.env.DEVNET_API_TOKEN!;
  const client = axios.create({ baseURL: TXLINE_API, headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken } });

  // Fetch the immutable two-stat proof bundle at the final-whistle seq.
  const res = await client.get("/scores/stat-validation", {
    params: { fixtureId: RECEIPT.fixtureId, seq: RECEIPT.seq, statKey: 1, statKey2: 2 },
  });
  const v = res.data;
  const homeGoals = v.statToProve.value;
  const awayGoals = v.statToProve2.value;
  console.log(`Proof bundle: home(key1)=${homeGoals} away(key2)=${awayGoals} @ seq ${RECEIPT.seq}`);
  if (homeGoals !== RECEIPT.finalScore.home || awayGoals !== RECEIPT.finalScore.away) {
    throw new Error(`Proof score ${homeGoals}-${awayGoals} != expected ${RECEIPT.finalScore.home}-${RECEIPT.finalScore.away}`);
  }

  const targetTs = v.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(targetTs / 86400000);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    new PublicKey(DEVNET_TXORACLE),
  );

  // The complete, self-contained receipt: everything a browser needs to
  // re-run validate_stat against the on-chain oracle, no TxLINE auth required.
  const payload = {
    ...RECEIPT,
    txoracleProgram: DEVNET_TXORACLE,
    dailyScoresMerkleRoots: dailyScoresPda.toBase58(),
    epochDay,
    targetTs,
    // The exact validate_stat argument bundle (HOME predicate: home-away > 0).
    proof: {
      ts: targetTs,
      summary: v.summary,
      subTreeProof: v.subTreeProof,
      mainTreeProof: v.mainTreeProof,
      statHome: { statToProve: v.statToProve, eventStatRoot: v.eventStatRoot, statProof: v.statProof },
      statAway: { statToProve: v.statToProve2, eventStatRoot: v.eventStatRoot, statProof: v.statProof2 },
      predicate: { threshold: 0, comparison: "GreaterThan" },
      op: "Subtract",
    },
    explorerSettleTx: `https://explorer.solana.com/tx/${RECEIPT.settleTx}?cluster=devnet`,
    capturedNote: "Self-contained: a browser can re-run validate_stat against the public devnet RPC + on-chain root with only this file — no TxLINE API key needed.",
  };
  fs.writeFileSync(`${OUT_DIR}/receipt-argentina-egypt.json`, JSON.stringify(payload, null, 2));
  console.log("Wrote receipt-argentina-egypt.json");

  // CONFIRM the captured payload re-verifies true via validate_stat.view().
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/Users/mac/Documents/codes/opensauce/world/thewalrussessions4/onchain/gaffer_verifier/devnet-wallet.json", "utf8"))));
  const provider = new AnchorProvider(new Connection(RPC, "confirmed"), new Wallet(admin), AnchorProvider.defaultOptions());
  const program = new Program({ ...(TXORACLE_IDL as any), address: DEVNET_TXORACLE } as any, provider);
  const toNodes = (ns: any[]) => ns.map((n) => ({ hash: n.hash, isRightSibling: n.isRightSibling }));
  const summ = {
    fixtureId: new BN(v.summary.fixtureId),
    updateStats: { updateCount: v.summary.updateStats.updateCount, minTimestamp: new BN(v.summary.updateStats.minTimestamp), maxTimestamp: new BN(v.summary.updateStats.maxTimestamp) },
    eventsSubTreeRoot: v.summary.eventStatsSubTreeRoot,
  };
  const isValid: boolean = await (program.methods as any)
    .validateStat(new BN(targetTs), summ, toNodes(v.subTreeProof), toNodes(v.mainTreeProof), { threshold: 0, comparison: { greaterThan: {} } },
      { statToProve: v.statToProve, eventStatRoot: v.eventStatRoot, statProof: toNodes(v.statProof) },
      { statToProve: v.statToProve2, eventStatRoot: v.eventStatRoot, statProof: toNodes(v.statProof2) },
      { subtract: {} })
    .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .view();

  console.log(`\nRe-verification via validate_stat.view(): ${isValid ? "✓ TRUE — proof validates against the on-chain root" : "✗ FALSE"}`);
  console.log("This is exactly what the browser receipt will do — independently, with no server-supplied answer.");
  if (!isValid) throw new Error("captured receipt did NOT verify — payload incomplete");
  void txIdl;
}
main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
