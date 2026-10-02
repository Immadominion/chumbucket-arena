/**
 * Is this Solana address a key someone could actually hold?
 *
 * Supabase Auth's Web3 sign-in verifies an ed25519 signature, and observed on
 * 2026-10-02 it accepted an all-zero signature for the all-zero address
 * (`11111111111111111111111111111111`, the System Program). That is the
 * classic small-order-key edge case: for a public key of small order
 * (the identity, the order-2/4/8 torsion points), signatures can be forged
 * without any private key. Nobody owns such an address, so nobody's wallet
 * is at risk — but a session for one must never be treated as a wallet.
 *
 * So an address is accepted only if it decodes to a canonical point on
 * ed25519 that is NOT of small order (8·P ≠ identity). Plain BigInt
 * arithmetic, no dependency; not constant-time, which is fine for public keys.
 */

import { utils } from "@coral-xyz/anchor";

const P = 2n ** 255n - 19n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint): bigint => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/** Decode a 32-byte ed25519 public key to affine (x, y), or null if invalid. */
function decodePoint(bytes: Uint8Array): [bigint, bigint] | null {
  if (bytes.length !== 32) return null;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return null; // non-canonical encoding
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = u·v³·(u·v⁷)^((p−5)/8)
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * pow(u * v7 % P, (P - 5n) / 8n) % P;
  const vx2 = v * (x * x % P) % P;
  if (vx2 === u) {
    // x is a root
  } else if (vx2 === mod(-u)) {
    x = x * SQRT_M1 % P;
  } else {
    return null; // not on the curve
  }
  if (x === 0n && sign === 1n) return null;
  if ((x & 1n) !== sign) x = mod(-x);
  return [x, y];
}

/** Twisted Edwards (a = −1) addition; complete for ed25519. */
function add([x1, y1]: [bigint, bigint], [x2, y2]: [bigint, bigint]): [bigint, bigint] {
  const t = D * (x1 * x2 % P) % P * (y1 * y2 % P) % P;
  const x3 = (x1 * y2 + y1 * x2) % P * inv(mod(1n + t)) % P;
  const y3 = (y1 * y2 + x1 * x2) % P * inv(mod(1n - t)) % P;
  return [x3, y3];
}

/** True for a canonical ed25519 point whose order is not small. */
export function isUsableEd25519Key(bytes: Uint8Array): boolean {
  let point = decodePoint(bytes);
  if (!point) return false;
  for (let i = 0; i < 3; i++) point = add(point, point); // 8·P
  return !(point[0] === 0n && point[1] === 1n);
}

/** The same check for a base58 Solana address. */
export function isUsableSolanaAddress(address: string): boolean {
  try {
    return isUsableEd25519Key(Uint8Array.from(utils.bytes.bs58.decode(address)));
  } catch {
    return false;
  }
}
