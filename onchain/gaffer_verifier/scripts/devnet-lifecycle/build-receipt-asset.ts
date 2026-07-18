// Produce the COMPLETE browser-ready receipt asset for the real Argentina 3-2
// on-chain settlement: metadata + the prebuilt unsigned base64 validate_stat tx
// + the exact public-RPC simulate call. The frontend loads this static JSON and
// runs the raw fetch itself — no anchor/web3/Buffer, no backend, no auth. Writes
// to web/public/receipts/ so it ships with the app.
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as fs from "fs";
import { fileURLToPath } from "node:url";

const RPC = "https://api.devnet.solana.com";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TXORACLE_IDL = JSON.parse(fs.readFileSync(`${ROOT}/vendor/txline/idl/txoracle.json`, "utf8"));
const OUT_DIR = __dirname;
const WEB_PUBLIC = `${ROOT}/web/public/receipts`;
// Existing devnet account used as the non-signing simulation fee payer.
const SIM_FEE_PAYER = "DvkE9uHRqSBp28thyYQdZFjsLpnZz25cDuD2B9epBesZ";

const CMP: Record<string, any> = { GreaterThan: { greaterThan: {} }, LessThan: { lessThan: {} }, EqualTo: { equalTo: {} } };
const OP: Record<string, any> = { Subtract: { subtract: {} }, Add: { add: {} } };
const toNodes = (ns: any[]) => ns.map((n) => ({ hash: n.hash, isRightSibling: n.isRightSibling }));

async function main() {
  const r = JSON.parse(fs.readFileSync(`${OUT_DIR}/receipt-argentina-egypt.json`, "utf8"));
  const p = r.proof;
  const conn = new Connection(RPC, "confirmed");
  const program = new Program({ ...TXORACLE_IDL, address: r.txoracleProgram } as any, new AnchorProvider(conn, {} as any, {}));

  const summary = {
    fixtureId: new BN(p.summary.fixtureId),
    updateStats: { updateCount: p.summary.updateStats.updateCount, minTimestamp: new BN(p.summary.updateStats.minTimestamp), maxTimestamp: new BN(p.summary.updateStats.maxTimestamp) },
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
  tx.feePayer = new PublicKey(SIM_FEE_PAYER);
  tx.recentBlockhash = "11111111111111111111111111111111";
  const base64Tx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

  // The complete browser-ready asset. `rpcRequest` is the exact JSON-RPC body a
  // skeptic can curl themselves; the app POSTs it to `rpcUrl` and reads returnData.
  const asset = {
    fixtureId: r.fixtureId,
    label: r.label,
    home: r.home,
    away: r.away,
    finalScore: r.finalScore,
    predicateHuman: "home_goals − away_goals > 0  (HOME win)",
    cluster: r.cluster,
    rpcUrl: RPC,
    txoracleProgram: r.txoracleProgram,
    dailyScoresMerkleRoots: r.dailyScoresMerkleRoots,
    settleTx: r.settleTx,
    explorerSettleTx: r.explorerSettleTx,
    explorerOracleProgram: `https://explorer.solana.com/address/${r.txoracleProgram}?cluster=devnet`,
    explorerRootAccount: `https://explorer.solana.com/address/${r.dailyScoresMerkleRoots}?cluster=devnet`,
    rpcRequest: {
      jsonrpc: "2.0", id: 1, method: "simulateTransaction",
      params: [base64Tx, { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64" }],
    },
    // Success criterion the browser checks: returnData.data[0] base64-decodes to a byte==1.
    expect: "value.returnData.data[0] === 'AQ==' (byte 0x01 = TRUE)",
    note: "The browser POSTs rpcRequest to rpcUrl (a PUBLIC Solana RPC) and reads the bool. TxLINE's on-chain program computes the verdict against its own Merkle-root account — this app never supplies the answer.",
  };

  fs.mkdirSync(WEB_PUBLIC, { recursive: true });
  fs.writeFileSync(`${WEB_PUBLIC}/argentina-egypt.json`, JSON.stringify(asset, null, 2));
  console.log(`Wrote web/public/receipts/argentina-egypt.json (base64 tx: ${base64Tx.length} chars)`);

}
main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
