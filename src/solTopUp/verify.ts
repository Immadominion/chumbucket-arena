/**
 * Strict checks on a Jupiter gasless USDC -> SOL swap before anyone signs it.
 *
 * The person signs this with their own wallet. A wallet app shows its own
 * simulation; the wallet that lives on the phone does not, so the phone runs
 * the same rules (lib/features/sol_topup/domain/gasless_swap_check.dart) and
 * this server copy runs them again before the transaction is shown at all.
 *
 * What a swap may do, and nothing else (shapes read from real mainnet
 * transactions, docs/gasless-sol-topup.md §4):
 *
 *   - v0, at most 3 signers, signed by someone else as fee payer (Jupiter's
 *     gas wallet for Metis routes, the market maker for JupiterZ). The
 *     person's own signature slot is empty: nothing has been signed for them.
 *   - Top level, only: ComputeBudget; ATA create(-idempotent) of the
 *     person's OWN USDC/WSOL account, paid by the fee payer; exactly ONE
 *     swap — Jupiter v6 `route`/`shared_accounts_route` (v1 or v2) or a
 *     JupiterZ `fill` — spending exactly the reviewed USDC from the person's
 *     canonical USDC account into their canonical WSOL account (or native
 *     SOL); a CloseAccount of that WSOL account back to the person; at most
 *     one rent repayment to the fee payer for the WSOL account it created;
 *     at most one Jupiter fee payment bounded by the quoted fee bps.
 *   - System transfers from anyone but the person are the fee payer's own
 *     money (tips) and are allowed.
 *
 * Accounts that belong to the person (the wallet, its USDC and WSOL
 * accounts) are always static keys: lookup tables hold shared accounts only,
 * and signers can never come from a lookup table. So every check that
 * protects the person works without resolving lookup tables. The server also
 * resolves them (see inspect.ts) to check the mints.
 */

import { createHash } from "node:crypto";
import { PublicKey, VersionedTransaction, type MessageV0 } from "@solana/web3.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
/** Jupiter Aggregator v6 (Metis router). */
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/** JupiterZ order engine (RFQ router). */
export const JUPITERZ_PROGRAM = "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH";
/** `signatureFeePayer` when Jupiter sponsors the gas (Swap API docs). */
export const JUPITER_GAS_WALLET = "gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB";

/** Ceilings no quote may exceed, whatever Jupiter says. */
export const SWAP_LIMITS = {
  /** Jupiter's own fee, including any gas recoup. 3%. */
  maxFeeBps: 300,
  maxSlippageBps: 300,
  /** A 165-byte token account at the pre-2026 rent rate; today's is lower. */
  maxRentRepayLamports: 2_039_280n,
  /** A JupiterZ quote may not be valid for longer than this. */
  maxFillTtlSeconds: 600,
  /** The swap must deliver at least this share of the quoted SOL (basis points). */
  minQuoteFidelityBps: 9_900,
} as const;

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const ROUTE = disc("route");
const SHARED_ROUTE = disc("shared_accounts_route");
const ROUTE_V2 = disc("route_v2");
const SHARED_ROUTE_V2 = disc("shared_accounts_route_v2");
const FILL = disc("fill");

export class SwapCheckError extends Error {
  constructor(readonly reason: string) {
    super(`swap check failed: ${reason}`);
    this.name = "SwapCheckError";
  }
}

export type SwapRouter = "metis" | "jupiterz";

export interface ExpectedSwap {
  owner: string;
  /** Exact USDC base units the person reviewed. */
  inAmount: bigint;
  router: SwapRouter;
  /** The order's `outAmount`: SOL lamports after Jupiter's fee, before slippage. */
  quotedOutLamports: bigint;
  /** The order's `feeBps`. */
  feeBps: number;
  /** Seconds since epoch, for JupiterZ quote expiry. */
  nowSeconds: number;
}

export interface CheckedSwap {
  router: SwapRouter;
  feePayer: string;
  /** Position of the person's signature in the signature list. */
  ownerSignatureIndex: number;
  inAmount: bigint;
  /** What the transaction itself promises, net of Jupiter's fee and of
   *  slippage. The person receives at least this. */
  minOutLamports: bigint;
  /** What it promises before slippage, net of fee. */
  expectedOutLamports: bigint;
  feeBps: number;
  slippageBps: number;
  rentRepayLamports: bigint;
  /** Instruction slots whose mints sit in lookup tables, for the server's
   *  resolved check: [index of instruction, account position, expected mint]. */
  mintSlots: Array<{ accountIndex: number; mint: string }>;
  /** sha256 of the message bytes (what the person signs). */
  messageHash: string;
}

