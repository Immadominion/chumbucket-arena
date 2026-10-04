/**
 * The few facts the web app needs about a serialized Solana transaction, read
 * straight from its bytes (no web3.js in the web app):
 *
 *   [compact-u16 n] [n × 64-byte signatures] [message …]
 *
 * The BFF builds every Panta transaction (`pantaTrading.prepare`) and is the
 * one that checks it exactly and broadcasts it. Here the browser only makes
 * sure a wallet handed back the very message it was given, signed in its own
 * slot, so a wallet that rewrote a trade is refused before anything is sent.
 *
 * Pure: the BFF repo's bun tests import it.
 */

import { sameBytes } from "./siws";

export class TransactionShapeError extends Error {}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Signature count and where the message starts. Throws on anything malformed. */
export function signatureSection(tx: Uint8Array): { count: number; messageOffset: number } {
  let count = 0;
  let offset = 0;
  // compact-u16: at most three bytes, seven bits each.
  for (let shift = 0; shift < 21; shift += 7) {
    if (offset >= tx.length) throw new TransactionShapeError("truncated");
    const byte = tx[offset++]!;
    count |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    if (shift === 14) throw new TransactionShapeError("bad length");
  }
  const messageOffset = offset + count * 64;
  if (count === 0 || messageOffset >= tx.length) throw new TransactionShapeError("no message");
  return { count, messageOffset };
}

/**
 * True when `signed` is `unsigned` with only signature slot `slot` filled in:
 * same length, same message, every other slot untouched, and a non-empty
 * signature in the slot.
 */
export function signedOnlyInSlot(unsigned: Uint8Array, signed: Uint8Array, slot = 0): boolean {
  try {
    const before = signatureSection(unsigned);
    const after = signatureSection(signed);
    if (unsigned.length !== signed.length || before.count !== after.count || slot >= before.count) return false;
    if (!sameBytes(unsigned.subarray(before.messageOffset), signed.subarray(after.messageOffset))) return false;
    const start = (n: number) => before.messageOffset - (before.count - n) * 64;
    for (let n = 0; n < before.count; n++) {
      const a = unsigned.subarray(start(n), start(n) + 64);
      const b = signed.subarray(start(n), start(n) + 64);
      if (n === slot ? b.every((byte) => byte === 0) : !sameBytes(a, b)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The message bytes a signer signs (everything after the signature section). */
export function messageBytes(tx: Uint8Array): Uint8Array {
  return tx.subarray(signatureSection(tx).messageOffset);
}

/** `unsigned` with a detached 64-byte signature written into slot `slot`. */
export function withSignature(unsigned: Uint8Array, signature: Uint8Array, slot = 0): Uint8Array {
  const { count, messageOffset } = signatureSection(unsigned);
  if (signature.length !== 64 || slot >= count) throw new TransactionShapeError("bad signature");
  const out = new Uint8Array(unsigned);
  out.set(signature, messageOffset - (count - slot) * 64);
  return out;
}
