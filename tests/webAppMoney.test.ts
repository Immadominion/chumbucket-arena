/**
 * Calls with money in the web app (web/lib/webapp/money.ts, moneyFlow.ts,
 * transferCheck.ts, claimCheck.ts, swapCheck.ts, solanaV0.ts and the money
 * sheets under web/components/webapp/money): the amount row, where a call
 * with money stands, the deposit and wallet sheets' states, and — before any
 * wallet signs — the browser's own checks of a USDC transfer (contract §c), a
 * win claim and a gasless swap. Test doubles stand in for the BFF and the
 * wallet; the transactions are real v0 bytes in the BFF's shapes.
 */

import { describe, expect, test } from "bun:test";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkGaslessSwap as serverSwapCheck, type ExpectedSwap as ServerExpectedSwap } from "../src/solTopUp/verify.ts";
import { METIS, OWNER, RFQ } from "./fixtures/jupiterGasless.ts";
import { fundedLabel } from "../web/lib/callsBff.ts";
import { checkPantaClaim, type ReviewedClaim } from "../web/lib/webapp/claimCheck.ts";
import {
  activityRow,
  amountHint,
  balanceRose,
  balanceUsd,
  callCta,
  cashOutForm,
  collectable,
  covers,
  customAmount,
  defaultAmount,
  depositTiles,
  fundedStamp,
  fundsLanded,
  parseUsd,
  pendingMark,
  presetAmounts,
  progressOf,
  readLastAmount,
  usd,
  usdDecimal,
  writeLastAmount,
  type ActivityItem,
  type DepositOptions,
  type MoneyCallView,
  type MoneyStatus,
  type MoneyWallet,
  type PrepareCallResult,
  type TopUpOrder,
  type TransferPrepareResult,
} from "../web/lib/webapp/money.ts";
import {
  advanceCall,
  collectWin,
  confirmCall,
  MoneyStop,
  prepareTransfer,
  sendTransfer,
  stopLine,
  topUp,
  type MoneyFlowApi,
} from "../web/lib/webapp/moneyFlow.ts";
import { PANTA_PROGRAM, UnsafeTransaction } from "../web/lib/webapp/pantaBuyCheck.ts";
import { MalformedTransaction, parseV0, tokenAccountOf } from "../web/lib/webapp/solanaV0.ts";
import { base64ToBytes, bytesToBase64, signedOnlyInSlot } from "../web/lib/webapp/solanaTx.ts";
import { checkGaslessSwap, type ExpectedSwap } from "../web/lib/webapp/swapCheck.ts";
import { checkedSigner, TradeError, type TradeOrder } from "../web/lib/webapp/trade.ts";
import { checkUsdcTransfer, type ReviewedTransfer } from "../web/lib/webapp/transferCheck.ts";
import { chumbucketWalletOn, linkingOn, moneyOn } from "../web/lib/webapp/rollout.ts";
import type { KeyValueStorage as KeyValueStorageLike } from "../web/lib/webapp/cache.ts";
import type { CallFeedEntry } from "../web/lib/webapp/types.ts";

const WEB = join(import.meta.dir, "../web");
const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const friend = Keypair.fromSeed(new Uint8Array(32).fill(11));
const thief = Keypair.fromSeed(new Uint8Array(32).fill(8));
const blockhash = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const FAKE_MINT = new PublicKey(new Uint8Array(32).fill(21));
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ataOf = (who: PublicKey, mint = USDC) => PublicKey.findProgramAddressSync([who.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const pda = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

function sign(bytes: Uint8Array, signer = owner): Uint8Array {
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([signer]);
  return tx.serialize();
}

function memoryStorage(): KeyValueStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const brokenStorage: KeyValueStorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceeded");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

// ── a USDC transfer, as the BFF builds a cash out (contract §c) ──────────────

interface TransferOpts {
  from?: Keypair;
  to?: PublicKey;
  amount?: bigint;
  decimals?: number;
  mint?: PublicKey;
  create?: boolean;
  payer?: PublicKey;
  units?: number | null;
  price?: number | null;
  extra?: TransactionInstruction[];
  before?: TransactionInstruction[];
  tokenProgram?: PublicKey;
  destinationAccount?: PublicKey;
  lookup?: boolean;
  secondSigner?: PublicKey;
}
function transferTx(o: TransferOpts = {}): Uint8Array {
  const from = (o.from ?? owner).publicKey;
  const to = o.to ?? friend.publicKey;
  const mint = o.mint ?? USDC;
  const toAta = o.destinationAccount ?? ataOf(to, mint);
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(o.amount ?? 5_000_000n, 1);
  data[9] = o.decimals ?? 6;
  const ixs: TransactionInstruction[] = [
    ...(o.before ?? []),
    ...(o.units === null ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units: o.units ?? 40_000 })]),
    ...(o.price === null ? [] : [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.price ?? 50_000 })]),
    ...(o.create
      ? [new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [meta(from, true, true), meta(toAta, true), meta(to), meta(mint), meta(SystemProgram.programId), meta(TOKEN)] })]
      : []),
    new TransactionInstruction({
      programId: o.tokenProgram ?? TOKEN,
      data,
      keys: [meta(ataOf(from, mint), true), meta(mint), meta(toAta, true), meta(from, false, true), ...(o.secondSigner ? [meta(o.secondSigner, false, true)] : [])],
    }),
    ...(o.extra ?? []),
  ];
  const lookups = o.lookup
    ? [new AddressLookupTableAccount({ key: pda(20), state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [mint] } })]
    : [];
  const message = new TransactionMessage({ payerKey: o.payer ?? from, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lookups);
  return new VersionedTransaction(message).serialize();
}
const reviewed = (over: Partial<ReviewedTransfer> = {}): ReviewedTransfer => ({
  from: owner.publicKey.toBase58(),
  to: friend.publicKey.toBase58(),
  amountBaseUnits: "5000000",
  createsAccount: false,
  ...over,
});
const refusedTransfer = (tx: Uint8Array, t: ReviewedTransfer = reviewed()) =>
  checkUsdcTransfer(tx, t).then(
    () => false,
    (e) => e instanceof UnsafeTransaction,
  );

