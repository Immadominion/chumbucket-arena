/**
 * The browser's own check of a Panta buy before ANY wallet signs it: the
 * Chumbucket wallet has no second screen, and a browser wallet's preview is
 * not ours to trust either. Ported rule for rule from the phone's
 * `checkPantaBuyForEmbeddedSigning` (panta_embedded_wallet.dart), which
 * mirrors what the BFF builds (`PantaExecution`):
 *
 *   - one v0 transaction, no address lookup tables, exactly one signer — the
 *     owner — which is also the fee payer;
 *   - only the instructions a primary buy is made of, in their order:
 *     compute budget (capped), the owner's own USDC account (create if
 *     missing), ONE buy on Panta's mainnet program for this market, side and
 *     USDC amount, and the attribution memo;
 *   - no other program, so nothing can move SOL or USDC anywhere else.
 *
 * Anything else throws [UnsafeTransaction] and is never shown to a wallet.
 *
 * Pure (WebCrypto for SHA-256): the BFF repo's bun tests import it.
 */

import bs58 from "bs58";
import type { Side } from "./types";

export class UnsafeTransaction extends Error {}

/** Panta's mainnet program (`PANTA_MAINNET_PROGRAM_ID` in the BFF). */
export const PANTA_PROGRAM = "6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** Mainnet USDC: the only token a buy may spend. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** sha256("global:primary_order_usdc")[0..8], the buy's Anchor discriminator. */
const BUY_DISCRIMINATOR = [46, 137, 68, 116, 49, 89, 13, 247];
/** The BFF's own ceilings (`MAX_COMPUTE_UNITS`, `MAX_COMPUTE_PRICE`). */
const MAX_COMPUTE_UNITS = 1_400_000n;
const MAX_COMPUTE_PRICE = 1_000_000n;

export interface ReviewedBuy {
  owner: string;
  venueMarketId: string;
  side: Side;
  amountBaseUnits: string;
}

// ── ed25519 "is this 32-byte string a curve point?" (program-derived addresses) ──

const P = (1n << 255n) - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;
function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}
const D = mod(-121665n * pow(121666n, P - 2n));

/** True when the bytes decompress to an ed25519 point (as curve25519-dalek decides). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  y = mod(y);
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = mod(u * pow(v, P - 2n));
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}

async function sha256(parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

/** Solana's findProgramAddress: the first off-curve hash from bump 255 down. */
export async function programAddress(seeds: Uint8Array[], program: string): Promise<string> {
  const programBytes = bs58.decode(program);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const hash = await sha256([...seeds, Uint8Array.of(bump), programBytes, marker]);
    if (!isOnCurve(hash)) return bs58.encode(hash);
  }
  throw new UnsafeTransaction("no program address");
}

/** The owner's canonical USDC account. */
export const usdcAccountOf = (owner: string): Promise<string> =>
  programAddress([bs58.decode(owner), bs58.decode(TOKEN_PROGRAM), bs58.decode(USDC_MINT)], ATA_PROGRAM);

// ── v0 transaction parsing ──

interface Parsed {
  signatures: Uint8Array[];
  numRequiredSignatures: number;
  numReadonlySigned: number;
  keys: string[];
  instructions: Array<{ program: number; accounts: number[]; data: Uint8Array }>;
  lookups: number;
}

function parse(tx: Uint8Array): Parsed {
  let at = 0;
  const byte = () => {
    if (at >= tx.length) throw new UnsafeTransaction("truncated");
    return tx[at++]!;
  };
  const take = (n: number) => {
    if (n < 0 || at + n > tx.length) throw new UnsafeTransaction("truncated");
    const out = tx.subarray(at, at + n);
    at += n;
    return out;
  };
  const shortLen = () => {
    let len = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = byte();
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return len;
    }
    throw new UnsafeTransaction("bad length");
  };
  const signatures = Array.from({ length: shortLen() }, () => take(64));
  if (byte() !== 0x80) throw new UnsafeTransaction("not v0");
  const numRequiredSignatures = byte();
  const numReadonlySigned = byte();
  byte(); // read-only unsigned
  const keys = Array.from({ length: shortLen() }, () => bs58.encode(take(32)));
  take(32); // recent blockhash
  const instructions = Array.from({ length: shortLen() }, () => {
    const program = byte();
    const accounts = Array.from({ length: shortLen() }, () => byte());
    const data = take(shortLen());
    return { program, accounts, data };
  });
  const lookups = shortLen();
  if (lookups === 0 && at !== tx.length) throw new UnsafeTransaction("trailing bytes");
  return { signatures, numRequiredSignatures, numReadonlySigned, keys, instructions, lookups };
}

