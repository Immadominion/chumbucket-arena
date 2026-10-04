/**
 * The browser's own check of a USDC transfer before ANY wallet signs it: a
 * cash out from the trading wallet, or "From your wallet" into it. The BFF
 * builds it (`money.cashOutPrepare` / `money.depositFromWalletPrepare`) and
 * checks it again on submit; the Chumbucket wallet has no second screen, so
 * this check is what stands between the review and a signature. The rules
 * are the contract's, section (c) of docs/money-api.md, exactly:
 *
 *   - one v0 transaction, no address lookup tables, signatures empty,
 *     exactly one signer: `from`, which is also the fee payer;
 *   - instructions, in this order and nothing else:
 *       0–2 Compute Budget (SetComputeUnitLimit ≤ 200 000, SetComputeUnitPrice
 *       ≤ 1 000 000 micro-lamports, each at most once);
 *       only when the review says the destination's USDC account is created:
 *       one ATA CreateIdempotent `[from, ata(to), to, USDC, System, Token]`;
 *       exactly one SPL Token TransferChecked `[ata(from), USDC, ata(to), from]`
 *       of exactly the reviewed amount, 6 decimals.
 *
 * No System transfer and no other program, so nothing else can leave `from`.
 * Anything else throws [UnsafeTransaction] and is never shown to a wallet.
 *
 * Pure: the BFF repo's bun tests import it.
 */

import bs58 from "bs58";
import { isOnCurve, UnsafeTransaction } from "./pantaBuyCheck";
import {
  ATA_PROGRAM,
  COMPUTE_BUDGET,
  MalformedTransaction,
  parseV0,
  readLe,
  sameData,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  tokenAccountOf,
  USDC_MINT,
  isAddress,
  type V0Transaction,
} from "./solanaV0";

/** What the person reviewed: who pays, who receives, how much. */
export interface ReviewedTransfer {
  from: string;
  to: string;
  amountBaseUnits: string;
  /** The destination's USDC account is created in this transaction (paid by `from`). */
  createsAccount: boolean;
}

export const MAX_TRANSFER_COMPUTE_UNITS = 200_000n;
export const MAX_TRANSFER_COMPUTE_PRICE = 1_000_000n;

/** Throws [UnsafeTransaction] unless `tx` is exactly the reviewed USDC transfer, unsigned. */
export async function checkUsdcTransfer(tx: Uint8Array, transfer: ReviewedTransfer): Promise<void> {
  const require = (ok: boolean, why: string) => {
    if (!ok) throw new UnsafeTransaction(why);
  };
  require(tx.length > 65 && tx.length <= 1232, "size");
  require(isAddress(transfer.from) && isAddress(transfer.to) && transfer.from !== transfer.to, "parties");
  // A wallet on the curve, never the mint or a program-derived address.
  require(transfer.to !== USDC_MINT && isOnCurve(bs58.decode(transfer.to)), "destination");
  const amount = /^[1-9][0-9]{0,19}$/.test(transfer.amountBaseUnits) ? BigInt(transfer.amountBaseUnits) : 0n;
  require(amount > 0n && amount < 1n << 64n, "amount");

  let t: V0Transaction;
  try {
    t = parseV0(tx);
  } catch (e) {
    if (e instanceof MalformedTransaction) throw new UnsafeTransaction(e.message);
    throw e;
  }
  require(
    t.signatures.length === 1 &&
      t.signatures[0]!.every((b) => b === 0) &&
      t.header.required === 1 &&
      t.header.readonlySigned === 0,
    "signers",
  );
  require(t.lookups.length === 0, "lookup tables");
  require(t.keys[0] === transfer.from, "fee payer");
  require(new Set(t.keys).size === t.keys.length, "duplicate keys");

  const fromUsdc = await tokenAccountOf(transfer.from, USDC_MINT);
  const toUsdc = await tokenAccountOf(transfer.to, USDC_MINT);
  const amountLe = Array.from({ length: 8 }, (_, i) => Number((amount >> BigInt(8 * i)) & 0xffn));
  const transferData = [12, ...amountLe, 6];

  // ComputeBudget{0,2} -> ATA create (only when reviewed) -> one TransferChecked.
  let stage = 0;
  let sawLimit = false;
  let sawPrice = false;
  let creates = 0;
  let transfers = 0;
  require(t.instructions.length >= 1 && t.instructions.length <= 4, "instruction count");
  for (const ix of t.instructions) {
    // Programs are never the payer, never a signer.
    require(ix.program >= t.header.required && ix.program < t.keys.length, "program index");
    require(ix.accounts.every((i) => i < t.keys.length), "account index");
    const program = t.keys[ix.program]!;
    const accounts = ix.accounts.map((i) => t.keys[i]!);
    const data = ix.data;
    switch (program) {
      case COMPUTE_BUDGET:
        require(stage === 0 && accounts.length === 0, "compute budget");
        if (data.length === 5 && data[0] === 2 && !sawLimit) {
          sawLimit = true;
          require(readLe(data, 1, 4) <= MAX_TRANSFER_COMPUTE_UNITS, "compute units");
        } else if (data.length === 9 && data[0] === 3 && !sawPrice) {
          sawPrice = true;
          require(readLe(data, 1, 8) <= MAX_TRANSFER_COMPUTE_PRICE, "compute price");
        } else {
          require(false, "compute budget");
        }
        break;
      case ATA_PROGRAM:
        require(
          transfer.createsAccount &&
            creates === 0 &&
            stage === 0 &&
            sameData(data, [1]) &&
            accounts.join() === [transfer.from, toUsdc, transfer.to, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM].join(),
          "usdc account",
        );
        creates++;
        stage = 1;
        break;
      case TOKEN_PROGRAM:
        require(
          transfers === 0 &&
            stage <= 1 &&
            sameData(data, transferData) &&
            accounts.join() === [fromUsdc, USDC_MINT, toUsdc, transfer.from].join(),
          "transfer",
        );
        transfers++;
        stage = 2;
        break;
      default:
        // System, Token-2022, Memo or anything else: never.
        require(false, "program");
    }
  }
  require(transfers === 1 && creates === (transfer.createsAccount ? 1 : 0), "shape");
}