describe("the transfer check (contract §c), before any wallet signs a cash out", () => {
  test("exactly the reviewed transfer passes: with and without the destination's account, with 0–2 compute budget instructions", async () => {
    await checkUsdcTransfer(transferTx(), reviewed());
    await checkUsdcTransfer(transferTx({ create: true }), reviewed({ createsAccount: true }));
    await checkUsdcTransfer(transferTx({ units: null, price: null }), reviewed());
    await checkUsdcTransfer(transferTx({ units: 200_000, price: 1_000_000 }), reviewed());
    // Full precision (a "Max" cash out).
    await checkUsdcTransfer(transferTx({ amount: 12_190_001n }), reviewed({ amountBaseUnits: "12190001" }));
  });

  test("malicious payloads are refused: wrong mint, wrong destination, extra instruction, foreign fee payer, amount mismatch", async () => {
    const cases: Array<[string, Uint8Array, ReviewedTransfer?]> = [
      ["wrong mint", transferTx({ mint: FAKE_MINT })],
      ["wrong destination", transferTx({ to: thief.publicKey })],
      ["destination account is not the reviewed wallet's", transferTx({ destinationAccount: ataOf(thief.publicKey) })],
      ["extra SOL transfer", transferTx({ extra: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: thief.publicKey, lamports: 1 })] })],
      ["extra USDC transfer", transferTx({ extra: [splTransferChecked(owner.publicKey, thief.publicKey, 1n)] })],
      ["memo", transferTx({ extra: [new TransactionInstruction({ programId: MEMO, data: Buffer.from("hi"), keys: [meta(owner.publicKey, false, true)] })] })],
      ["foreign fee payer", transferTx({ payer: thief.publicKey })],
      ["more than reviewed", transferTx({ amount: 5_000_001n })],
      ["less than reviewed", transferTx({ amount: 4_000_000n })],
      ["wrong decimals", transferTx({ decimals: 9 })],
      ["Token-2022", transferTx({ tokenProgram: TOKEN_2022 })],
      ["a second signer", transferTx({ secondSigner: thief.publicKey })],
      ["address lookup table", transferTx({ lookup: true })],
      ["compute units over 200 000", transferTx({ units: 200_001 })],
      ["compute price over 1 000 000", transferTx({ price: 1_000_001 })],
      ["two compute limits", transferTx({ before: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })] })],
      ["account created though the review said not", transferTx({ create: true })],
      ["account not created though the review said so", transferTx(), reviewed({ createsAccount: true })],
      ["the reviewed destination differs", transferTx(), reviewed({ to: thief.publicKey.toBase58() })],
      ["the reviewed sender differs", transferTx(), reviewed({ from: thief.publicKey.toBase58() })],
      ["to yourself", transferTx({ to: owner.publicKey }), reviewed({ to: owner.publicKey.toBase58() })],
      ["to a program-derived address", transferTx({ to: ataOf(friend.publicKey) }), reviewed({ to: ataOf(friend.publicKey).toBase58() })],
      ["already signed", sign(transferTx())],
      ["truncated", transferTx().subarray(0, 150)],
      ["trailing byte", Uint8Array.from([...transferTx(), 0])],
    ];
    for (const [name, tx, t] of cases) expect({ name, refused: await refusedTransfer(tx, t) }).toEqual({ name, refused: true });
  });

  test("passes the transfer exactly as the BFF builds it with @solana/spl-token (contract §c)", async () => {
    for (const createsAccount of [false, true]) {
      const from = owner.publicKey;
      const to = friend.publicKey;
      const toAta = getAssociatedTokenAddressSync(USDC, to, true);
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
        ...(createsAccount ? [createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, USDC)] : []),
        createTransferCheckedInstruction(getAssociatedTokenAddressSync(USDC, from, true), USDC, toAta, from, 5_000_000n, 6),
      ];
      const bytes = new VersionedTransaction(new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions }).compileToV0Message()).serialize();
      await checkUsdcTransfer(bytes, reviewed({ createsAccount }));
    }
  });

  test("checkedSigner(...).signTransfer runs the check on its own copy, before the wallet sees anything", async () => {
    const seen: Uint8Array[] = [];
    const signer = checkedSigner(owner.publicKey.toBase58(), async (bytes) => {
      seen.push(bytes);
      return sign(bytes);
    });
    await expect(signer.signTransfer(transferTx({ to: thief.publicKey }), reviewed())).rejects.toBeInstanceOf(UnsafeTransaction);
    await expect(signer.signTransfer(transferTx(), reviewed({ from: thief.publicKey.toBase58() }))).rejects.toBeInstanceOf(UnsafeTransaction);
    expect(seen).toHaveLength(0);
    const bytes = transferTx();
    const signed = await signer.signTransfer(bytes, reviewed());
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(bytes);
    expect(signedOnlyInSlot(bytes, signed, 0)).toBe(true);
    // A wallet that hands back anything but the checked bytes, signed in slot 0: refused.
    const rewriting = checkedSigner(owner.publicKey.toBase58(), async () => sign(transferTx({ amount: 1n })));
    await expect(rewriting.signTransfer(transferTx(), reviewed())).rejects.toBeInstanceOf(UnsafeTransaction);
  });
});

function splTransferChecked(from: PublicKey, to: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = 6;
  return new TransactionInstruction({ programId: TOKEN, data, keys: [meta(ataOf(from), true), meta(USDC), meta(ataOf(to), true), meta(from, false, true)] });
}

// ── the v0 reader ────────────────────────────────────────────────────────────

describe("reading a v0 transaction", () => {
  test("agrees with @solana/web3.js, lookup tables included", () => {
    for (const b64 of [METIS.unsignedBase64, RFQ.unsignedBase64]) {
      const bytes = base64ToBytes(b64);
      const ours = parseV0(bytes);
      const theirs = VersionedTransaction.deserialize(bytes).message as MessageV0;
      expect(ours.keys).toEqual(theirs.staticAccountKeys.map((k) => k.toBase58()));
      expect(ours.instructions.map((i) => [i.program, i.accounts, Array.from(i.data)])).toEqual(
        theirs.compiledInstructions.map((i) => [i.programIdIndex, i.accountKeyIndexes, Array.from(i.data)]),
      );
      expect(ours.lookups.map((l) => [l.table, l.writable, l.readonly])).toEqual(
        theirs.addressTableLookups.map((l) => [l.accountKey.toBase58(), l.writableIndexes, l.readonlyIndexes]),
      );
      expect(ours.header).toEqual({ required: theirs.header.numRequiredSignatures, readonlySigned: theirs.header.numReadonlySignedAccounts, readonlyUnsigned: theirs.header.numReadonlyUnsignedAccounts });
    }
  });

  test("refuses legacy, truncated, padded and non-minimal encodings", () => {
    const tx = transferTx();
    expect(() => parseV0(tx.subarray(0, tx.length - 1))).toThrow(MalformedTransaction);
    expect(() => parseV0(Uint8Array.from([...tx, 0]))).toThrow(MalformedTransaction);
    const legacy = new VersionedTransaction(
      new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: friend.publicKey, lamports: 1 })] }).compileToLegacyMessage(),
    ).serialize();
    expect(() => parseV0(legacy)).toThrow(MalformedTransaction);
    // A signature count of 1 written as two bytes (0x81 0x00).
    expect(() => parseV0(Uint8Array.from([0x81, 0x00, ...tx.subarray(1)]))).toThrow(MalformedTransaction);
  });

  test("canonical token accounts agree with @solana/web3.js", async () => {
    for (let i = 0; i < 20; i++) {
      const who = Keypair.generate().publicKey;
      expect(await tokenAccountOf(who.toBase58(), USDC.toBase58())).toBe(ataOf(who).toBase58());
    }
  });
});

// ── a win claim, as the BFF's PantaClaimExecution builds it ──────────────────

const CLAIM_DISC = [0x2b, 0xa0, 0x6a, 0x33, 0xa7, 0x4c, 0x14, 0x1f];
const claimMarket = pda(3);
interface ClaimOpts {
  market?: PublicKey;
  payTo?: PublicKey;
  payer?: PublicKey;
  extra?: TransactionInstruction[];
  memo?: boolean;
  dataOwner?: PublicKey;
}
function claimTx(o: ClaimOpts = {}): Uint8Array {
  const who = owner.publicKey;
  const ata = ataOf(who);
  const data = Buffer.from([...CLAIM_DISC, ...(o.dataOwner ?? who).toBytes()]);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [meta(who, true, true), meta(ata, true), meta(who), meta(USDC), meta(SystemProgram.programId), meta(TOKEN)] }),
    new TransactionInstruction({
      programId: new PublicKey(PANTA_PROGRAM),
      data,
      keys: [meta(who, true, true), meta(pda(5)), meta(o.market ?? claimMarket, true), meta(pda(6), true), meta(pda(7), true), meta(pda(8), true), meta(pda(9), true), meta(o.payTo ?? ata, true), meta(USDC), meta(TOKEN), meta(ATA), meta(SystemProgram.programId)],
    }),
    ...(o.memo === false ? [] : [new TransactionInstruction({ programId: MEMO, data: Buffer.from("panta:v1:claim"), keys: [meta(who, false, true)] })]),
    ...(o.extra ?? []),
  ];
  const message = new TransactionMessage({ payerKey: o.payer ?? who, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}
const reviewedClaim = (over: Partial<ReviewedClaim> = {}): ReviewedClaim => ({
  owner: owner.publicKey.toBase58(),
  venueMarketId: claimMarket.toBase58(),
  outcome: "YES",
  winningShares: "9.2",
  ...over,
});

describe("the claim check (ported from the phone), before any wallet signs Collect", () => {
  test("exactly the reviewed claim passes, memo or not", async () => {
    await checkPantaClaim(claimTx(), reviewedClaim());
    await checkPantaClaim(claimTx({ memo: false }), reviewedClaim({ outcome: "NO" }));
  });

  test("a claim for another market, paid elsewhere, with a transfer, or someone else's: refused", async () => {
    const cases: Array<[string, Uint8Array, ReviewedClaim?]> = [
      ["another market", claimTx({ market: pda(30) })],
      ["paid to another account", claimTx({ payTo: ataOf(thief.publicKey) })],
      ["a SOL transfer", claimTx({ extra: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: thief.publicKey, lamports: 1 })] })],
      ["a USDC transfer", claimTx({ extra: [splTransferChecked(owner.publicKey, thief.publicKey, 1n)] })],
      ["foreign fee payer", claimTx({ payer: thief.publicKey })],
      ["the claim names someone else", claimTx({ dataOwner: thief.publicKey })],
      ["no shares", claimTx(), reviewedClaim({ winningShares: "0" })],
      ["not a win", claimTx(), reviewedClaim({ outcome: "VOID" as "YES" })],
      ["already signed", sign(claimTx())],
    ];
    for (const [name, tx, c] of cases) {
      expect({ name, refused: await checkPantaClaim(tx, c ?? reviewedClaim()).then(() => false, (e) => e instanceof UnsafeTransaction) }).toEqual({ name, refused: true });
    }
  });
});