export function ownerTokenAccount(owner: string, mint: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0].toBase58();
}

export function messageHashOf(tx: VersionedTransaction): string {
  return createHash("sha256").update(tx.message.serialize()).digest("hex");
}

const u64 = (data: Uint8Array, at: number) => Buffer.from(data).readBigUInt64LE(at);
const u16 = (data: Uint8Array, at: number) => Buffer.from(data).readUInt16LE(at);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const startsWith = (data: Uint8Array, prefix: Uint8Array) => data.length >= prefix.length && same(data.subarray(0, prefix.length), prefix);

/** Parses and checks the unsigned transaction Jupiter returned. Throws SwapCheckError. */
export function checkGaslessSwap(bytes: Uint8Array, expected: ExpectedSwap): CheckedSwap {
  const fail = (reason: string): never => {
    throw new SwapCheckError(reason);
  };
  const need = (ok: boolean, reason: string) => {
    if (!ok) fail(reason);
  };

  let tx: VersionedTransaction;
  try {
    need(bytes.length > 0 && bytes.length <= 1232, "size");
    tx = VersionedTransaction.deserialize(bytes);
  } catch (error) {
    if (error instanceof SwapCheckError) throw error;
    return fail("encoding");
  }
  need(tx.version === 0, "not a v0 transaction");
  need(Buffer.from(tx.serialize()).equals(Buffer.from(bytes)), "non-canonical encoding");
  const message = tx.message as MessageV0;
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const header = message.header;
  const owner = expected.owner;
  const ownerUsdc = ownerTokenAccount(owner, USDC_MINT);
  const ownerWsol = ownerTokenAccount(owner, WSOL_MINT);
  const loadedCount = message.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  const totalKeys = keys.length + loadedCount;

  need(header.numRequiredSignatures >= 2 && header.numRequiredSignatures <= 3, "signer count");
  need(tx.signatures.length === header.numRequiredSignatures, "signature slots");
  need(new Set(keys).size === keys.length, "duplicate keys");
  const feePayer = keys[0]!;
  need(feePayer !== owner, "the person would pay the network fee");
  const ownerIndex = keys.indexOf(owner);
  const writableSigners = header.numRequiredSignatures - header.numReadonlySignedAccounts;
  need(ownerIndex >= 1 && ownerIndex < writableSigners, "the person is not a signer");
  need(tx.signatures[ownerIndex]!.every((b) => b === 0), "already signed for the person");
  for (const forbidden of [ownerUsdc, ownerWsol]) {
    // The person's token accounts are never signers.
    const at = keys.indexOf(forbidden);
    need(at < 0 || at >= header.numRequiredSignatures, "token account as signer");
  }

  const at = (index: number): string | null => (index < keys.length ? keys[index]! : index < totalKeys ? null : fail("account index"));
  const isStatic = (index: number, key: string) => index < keys.length && keys[index] === key;
  const staticOrLoaded = (index: number, key: string) => (index < keys.length ? keys[index] === key : index < totalKeys);

  let swap: { inAmount: bigint; expectedOut: bigint; minOut: bigint; slippageBps: number; feeBps: number; maker?: string } | null = null;
  let wsolCreated = false;
  let wsolClosed = false;
  let rentRepay = 0n;
  let jupiterFeePaid: { to: string; lamports: bigint } | null = null;
  const syncedNative = new Set<string>();
  const mintSlots: CheckedSwap["mintSlots"] = [];
  let ataCreates = 0;

  for (const ix of message.compiledInstructions) {
    need(ix.programIdIndex > 0 && ix.programIdIndex < keys.length, "program index");
    need(ix.programIdIndex >= header.numRequiredSignatures, "program as signer");
    const program = keys[ix.programIdIndex]!;
    const data = ix.data;
    const accounts = ix.accountKeyIndexes;
    for (const index of accounts) at(index);

    switch (program) {
      case COMPUTE_BUDGET_PROGRAM: {
        // Paid by the fee payer, never the person; only well-formed requests.
        need(accounts.length === 0 && data.length >= 1 && data.length <= 9, "compute budget");
        if (data[0] === 2) need(data.length === 5 && Buffer.from(data).readUInt32LE(1) <= 1_400_000, "compute limit");
        else if (data[0] === 3) need(data.length === 9, "compute price");
        else need(data[0] === 1 || data[0] === 4, "compute budget kind");
        break;
      }
      case ATA_PROGRAM: {
        // create / create-idempotent of the person's own USDC or WSOL account,
        // paid by the fee payer.
        need(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)), "token account instruction");
        need(accounts.length === 6 && ++ataCreates <= 2, "token account accounts");
        const [payer, account, wallet, mint, system, token] = accounts as [number, number, number, number, number, number];
        need(isStatic(payer, feePayer), "token account paid by the person");
        need(isStatic(wallet, owner), "token account for someone else");
        need(isStatic(account, ownerWsol) || isStatic(account, ownerUsdc), "unexpected token account");
        need(isStatic(system, SYSTEM_PROGRAM) && isStatic(token, TOKEN_PROGRAM), "token account programs");
        const mintKey = isStatic(account, ownerWsol) ? WSOL_MINT : USDC_MINT;
        need(staticOrLoaded(mint, mintKey), "token account mint");
        if (mint >= keys.length) mintSlots.push({ accountIndex: mint, mint: mintKey });
        if (isStatic(account, ownerWsol)) wsolCreated = true;
        break;
      }
      case JUPITER_V6_PROGRAM: {
        need(swap === null && expected.router === "metis", "second or unexpected swap");
        swap = checkJupiterRoute(data, accounts, { owner, ownerUsdc, ownerWsol, isStatic, staticOrLoaded, mintSlots, keys });
        break;
      }
      case JUPITERZ_PROGRAM: {
        need(swap === null && expected.router === "jupiterz", "second or unexpected swap");
        // input_amount u64, output_amount u64, expire_at i64 (the on-chain IDL,
        // v0.1.0). Live fills carry up to 5 more bytes the published IDL does
        // not describe; they are tolerated, bounded, and the server's
        // simulation (inspect.ts) proves the exact USDC debit regardless.
        need(data.length >= 32 && data.length <= 40 && startsWith(data, FILL), "not a fill");
        need(accounts.length >= 11, "fill accounts");
        const [taker, maker, takerIn, , takerOut, , inMint, inToken, outMint, outToken, system] = accounts as number[];
        need(isStatic(taker!, owner), "fill taker");
        need(isStatic(maker!, feePayer), "maker is not the fee payer");
        need(isStatic(takerIn!, ownerUsdc), "fill spends from another account");
        // None (the program id) delivers native SOL to the taker.
        need(isStatic(takerOut!, JUPITERZ_PROGRAM) || isStatic(takerOut!, ownerWsol), "fill pays someone else");
        need(staticOrLoaded(inMint!, USDC_MINT) && staticOrLoaded(outMint!, WSOL_MINT), "fill mints");
        need(staticOrLoaded(inToken!, TOKEN_PROGRAM) && staticOrLoaded(outToken!, TOKEN_PROGRAM) && staticOrLoaded(system!, SYSTEM_PROGRAM), "fill programs");
        const inAmount = u64(data, 8);
        const outAmount = u64(data, 16);
        const expireAt = Number(Buffer.from(data).readBigInt64LE(24));
        need(outAmount > 0n, "fill pays nothing");
        need(expireAt > expected.nowSeconds && expireAt <= expected.nowSeconds + SWAP_LIMITS.maxFillTtlSeconds, "fill expiry");
        swap = { inAmount, expectedOut: outAmount, minOut: outAmount, slippageBps: 0, feeBps: 0, maker: keys[maker!]! };
        break;
      }
      case TOKEN_PROGRAM: {
        if (data.length === 1 && data[0] === 9) {
          // CloseAccount(the person's WSOL account) -> the person, by the person.
          need(accounts.length === 3, "close accounts");
          need(isStatic(accounts[0]!, ownerWsol) && isStatic(accounts[1]!, owner) && isStatic(accounts[2]!, owner), "close pays someone else");
          need(!wsolClosed, "second close");
          wsolClosed = true;
        } else if (data.length === 1 && data[0] === 17) {
          need(accounts.length === 1, "sync accounts");
          const synced = at(accounts[0]!);
          need(synced !== null && synced !== ownerUsdc, "sync");
          syncedNative.add(synced!);
        } else {
          fail("token instruction");
        }
        break;
      }
      case SYSTEM_PROGRAM: {
        need(data.length === 12 && Buffer.from(data).readUInt32LE(0) === 2 && accounts.length === 2, "system instruction");
        const from = at(accounts[0]!);
        const to = at(accounts[1]!);
        const lamports = u64(data, 4);
        if (from !== owner) {
          // The fee payer's own money (a tip). Never the person's.
          need(from !== null && accounts[0]! < header.numRequiredSignatures, "transfer source");
          break;
        }
        need(to !== null && to !== owner, "transfer destination");
        if (to === feePayer) {
          // Repays the rent the fee payer put into the person's WSOL account,
          // which the close just refunded to the person.
          need(rentRepay === 0n && wsolCreated && wsolClosed && lamports <= SWAP_LIMITS.maxRentRepayLamports, "rent repayment");
          rentRepay = lamports;
        } else {
          need(jupiterFeePaid === null && expected.router === "jupiterz", "transfer from the person");
          jupiterFeePaid = { to: to!, lamports };
        }
        break;
      }
      default:
        fail(`program ${program.slice(0, 8)}`);
    }
  }

  const s = swap ?? fail("no swap");
  need(s.inAmount === expected.inAmount, "amount differs from the review");
  need(expected.feeBps >= 0 && expected.feeBps <= SWAP_LIMITS.maxFeeBps, "fee too high");
  let minOut = s.minOut;
  let expectedOut = s.expectedOut;
  let feeBps = s.feeBps;
  if (expected.router === "jupiterz") {
    // RFQ: Jupiter's fee is a separate SOL payment after the fill, bounded by
    // the quoted fee, into an account it then syncs.
    feeBps = expected.feeBps;
    const bound = (s.expectedOut * BigInt(expected.feeBps) + 9_999n) / 10_000n;
    if (jupiterFeePaid) {
      need(jupiterFeePaid.lamports <= bound && syncedNative.has(jupiterFeePaid.to), "fee above the quote");
      minOut -= jupiterFeePaid.lamports;
      expectedOut -= jupiterFeePaid.lamports;
    }
  } else {
    // The route takes its fee from the output; never more than quoted.
    need(s.feeBps <= SWAP_LIMITS.maxFeeBps && s.feeBps <= expected.feeBps, "fee above the quote");
    need(wsolClosed, "SOL left wrapped");
  }
  need(s.slippageBps <= SWAP_LIMITS.maxSlippageBps, "slippage too wide");
  // A rent repayment only returns what the close just refunded: the person's
  // SOL from this swap is unchanged by it.
  need(minOut > 0n, "pays nothing");
  need(expectedOut * 10_000n >= expected.quotedOutLamports * BigInt(SWAP_LIMITS.minQuoteFidelityBps), "worse than the quote");

  return {
    router: expected.router,
    feePayer,
    ownerSignatureIndex: ownerIndex,
    inAmount: s.inAmount,
    minOutLamports: minOut,
    expectedOutLamports: expectedOut,
    feeBps,
    slippageBps: s.slippageBps,
    rentRepayLamports: rentRepay,
    mintSlots,
    messageHash: messageHashOf(tx),
  };
}

