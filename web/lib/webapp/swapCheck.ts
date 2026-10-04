/**
 * The browser's own check of a gasless USDC → SOL swap (`solTopUp.order`)
 * before ANY wallet signs it. Network fees stay invisible: when a trade or a
 * transfer needs SOL, the app swaps a little USDC for it silently, so the
 * Chumbucket wallet signs this with no screen of its own. Ported rule for
 * rule from the BFF's `src/solTopUp/verify.ts` (and the phone's
 * `gasless_swap_check.dart`); the shapes are read from real mainnet swaps
 * (docs/gasless-sol-topup.md §4).
 *
 * A swap may only: let someone else pay the fee (Jupiter's gas wallet or the
 * market maker); create the person's own USDC/WSOL account at the payer's
 * cost; run ONE exact-in Jupiter route or JupiterZ fill that spends exactly
 * the reviewed USDC from the person's own USDC account into the person's own
 * SOL; close the WSOL account back to the person; repay the payer the rent it
 * put into that account; and pay Jupiter's quoted fee. The person's accounts
 * are always static keys (a lookup table can never hold a signer), so every
 * rule that protects the person works without resolving lookup tables.
 *
 * Pure: the BFF repo's bun tests import it.
 */

import { UnsafeTransaction } from "./pantaBuyCheck";
import {
  ATA_PROGRAM,
  COMPUTE_BUDGET,
  MalformedTransaction,
  parseV0,
  readLe,
  startsWith,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  tokenAccountOf,
  USDC_MINT,
  WSOL_MINT,
  type V0Transaction,
} from "./solanaV0";

/** Jupiter Aggregator v6 (the Metis router). */
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/** JupiterZ order engine (the RFQ router). */
const JUPITER_Z = "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH";

export const SWAP_LIMITS = {
  maxFeeBps: 300,
  maxSlippageBps: 300,
  maxRentRepayLamports: 2_039_280n,
  maxFillTtlSeconds: 600,
  minQuoteFidelityBps: 9_900,
} as const;

// sha256("global:<name>")[0..8], the Anchor discriminators in Jupiter's IDLs.
const ROUTE = [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a];
const SHARED_ROUTE = [0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81];
const ROUTE_V2 = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
const SHARED_ROUTE_V2 = [0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9];
const FILL = [0xa8, 0x60, 0xb7, 0xa3, 0x5c, 0x0a, 0x28, 0xa0];

export type SwapRouter = "metis" | "jupiterz";

/** What the person's top-up was quoted as (`solTopUp.order`'s review). */
export interface ExpectedSwap {
  owner: string;
  /** Exact USDC base units spent. */
  inAmount: bigint;
  router: SwapRouter;
  /** SOL lamports after Jupiter's fee, before slippage. */
  quotedOutLamports: bigint;
  feeBps: number;
  /** Seconds since epoch, for a JupiterZ fill's expiry. */
  nowSeconds: number;
}

export interface CheckedSwap {
  router: SwapRouter;
  feePayer: string;
  /** The person's signature slot (never 0: someone else pays the fee). */
  ownerSignatureIndex: number;
  inAmount: bigint;
  minOutLamports: bigint;
  expectedOutLamports: bigint;
}

interface Swap {
  inAmount: bigint;
  expectedOut: bigint;
  minOut: bigint;
  slippageBps: number;
  feeBps: number;
}