// ── a gasless swap: the web check against the BFF's own ──────────────────────

const metisExpected = (over: Partial<ExpectedSwap> = {}): ExpectedSwap => ({
  owner: OWNER,
  inAmount: METIS.inAmount,
  router: "metis",
  quotedOutLamports: METIS.outAmount,
  feeBps: METIS.feeBps,
  nowSeconds: METIS.blockTime,
  ...over,
});
const rfqExpected = (over: Partial<ExpectedSwap> = {}): ExpectedSwap => ({
  owner: OWNER,
  inAmount: RFQ.inAmount,
  router: "jupiterz",
  quotedOutLamports: RFQ.outAmount,
  feeBps: RFQ.feeBps,
  nowSeconds: RFQ.blockTime,
  ...over,
});
function mutateSwap(b64: string, change: (m: { keys: PublicKey[]; ixs: MessageV0["compiledInstructions"] }) => void, sigs?: (s: Uint8Array[]) => void): Uint8Array {
  const tx = VersionedTransaction.deserialize(base64ToBytes(b64));
  const m = tx.message as MessageV0;
  const keys = m.staticAccountKeys.slice();
  const ixs = m.compiledInstructions.map((ix) => ({ ...ix, accountKeyIndexes: ix.accountKeyIndexes.slice(), data: new Uint8Array(ix.data) }));
  change({ keys, ixs });
  const message = new MessageV0({ header: { ...m.header }, staticAccountKeys: keys, recentBlockhash: m.recentBlockhash, compiledInstructions: ixs, addressTableLookups: m.addressTableLookups });
  const s = tx.signatures.map((x) => new Uint8Array(x));
  sigs?.(s);
  return new VersionedTransaction(message, s).serialize();
}
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

describe("the gasless swap check agrees with the BFF's", () => {
  const verdicts = async (bytes: Uint8Array, expected: ExpectedSwap) => {
    const web = await checkGaslessSwap(bytes, expected).then((c) => c.ownerSignatureIndex, () => "refused");
    let server: number | "refused";
    try {
      server = serverSwapCheck(bytes, expected as ServerExpectedSwap).ownerSignatureIndex;
    } catch {
      server = "refused";
    }
    return { web, server };
  };

  test("the real Metis and JupiterZ shapes pass both, with the person's own slot", async () => {
    expect(await verdicts(base64ToBytes(METIS.unsignedBase64), metisExpected())).toEqual({ web: 1, server: 1 });
    const rfq = await verdicts(base64ToBytes(RFQ.unsignedBase64), rfqExpected());
    expect(rfq.web).toBe(rfq.server);
    expect(rfq.web).not.toBe("refused");
  });

  test("every tampered swap is refused by both", async () => {
    const cases: Array<[string, Uint8Array, ExpectedSwap]> = [
      ["another amount", base64ToBytes(METIS.unsignedBase64), metisExpected({ inAmount: METIS.inAmount + 1n })],
      ["another owner", base64ToBytes(METIS.unsignedBase64), metisExpected({ owner: thief.publicKey.toBase58() })],
      ["another router", base64ToBytes(METIS.unsignedBase64), metisExpected({ router: "jupiterz" })],
      ["worse than quoted", base64ToBytes(METIS.unsignedBase64), metisExpected({ quotedOutLamports: 108_000_000n })],
      ["fee above quote", base64ToBytes(METIS.unsignedBase64), metisExpected({ feeBps: 5 })],
      ["the person pays gas", mutateSwap(METIS.unsignedBase64, ({ keys }) => { [keys[0], keys[1]] = [keys[1]!, keys[0]!]; }), metisExpected()],
      ["already signed for the person", mutateSwap(METIS.unsignedBase64, () => {}, (s) => s[1]!.fill(7)), metisExpected()],
      ["pays someone else", mutateSwap(METIS.unsignedBase64, ({ keys, ixs }) => { ixs.find((ix) => keys[ix.programIdIndex]!.toBase58() === JUP)!.accountKeyIndexes[2] = 2; }), metisExpected()],
      ["spends another account", mutateSwap(METIS.unsignedBase64, ({ keys, ixs }) => { ixs.find((ix) => keys[ix.programIdIndex]!.toBase58() === JUP)!.accountKeyIndexes[1] = 2; }), metisExpected()],
      [
        "a SOL transfer from the person",
        mutateSwap(METIS.unsignedBase64, ({ keys, ixs }) => {
          const transfer = SystemProgram.transfer({ fromPubkey: keys[1]!, toPubkey: keys[2]!, lamports: 1 });
          ixs.push({ programIdIndex: keys.findIndex((k) => k.equals(SystemProgram.programId)), accountKeyIndexes: [1, 2], data: transfer.data });
        }),
        metisExpected(),
      ],
      ["an RFQ for another amount", base64ToBytes(RFQ.unsignedBase64), rfqExpected({ inAmount: 1n })],
    ];
    for (const [name, bytes, expected] of cases) expect({ name, ...(await verdicts(bytes, expected)) }).toEqual({ name, web: "refused", server: "refused" });
  });

  test("signSwap signs in the person's slot only, after the check", async () => {
    const seen: number[] = [];
    const signer = checkedSigner(OWNER, async (bytes, slot) => {
      seen.push(slot ?? -1);
      const out = bytes.slice();
      out.fill(9, 1 + 64 * (slot ?? 0), 1 + 64 * ((slot ?? 0) + 1));
      return out;
    });
    const { checked } = await signer.signSwap(base64ToBytes(METIS.unsignedBase64), metisExpected());
    expect(checked.ownerSignatureIndex).toBe(1);
    expect(seen).toEqual([1]);
    await expect(signer.signSwap(base64ToBytes(METIS.unsignedBase64), metisExpected({ inAmount: 1n }))).rejects.toBeInstanceOf(UnsafeTransaction);
    expect(seen).toEqual([1]);
    // A wallet that signs the fee payer's slot instead is refused.
    const wrongSlot = checkedSigner(OWNER, async (bytes) => {
      const out = bytes.slice();
      out.fill(9, 1, 65);
      return out;
    });
    await expect(wrongSlot.signSwap(base64ToBytes(METIS.unsignedBase64), metisExpected())).rejects.toBeInstanceOf(UnsafeTransaction);
  });
});

// ── dollars and the amount row ───────────────────────────────────────────────

const status = (over: Partial<MoneyStatus> = {}): MoneyStatus => ({
  enabled: true,
  reason: null,
  presetsBaseUnits: ["5000000", "10000000", "25000000"],
  minBaseUnits: "1000000",
  maxBaseUnits: "100000000",
  defaultAmountBaseUnits: "5000000",
  pendingTtlMs: 600_000,
  ...over,
});

describe("money on screen is dollars", () => {
  test("amounts drop whole cents; balances keep them; both round down", () => {
    expect([usd("5000000"), usd("9200000"), usd("12190000"), usd("1250000000"), usd("5009999"), usd("0"), usd("garbage")]).toEqual([
      "$5", "$9.20", "$12.19", "$1,250", "$5", "$0", "$0",
    ]);
    expect([balanceUsd("12190000"), balanceUsd("0"), balanceUsd(null), balanceUsd("12199999")]).toEqual(["$12.19", "$0.00", "$0.00", "$12.19"]);
    expect([usdDecimal("5000000"), usdDecimal("5250000")]).toEqual(["5", "5.25"]);
  });

  test("typed dollars become base units, cents at most", () => {
    expect([parseUsd("5"), parseUsd("$5.50"), parseUsd("1,000"), parseUsd("0.01")]).toEqual([5_000_000n, 5_500_000n, 1_000_000_000n, 10_000n]);
    expect([parseUsd("5.001"), parseUsd("-5"), parseUsd("five"), parseUsd("")]).toEqual([null, null, null, null]);
    expect(parseUsd("12.190001", { cents: false })).toBe(12_190_001n);
  });
});