const readLe = (data: Uint8Array, offset: number, length: number): bigint => {
  let value = 0n;
  for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
};
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

/** Throws [UnsafeTransaction] unless `tx` is exactly the reviewed buy, unsigned. */
export async function checkPantaBuy(tx: Uint8Array, buy: ReviewedBuy): Promise<void> {
  const require = (ok: boolean, why: string) => {
    if (!ok) throw new UnsafeTransaction(why);
  };
  require(tx.length > 65 && tx.length <= 1232, "size");
  const t = parse(tx);
  require(
    t.signatures.length === 1 && t.signatures[0]!.every((b) => b === 0) && t.numRequiredSignatures === 1 && t.numReadonlySigned === 0,
    "signers",
  );
  require(t.lookups === 0, "lookup tables");
  require(t.keys.length > 0 && t.keys[0] === buy.owner, "fee payer");
  require(new Set(t.keys).size === t.keys.length, "duplicate keys");

  const amount = /^[1-9][0-9]{0,19}$/.test(buy.amountBaseUnits) ? BigInt(buy.amountBaseUnits) : 0n;
  require(amount > 0n && amount < 1n << 64n, "amount");
  const amountLe = Array.from({ length: 8 }, (_, i) => Number((amount >> BigInt(8 * i)) & 0xffn));
  const buyData = [...BUY_DISCRIMINATOR, buy.side === "YES" ? 0 : 1, ...amountLe];
  const ownerUsdc = await usdcAccountOf(buy.owner);

  // ComputeBudget* -> ATA? -> one buy -> one memo, as the BFF builds it.
  let stage = 0;
  let buys = 0;
  let memos = 0;
  let sawLimit = false;
  let sawPrice = false;
  require(t.instructions.length >= 2 && t.instructions.length <= 5, "instruction count");
  for (const ix of t.instructions) {
    require(ix.program > 0 && ix.program < t.keys.length, "program index");
    require(ix.accounts.every((i) => i < t.keys.length), "account index");
    const program = t.keys[ix.program]!;
    const accounts = ix.accounts.map((i) => t.keys[i]!);
    const data = ix.data;
    switch (program) {
      case COMPUTE_BUDGET:
        require(stage === 0 && accounts.length === 0, "compute budget");
        if (data.length === 5 && data[0] === 2 && !sawLimit) {
          sawLimit = true;
          require(readLe(data, 1, 4) <= MAX_COMPUTE_UNITS, "compute units");
        } else if (data.length === 9 && data[0] === 3 && !sawPrice) {
          sawPrice = true;
          require(readLe(data, 1, 8) <= MAX_COMPUTE_PRICE, "compute price");
        } else {
          require(false, "compute budget");
        }
        break;
      case ATA_PROGRAM:
        require(
          stage === 0 &&
            same(data, [1]) &&
            accounts.join() === [buy.owner, ownerUsdc, buy.owner, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM].join(),
          "usdc account",
        );
        stage = 1;
        break;
      case PANTA_PROGRAM:
        require(
          buys === 0 &&
            stage <= 1 &&
            same(data, buyData) &&
            accounts.length === 12 &&
            accounts[0] === buy.owner &&
            accounts[1] === buy.venueMarketId &&
            accounts[6] === USDC_MINT &&
            accounts[7] === ownerUsdc &&
            accounts[9] === TOKEN_PROGRAM &&
            accounts[10] === ATA_PROGRAM &&
            accounts[11] === SYSTEM_PROGRAM,
          "buy",
        );
        buys++;
        stage = 2;
        break;
      case MEMO_PROGRAM: {
        const text = new TextDecoder().decode(data);
        require(
          memos === 0 && stage === 2 && accounts.length === 1 && accounts[0] === buy.owner &&
            text.startsWith("panta:v1:") && text.length <= 256 && /^[ -~]+$/.test(text),
          "memo",
        );
        memos++;
        stage = 3;
        break;
      }
      default:
        // System, Token, Token-2022 or anything else at the top level: never.
        require(false, "program");
    }
  }
  require(buys === 1 && memos === 1, "shape");
}
