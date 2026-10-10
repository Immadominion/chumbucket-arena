/**
 * Wallet apps may rewrite a single-signer transaction before they sign it.
 * Solflare and Phantom put their own ComputeBudget limit/price in front and
 * append Lighthouse assertion instructions (checks that fail the transaction
 * if an account ends up different from the wallet's simulation). The person
 * still approved the reviewed transaction, so the signed one is accepted only
 * when nothing reviewed changed:
 *
 *  - same message version, no address lookup tables, same recent blockhash;
 *  - still exactly one signer, the reviewed fee payer;
 *  - with ComputeBudget and Lighthouse instructions set aside, the instruction
 *    list is the reviewed one: same programs, same accounts with the same
 *    signer/writable privileges, same data, same order;
 *  - ComputeBudget: no accounts, at most one unit limit (<= 1.4M) and one
 *    unit price, nothing else, and a priority fee of at most 0.001 SOL;
 *  - Lighthouse: assertion instructions only (never MemoryWrite or
 *    MemoryClose, the two that write state), at most two accounts each,
 *    at most four of them.
 *
 * Anything else is refused: the transaction is not the one the person reviewed.
 */
import { ComputeBudgetProgram, TransactionMessage, type TransactionInstruction, type VersionedMessage } from "@solana/web3.js";

export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58();
const MAX_COMPUTE_UNITS = 1_400_000;
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
/** Ceiling on the wallet's priority fee: 0.001 SOL (wallets add ~0.00002-0.0001). */
export const MAX_WALLET_PRIORITY_FEE_LAMPORTS = 1_000_000n;
/** Lighthouse instruction tags: 0 MemoryWrite, 1 MemoryClose, 2..17 assertions. */
const LIGHTHOUSE_FIRST_ASSERTION = 2;
const LIGHTHOUSE_LAST_ASSERTION = 17;
const MAX_LIGHTHOUSE_INSTRUCTIONS = 4;

const isWalletAddition = (ix: TransactionInstruction) => {
  const program = ix.programId.toBase58();
  return program === COMPUTE_BUDGET_PROGRAM || program === LIGHTHOUSE_PROGRAM;
};

function sameInstruction(a: TransactionInstruction, b: TransactionInstruction): boolean {
  if (!a.programId.equals(b.programId) || !a.data.equals(b.data) || a.keys.length !== b.keys.length) return false;
  return a.keys.every((key, i) => {
    const other = b.keys[i]!;
    return key.pubkey.equals(other.pubkey) && key.isSigner === other.isSigner && key.isWritable === other.isWritable;
  });
}

/** null when [signed] is [reviewed] as a wallet may amend it; otherwise why not. */
export function walletAmendmentRefusal(reviewed: VersionedMessage, signed: VersionedMessage): string | null {
  try {
    if (reviewed.version !== signed.version) return "message version changed";
    if (reviewed.addressTableLookups.length !== 0 || signed.addressTableLookups.length !== 0) return "address lookup tables";
    if (reviewed.recentBlockhash !== signed.recentBlockhash) return "recent blockhash changed";
    if (reviewed.header.numRequiredSignatures !== 1 || signed.header.numRequiredSignatures !== 1) return "signer set changed";
    const payer = reviewed.staticAccountKeys[0];
    if (!payer || !signed.staticAccountKeys[0]?.equals(payer)) return "fee payer changed";

    const before = TransactionMessage.decompile(reviewed).instructions;
    const after = TransactionMessage.decompile(signed).instructions;
    const kept = after.filter(ix => !isWalletAddition(ix));
    const core = before.filter(ix => !isWalletAddition(ix));
    if (kept.length !== core.length || !kept.every((ix, i) => sameInstruction(ix, core[i]!))) {
      return "reviewed instructions changed";
    }

    let units: number | undefined;
    let price: bigint | undefined;
    let lighthouse = 0;
    for (const ix of after) {
      const program = ix.programId.toBase58();
      if (program === COMPUTE_BUDGET_PROGRAM) {
        if (ix.keys.length !== 0) return "ComputeBudget with accounts";
        if (ix.data[0] === 2 && ix.data.length === 5 && units === undefined) {
          units = ix.data.readUInt32LE(1);
          if (units <= 0 || units > MAX_COMPUTE_UNITS) return "compute unit limit out of range";
        } else if (ix.data[0] === 3 && ix.data.length === 9 && price === undefined) {
          price = ix.data.readBigUInt64LE(1);
        } else return "unsupported or repeated ComputeBudget instruction";
      } else if (program === LIGHTHOUSE_PROGRAM) {
        const tag = ix.data[0];
        if (tag === undefined || tag < LIGHTHOUSE_FIRST_ASSERTION || tag > LIGHTHOUSE_LAST_ASSERTION) return "Lighthouse instruction is not an assertion";
        if (ix.keys.length > 2) return "Lighthouse assertion with too many accounts";
        if (++lighthouse > MAX_LIGHTHOUSE_INSTRUCTIONS) return "too many Lighthouse assertions";
      }
    }
    if (price !== undefined && price > 0n) {
      const nonBudget = after.filter(ix => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM).length;
      const limit = BigInt(units ?? Math.min(MAX_COMPUTE_UNITS, DEFAULT_UNITS_PER_INSTRUCTION * nonBudget));
      const fee = (limit * price + 999_999n) / 1_000_000n;
      if (fee > MAX_WALLET_PRIORITY_FEE_LAMPORTS) return "wallet priority fee above the ceiling";
    }
    return null;
  } catch {
    return "unreadable transaction";
  }
}