describe("the amount row: Free · $5 · $10 · $25 · +", () => {
  test("the chips are the server's presets", () => {
    expect(presetAmounts(status())).toEqual(["5000000", "10000000", "25000000"]);
    expect(presetAmounts(status({ presetsBaseUnits: [] }))).toEqual(["5000000", "10000000", "25000000"]);
    expect(presetAmounts(null)).toEqual(["5000000", "10000000", "25000000"]);
  });

  test("starts on the last amount used here, else the server's default, else $5", () => {
    expect(defaultAmount(status(), "10000000")).toBe("10000000");
    expect(defaultAmount(status(), null)).toBeNull(); // Free last time: Free again
    expect(defaultAmount(status({ defaultAmountBaseUnits: "25000000" }), undefined)).toBe("25000000");
    expect(defaultAmount(status({ defaultAmountBaseUnits: null }), undefined)).toBe("5000000");
    // A remembered amount the server no longer takes falls back.
    expect(defaultAmount(status({ maxBaseUnits: "20000000" }), "50000000")).toBe("5000000");
  });

  test("the last amount is a per-viewer convenience: per account, and never breaks on storage errors", () => {
    const s = memoryStorage();
    writeLastAmount(s, "u1", "10000000");
    writeLastAmount(s, "u2", null);
    expect(readLastAmount(s, "u1")).toBe("10000000");
    expect(readLastAmount(s, "u2")).toBeNull();
    expect(readLastAmount(s, "u3")).toBeUndefined();
    s.data.set("cb.app.lastAmount.u4", "-5");
    expect(readLastAmount(s, "u4")).toBeUndefined();
    expect(() => writeLastAmount(brokenStorage, "u1", "5000000")).not.toThrow();
    expect(readLastAmount(brokenStorage, "u1")).toBeUndefined();
    expect(readLastAmount(null, "u1")).toBeUndefined();
  });

  test("a custom amount is whole cents within the server's limits", () => {
    expect(customAmount("7.50", status())).toEqual({ ok: true, amount: "7500000" });
    expect(customAmount("0.50", status())).toEqual({ ok: false, problem: "min" });
    expect(customAmount("101", status())).toEqual({ ok: false, problem: "max" });
    expect(customAmount("abc", status())).toEqual({ ok: false, problem: "format" });
    expect(customAmount("1000", status({ maxBaseUnits: null }))).toEqual({ ok: true, amount: "1000000000" });
    expect(amountHint("min", status())).toBe("At least $1");
    expect(amountHint("max", status())).toBe("Up to $100");
  });

  test("the button follows the amount: Call YES, or Call YES · $5; Tail and Fade on someone's call", () => {
    expect(callCta("own", "YES", null)).toBe("Call YES");
    expect(callCta("own", "YES", "5000000")).toBe("Call YES · $5");
    expect(callCta("back", "YES", null)).toBe("Back YES");
    expect(callCta("back", "YES", "10000000")).toBe("Tail YES · $10");
    expect(callCta("fade", "NO", "5000000")).toBe("Fade NO · $5");
    expect(callCta("fade", "NO", null)).toBe("Fade NO");
  });

  test("whether the balance covers the amount (unknown balance: ask the server)", () => {
    const w = (usdc: string | null): MoneyWallet => ({ wallet: { address: OWNER, walletType: "chumbucket" }, balance: usdc === null ? null : { usdcBaseUnits: usdc, lamports: "0", slot: 1 }, gas: { needsTopUp: false, topUp: null } });
    expect(covers(w("5000000"), "5000000")).toBe(true);
    expect(covers(w("4999999"), "5000000")).toBe(false);
    expect(covers(w(null), "5000000")).toBeNull();
  });
});

// ── where a call with money stands ───────────────────────────────────────────

const moneyCall = (over: Partial<MoneyCallView> = {}): MoneyCallView => ({
  callId: "30000000-0000-4000-8000-000000000001",
  kind: "own",
  targetCallId: null,
  marketId: "m1",
  side: "YES",
  amountBaseUnits: "5000000",
  wallet: owner.publicKey.toBase58(),
  state: "PENDING",
  trade: "QUOTED",
  orderId: "ord_1",
  filledBaseUnits: null,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 600_001,
  canRetry: true,
  canKeepFree: true,
  canDiscard: true,
  ...over,
});

function entry(over: Partial<CallFeedEntry> & { side?: "YES" | "NO" } = {}): CallFeedEntry {
  return {
    call: { id: "30000000-0000-4000-8000-000000000001", userId: "u1", marketId: "m1", side: over.side ?? "YES", confidence: null, thesis: null, entryProbability: null, visibility: "public", createdAt: 1, lockedAt: 1, parentCallId: null, fundingState: "NONE" },
    author: { id: "u1", handle: "ada", displayName: "Ada", avatarUrl: null, settledCalls: 0, correctCalls: 0 },
    market: { id: "m1", venue: "panta", venueMarketId: claimMarket.toBase58(), question: "Will it?", rulesText: "", category: "crypto", outcomes: [{ side: "YES", label: "Yes" }, { side: "NO", label: "No" }], status: "OPEN", opensAt: null, closesAt: null, resolvesAt: null, resolutionSource: null },
    result: null,
    backCount: 0,
    fadeCount: 0,
    viewerHasCalled: true,
    ...over,
  };
}

describe("a call with money: never funded before the BFF says so", () => {
  test("FUNDED only from the BFF; an order going through is pending; a failure or a lapsed quote is stuck", () => {
    expect(progressOf(moneyCall({ state: "FUNDED", trade: "FILLED" }))).toBe("funded");
    expect(progressOf(moneyCall({ trade: "FILLED" }))).toBe("pending");
    expect(progressOf(moneyCall({ trade: "SUBMITTED" }))).toBe("pending");
    expect(progressOf(moneyCall({ trade: "FAILED" }))).toBe("stuck");
    expect(progressOf(moneyCall({ trade: "QUOTED" }))).toBe("stuck");
    expect(progressOf(moneyCall({ trade: "NONE" }))).toBe("stuck");
    expect(progressOf(moneyCall({ state: "FREE" }))).toBe("free");
    expect(progressOf(moneyCall({ state: "EXPIRED" }))).toBe("expired");
  });

  test("receipts say $5 on YES only for a FILLED call with its amount; a pending one is the owner's grey mark", () => {
    const name = (s: "YES" | "NO") => s;
    expect(fundedStamp(entry({ funding: { state: "FILLED", venue: "panta", fundedAt: 1, amountBaseUnits: "5000000", side: "YES" } }), name)).toBe("$5 on YES");
    expect(fundedStamp(entry({ funding: { venue: "panta" } }), name)).toBeNull();
    expect(fundedStamp(entry({ funding: null }), name)).toBeNull();
    expect(fundedStamp(entry({ funding: { venue: "panta", amountBaseUnits: "5000000", side: "YES" }, money: { state: "PENDING", amountBaseUnits: "5000000", side: "YES", expiresAt: 1 } }), name)).toBeNull();
    expect(pendingMark(entry({ money: { state: "PENDING", amountBaseUnits: "5000000", side: "YES", expiresAt: 1 } }))).toEqual({ amount: "$5", state: "pending" });
    expect(pendingMark(entry({ money: { state: "EXPIRED", amountBaseUnits: "5000000", side: "YES", expiresAt: 1 } }))).toEqual({ amount: "$5", state: "expired" });
    // Kept free: the old call was replaced by a fresh free call; its owner sees it never went through.
    expect(pendingMark(entry({ money: { state: "FREE", amountBaseUnits: "5000000", side: "YES", expiresAt: 1 } }))).toEqual({ amount: "$5", state: "replaced" });
    expect(pendingMark(entry())).toBeNull();
  });

  test("the public receipt and its link card say $5 on YES for a fill with its amount, else Funded", () => {
    const outcomes = [{ side: "YES" as const, label: "Yes" }, { side: "NO" as const, label: "No" }];
    expect(fundedLabel({ funding: { state: "FILLED", venue: "panta", amountBaseUnits: "5000000", side: "YES" }, market: { outcomes } })).toBe("$5 on YES");
    expect(fundedLabel({ funding: { venue: "panta", amountBaseUnits: "9205000", side: "NO" }, market: { outcomes: [{ side: "NO", label: "Celtics" }] } })).toBe("$9.20 on Celtics");
    expect(fundedLabel({ funding: { state: "FILLED", venue: "panta" } })).toBeNull();
    expect(fundedLabel({ funding: { state: "SUBMITTED", venue: "panta", amountBaseUnits: "5000000", side: "YES" } })).toBeNull();
    expect(fundedLabel({ funding: null })).toBeNull();
    const receipt = readFileSync(join(WEB, "components/public/CallReceipt.tsx"), "utf8");
    expect(receipt).toContain("<FundedMark label={stamp} />");
    expect(readFileSync(join(WEB, "app/c/[challengeId]/opengraph-image.tsx"), "utf8")).toContain("markLabel: fundedLabel(entry)");
  });
});