/** Throws [UnsafeTransaction] unless `bytes` is exactly the quoted gasless swap, unsigned for the person. */
export async function checkGaslessSwap(bytes: Uint8Array, expected: ExpectedSwap): Promise<CheckedSwap> {
  const fail = (why: string): never => {
    throw new UnsafeTransaction(why);
  };
  const need = (ok: boolean, why: string) => {
    if (!ok) fail(why);
  };
  need(bytes.length > 0 && bytes.length <= 1232, "size");
  let t: V0Transaction;
  try {
    t = parseV0(bytes);
  } catch (e) {
    if (e instanceof MalformedTransaction) throw new UnsafeTransaction(e.message);
    throw e;
  }
  const { keys, header } = t;
  const owner = expected.owner;
  const ownerUsdc = await tokenAccountOf(owner, USDC_MINT);
  const ownerWsol = await tokenAccountOf(owner, WSOL_MINT);
  const loaded = t.lookups.reduce((n, l) => n + l.writable.length + l.readonly.length, 0);
  const total = keys.length + loaded;

  need(header.required >= 2 && header.required <= 3, "signer count");
  need(t.signatures.length === header.required, "signature slots");
  need(new Set(keys).size === keys.length, "duplicate keys");
  const feePayer = keys[0]!;
  need(feePayer !== owner, "the person would pay the network fee");
  const ownerIndex = keys.indexOf(owner);
  need(ownerIndex >= 1 && ownerIndex < header.required - header.readonlySigned, "the person is not a signer");
  need(t.signatures[ownerIndex]!.every((b) => b === 0), "already signed for the person");
  for (const account of [ownerUsdc, ownerWsol]) {
    const at = keys.indexOf(account);
    need(at < 0 || at >= header.required, "token account as signer");
  }

  const at = (index: number): string | null => (index < keys.length ? keys[index]! : index < total ? null : fail("account index"));
  const isStatic = (index: number | undefined, key: string) => index !== undefined && index < keys.length && keys[index] === key;
  const staticOrLoaded = (index: number | undefined, key: string) =>
    index !== undefined && (index < keys.length ? keys[index] === key : index < total);

  let swap: Swap | null = null;
  let wsolCreated = false;
  let wsolClosed = false;
  let rentRepay = 0n;
  let feePaid: { to: string; lamports: bigint } | null = null;
  const synced = new Set<string>();
  let ataCreates = 0;

  for (const ix of t.instructions) {
    need(ix.program >= header.required && ix.program < keys.length, "program index");
    const program = keys[ix.program]!;
    const data = ix.data;
    const a = ix.accounts;
    for (const index of a) at(index);
    switch (program) {
      case COMPUTE_BUDGET:
        need(a.length === 0 && data.length >= 1 && data.length <= 9, "compute budget");
        if (data[0] === 2) need(data.length === 5 && readLe(data, 1, 4) <= 1_400_000n, "compute limit");
        else if (data[0] === 3) need(data.length === 9, "compute price");
        else need(data[0] === 1 || data[0] === 4, "compute budget kind");
        break;
      case ATA_PROGRAM: {
        // The person's own USDC or WSOL account, paid by the fee payer.
        need(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)), "token account instruction");
        need(a.length === 6 && ++ataCreates <= 2, "token account accounts");
        const wsol = isStatic(a[1], ownerWsol);
        need(isStatic(a[0], feePayer), "token account paid by the person");
        need(isStatic(a[2], owner), "token account for someone else");
        need(wsol || isStatic(a[1], ownerUsdc), "unexpected token account");
        need(isStatic(a[4], SYSTEM_PROGRAM) && isStatic(a[5], TOKEN_PROGRAM), "token account programs");
        need(staticOrLoaded(a[3], wsol ? WSOL_MINT : USDC_MINT), "token account mint");
        if (wsol) wsolCreated = true;
        break;
      }
      case JUPITER_V6:
        need(swap === null && expected.router === "metis", "second or unexpected swap");
        swap = route(data, a, { owner, ownerUsdc, ownerWsol, isStatic, staticOrLoaded });
        break;
      case JUPITER_Z: {
        need(swap === null && expected.router === "jupiterz", "second or unexpected swap");
        // fill(input_amount u64, output_amount u64, expire_at i64); live fills
        // carry up to 5 more bytes the published IDL does not name.
        need(data.length >= 32 && data.length <= 40 && startsWith(data, FILL), "not a fill");
        need(a.length >= 11, "fill accounts");
        need(isStatic(a[0], owner), "fill taker");
        need(isStatic(a[1], feePayer), "maker is not the fee payer");
        need(isStatic(a[2], ownerUsdc), "fill spends from another account");
        need(isStatic(a[4], JUPITER_Z) || isStatic(a[4], ownerWsol), "fill pays someone else");
        need(staticOrLoaded(a[6], USDC_MINT) && staticOrLoaded(a[8], WSOL_MINT), "fill mints");
        need(staticOrLoaded(a[7], TOKEN_PROGRAM) && staticOrLoaded(a[9], TOKEN_PROGRAM) && staticOrLoaded(a[10], SYSTEM_PROGRAM), "fill programs");
        const out = readLe(data, 16, 8);
        let expireAt = readLe(data, 24, 8);
        if (expireAt >= 1n << 63n) expireAt -= 1n << 64n; // i64
        need(out > 0n, "fill pays nothing");
        need(
          expireAt > BigInt(expected.nowSeconds) && expireAt <= BigInt(expected.nowSeconds + SWAP_LIMITS.maxFillTtlSeconds),
          "fill expiry",
        );
        swap = { inAmount: readLe(data, 8, 8), expectedOut: out, minOut: out, slippageBps: 0, feeBps: 0 };
        break;
      }
      case TOKEN_PROGRAM:
        if (data.length === 1 && data[0] === 9) {
          // CloseAccount(the person's WSOL) -> the person, by the person.
          need(a.length === 3 && isStatic(a[0], ownerWsol) && isStatic(a[1], owner) && isStatic(a[2], owner), "close pays someone else");
          need(!wsolClosed, "second close");
          wsolClosed = true;
        } else if (data.length === 1 && data[0] === 17) {
          need(a.length === 1, "sync accounts");
          const account = at(a[0]!);
          need(account !== null && account !== ownerUsdc, "sync");
          synced.add(account!);
        } else {
          fail("token instruction");
        }
        break;
      case SYSTEM_PROGRAM: {
        need(data.length === 12 && readLe(data, 0, 4) === 2n && a.length === 2, "system instruction");
        const from = at(a[0]!);
        const to = at(a[1]!);
        const lamports = readLe(data, 4, 8);
        if (from !== owner) {
          // The fee payer's own money (a tip), never the person's.
          need(from !== null && a[0]! < header.required, "transfer source");
          break;
        }
        need(to !== null && to !== owner, "transfer destination");
        if (to === feePayer) {
          need(rentRepay === 0n && wsolCreated && wsolClosed && lamports <= SWAP_LIMITS.maxRentRepayLamports, "rent repayment");
          rentRepay = lamports;
        } else {
          need(feePaid === null && expected.router === "jupiterz", "transfer from the person");
          feePaid = { to: to!, lamports };
        }
        break;
      }
      default:
        fail("program");
    }
  }

  const s = swap ?? fail("no swap");
  need(s.inAmount === expected.inAmount, "amount differs from the review");
  need(expected.feeBps >= 0 && expected.feeBps <= SWAP_LIMITS.maxFeeBps, "fee too high");
  let minOut = s.minOut;
  let expectedOut = s.expectedOut;
  if (expected.router === "jupiterz") {
    const bound = (s.expectedOut * BigInt(expected.feeBps) + 9_999n) / 10_000n;
    if (feePaid) {
      need(feePaid.lamports <= bound && synced.has(feePaid.to), "fee above the quote");
      minOut -= feePaid.lamports;
      expectedOut -= feePaid.lamports;
    }
  } else {
    need(s.feeBps <= SWAP_LIMITS.maxFeeBps && s.feeBps <= expected.feeBps, "fee above the quote");
    need(wsolClosed, "SOL left wrapped");
  }
  need(s.slippageBps <= SWAP_LIMITS.maxSlippageBps, "slippage too wide");
  need(minOut > 0n, "pays nothing");
  need(expectedOut * 10_000n >= expected.quotedOutLamports * BigInt(SWAP_LIMITS.minQuoteFidelityBps), "worse than the quote");
  return {
    router: expected.router,
    feePayer,
    ownerSignatureIndex: ownerIndex,
    inAmount: s.inAmount,
    minOutLamports: minOut,
    expectedOutLamports: expectedOut,
  };
}

