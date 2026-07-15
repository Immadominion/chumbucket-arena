// De-risk the "verify it yourself" browser path WITHOUT any anchor/Buffer in the
// browser: the backend builds the validate_stat tx (base64, unsigned, dummy
// payer), and the "browser" simulates it via a RAW fetch to a PUBLIC Solana RPC
// with sigVerify:false + replaceRecentBlockhash:true. This proves a browser
// needs only `fetch` — the on-chain program computes the verdict on public
// Solana infra, reading its own daily_scores_roots PDA (the Merkle root). If the
// returnData bool is 1 (true), the whole client architecture is validated.
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as fs from "fs";

const RPC = "https://api.devnet.solana.com";
const TXORACLE_IDL = JSON.parse(fs.readFileSync("/Users/mac/Documents/codes/opensauce/world/thewalrussessions4/vendor/txline/idl/txoracle.json", "utf8"));
const OUT_DIR = __dirname;

const CMP: Record<string, any> = { GreaterThan: { greaterThan: {} }, LessThan: { lessThan: {} }, EqualTo: { equalTo: {} } };
const OP: Record<string, any> = { Subtract: { subtract: {} }, Add: { add: {} } };
const toNodes = (ns: any[]) => ns.map((n) => ({ hash: n.hash, isRightSibling: n.isRightSibling }));

async function main() {
  const r = JSON.parse(fs.readFileSync(`${OUT_DIR}/receipt-argentina-egypt.json`, "utf8"));
  const p = r.proof;

  // ---- STEP 1 (backend job): build the validate_stat instruction from the
  // public proof bundle, into an unsigned base64 tx with a throwaway fee payer.
  // Sim fee payer must be an EXISTING account (the RPC loads it even under
  // sigVerify:false). A random keypair 404s. Any known-existing account works —
  // no signature, no funds move. For the real receipt we embed a per-cluster
  // known account (here the devnet admin wallet).
  const dummyPayer = new PublicKey("DvkE9uHRqSBp28thyYQdZFjsLpnZz25cDuD2B9epBesZ");
  const conn = new Connection(RPC, "confirmed");
  const program = new Program({ ...TXORACLE_IDL, address: r.txoracleProgram } as any, new AnchorProvider(conn, {} as any, {}));

  const summary = {
    fixtureId: new BN(p.summary.fixtureId),
    updateStats: {
      updateCount: p.summary.updateStats.updateCount,
      minTimestamp: new BN(p.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(p.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: p.summary.eventStatsSubTreeRoot,
  };
  const ix = await (program.methods as any)
    .validateStat(
      new BN(p.ts), summary, toNodes(p.subTreeProof), toNodes(p.mainTreeProof),
      { threshold: p.predicate.threshold, comparison: CMP[p.predicate.comparison] },
      { statToProve: p.statHome.statToProve, eventStatRoot: p.statHome.eventStatRoot, statProof: toNodes(p.statHome.statProof) },
      { statToProve: p.statAway.statToProve, eventStatRoot: p.statAway.eventStatRoot, statProof: toNodes(p.statAway.statProof) },
      OP[p.op],
    )
    .accounts({ dailyScoresMerkleRoots: new PublicKey(r.dailyScoresMerkleRoots) })
    .instruction();

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  tx.feePayer = dummyPayer;
  tx.recentBlockhash = "11111111111111111111111111111111"; // placeholder; replaceRecentBlockhash overrides it
  const base64Tx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  console.log(`Built unsigned validate_stat tx: ${base64Tx.length} base64 chars`);

  // ---- STEP 2 (browser job): a RAW JSON-RPC fetch to a public RPC. This is the
  // ENTIRE browser dependency surface — no anchor, no web3, no Buffer.
  const body = {
    jsonrpc: "2.0", id: 1, method: "simulateTransaction",
    params: [base64Tx, { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64" }],
  };
  const resp = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json: any = await resp.json();
  const val = json.result?.value;
  console.log("\nRaw RPC simulate result:");
  console.log("  err:", val?.err);
  console.log("  returnData:", JSON.stringify(val?.returnData));
  console.log("  logs tail:", (val?.logs || []).slice(-4));

  // ---- STEP 3 (browser job): parse the bool from returnData (1 byte: 0x01=true).
  let verified = false;
  if (val?.returnData?.data?.[0]) {
    const bytes = Buffer.from(val.returnData.data[0], "base64");
    verified = bytes.length >= 1 && bytes[0] === 1;
  }
  console.log(`\n${verified ? "✓ VERIFIED TRUE" : "✗ not verified"} — via a raw fetch a browser can make with zero Solana libraries.`);
  if (!verified) { console.error("De-risk FAILED — investigate before building the UI."); process.exit(1); }
  console.log("Browser architecture CONFIRMED: backend builds tx (base64) → browser raw-fetch simulates on public RPC → reads bool.");
}
main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
