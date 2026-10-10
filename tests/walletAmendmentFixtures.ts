/**
 * Wallet-app amendments as Solflare makes them (seen on mainnet in this
 * project's own wallet history): decompile the reviewed message, put a
 * ComputeBudget price + limit in front, append Lighthouse assertions on the
 * owner and the owner's USDC account, recompile (account order changes), sign.
 * Shared by the API tests and, through scripts/wallet-amendment-vectors.ts,
 * by the app's tests.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

export const LIGHTHOUSE = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const synthetic = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));

export const amendOwner = Keypair.fromSeed(new Uint8Array(32).fill(41));
export const amendStranger = Keypair.fromSeed(new Uint8Array(32).fill(42));
export const ownerUsdc = PublicKey.findProgramAddressSync([amendOwner.publicKey.toBuffer(), TOKEN.toBuffer(), USDC.toBuffer()], ATA)[0];
export const amendBlockhash = synthetic(44).toBase58();
const program = synthetic(45);

export function buyData(amount: bigint): Buffer {
  const data = Buffer.alloc(17);
  createHash("sha256").update("global:primary_order_usdc").digest().copy(data, 0, 0, 8);
  data[8] = 0;
  data.writeBigUInt64LE(amount, 9);
  return data;
}

/** A Panta-shaped reviewed buy: ATA create-idempotent, primary buy, attribution Memo. */
export function reviewedInstructions(amount = 2_000_000n): TransactionInstruction[] {
  const owner = amendOwner.publicKey;
  const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return [
    new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [meta(owner, true, true), meta(ownerUsdc, true), meta(owner), meta(USDC), meta(SystemProgram.programId), meta(TOKEN)] }),
    new TransactionInstruction({ programId: program, data: buyData(amount), keys: [meta(owner, true, true), meta(synthetic(46), true), meta(synthetic(47)),
      meta(synthetic(48)), meta(synthetic(49), true), meta(synthetic(50), true), meta(USDC), meta(ownerUsdc, true), meta(synthetic(51), true),
      meta(TOKEN), meta(ATA), meta(SystemProgram.programId)] }),
    new TransactionInstruction({ programId: MEMO, data: Buffer.from("panta:v1:usr_synthetic:qt_test:ord_test"), keys: [meta(owner, false, true)] }),
  ];
}

function encode(instructions: TransactionInstruction[], blockhash = amendBlockhash, payer = amendOwner.publicKey): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
}

/** The unsigned reviewed transaction, base64, as the server hands it to the phone. */
export function reviewedPayload(): string {
  return Buffer.from(encode(reviewedInstructions()).serialize()).toString("base64");
}

export const lighthouseCheck = (tag: number, account: PublicKey) =>
  new TransactionInstruction({ programId: LIGHTHOUSE, data: Buffer.from([tag, 0, 1, 0, 0, 0, 0, 0, 0, 0]), keys: [{ pubkey: account, isSigner: false, isWritable: false }] });

export interface Amendment {
  before?: TransactionInstruction[];
  after?: TransactionInstruction[];
  core?: (reviewed: TransactionInstruction[]) => TransactionInstruction[];
  blockhash?: string;
  signer?: Keypair;
}

/** The reviewed transaction as a wallet app returns it, signed and base64. */
export function walletAmended(reviewed: string, amendment: Amendment = {}): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(reviewed, "base64"));
  const decompiled = TransactionMessage.decompile(tx.message);
  const core = amendment.core ? amendment.core(decompiled.instructions) : decompiled.instructions;
  const before = amendment.before ?? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 220_000 })];
  const after = amendment.after ?? [lighthouseCheck(6, amendOwner.publicKey), lighthouseCheck(10, ownerUsdc)];
  const amended = encode([...before, ...core, ...after], amendment.blockhash ?? decompiled.recentBlockhash, decompiled.payerKey);
  if (amendment.signer && !amendment.signer.publicKey.equals(decompiled.payerKey)) {
    // A signature from the wrong key in the owner's slot (web3.js refuses to make one).
    const key = createPrivateKey({ format: "der", type: "pkcs8",
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(amendment.signer.secretKey.subarray(0, 32))]) });
    amended.signatures[0] = new Uint8Array(sign(null, Buffer.from(amended.message.serialize()), key));
  } else amended.sign([amendment.signer ?? amendOwner]);
  return Buffer.from(amended.serialize()).toString("base64");
}

/** The reviewed transaction signed as is. */
export function signedAsReviewed(reviewed: string, signer: Keypair = amendOwner): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(reviewed, "base64"));
  tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * Every case the API and the app must agree on: [name, signed payload, accepted,
 * message accepted]. Only the signature check (the server's) separates the two.
 */
export function amendmentCases(reviewed: string): [string, string, boolean, boolean?][] {
  const budget = (price: number, units: number) => [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ComputeBudgetProgram.setComputeUnitLimit({ units })];
  return [
    ["signed exactly as reviewed", signedAsReviewed(reviewed), true],
    ["Solflare: priority fee in front, Lighthouse checks after", walletAmended(reviewed), true],
    ["Lighthouse checks only", walletAmended(reviewed, { before: [] }), true],
    ["priority fee only", walletAmended(reviewed, { after: [] }), true],
    ["fee at the 0.001 SOL ceiling", walletAmended(reviewed, { before: budget(1_000_000, 1_000_000) }), true],
    ["fee above the 0.001 SOL ceiling", walletAmended(reviewed, { before: budget(1_000_001, 1_000_000) }), false],
    ["price with no limit above the ceiling", walletAmended(reviewed, { before: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000_000 })] }), false],
    ["compute limit above 1.4M", walletAmended(reviewed, { before: budget(1, 1_400_001) }), false],
    ["two price instructions", walletAmended(reviewed, { before: [...budget(1, 200_000), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })] }), false],
    ["heap frame request", walletAmended(reviewed, { before: [ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 })] }), false],
    ["Lighthouse MemoryWrite", walletAmended(reviewed, { after: [lighthouseCheck(0, ownerUsdc)] }), false],
    ["Lighthouse MemoryClose", walletAmended(reviewed, { after: [lighthouseCheck(1, ownerUsdc)] }), false],
    ["unknown Lighthouse tag", walletAmended(reviewed, { after: [lighthouseCheck(18, ownerUsdc)] }), false],
    ["five Lighthouse checks", walletAmended(reviewed, { after: [6, 6, 10, 10, 10].map(tag => lighthouseCheck(tag, ownerUsdc)) }), false],
    ["buy amount changed", walletAmended(reviewed, { core: ixs => [ixs[0]!, new TransactionInstruction({ ...ixs[1]!, data: buyData(3_000_000n) }), ixs[2]!] }), false],
    ["Memo dropped", walletAmended(reviewed, { core: ixs => ixs.slice(0, 2) }), false],
    ["instructions reordered", walletAmended(reviewed, { core: ixs => [ixs[1]!, ixs[0]!, ixs[2]!] }), false],
    ["SOL transfer added", walletAmended(reviewed, { after: [SystemProgram.transfer({ fromPubkey: amendOwner.publicKey, toPubkey: synthetic(52), lamports: 1 })] }), false],
    ["recent blockhash changed", walletAmended(reviewed, { blockhash: synthetic(53).toBase58() }), false],
    ["signed by another key", walletAmended(reviewed, { signer: amendStranger }), false, true],
  ];
}
