/**
 * A whole v0 Solana transaction read from its bytes, lookup tables included,
 * for the browser's own checks before a wallet signs a transfer, a claim or a
 * gasless swap (`transferCheck.ts`, `claimCheck.ts`, `swapCheck.ts`):
 *
 *   [shortvec n] [n × 64-byte signatures]
 *   0x80 [header ×3] [shortvec k] [k × 32-byte keys] [32-byte blockhash]
 *   [shortvec i] i × ([program u8] [shortvec a] [a × u8] [shortvec d] [d bytes])
 *   [shortvec l] l × ([32-byte table] [shortvec w] [w × u8] [shortvec r] [r × u8])
 *
 * Strict: a non-minimal length, a truncated field or a trailing byte is
 * refused, so the bytes a check read are the only reading of them.
 *
 * Pure (no web3.js in the web app): the BFF repo's bun tests import it.
 */

import bs58 from "bs58";
import { programAddress } from "./pantaBuyCheck";

export class MalformedTransaction extends Error {}

export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface V0Instruction {
  program: number;
  accounts: number[];
  data: Uint8Array;
}

export interface V0Lookup {
  table: string;
  writable: number[];
  readonly: number[];
}

export interface V0Transaction {
  signatures: Uint8Array[];
  header: { required: number; readonlySigned: number; readonlyUnsigned: number };
  keys: string[];
  instructions: V0Instruction[];
  lookups: V0Lookup[];
  /** Where the message (what a signer signs) starts. */
  messageOffset: number;
}

export function parseV0(tx: Uint8Array): V0Transaction {
  let at = 0;
  const byte = () => {
    if (at >= tx.length) throw new MalformedTransaction("truncated");
    return tx[at++]!;
  };
  const take = (n: number) => {
    if (n < 0 || at + n > tx.length) throw new MalformedTransaction("truncated");
    const out = tx.subarray(at, at + n);
    at += n;
    return out;
  };
  // compact-u16, minimal encoding only.
  const shortvec = () => {
    let len = 0;
    for (let i = 0; i < 3; i++) {
      const b = byte();
      len |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) {
        if (i > 0 && b === 0) throw new MalformedTransaction("non-minimal length");
        if (len > 0xffff) throw new MalformedTransaction("bad length");
        return len;
      }
    }
    throw new MalformedTransaction("bad length");
  };
  const signatures = Array.from({ length: shortvec() }, () => take(64));
  const messageOffset = at;
  if (byte() !== 0x80) throw new MalformedTransaction("not v0");
  const header = { required: byte(), readonlySigned: byte(), readonlyUnsigned: byte() };
  const keys = Array.from({ length: shortvec() }, () => bs58.encode(take(32)));
  take(32); // recent blockhash
  const instructions = Array.from({ length: shortvec() }, () => {
    const program = byte();
    const accounts = Array.from({ length: shortvec() }, () => byte());
    const data = take(shortvec());
    return { program, accounts, data };
  });
  const lookups = Array.from({ length: shortvec() }, () => {
    const table = bs58.encode(take(32));
    const writable = Array.from({ length: shortvec() }, () => byte());
    const readonly = Array.from({ length: shortvec() }, () => byte());
    return { table, writable, readonly };
  });
  if (at !== tx.length) throw new MalformedTransaction("trailing bytes");
  if (header.readonlySigned > header.required || header.required + header.readonlyUnsigned > keys.length) {
    throw new MalformedTransaction("header");
  }
  return { signatures, header, keys, instructions, lookups, messageOffset };
}

/** Unsigned little-endian, as a bigint (a u64 never wraps negative). Throws past the end. */
export function readLe(data: Uint8Array, offset: number, length: number): bigint {
  if (offset < 0 || offset + length > data.length) throw new MalformedTransaction("short data");
  let value = 0n;
  for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
}

export const sameData = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
  a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

export const startsWith = (data: Uint8Array, prefix: ArrayLike<number>): boolean =>
  data.length >= prefix.length && sameData(data.subarray(0, prefix.length), prefix);

/** A 32-byte base58 address (any key, on or off the curve); false for anything else. */
export function isAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** `owner`'s canonical token account for `mint` (Token program). */
export const tokenAccountOf = (owner: string, mint: string): Promise<string> =>
  programAddress([bs58.decode(owner), bs58.decode(TOKEN_PROGRAM), bs58.decode(mint)], ATA_PROGRAM);