interface RouteContext {
  owner: string;
  ownerUsdc: string;
  ownerWsol: string;
  isStatic: (index: number | undefined, key: string) => boolean;
  staticOrLoaded: (index: number | undefined, key: string) => boolean;
}

/** Jupiter v6 exact-in routes only; every other v6 instruction is refused. */
function route(data: Uint8Array, a: number[], c: RouteContext): Swap {
  const need = (ok: boolean, why: string) => {
    if (!ok) throw new UnsafeTransaction(why);
  };
  const noneOrWsol = (index: number | undefined) => c.isStatic(index, JUPITER_V6) || c.isStatic(index, c.ownerWsol);
  let inAmount: bigint;
  let quotedOut: bigint;
  let slippageBps: number;
  let feeBps: number;
  if (startsWith(data, ROUTE_V2) || startsWith(data, SHARED_ROUTE_V2)) {
    const shared = startsWith(data, SHARED_ROUTE_V2);
    const o = shared ? 9 : 8; // shared_accounts_route_v2 carries an `id: u8` first
    need(data.length >= o + 26, "route data");
    inAmount = readLe(data, o, 8);
    quotedOut = readLe(data, o + 8, 8);
    slippageBps = Number(readLe(data, o + 16, 2));
    feeBps = Number(readLe(data, o + 18, 2));
    if (shared) {
      need(a.length >= 12, "route accounts");
      need(c.isStatic(a[1], c.owner) && c.isStatic(a[2], c.ownerUsdc), "route spends from another account");
      need(c.isStatic(a[5], c.ownerWsol), "route pays someone else");
      need(c.staticOrLoaded(a[6], USDC_MINT) && c.staticOrLoaded(a[7], WSOL_MINT), "route mint");
    } else {
      need(a.length >= 10, "route accounts");
      need(c.isStatic(a[0], c.owner) && c.isStatic(a[1], c.ownerUsdc), "route spends from another account");
      need(c.isStatic(a[2], c.ownerWsol) && noneOrWsol(a[7]), "route pays someone else");
      need(c.staticOrLoaded(a[3], USDC_MINT) && c.staticOrLoaded(a[4], WSOL_MINT), "route mint");
      need(c.staticOrLoaded(a[5], TOKEN_PROGRAM) && c.staticOrLoaded(a[6], TOKEN_PROGRAM), "route token programs");
    }
  } else if (startsWith(data, ROUTE) || startsWith(data, SHARED_ROUTE)) {
    // v1: route_plan first, then a fixed 19-byte tail.
    const shared = startsWith(data, SHARED_ROUTE);
    need(data.length >= 8 + (shared ? 1 : 0) + 4 + 19, "route data");
    const tail = data.length - 19;
    inAmount = readLe(data, tail, 8);
    quotedOut = readLe(data, tail + 8, 8);
    slippageBps = Number(readLe(data, tail + 16, 2));
    feeBps = data[tail + 18]!;
    if (shared) {
      need(a.length >= 13, "route accounts");
      need(c.isStatic(a[2], c.owner) && c.isStatic(a[3], c.ownerUsdc), "route spends from another account");
      need(c.isStatic(a[6], c.ownerWsol), "route pays someone else");
      need(c.staticOrLoaded(a[7], USDC_MINT) && c.staticOrLoaded(a[8], WSOL_MINT), "route mint");
    } else {
      need(a.length >= 9, "route accounts");
      need(c.isStatic(a[1], c.owner) && c.isStatic(a[2], c.ownerUsdc), "route spends from another account");
      need(c.isStatic(a[3], c.ownerWsol) && noneOrWsol(a[4]), "route pays someone else");
      need(c.staticOrLoaded(a[5], WSOL_MINT), "route mint");
    }
  } else {
    throw new UnsafeTransaction("not an exact-in route");
  }
  need(quotedOut > 0n, "route pays nothing");
  // Out after slippage, then after Jupiter's fee (taken from the output).
  const afterFee = (v: bigint) => (v * BigInt(10_000 - feeBps)) / 10_000n;
  return {
    inAmount,
    expectedOut: afterFee(quotedOut),
    minOut: afterFee((quotedOut * BigInt(10_000 - slippageBps)) / 10_000n),
    slippageBps,
    feeBps,
  };
}