interface RouteContext {
  owner: string;
  ownerUsdc: string;
  ownerWsol: string;
  keys: string[];
  isStatic: (index: number, key: string) => boolean;
  staticOrLoaded: (index: number, key: string) => boolean;
  mintSlots: CheckedSwap["mintSlots"];
}

/** Jupiter v6 ExactIn routes. Every other v6 instruction (exact-out, token
 *  ledger, claims) is refused. */
function checkJupiterRoute(data: Uint8Array, accounts: number[], c: RouteContext) {
  const need = (ok: boolean, reason: string) => {
    if (!ok) throw new SwapCheckError(reason);
  };
  const mint = (index: number | undefined, key: string) => {
    need(index !== undefined && c.staticOrLoaded(index, key), "route mint");
    if (index! >= c.keys.length) c.mintSlots.push({ accountIndex: index!, mint: key });
  };
  const noneOrWsol = (index: number | undefined) =>
    index !== undefined && (c.isStatic(index, JUPITER_V6_PROGRAM) || c.isStatic(index, c.ownerWsol));

  let inAmount: bigint, quotedOut: bigint, slippageBps: number, feeBps: number;
  if (startsWith(data, ROUTE_V2) || startsWith(data, SHARED_ROUTE_V2)) {
    const shared = startsWith(data, SHARED_ROUTE_V2);
    const o = shared ? 9 : 8; // shared_accounts_route_v2 carries an `id: u8` first
    need(data.length >= o + 22 + 4, "route data");
    inAmount = u64(data, o);
    quotedOut = u64(data, o + 8);
    slippageBps = u16(data, o + 16);
    feeBps = u16(data, o + 18);
    if (shared) {
      // program_authority, user_transfer_authority, source, program_source,
      // program_destination, destination, source_mint, destination_mint, ...
      need(accounts.length >= 12, "route accounts");
      need(c.isStatic(accounts[1]!, c.owner) && c.isStatic(accounts[2]!, c.ownerUsdc), "route spends from another account");
      need(c.isStatic(accounts[5]!, c.ownerWsol), "route pays someone else");
      mint(accounts[6], USDC_MINT);
      mint(accounts[7], WSOL_MINT);
    } else {
      // user_transfer_authority, user_source, user_destination, source_mint,
      // destination_mint, source_token_program, destination_token_program,
      // destination_token_account (None or the user's), event_authority, program
      need(accounts.length >= 10, "route accounts");
      need(c.isStatic(accounts[0]!, c.owner) && c.isStatic(accounts[1]!, c.ownerUsdc), "route spends from another account");
      need(c.isStatic(accounts[2]!, c.ownerWsol) && noneOrWsol(accounts[7]), "route pays someone else");
      mint(accounts[3], USDC_MINT);
      mint(accounts[4], WSOL_MINT);
      need(c.staticOrLoaded(accounts[5]!, TOKEN_PROGRAM) && c.staticOrLoaded(accounts[6]!, TOKEN_PROGRAM), "route token programs");
    }
  } else if (startsWith(data, ROUTE) || startsWith(data, SHARED_ROUTE)) {
    // v1: route_plan first, then in_amount u64, quoted_out u64, slippage u16,
    // platform_fee u8 — a fixed 19-byte tail.
    const shared = startsWith(data, SHARED_ROUTE);
    need(data.length >= 8 + (shared ? 1 : 0) + 4 + 19, "route data");
    const t = data.length - 19;
    inAmount = u64(data, t);
    quotedOut = u64(data, t + 8);
    slippageBps = u16(data, t + 16);
    feeBps = data[t + 18]!;
    if (shared) {
      need(accounts.length >= 13, "route accounts");
      need(c.isStatic(accounts[2]!, c.owner) && c.isStatic(accounts[3]!, c.ownerUsdc), "route spends from another account");
      need(c.isStatic(accounts[6]!, c.ownerWsol), "route pays someone else");
      mint(accounts[7], USDC_MINT);
      mint(accounts[8], WSOL_MINT);
    } else {
      need(accounts.length >= 9, "route accounts");
      need(c.isStatic(accounts[1]!, c.owner) && c.isStatic(accounts[2]!, c.ownerUsdc), "route spends from another account");
      need(c.isStatic(accounts[3]!, c.ownerWsol) && noneOrWsol(accounts[4]), "route pays someone else");
      mint(accounts[5], WSOL_MINT);
    }
  } else {
    throw new SwapCheckError("not an exact-in route");
  }
  need(quotedOut > 0n, "route pays nothing");
  // Out after slippage, then after Jupiter's fee (taken from the output).
  const afterFee = (v: bigint) => (v * BigInt(10_000 - feeBps)) / 10_000n;
  const expectedOut = afterFee(quotedOut);
  const minOut = afterFee((quotedOut * BigInt(10_000 - slippageBps)) / 10_000n);
  return { inAmount, expectedOut, minOut, slippageBps, feeBps };
}
