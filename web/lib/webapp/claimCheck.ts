/**
 * The browser's own check of a Panta win claim before ANY wallet signs it
 * (`Collect $9.20`). Ported rule for rule from the phone's
 * `checkPantaClaimForEmbeddedSigning` (panta_embedded_claim.dart), which
 * mirrors what the BFF lets a claim contain (`PantaClaimExecution`):
 *
 *   - one v0 transaction, no lookup tables, exactly one signer — the owner,
 *     also the fee payer — with an empty signature slot;
 *   - in order: bounded Compute Budget, the owner's own USDC account
 *     (create-if-missing, paid by the owner), ONE `claim_win_usdc` on Panta's
 *     mainnet program for the reviewed market, paying the owner's own
 *     canonical USDC account, and at most one owner-signed text memo;
 *   - no System or Token instruction at the top level, so nothing can move
 *     SOL or USDC anywhere else.
 *
 * The transaction carries neither the outcome nor the shares (the program
 * pays what the position holds), so those are checked as the review: a YES
 * or NO win of a positive number of shares.
 *
 * Pure: the BFF repo's bun tests import it.
 */

import bs58 from "bs58";
import { PANTA_PROGRAM, UnsafeTransaction } from "./pantaBuyCheck";
import type { Side } from "./types";
import {
  ATA_PROGRAM,
  COMPUTE_BUDGET,
  isAddress,
  MalformedTransaction,
  MEMO_PROGRAM,
  parseV0,
  readLe,
  sameData,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  tokenAccountOf,
  USDC_MINT,
  type V0Transaction,
} from "./solanaV0";

/** What the person reviewed: whose position, on which market, which side won, how many shares. */
export interface ReviewedClaim {
  owner: string;
  venueMarketId: string;
  outcome: Side;
  winningShares: string;
}

/** sha256("global:claim_win_usdc")[0..8] (`CLAIM_WIN_DISCRIMINATOR` in the BFF). */
const CLAIM_WIN_DISCRIMINATOR = [0x2b, 0xa0, 0x6a, 0x33, 0xa7, 0x4c, 0x14, 0x1f];
const MAX_COMPUTE_UNITS = 1_400_000n;
const MAX_COMPUTE_PRICE = 1_000_000n;
const SHARES = /^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/;

/** Throws [UnsafeTransaction] unless `tx` is exactly the reviewed claim, unsigned. */
export async function checkPantaClaim(tx: Uint8Array, claim: ReviewedClaim): Promise<void> {
  const require = (ok: boolean, why: string) => {
    if (!ok) throw new UnsafeTransaction(why);
  };
  // The review: a win, for a positive number of shares.
  require(claim.outcome === "YES" || claim.outcome === "NO", "outcome");
  require(SHARES.test(claim.winningShares) && /[1-9]/.test(claim.winningShares), "shares");
  require(isAddress(claim.owner) && isAddress(claim.venueMarketId) && claim.owner !== claim.venueMarketId, "parties");
  require(tx.length > 65 && tx.length <= 1232, "size");

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
  require(t.keys[0] === claim.owner, "fee payer");
  require(new Set(t.keys).size === t.keys.length, "duplicate keys");

  const ownerUsdc = await tokenAccountOf(claim.owner, USDC_MINT);
  const claimData = [...CLAIM_WIN_DISCRIMINATOR, ...bs58.decode(claim.owner)];
  // Invoked programs are never signers or writable.
  const readonlyFrom = t.keys.length - t.header.readonlyUnsigned;

  // ComputeBudget* -> ATA? -> one claim -> Memo?, as the BFF allows it.
  let stage = 0;
  let sawLimit = false;
  let sawPrice = false;
  let claims = 0;
  let memos = 0;
  require(t.instructions.length >= 1 && t.instructions.length <= 6, "instruction count");
  for (const ix of t.instructions) {
    require(ix.program >= readonlyFrom && ix.program < t.keys.length, "program index");
    require(ix.accounts.every((i) => i < t.keys.length), "account index");
    const program = t.keys[ix.program]!;
    const accounts = ix.accounts.map((i) => t.keys[i]!);
    const data = ix.data;
    switch (program) {
      case COMPUTE_BUDGET:
        require(stage === 0 && accounts.length === 0, "compute budget");
        if (data.length === 5 && data[0] === 2 && !sawLimit) {
          sawLimit = true;
          const units = readLe(data, 1, 4);
          require(units > 0n && units <= MAX_COMPUTE_UNITS, "compute units");
        } else if (data.length === 9 && data[0] === 3 && !sawPrice) {
          sawPrice = true;
          require(readLe(data, 1, 8) <= MAX_COMPUTE_PRICE, "compute price");
        } else {
          require(false, "compute budget");
        }
        break;
      case ATA_PROGRAM:
        // CreateIdempotent of the owner's own USDC account, paid by the owner.
        require(
          stage === 0 &&
            sameData(data, [1]) &&
            accounts.join() === [claim.owner, ownerUsdc, claim.owner, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM].join(),
          "usdc account",
        );
        stage = 1;
        break;
      case PANTA_PROGRAM:
        require(
          claims === 0 &&
            stage <= 1 &&
            sameData(data, claimData) &&
            accounts.length === 12 &&
            new Set(accounts).size === 12 &&
            accounts[0] === claim.owner &&
            accounts[2] === claim.venueMarketId &&
            // Paid into the owner's own canonical USDC account, through the
            // real Token / ATA / System programs. Panta's config, vault and
            // PDAs (1, 3–6) are the program's to check.
            accounts[7] === ownerUsdc &&
            accounts[8] === USDC_MINT &&
            accounts[9] === TOKEN_PROGRAM &&
            accounts[10] === ATA_PROGRAM &&
            accounts[11] === SYSTEM_PROGRAM,
          "claim",
        );
        claims++;
        stage = 2;
        break;
      case MEMO_PROGRAM:
        require(
          memos === 0 &&
            stage === 2 &&
            accounts.length === 1 &&
            accounts[0] === claim.owner &&
            data.length <= 566 &&
            data.every((b) => b >= 0x20 && b < 0x7f),
          "memo",
        );
        memos++;
        stage = 3;
        break;
      default:
        // System, Token or anything else at the top level: never.
        require(false, "program");
    }
  }
  require(claims === 1, "shape");
}