// ── the flows, with the BFF and the wallet as test doubles ───────────────────

const CALL_ID = "30000000-0000-4000-8000-000000000001";
const BUY_DISC = createHash("sha256").update("global:primary_order_usdc").digest().subarray(0, 8);
function pantaBuy(amount = 5_000_000n, side: "YES" | "NO" = "YES"): Uint8Array {
  const who = owner.publicKey;
  const ata = ataOf(who);
  const data = Buffer.alloc(17);
  BUY_DISC.copy(data, 0);
  data[8] = side === "YES" ? 0 : 1;
  data.writeBigUInt64LE(amount, 9);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    new TransactionInstruction({ programId: new PublicKey(PANTA_PROGRAM), data, keys: [meta(who, true, true), meta(claimMarket, true), meta(pda(5)), meta(pda(6)), meta(pda(7), true), meta(pda(8), true), meta(USDC), meta(ata, true), meta(pda(10), true), meta(TOKEN), meta(ATA), meta(SystemProgram.programId)] }),
    new TransactionInstruction({ programId: MEMO, data: Buffer.from("panta:v1:usr_x:qt_1:ord_1"), keys: [meta(who, false, true)] }),
  ];
  return new VersionedTransaction(new TransactionMessage({ payerKey: who, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()).serialize();
}
function ready(over: { amount?: string; side?: "YES" | "NO"; payload?: Uint8Array; expiresAt?: number; mc?: Partial<MoneyCallView> } = {}): PrepareCallResult {
  const amount = over.amount ?? "5000000";
  return {
    status: "READY",
    moneyCall: moneyCall({ amountBaseUnits: amount, side: over.side ?? "YES", ...over.mc }),
    call: entry({ side: over.side ?? "YES" }),
    trade: {
      order: {
        orderId: "ord_1",
        owner: owner.publicKey.toBase58(),
        side: over.side ?? "YES",
        amountBaseUnits: amount,
        fundingState: "QUOTED",
        transaction: { encoding: "solana-tx-base64", payload: bytesToBase64(over.payload ?? pantaBuy(BigInt(amount), over.side ?? "YES")), expiresAt: over.expiresAt ?? 60_000 },
        expiresAt: over.expiresAt ?? 60_000,
      },
      review: { amountUsdc: "5.000000", amountBaseUnits: amount, avgPrice: "0.5", feeUsdc: "0.01", expectedShares: "9.2" },
    },
  };
}

function rig(answers: PrepareCallResult[], topUps: TopUpOrder[] = []) {
  const asked: number[] = [];
  const raw: Array<{ slot: number | undefined }> = [];
  const executed: string[] = [];
  const submitted: string[] = [];
  const api: MoneyFlowApi = {
    async submitTrade(orderId, signed) {
      submitted.push(signed);
      return { orderId, owner: owner.publicKey.toBase58(), side: "YES", amountBaseUnits: "5000000", fundingState: "SUBMITTED", fillTxSignature: null, updatedAt: 1 } satisfies TradeOrder;
    },
    async topUpOrder() {
      return topUps.shift() ?? { status: "REFUSED", reason: "NOT_GASLESS", message: "Jupiter can't cover the network fee for this swap right now." };
    },
    async topUpExecute(requestId) {
      executed.push(requestId);
      return { status: "SUCCESS", signature: "sig" };
    },
    async transferSubmit(transferId) {
      submitted.push(transferId);
      return { transferId, kind: "cash_out", from: owner.publicKey.toBase58(), to: friend.publicKey.toBase58(), amountBaseUnits: "5000000", state: "SUBMITTED", signature: "s", createdAt: 1, updatedAt: 1, expiresAt: 60_000 };
    },
    async claimPrepare() {
      throw new Error("unused");
    },
    async claimSubmit() {
      throw new Error("unused");
    },
  };
  const signer = checkedSigner(owner.publicKey.toBase58(), async (bytes, slot) => {
    raw.push({ slot });
    return sign(bytes);
  });
  const ask = async () => {
    asked.push(asked.length);
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next;
  };
  return { api, ask, asked, raw, executed, submitted, deps: { api, signerFor: async () => signer, now: () => 1_000 } };
}
const intent = { amountBaseUnits: "5000000", side: "YES" as const, marketId: "m1" };
const wallet = { address: owner.publicKey.toBase58(), walletType: "chumbucket" };

describe("a call with an amount, step by step", () => {
  test("READY: a checked buy is reviewed in dollars; confirming signs those bytes and submits (SUBMITTED, never funded)", async () => {
    const h = rig([ready()]);
    const step = await advanceCall(h.ask, intent, h.deps);
    expect(step.step).toBe("review");
    if (step.step !== "review") return;
    expect([step.reviewed.pay, step.reviewed.win, step.reviewed.fee]).toEqual(["$5.00", "~$9.20", "$0.01"]);
    expect(h.raw).toHaveLength(0);
    const order = await confirmCall(h.api, step.reviewed, () => 1_000);
    expect(order.fundingState).toBe("SUBMITTED");
    expect(h.raw).toHaveLength(1);
    expect(h.submitted).toHaveLength(1);
  });

  test("NEEDS_FUNDS stops at the deposit sheet with the shortfall; nothing signed", async () => {
    const h = rig([{ status: "NEEDS_FUNDS", wallet, balanceBaseUnits: "1500000", neededBaseUnits: "5000000", shortfallBaseUnits: "3500000" }]);
    expect(await advanceCall(h.ask, intent, h.deps)).toEqual({ step: "funds", wallet, neededBaseUnits: "5000000", shortfallBaseUnits: "3500000" });
    expect(h.raw).toHaveLength(0);
  });

  test("NEEDS_GAS: a checked gasless top-up runs silently, then the same ask again", async () => {
    const swapOwner = checkedSigner(OWNER, async (bytes, slot) => {
      const out = bytes.slice();
      out.fill(9, 1 + 64 * (slot ?? 0), 65 + 64 * (slot ?? 0));
      return out;
    });
    const h = rig(
      [{ status: "NEEDS_GAS", wallet: { address: OWNER, walletType: "chumbucket" }, topUp: { amountBaseUnits: METIS.inAmount.toString() } }, { status: "NEEDS_FUNDS", wallet, balanceBaseUnits: "0", neededBaseUnits: "5000000", shortfallBaseUnits: "5000000" }],
      [{ status: "READY", requestId: "req_1", transaction: METIS.unsignedBase64, expiresAt: "", review: { wallet: OWNER, usdcInBaseUnits: METIS.inAmount.toString(), solOutLamports: METIS.outAmount.toString(), solOutMinLamports: "1", feeBps: METIS.feeBps, router: "metis", feePayer: METIS.feePayer } }],
    );
    const step = await advanceCall(h.ask, intent, { ...h.deps, signerFor: async () => swapOwner, now: () => METIS.blockTime * 1000 });
    expect(step.step).toBe("funds");
    expect(h.executed).toEqual(["req_1"]);
    expect(h.asked).toHaveLength(2);
  });

  test("NEEDS_GAS with no top-up on this server, or a refused swap, stops with one plain line; never asks for SOL", async () => {
    const none = rig([{ status: "NEEDS_GAS", wallet, topUp: null }]);
    const e1 = await advanceCall(none.ask, intent, none.deps).catch((e) => e);
    expect(e1).toBeInstanceOf(MoneyStop);
    expect(stopLine(e1, "x")).not.toMatch(/\bSOL\b/);
    const refused = rig([{ status: "NEEDS_GAS", wallet, topUp: { amountBaseUnits: "1000000" } }]);
    expect(await advanceCall(refused.ask, intent, refused.deps).catch((e) => e)).toBeInstanceOf(MoneyStop);
    // No USDC to swap: the deposit sheet, for the call and the top-up together.
    const broke = rig([{ status: "NEEDS_GAS", wallet, topUp: { amountBaseUnits: "1000000" } }], [{ status: "REFUSED", reason: "NEEDS_USDC", message: "Add USDC first." }]);
    expect(await advanceCall(broke.ask, intent, broke.deps)).toEqual({ step: "funds", wallet, neededBaseUnits: "6000000", shortfallBaseUnits: null });
  });

  test("a swap that doesn't check out never reaches a wallet or Jupiter", async () => {
    const h = rig(
      [{ status: "NEEDS_GAS", wallet: { address: OWNER, walletType: "chumbucket" }, topUp: { amountBaseUnits: "1" } }],
      [{ status: "READY", requestId: "req_1", transaction: METIS.unsignedBase64, expiresAt: "", review: { wallet: OWNER, usdcInBaseUnits: "1", solOutLamports: METIS.outAmount.toString(), solOutMinLamports: "1", feeBps: METIS.feeBps, router: "metis", feePayer: METIS.feePayer } }],
    );
    const seen: number[] = [];
    const swapOwner = checkedSigner(OWNER, async (b) => { seen.push(1); return b; });
    const e = await advanceCall(h.ask, intent, { ...h.deps, signerFor: async () => swapOwner, now: () => METIS.blockTime * 1000 }).catch((x) => x);
    expect(e).toBeInstanceOf(MoneyStop);
    expect(seen).toHaveLength(0);
    expect(h.executed).toHaveLength(0);
  });

  test("an answer for another amount, side or market, or a buy that isn't the reviewed one, never reaches a wallet", async () => {
    for (const answer of [ready({ amount: "10000000" }), ready({ side: "NO" }), ready({ mc: { marketId: "m2" } }), ready({ payload: pantaBuy(50_000_000n) })]) {
      const h = rig([answer]);
      const e = await advanceCall(h.ask, intent, h.deps).catch((x) => x);
      expect(e).toBeInstanceOf(TradeError);
      expect(h.raw).toHaveLength(0);
    }
  });

  test("a lapsed quote says expired (the sheet asks again with the same key); a declined signature says so", async () => {
    const h = rig([ready({ expiresAt: 500 })]);
    expect(await advanceCall(h.ask, intent, h.deps).catch((e) => (e as TradeError).kind)).toBe("expired");
    const d = rig([ready()]);
    const step = await advanceCall(d.ask, intent, { ...d.deps, signerFor: async () => checkedSigner(owner.publicKey.toBase58(), async () => { throw new Error("rejected"); }) });
    if (step.step !== "review") throw new Error("expected review");
    expect(await confirmCall(d.api, step.reviewed, () => 1_000).catch((e) => stopLine(e, "x"))).toBe("Not signed. Nothing was spent.");
    expect(d.submitted).toHaveLength(0);
  });
});

describe("a cash out, step by step", () => {
  const ask = (over: Partial<Extract<TransferPrepareResult, { status: "READY" }>["review"]> = {}, payload = transferTx()): TransferPrepareResult => ({
    status: "READY",
    transfer: { transferId: "40000000-0000-4000-8000-000000000001", kind: "cash_out", from: owner.publicKey.toBase58(), to: friend.publicKey.toBase58(), amountBaseUnits: "5000000", state: "BUILT", signature: null, createdAt: 1, updatedAt: 1, expiresAt: 60_000 },
    transaction: { encoding: "solana-tx-base64", payload: bytesToBase64(payload), expiresAt: 60_000 },
    review: { from: owner.publicKey.toBase58(), to: friend.publicKey.toBase58(), amountBaseUnits: "5000000", createsAccount: false, networkFeeLamports: "5000", rentLamports: "0", ...over },
  });
  const want = { from: owner.publicKey.toBase58(), to: friend.publicKey.toBase58(), amountBaseUnits: "5000000" };

  test("READY is reviewed, then signed through the transfer check and submitted (SUBMITTED, never done)", async () => {
    const h = rig([]);
    const step = await prepareTransfer(async () => ask(), want, h.deps);
    if (step.step !== "review") throw new Error("expected review");
    const view = await sendTransfer(h.api, await h.deps.signerFor(), step.ready, () => 1_000);
    expect(view.state).toBe("SUBMITTED");
    expect(h.raw).toEqual([{ slot: 0 }]);
  });

  test("INVALID comes back as the server's line; another destination or amount than asked is refused before signing", async () => {
    const h = rig([]);
    expect(await prepareTransfer(async () => ({ status: "INVALID", reason: "TOKEN_ACCOUNT", message: "That’s a USDC account, not a wallet." }), want, h.deps)).toEqual({
      step: "invalid",
      reason: "TOKEN_ACCOUNT",
      message: "That’s a USDC account, not a wallet.",
    });
    await expect(prepareTransfer(async () => ask({ to: thief.publicKey.toBase58() }), want, h.deps)).rejects.toBeInstanceOf(TradeError);
    await expect(prepareTransfer(async () => ask({ amountBaseUnits: "6000000" }), want, h.deps)).rejects.toBeInstanceOf(TradeError);
    // The review matches, the bytes don't: the signer's check refuses.
    const step = await prepareTransfer(async () => ask({}, transferTx({ to: thief.publicKey })), want, h.deps);
    if (step.step !== "review") throw new Error("expected review");
    await expect(sendTransfer(h.api, await h.deps.signerFor(), step.ready, () => 1_000)).rejects.toMatchObject({ kind: "unsafe" });
    expect(h.raw).toHaveLength(0);
    expect(h.submitted).toHaveLength(0);
  });
});

describe("a lapsed transfer review", () => {
  test("says the review timed out and nothing was sent, not that a price moved", () => {
    expect(stopLine(new TradeError("expired"), "x", "transfer")).toBe("That took too long. Nothing was sent. Start again.");
    expect(stopLine(new TradeError("declined"), "x", "transfer")).toBe("Not signed. Nothing was sent.");
    expect(stopLine(new TradeError("expired"), "x")).toBe("The price moved. Try again.");
  });

  test("a READY review spends its key: the next review asks with a new one", () => {
    for (const f of ["components/webapp/money/WalletSheet.tsx", "components/webapp/money/DepositSheet.tsx"]) {
      const code = readFileSync(join(WEB, f), "utf8");
      expect({ f, spent: /A review lives 60 s and its key is spent[\s\S]{0,120}intent\.current = null;/.test(code) }).toEqual({ f, spent: true });
      expect({ f, refusal: code.includes("if (e instanceof BffRejected) intent.current = null;") }).toEqual({ f, refusal: true });
    }
  });
});

describe("collecting a win", () => {
  const item = { orderId: "ord_1", wallet: owner.publicKey.toBase58(), side: "YES" as const };
  const claimView = { claimId: "50000000-0000-4000-8000-000000000001", orderId: "ord_1", venueMarketId: claimMarket.toBase58(), owner: owner.publicKey.toBase58(), state: "BUILT" as const, signature: null, payoutBaseUnits: null, createdAt: 1, updatedAt: 1, expiresAt: 60_000 };
  const deps = (payload: Uint8Array | null, over: Record<string, unknown> = {}) => {
    const submitted: string[] = [];
    const seen: number[] = [];
    return {
      submitted,
      seen,
      deps: {
        api: {
          claimPrepare: async () => ({
            claim: { ...claimView, ...over },
            transaction: payload ? { encoding: "solana-tx-base64" as const, payload: bytesToBase64(payload), expiresAt: 60_000 } : null,
            review: payload ? { outcome: "YES" as const, winningShares: "9.2", estimatedPayoutUsdc: "9.2" } : null,
          }),
          claimSubmit: async (claimId: string) => {
            submitted.push(claimId);
            return { ...claimView, state: "SUBMITTED" as const };
          },
        },
        signerFor: async () => checkedSigner(owner.publicKey.toBase58(), async (b) => { seen.push(1); return sign(b); }),
        now: () => 1_000,
      },
    };
  };

  test("the claim is checked, signed by its own wallet, and submitted", async () => {
    const h = deps(claimTx());
    expect((await collectWin(h.deps, item, "collect-key-0001")).state).toBe("SUBMITTED");
    expect(h.seen).toHaveLength(1);
  });

  test("a claim that pays elsewhere never reaches the wallet; one already going answers itself", async () => {
    const bad = deps(claimTx({ payTo: ataOf(thief.publicKey) }));
    await expect(collectWin(bad.deps, item, "collect-key-0001")).rejects.toMatchObject({ kind: "unsafe" });
    expect(bad.seen).toHaveLength(0);
    const going = deps(null, { state: "SUBMITTED" });
    expect((await collectWin(going.deps, item, "collect-key-0001")).state).toBe("SUBMITTED");
    const other = deps(claimTx(), { owner: thief.publicKey.toBase58() });
    await expect(collectWin(other.deps, item, "collect-key-0001")).rejects.toBeInstanceOf(TradeError);
  });
});

describe("top-ups on their own", () => {
  test("ENOUGH_SOL is done; NEEDS_USDC is funds; another wallet's review is refused", async () => {
    const api = (o: TopUpOrder) => ({ topUpOrder: async () => o, topUpExecute: async () => ({ status: "SUCCESS" as const, signature: "s" }) });
    const signerFor = async () => checkedSigner(OWNER, async (b) => b);
    expect(await topUp({ api: api({ status: "REFUSED", reason: "ENOUGH_SOL", message: "" }), signerFor }, OWNER, "1")).toBe("done");
    expect(await topUp({ api: api({ status: "REFUSED", reason: "NEEDS_USDC", message: "" }), signerFor }, OWNER, "1")).toBe("funds");
    const other = api({ status: "READY", requestId: "r", transaction: METIS.unsignedBase64, expiresAt: "", review: { wallet: thief.publicKey.toBase58(), usdcInBaseUnits: "1", solOutLamports: "1", solOutMinLamports: "1", feeBps: 1, router: "metis", feePayer: "x" } });
    await expect(topUp({ api: other, signerFor }, OWNER, "1")).rejects.toBeInstanceOf(MoneyStop);
  });
});

// ── the deposit and wallet sheets' states ────────────────────────────────────

const options = (over: Partial<DepositOptions> = {}): DepositOptions => ({
  tradingWallet: wallet,
  sendUsdc: { address: owner.publicKey.toBase58(), mint: USDC.toBase58(), network: "solana-mainnet", uri: `solana:${owner.publicKey.toBase58()}?spl-token=${USDC.toBase58()}&amount=3.5` },
  card: { available: false, testMode: false, reason: "Not live yet", presetsUsd: [], limits: null },
  fromWallet: { wallets: [{ address: friend.publicKey.toBase58(), walletType: "phantom" }] },
  ...over,
});
const walletWith = (usdc: string | null, address = owner.publicKey.toBase58()): MoneyWallet => ({
  wallet: { address, walletType: "chumbucket" },
  balance: usdc === null ? null : { usdcBaseUnits: usdc, lamports: "1000000", slot: 1 },
  gas: { needsTopUp: false, topUp: null },
});

describe("the deposit sheet", () => {
  test("icon-led choices: your wallet (when this browser can sign), Send USDC, and the card only when offered", () => {
    expect(depositTiles(options(), true).map((t) => t.id)).toEqual(["wallet", "send"]);
    expect(depositTiles(options(), false).map((t) => t.id)).toEqual(["send"]);
    expect(depositTiles(options({ fromWallet: { wallets: [] } }), true).map((t) => t.id)).toEqual(["send"]);
    const card = depositTiles(options({ card: { available: true, testMode: false, reason: null, presetsUsd: ["10", "25"], limits: { minUsd: "5", maxUsd: "500" } } }), false);
    expect(card.map((t) => t.id)).toEqual(["send", "card"]);
    expect(card[1]).toEqual({ id: "card", test: false, presetsUsd: ["10", "25"] });
    expect(depositTiles(null, true)).toEqual([]);
    expect(depositTiles(options({ sendUsdc: { address: "not-an-address", mint: "", network: "solana-mainnet", uri: "" } }), false)).toEqual([]);
  });

  test("test money is always marked test", () => {
    const tiles = depositTiles(options({ card: { available: true, testMode: true, reason: null, presetsUsd: ["10"], limits: null } }), false);
    expect(tiles.find((t) => t.id === "card")).toMatchObject({ test: true });
    const sheet = readFileSync(join(WEB, "components/webapp/money/DepositSheet.tsx"), "utf8");
    expect(sheet).toMatch(/tile\.test \?[\s\S]{0,80}Test/);
  });

  test("watching the balance: a waiting call continues once it covers what it needs; otherwise any new USDC", () => {
    expect(fundsLanded(walletWith("4999999"), "5000000")).toBe(false);
    expect(fundsLanded(walletWith("5000000"), "5000000")).toBe(true);
    expect(fundsLanded(walletWith(null), "5000000")).toBe(false);
    expect(balanceRose("1000000", walletWith("1000001"))).toBe(true);
    expect(balanceRose("1000000", walletWith("1000000"))).toBe(false);
    expect(balanceRose(null, walletWith("1000000"))).toBe(false);
  });
});

describe("the wallet sheet", () => {
  test("cash out: an address that isn't this wallet, an amount within the balance, or Max to the last base unit", () => {
    const w = walletWith("12190001");
    const to = friend.publicKey.toBase58();
    expect(cashOutForm({ address: to, amount: "5", max: false }, w)).toEqual({ ok: true, destination: to, amountBaseUnits: "5000000" });
    expect(cashOutForm({ address: ` ${to} `, amount: "", max: true }, w)).toEqual({ ok: true, destination: to, amountBaseUnits: "12190001" });
    expect(cashOutForm({ address: "", amount: "5", max: false }, w)).toMatchObject({ ok: false, field: "address", line: null });
    expect(cashOutForm({ address: "0xabc", amount: "5", max: false }, w)).toMatchObject({ ok: false, field: "address" });
    expect(cashOutForm({ address: owner.publicKey.toBase58(), amount: "5", max: false }, w)).toMatchObject({ ok: false, field: "address" });
    expect(cashOutForm({ address: to, amount: "13", max: false }, w)).toEqual({ ok: false, field: "amount", line: "You have $12.19" });
    expect(cashOutForm({ address: to, amount: "5.001", max: false }, w)).toMatchObject({ ok: false, field: "amount" });
    expect(cashOutForm({ address: to, amount: "", max: true }, walletWith("0"))).toMatchObject({ ok: false, field: "amount" });
  });

  test("activity rows: an icon per kind, a sign, and the call's question when there is one", () => {
    const item = (over: Partial<ActivityItem>): ActivityItem => ({ id: "a", kind: "trade", direction: "out", amountBaseUnits: "5000000", state: "done", at: 1, signature: null, callId: null, marketId: null, side: null, question: null, counterparty: null, ...over });
    expect(activityRow(item({ question: "Will it?" }))).toEqual({ icon: "chart-pie", amount: "−$5", tone: "out", title: "Will it?" });
    expect(activityRow(item({ kind: "claim", direction: "in", amountBaseUnits: "9200000" }))).toEqual({ icon: "award", amount: "+$9.20", tone: "in", title: "Collected" });
    expect(activityRow(item({ kind: "deposit", direction: "in" }))).toMatchObject({ icon: "arrow-down", title: "Added" });
    expect(activityRow(item({ kind: "cash_out" }))).toMatchObject({ icon: "arrow-up", title: "Cashed out" });
    expect(activityRow(item({ state: "pending" }))).toMatchObject({ icon: "sand-watch" });
    expect(activityRow(item({ state: "failed" }))).toMatchObject({ icon: "cancel", tone: "muted" });
  });

  test("winnings: only COLLECTABLE items are collected", () => {
    const w = { totalBaseUnits: "9200000", items: [
      { orderId: "o1", callId: "c1", marketId: "m1", question: null, side: "YES" as const, wallet: OWNER, amountBaseUnits: "9200000", costBaseUnits: "5000000", state: "COLLECTABLE" as const, claimId: null },
      { orderId: "o2", callId: "c2", marketId: "m2", question: null, side: "NO" as const, wallet: OWNER, amountBaseUnits: "1000000", costBaseUnits: "500000", state: "COLLECTING" as const, claimId: "x" },
    ] };
    expect(collectable(w).map((i) => i.orderId)).toEqual(["o1"]);
    expect(collectable(null)).toEqual([]);
  });
});

// ── the rules the money screens keep ─────────────────────────────────────────

function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(tsx?|css)$/.test(name) && name !== "Icon.tsx") out.push({ file: path, text: readCode(path) });
  }
  return out;
}

describe("web app money rules", () => {
  const MONEY = join(WEB, "components/webapp/money");

  test("the money screens exist", () => {
    for (const f of ["MoneyProvider.tsx", "AmountRow.tsx", "CallButton.tsx", "MoneyCallSheet.tsx", "DepositSheet.tsx", "WalletSheet.tsx", "BalancePill.tsx", "Winnings.tsx", "PendingCalls.tsx", "signers.ts"]) {
      expect({ f, exists: existsSync(join(MONEY, f)) }).toEqual({ f, exists: true });
    }
  });

  test("hidden unless the server's money.status says enabled", () => {
    expect(readCode(join(MONEY, "moneyContext.ts"))).toContain("api.moneyStatus()");
    const provider = readCode(join(MONEY, "MoneyProvider.tsx"));
    expect(provider).toContain("useMoneyStatus()");
    expect(provider).toMatch(/const enabled = moneyOn\(status\.data\);/);
    // Off: none of the sheets is even mounted.
    expect(provider).toMatch(/\{enabled \? \(/);
    for (const f of ["AmountRow.tsx", "BalancePill.tsx", "Winnings.tsx", "PendingCalls.tsx"]) {
      expect({ f, gated: /if \(!money\.enabled[^)]*\) return null;/.test(readCode(join(MONEY, f))) }).toEqual({ f, gated: true });
    }
  });

  test("pink is money: Free is the ink button with the Free mark; an amount is the pink button with its dollars", () => {
    const button = readCode(join(MONEY, "CallButton.tsx"));
    expect(button).toMatch(/amount \? "wa-btn wa-btn--primary" : "wa-btn wa-btn--ink"/);
    expect(button).toMatch(/<span className="wa-btn-label">\{text\}<\/span>\s*\{amount \? null : <FreeChip \/>\}/);
    for (const screen of ["screens/MarketScreen.tsx", "ResponseSheet.tsx"]) {
      const code = readCode(join(WEB, "components/webapp", screen));
      expect({ screen, row: code.includes("<AmountRow"), button: code.includes("<CallButton") }).toEqual({ screen, row: true, button: true });
    }
  });

  test("every money signature goes through a checked signer; none is written by hand", () => {
    const signers = readCode(join(MONEY, "signers.ts"));
    expect(signers).toContain("checkedSigner(");
    expect(signers).not.toMatch(/async sign\(|sign: \(|signTransfer: |signClaim: |signSwap: /);
    const trade = readCode(join(WEB, "lib/webapp/trade.ts"));
    const at = (s: string) => trade.indexOf(s);
    expect(at("await checkUsdcTransfer(copy, transfer)")).toBeGreaterThan(0);
    expect(at("await checkUsdcTransfer(copy, transfer)")).toBeLessThan(at("const signed = await signRaw(copy, 0);\n      if (!signedOnlyInSlot(copy, signed, 0)) throw new UnsafeTransaction(\"signed something else\");\n      return signed;\n    },\n    async signClaim"));
    expect(at("await checkPantaClaim(copy, claim)")).toBeLessThan(at("async signSwap"));
    expect(at("const checked = await checkGaslessSwap(copy, swap)")).toBeLessThan(at("await signRaw(copy, checked.ownerSignatureIndex)"));
    for (const { file, text } of sources(MONEY)) {
      expect({ file, match: text.match(/signAndSendTransaction|sendTransaction|sendRawTransaction/)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });

  test("never funded early: the pending state is said as pending, and only the BFF's FUNDED shows the stamp", () => {
    const sheet = readCode(join(MONEY, "MoneyCallSheet.tsx"));
    expect(sheet).toContain("progressOf(");
    expect(sheet).not.toMatch(/fundingState === "SUBMITTED"[^\n]*funded/i);
    const ui = readCode(join(WEB, "components/webapp/ui.tsx"));
    expect(ui).toContain("fundedStamp(");
    expect(ui).toContain("pendingMark(");
  });

  test("the review shows dollars only: pay, get if right, fee; never a per-share price", () => {
    for (const { file, text } of sources(MONEY)) {
      expect({ file, match: text.match(/avgPrice|per share|¢/)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });

  test("no refresh buttons, no 'updated X ago', no Retry: the sheets are stateful", () => {
    for (const { file, text } of sources(MONEY)) {
      for (const p of [/["'>]\s*Refresh\b/, /\bRetry\b/, /updated \S+ ago/i, /Last (updated|refreshed)/i]) {
        expect({ file, match: text.match(p)?.[0] ?? null }).toEqual({ file, match: null });
      }
    }
  });

  test("the last amount is kept with try/catch in the browser only", () => {
    const money = readCode(join(WEB, "lib/webapp/money.ts"));
    expect(money).toMatch(/export function readLastAmount[\s\S]*?try \{[\s\S]*?\} catch \{/);
    expect(money).toMatch(/export function writeLastAmount[\s\S]*?try \{[\s\S]*?\} catch \{/);
  });
});

describe("rollout: the server's answer for this account decides, never a build flag alone", () => {
  // What a non-admin gets while MONEY_CALLS_ENABLED, CHUMBUCKET_WALLET_ENABLED,
  // ACCOUNT_LINKING_ENABLED and ACCOUNT_FOLD_ENABLED are "admins".
  const nonAdmin = {
    money: { enabled: false, reason: "Calls with money aren't available yet.", presetsBaseUnits: ["5000000"], minBaseUnits: "1000000", maxBaseUnits: null, defaultAmountBaseUnits: null, pendingTtlMs: 600000 },
    wallet: { enabled: false, account: { tradingWallet: null, chumbucketWallet: null } },
    signIns: { methods: [{ id: "s1", kind: "x", label: "dev", current: true, unlink: null, alsoUnlinks: [] }], linking: false, fold: false },
  };

  test("a non-admin status hides everything: money, the Chumbucket wallet (even when the bundle ships it), linking", () => {
    expect(moneyOn(nonAdmin.money)).toBe(false);
    expect(chumbucketWalletOn(true, nonAdmin.wallet)).toBe(false);
    expect(linkingOn(nonAdmin.signIns)).toBe(false);
    // No answer yet, or a failed one, is off too.
    for (const unknown of [null, undefined, {}, { enabled: "true" }]) {
      expect(moneyOn(unknown)).toBe(false);
      expect(chumbucketWalletOn(true, unknown)).toBe(false);
    }
    expect(linkingOn(null)).toBe(false);
    // On only with both: the bundle ships it and the server says so for this account.
    expect(moneyOn({ ...nonAdmin.money, enabled: true })).toBe(true);
    expect(chumbucketWalletOn(true, { enabled: true })).toBe(true);
    expect(chumbucketWalletOn(false, { enabled: true })).toBe(false);
    expect(linkingOn({ ...nonAdmin.signIns, linking: true })).toBe(true);
  });

  test("every surface reads those gates: no money UI, no Privy load, no linking UI when off", () => {
    const provider = readCode(join(WEB, "components/webapp/money/MoneyProvider.tsx"));
    expect(provider).toMatch(/const enabled = moneyOn\(status\.data\);/);
    expect(provider).toMatch(/\{enabled \? \(/);
    const root = readCode(join(WEB, "components/webapp/chumbucketWallet.tsx"));
    expect(root).toContain("setOn(chumbucketWalletOn(CHUMBUCKET_WALLET_ENABLED, s));");
    expect(root).toMatch(/\(\) => \(on \? \{ enabled: true, address, busy, error, ensure \} : OFF\)/);
    expect(root).toMatch(/if \(!onRef\.current\) throw new Error\("off"\);/);
    expect(root).toContain("{hosted && on ? <PrivyBridgeHost");
    // A new account starts off again.
    expect(root).toMatch(/setAddress\(null\);\s*setOn\(false\);/);
    const signIns = readCode(join(WEB, "components/webapp/SignInMethods.tsx"));
    expect(signIns).toMatch(/if \(!linkingOn\(data\)\) return null;/);
    // Nothing reads the build flag to decide on its own.
    for (const { file, text } of [...sources(join(WEB, "components/webapp")), ...sources(join(WEB, "lib/webapp"))]) {
      if (file.endsWith("chumbucketWallet.tsx")) continue;
      expect({ file, match: text.match(/NEXT_PUBLIC_CHUMBUCKET_WALLET_ENABLED|CHUMBUCKET_WALLET_ENABLED|MONEY_CALLS_ENABLED/)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });
});

describe("keep free makes a new free call", () => {
  test("the sheet moves to the new call and the market shows it as yours; a fill after all reads funded", () => {
    const sheet = readCode(join(WEB, "components/webapp/money/MoneyCallSheet.tsx"));
    expect(sheet).toContain("if (kept.call.call.id !== moneyCall.callId) replaced(moneyCall.callId, kept.call);");
    expect(sheet).toContain('finish(kept.moneyCall.state === "FUNDED" ? "funded" : "free", kept.call);');
    expect(sheet).toMatch(/if \(pathname === appPath\.call\(oldId\)\) router\.replace\(appPath\.call\(entry\.call\.id\)\);/);
    // A refusal (market closed, price unreadable) leaves the pending call as it was, with the server's line.
    expect(sheet).toMatch(/catch \(e\) \{\s*if \(alive\.current\) setView\(\{ v: "stuck", moneyCall, line: lineOf\(e\), busy: null \}\);/);
  });
});
