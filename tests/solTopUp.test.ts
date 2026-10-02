/**
 * Gasless SOL top-up (Jupiter Swap API v2) — every money-relevant rule, offline.
 *
 * Transactions are REAL mainnet shapes with synthetic identities
 * (tests/fixtures/jupiterGasless.ts). Jupiter, the RPC and the accounts are
 * fakes. Nothing here signs anything but a synthetic test key, and nothing is
 * sent anywhere.
 */

import { describe, expect, test } from "bun:test";
import { createHmac, pbkdf2Sync } from "node:crypto";
import {
  AddressLookupTableAccount,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import { appRouter } from "../src/api/router.ts";
import { solTopUpRouter } from "../src/api/solTopUp.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { DepositPerson } from "../src/deposits/accounts.ts";
import { primeDepositsRuntime, type DepositsRuntime } from "../src/deposits/runtime.ts";
import { DepositRateLimiter } from "../src/deposits/service.ts";
import type { WalletBalance, WalletBalanceReader } from "../src/deposits/balance.ts";
import { MAINNET_GENESIS_HASH } from "../src/prediction/PantaChain.ts";
import { JUPITER_SWAP_API, resolveSolTopUp, usdcToBaseUnits, type SolTopUpConfig } from "../src/solTopUp/config.ts";
import { loadedKeys, RpcSwapInspector, type SwapEffect, type SwapInspector } from "../src/solTopUp/inspect.ts";
import { HttpJupiterTransport, JupiterHttpError, type JupiterExecuteResult, type JupiterOrder, type JupiterOrderRequest, type JupiterTransport } from "../src/solTopUp/jupiter.ts";
import { solNeed, tradesCovered, type RentReader } from "../src/solTopUp/need.ts";
import { primeSolTopUpRuntime } from "../src/solTopUp/runtime.ts";
import { SolTopUpService } from "../src/solTopUp/service.ts";
import {
  checkGaslessSwap,
  ownerTokenAccount,
  SwapCheckError,
  USDC_MINT,
  WSOL_MINT,
  type CheckedSwap,
  type ExpectedSwap,
} from "../src/solTopUp/verify.ts";
import { METIS, OWNER, OWNER_USDC, OWNER_WSOL, RFQ, TEST_PHRASE } from "./fixtures/jupiterGasless.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** SLIP-0010 ed25519 at m/44'/501'/0'/0' — how Phantom, Solflare and the app's
 *  on-phone wallet open a recovery phrase. */
function keyFromPhrase(phrase: string): Keypair {
  const seed = pbkdf2Sync(phrase, "mnemonic", 2048, 64, "sha512");
  let node = createHmac("sha512", "ed25519 seed").update(seed).digest();
  for (const index of [44, 501, 0, 0]) {
    const i = Buffer.alloc(4);
    i.writeUInt32BE((index | 0x80000000) >>> 0);
    node = createHmac("sha512", node.subarray(32)).update(Buffer.concat([Buffer.alloc(1), node.subarray(0, 32), i])).digest();
  }
  return Keypair.fromSeed(node.subarray(0, 32));
}
const ownerKey = keyFromPhrase(TEST_PHRASE);
const stranger = Keypair.fromSeed(new Uint8Array(32).fill(9));

const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const metisExpected = (over: Partial<ExpectedSwap> = {}): ExpectedSwap => ({
  owner: OWNER,
  inAmount: METIS.inAmount,
  router: "metis",
  quotedOutLamports: METIS.outAmount,
  feeBps: METIS.feeBps,
  nowSeconds: METIS.blockTime,
  ...over,
});
const rfqExpected = (over: Partial<ExpectedSwap> = {}): ExpectedSwap => ({
  owner: OWNER,
  inAmount: RFQ.inAmount,
  router: "jupiterz",
  quotedOutLamports: RFQ.outAmount,
  feeBps: RFQ.feeBps,
  nowSeconds: RFQ.blockTime,
  ...over,
});

/** Rebuilds a fixture with a change to its compiled message. */
function mutate(b64: string, change: (m: { keys: PublicKey[]; ixs: MessageV0["compiledInstructions"]; header: MessageV0["header"] }) => void, signatures?: (sigs: Uint8Array[]) => void): Uint8Array {
  const tx = VersionedTransaction.deserialize(bytesOf(b64));
  const m = tx.message as MessageV0;
  const keys = m.staticAccountKeys.slice();
  const ixs = m.compiledInstructions.map((ix) => ({ ...ix, accountKeyIndexes: ix.accountKeyIndexes.slice(), data: new Uint8Array(ix.data) }));
  const header = { ...m.header };
  change({ keys, ixs, header });
  const message = new MessageV0({ header, staticAccountKeys: keys, recentBlockhash: m.recentBlockhash, compiledInstructions: ixs, addressTableLookups: m.addressTableLookups });
  const sigs = tx.signatures.map((s) => new Uint8Array(s));
  signatures?.(sigs);
  return new VersionedTransaction(message, sigs).serialize();
}
const programIx = (ixs: MessageV0["compiledInstructions"], keys: PublicKey[], program: string) =>
  ixs.find((ix) => keys[ix.programIdIndex]!.toBase58() === program)!;
const refuses = (bytes: Uint8Array, expected: ExpectedSwap, reason?: RegExp) => {
  let caught: unknown;
  try {
    checkGaslessSwap(bytes, expected);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SwapCheckError);
  if (reason) expect((caught as SwapCheckError).reason).toMatch(reason);
};

// ── the static rules ─────────────────────────────────────────────────────────

describe("checkGaslessSwap on real transaction shapes", () => {
  test("a Jupiter-sponsored Metis route_v2 passes, with what the person gets", () => {
    const c = checkGaslessSwap(bytesOf(METIS.unsignedBase64), metisExpected());
    expect(c).toMatchObject({ router: "metis", feePayer: METIS.feePayer, ownerSignatureIndex: 1, inAmount: METIS.inAmount, feeBps: 11, slippageBps: 34 });
    // quoted_out 106,138,175 less 34 bps slippage, then less the 11 bps fee.
    expect(c.minOutLamports).toBe(105_660_949n);
    expect(c.expectedOutLamports).toBe(106_021_423n);
    // What really landed for the original swapper was more than promised.
    expect(c.minOutLamports <= 106_119_149n).toBe(true);
    // The temporary WSOL account's rent, repaid to the sponsor after the close.
    expect(c.rentRepayLamports).toBe(1_488_440n);
    // The mints sit in lookup tables: flagged for the server's resolved check.
    expect(c.mintSlots.map((s) => s.mint).sort()).toEqual([USDC_MINT, WSOL_MINT, WSOL_MINT].sort());
  });

  test("a market-maker-paid JupiterZ fill passes; its fee transfer is bounded and counted", () => {
    const c = checkGaslessSwap(bytesOf(RFQ.unsignedBase64), rfqExpected());
    expect(c).toMatchObject({ router: "jupiterz", feePayer: RFQ.feePayer, inAmount: RFQ.inAmount, feeBps: 10 });
    // Exactly what the original swapper received: 4,597,565 - 4,597.
    expect(c.minOutLamports).toBe(4_592_968n);
  });

  test("the person's canonical token accounts are what the fixtures use", () => {
    expect(ownerTokenAccount(OWNER, USDC_MINT)).toBe(OWNER_USDC);
    expect(ownerTokenAccount(OWNER, WSOL_MINT)).toBe(OWNER_WSOL);
    expect(ownerKey.publicKey.toBase58()).toBe(OWNER);
  });

  test("refuses another amount, owner, router or a worse price than quoted", () => {
    refuses(bytesOf(METIS.unsignedBase64), metisExpected({ inAmount: METIS.inAmount + 1n }), /amount/);
    refuses(bytesOf(METIS.unsignedBase64), metisExpected({ owner: stranger.publicKey.toBase58() }), /signer/);
    refuses(bytesOf(METIS.unsignedBase64), metisExpected({ router: "jupiterz" }), /swap/);
    refuses(bytesOf(METIS.unsignedBase64), metisExpected({ quotedOutLamports: 108_000_000n }), /quote/);
    refuses(bytesOf(METIS.unsignedBase64), metisExpected({ feeBps: 5 }), /fee/);
    refuses(bytesOf(RFQ.unsignedBase64), rfqExpected({ inAmount: 1n }), /amount/);
  });

  test("refuses a transaction the person would pay gas for", () => {
    // Swap the first two keys: the person becomes the fee payer.
    const bytes = mutate(METIS.unsignedBase64, ({ keys }) => {
      const [a, b] = [keys[0]!, keys[1]!];
      keys[0] = b;
      keys[1] = a;
    });
    refuses(bytes, metisExpected(), /network fee/);
  });

  test("refuses anything already signed for the person", () => {
    const bytes = mutate(METIS.unsignedBase64, () => {}, (sigs) => sigs[1]!.fill(7));
    refuses(bytes, metisExpected(), /already signed/);
  });

  test("refuses a route that pays someone else or spends another account", () => {
    const toFeeAccount = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      programIx(ixs, keys, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4").accountKeyIndexes[2] = 2;
    });
    refuses(toFeeAccount, metisExpected(), /pays someone else/);
    const redirected = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      programIx(ixs, keys, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4").accountKeyIndexes[7] = 2;
    });
    refuses(redirected, metisExpected(), /pays someone else/);
    const otherSource = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      programIx(ixs, keys, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4").accountKeyIndexes[1] = 2;
    });
    refuses(otherSource, metisExpected(), /another account/);
  });

  test("refuses a changed amount or fee inside the route data", () => {
    const more = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      const ix = programIx(ixs, keys, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
      Buffer.from(ix.data.buffer, ix.data.byteOffset).writeBigUInt64LE(METIS.inAmount * 2n, 8);
    });
    refuses(more, metisExpected(), /amount/);
    const fee = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      const ix = programIx(ixs, keys, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
      Buffer.from(ix.data.buffer, ix.data.byteOffset).writeUInt16LE(400, 26);
    });
    refuses(fee, metisExpected({ feeBps: 400 }), /fee/);
  });

  test("refuses an extra SOL transfer from the person, or a bigger rent repayment", () => {
    const steal = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      const transfer = SystemProgram.transfer({ fromPubkey: keys[1]!, toPubkey: keys[2]!, lamports: 1 });
      ixs.push({ programIdIndex: keys.findIndex((k) => k.equals(SystemProgram.programId)), accountKeyIndexes: [1, 2], data: transfer.data });
    });
    refuses(steal, metisExpected(), /transfer/);
    const greedy = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      const ix = programIx(ixs, keys, "11111111111111111111111111111111");
      Buffer.from(ix.data.buffer, ix.data.byteOffset).writeBigUInt64LE(5_000_000n, 4);
    });
    refuses(greedy, metisExpected(), /rent/);
  });

  test("refuses a close that pays someone else, a token transfer, or another program", () => {
    const close = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      programIx(ixs, keys, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").accountKeyIndexes[1] = 0;
    });
    refuses(close, metisExpected(), /close/);
    const transfer = mutate(METIS.unsignedBase64, ({ keys, ixs }) => {
      const ix = programIx(ixs, keys, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      ix.data = Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]);
    });
    refuses(transfer, metisExpected(), /token instruction/);
    const memo = mutate(METIS.unsignedBase64, ({ keys }) => {
      keys[keys.findIndex((k) => k.toBase58() === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")] = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    });
    refuses(memo, metisExpected(), /program/);
  });

  test("refuses a fill paid by someone other than its maker, a stale fill, or a bigger fee", () => {
    const makerless = mutate(RFQ.unsignedBase64, ({ keys, ixs }) => {
      programIx(ixs, keys, "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH").accountKeyIndexes[1] = 3;
    });
    refuses(makerless, rfqExpected(), /maker/);
    refuses(bytesOf(RFQ.unsignedBase64), rfqExpected({ nowSeconds: RFQ.blockTime + 3_600 }), /expiry/);
    const fee = mutate(RFQ.unsignedBase64, ({ keys, ixs }) => {
      const ix = programIx(ixs, keys, "11111111111111111111111111111111");
      Buffer.from(ix.data.buffer, ix.data.byteOffset).writeBigUInt64LE(100_000n, 4);
    });
    refuses(fee, rfqExpected(), /fee/);
    const toThirdParty = mutate(RFQ.unsignedBase64, ({ keys, ixs }) => {
      programIx(ixs, keys, "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH").accountKeyIndexes[4] = 3;
    });
    refuses(toThirdParty, rfqExpected(), /someone else/);
  });

  test("refuses garbage and oversize input", () => {
    refuses(new Uint8Array([1, 2, 3]), metisExpected(), /encoding/);
    refuses(new Uint8Array(1300), metisExpected(), /size/);
  });
});

// ── the server's resolved look ──────────────────────────────────────────────

function altAccountData(addresses: PublicKey[]): Buffer {
  const header = Buffer.alloc(56);
  header.writeUInt32LE(1, 0); // LookupTable
  header.writeBigUInt64LE(0xffffffffffffffffn, 4); // never deactivated
  return Buffer.concat([header, ...addresses.map((a) => a.toBuffer())]);
}
function tableAddresses(table: Record<string, string>): PublicKey[] {
  const size = Math.max(...Object.keys(table).map(Number)) + 1;
  return Array.from({ length: size }, (_, i) => new PublicKey(table[String(i)] ?? "11111111111111111111111111111111"));
}
function tokenAccountData(mint: string, owner: string, amount: bigint): string {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data.toString("base64");
}

describe("server inspection: lookup tables resolved, mainnet simulated", () => {
  const checked = () => checkGaslessSwap(bytesOf(METIS.unsignedBase64), metisExpected());

  test("loaded keys follow Solana's order: every table's writable keys, then readonly", () => {
    const tx = VersionedTransaction.deserialize(bytesOf(METIS.unsignedBase64));
    const tables = new Map(Object.entries(METIS.tables).map(([k, v]) => [k, tableAddresses(v)]));
    const loaded = loadedKeys(tx.message as MessageV0, tables);
    const statics = tx.message.staticAccountKeys.length;
    for (const slot of checked().mintSlots) expect(loaded[slot.accountIndex - statics]).toBe(slot.mint);
  });

  function rpcFake(opts: { genesis?: string; swapMints?: boolean; simErr?: unknown; postLamports?: number; postUsdc?: bigint } = {}) {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.method);
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
      const ctx = { context: { slot: 9, apiVersion: "2.0.0" } };
      switch (body.method) {
        case "getGenesisHash":
          return reply(opts.genesis ?? MAINNET_GENESIS_HASH);
        case "getAccountInfo": {
          const table = { ...METIS.tables[body.params[0] as string] } as Record<string, string>;
          if (opts.swapMints) for (const [i, v] of Object.entries(table)) if (v === WSOL_MINT) table[i] = USDC_MINT;
          return reply({ ...ctx, value: { data: [altAccountData(tableAddresses(table)).toString("base64"), "base64"], executable: false, lamports: 1, owner: "AddressLookupTab1e1111111111111111111111111", rentEpoch: 0, space: 0 } });
        }
        case "getMultipleAccounts":
          return reply({ ...ctx, value: [
            { data: ["", "base64"], executable: false, lamports: 0, owner: "11111111111111111111111111111111", rentEpoch: 0, space: 0 },
            { data: [tokenAccountData(USDC_MINT, OWNER, 20_000_000n), "base64"], executable: false, lamports: 2_039_280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 165 },
          ] });
        case "simulateTransaction":
          return reply({ ...ctx, value: {
            err: opts.simErr ?? null, logs: [], unitsConsumed: 1,
            accounts: [
              { data: ["", "base64"], executable: false, lamports: opts.postLamports ?? 106_119_149, owner: "11111111111111111111111111111111", rentEpoch: 0 },
              { data: [tokenAccountData(USDC_MINT, OWNER, opts.postUsdc ?? 20_000_000n - METIS.inAmount), "base64"], executable: false, lamports: 2_039_280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0 },
            ],
          } });
        default:
          throw new Error(`unexpected ${body.method}`);
      }
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  test("measures exactly what the swap does to the person's SOL and USDC", async () => {
    const { fetchImpl, calls } = rpcFake();
    const effect = await new RpcSwapInspector("https://rpc.synthetic.invalid", fetchImpl).inspect(VersionedTransaction.deserialize(bytesOf(METIS.unsignedBase64)), OWNER, checked());
    expect(effect).toEqual({ lamportsDelta: 106_119_149n, usdcDelta: -METIS.inAmount });
    expect(calls).toContain("simulateTransaction");
    expect(calls).not.toContain("sendTransaction");
  });

  test("refuses a route whose lookup table holds another mint", async () => {
    const { fetchImpl } = rpcFake({ swapMints: true });
    await expect(new RpcSwapInspector("https://rpc.synthetic.invalid", fetchImpl).inspect(VersionedTransaction.deserialize(bytesOf(METIS.unsignedBase64)), OWNER, checked())).rejects.toBeInstanceOf(SwapCheckError);
  });

  test("refuses a swap that would fail, and a devnet RPC", async () => {
    await expect(new RpcSwapInspector("https://rpc.synthetic.invalid", rpcFake({ simErr: { InstructionError: [3, "Custom"] } }).fetchImpl).inspect(VersionedTransaction.deserialize(bytesOf(METIS.unsignedBase64)), OWNER, checked())).rejects.toBeInstanceOf(SwapCheckError);
    await expect(new RpcSwapInspector("https://rpc.synthetic.invalid", rpcFake({ genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }).fetchImpl).inspect(VersionedTransaction.deserialize(bytesOf(METIS.unsignedBase64)), OWNER, checked())).rejects.toThrow("not mainnet");
  });

  test("never accepts an insecure RPC URL", () => {
    expect(() => new RpcSwapInspector("http://rpc.synthetic.invalid")).toThrow();
    expect(() => new RpcSwapInspector("https://user:pass@rpc.synthetic.invalid")).toThrow();
  });
});

// ── SOL need ─────────────────────────────────────────────────────────────────

const rent: RentReader = {
  // Mainnet's answers on 2 October 2026.
  async minimumBalance(bytes) {
    return ({ 0: 650_240n, 165: 1_488_440n, 202: 1_676_400n } as Record<number, bigint>)[bytes] ?? 0n;
  },
};

describe("what a Panta buy needs in SOL", () => {
  test("a new position's rent plus fees, above the wallet's own rent floor", async () => {
    const need = await solNeed(rent);
    expect(need).toEqual({ perTradeLamports: 1_686_400n, floorLamports: 650_240n });
    expect(tradesCovered(0n, need)).toBe(0);
    expect(tradesCovered(650_240n + 1_686_399n, need)).toBe(0);
    expect(tradesCovered(650_240n + 1_686_400n, need)).toBe(1);
    // About $1 of SOL today (8.47M lamports) pays for four new positions.
    expect(tradesCovered(8_470_153n, need)).toBe(4);
  });
});

// ── the service ──────────────────────────────────────────────────────────────

class FakeJupiter implements JupiterTransport {
  orders: JupiterOrderRequest[] = [];
  executes: Array<{ signedTransaction: string; requestId: string }> = [];
  nextOrders: Array<Partial<JupiterOrder> | Error> = [];
  nextExecute: JupiterExecuteResult | Error = { status: "Success", signature: "5".repeat(88), code: 0, totalInputAmount: "1000000", totalOutputAmount: "8470153" };
  price: JupiterOrder = { inputMint: USDC_MINT, outputMint: WSOL_MINT, inAmount: "1000000", outAmount: "8470153", router: "metis" };

  async order(request: JupiterOrderRequest): Promise<JupiterOrder> {
    this.orders.push(request);
    if (!request.taker) return { ...this.price, inAmount: request.amount };
    const next = this.nextOrders.shift();
    if (next instanceof Error) throw next;
    return { inputMint: USDC_MINT, outputMint: WSOL_MINT, taker: request.taker, ...next } as JupiterOrder;
  }

  async execute(signedTransaction: string, requestId: string): Promise<JupiterExecuteResult> {
    this.executes.push({ signedTransaction, requestId });
    if (this.nextExecute instanceof Error) throw this.nextExecute;
    return this.nextExecute;
  }
}

const metisOrder = (over: Partial<JupiterOrder> = {}): Partial<JupiterOrder> => ({
  router: "metis",
  inAmount: METIS.inAmount.toString(),
  outAmount: METIS.outAmount.toString(),
  feeBps: METIS.feeBps,
  slippageBps: 34,
  gasless: true,
  signatureFeePayer: METIS.feePayer,
  prioritizationFeePayer: METIS.feePayer,
  rentFeePayer: METIS.feePayer,
  transaction: METIS.unsignedBase64,
  requestId: "req-metis-0001",
  ...over,
});
const rfqOrder = (over: Partial<JupiterOrder> = {}): Partial<JupiterOrder> => ({
  router: "jupiterz",
  inAmount: RFQ.inAmount.toString(),
  outAmount: RFQ.outAmount.toString(),
  feeBps: RFQ.feeBps,
  gasless: true,
  signatureFeePayer: RFQ.feePayer,
  prioritizationFeePayer: RFQ.feePayer,
  transaction: RFQ.unsignedBase64,
  requestId: "req-rfq-0001",
  expireAt: String(RFQ.blockTime + 20),
  ...over,
});

const USER = "10000000-0000-4000-8000-0000000000e1";
const person = (over: Partial<DepositPerson> = {}): DepositPerson => ({
  userId: USER,
  authUserId: "20000000-0000-4000-8000-0000000000e1",
  wallets: [{ address: OWNER, walletType: "embedded", primary: true, session: false }],
  email: null,
  ...over,
});

function rig(opts: { lamports?: string; usdc?: string; nowSeconds?: number; inspector?: SwapInspector } = {}) {
  const jupiter = new FakeJupiter();
  const config: SolTopUpConfig = {
    apiBase: JUPITER_SWAP_API,
    apiKey: "synthetic-jupiter-key-never-real",
    minUsdcBaseUnits: 500_000n,
    targetUsdcBaseUnits: 1_000_000n,
    maxUsdcBaseUnits: 25_000_000n,
    tradesToCover: 3,
    minIntervalMs: 0,
  };
  const balances: WalletBalanceReader = {
    async read(wallet): Promise<WalletBalance> {
      return { wallet, network: "solana-mainnet", lamports: opts.lamports ?? "0", usdcBaseUnits: opts.usdc ?? "20000000", slot: 1, readAt: "2026-10-02T12:00:00.000Z" };
    },
  };
  const inspected: Array<{ owner: string; checked: CheckedSwap }> = [];
  const inspector: SwapInspector = opts.inspector ?? {
    async inspect(_tx, owner, checked): Promise<SwapEffect> {
      inspected.push({ owner, checked });
      return { lamportsDelta: checked.minOutLamports + 1n, usdcDelta: -checked.inAmount };
    },
  };
  const nowMs = (opts.nowSeconds ?? METIS.blockTime) * 1000;
  const clock = { now: nowMs };
  const service = new SolTopUpService({ config, jupiter, inspector, rent, balances, now: () => clock.now });
  return { jupiter, service, inspected, clock };
}

function signFixture(unsigned: string, key: Keypair = ownerKey): string {
  const tx = VersionedTransaction.deserialize(bytesOf(unsigned));
  tx.sign([key]);
  return Buffer.from(tx.serialize()).toString("base64");
}

describe("SolTopUpService.plan", () => {
  test("0 SOL and USDC on hand: suggests about $1, enough for a few trades", async () => {
    const { service, jupiter } = rig();
    const plan = await service.plan(person());
    expect(plan).toMatchObject({ wallet: OWNER, needsSol: true, gaslessEligible: true, blocker: null, tradesCoveredNow: 0, perTradeLamports: "1686400", floorLamports: "650240" });
    // 3 trades + floor = 5,709,440 lamports; at 8.47M per $1 that is under $1.
    expect(plan.suggestion).toEqual({ amountBaseUnits: "1000000", estimatedLamports: "8470153", tradesCovered: 4 });
    // The price came from a quote with no taker: nothing was built to sign.
    expect(jupiter.orders).toEqual([{ inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: "1000000" }]);
  });

  test("scales up when SOL is dear, and stays within the cap", async () => {
    const { service, jupiter } = rig();
    jupiter.price = { ...jupiter.price, outAmount: "1500000" }; // SOL at ~$667
    const plan = await service.plan(person());
    expect(plan.suggestion?.amountBaseUnits).toBe("4000000");
  });

  test("enough SOL already, or not enough USDC: says which, suggests nothing", async () => {
    expect((await rig({ lamports: "10000000" }).service.plan(person())).blocker).toBe("ENOUGH_SOL");
    expect((await rig({ lamports: "7000000" }).service.plan(person())).blocker).toBe("ENOUGH_SOL");
    const poor = await rig({ usdc: "400000" }).service.plan(person());
    expect(poor).toMatchObject({ blocker: "NEEDS_USDC", suggestion: null, needsSol: true });
  });

  test("only the person's own wallets", async () => {
    await expect(rig().service.plan(person(), stranger.publicKey.toBase58())).rejects.toMatchObject({ code: "WALLET_NOT_YOURS" });
    await expect(rig().service.plan(person({ wallets: [] }))).rejects.toMatchObject({ code: "NO_WALLET" });
  });
});

describe("SolTopUpService.order", () => {
  test("a checked, simulated, Jupiter-paid Metis swap comes back for review", async () => {
    const { service, jupiter, inspected } = rig();
    jupiter.nextOrders = [metisOrder()];
    const view = await service.order(person(), { amountBaseUnits: METIS.inAmount.toString() });
    expect(jupiter.orders[0]).toMatchObject({ taker: OWNER, amount: METIS.inAmount.toString(), excludeRouters: "dflow,okx" });
    expect(inspected).toHaveLength(1);
    expect(view.transaction).toBe(METIS.unsignedBase64);
    expect(view.review).toMatchObject({
      wallet: OWNER,
      usdcInBaseUnits: METIS.inAmount.toString(),
      solOutLamports: METIS.outAmount.toString(),
      solOutMinLamports: "105660949",
      networkFeePaidBy: "jupiter",
      feePayer: METIS.feePayer,
      router: "metis",
    });
    expect(Date.parse(view.expiresAt)).toBe(METIS.blockTime * 1000 + 60_000);
  });

  test("a JupiterZ fill paid by its market maker", async () => {
    const { service, jupiter } = rig({ nowSeconds: RFQ.blockTime });
    jupiter.nextOrders = [rfqOrder()];
    const view = await service.order(person(), { amountBaseUnits: RFQ.inAmount.toString() });
    expect(view.review).toMatchObject({ networkFeePaidBy: "market_maker", feePayer: RFQ.feePayer, solOutMinLamports: "4592968" });
    expect(Date.parse(view.expiresAt)).toBe((RFQ.blockTime + 20) * 1000);
  });

  test("an unbuildable JupiterZ quote is retried once on Metis alone", async () => {
    const { service, jupiter } = rig();
    jupiter.nextOrders = [{ router: "jupiterz", inAmount: METIS.inAmount.toString(), outAmount: "1", transaction: "", errorCode: 2 }, metisOrder()];
    await service.order(person(), { amountBaseUnits: METIS.inAmount.toString() });
    expect(jupiter.orders.map((o) => o.excludeRouters)).toEqual(["dflow,okx", "dflow,okx,jupiterz"]);
  });

  test("never offers a swap the person would pay gas for", async () => {
    for (const over of [{ gasless: false }, { signatureFeePayer: OWNER }, { prioritizationFeePayer: OWNER }, { router: "dflow" }]) {
      const { service, jupiter } = rig();
      jupiter.nextOrders = [metisOrder(over)];
      await expect(service.order(person(), { amountBaseUnits: METIS.inAmount.toString() })).rejects.toMatchObject({ code: "NOT_GASLESS" });
    }
  });

  test("Jupiter's own refusals become plain answers", async () => {
    const cases: Array<[Partial<JupiterOrder>, string]> = [
      [{ transaction: "", errorCode: 3 }, "BELOW_GASLESS_MINIMUM"],
      [{ transaction: "", errorCode: 1 }, "NEEDS_USDC"],
      [{ transaction: "", errorCode: 2 }, "NOT_GASLESS"],
    ];
    for (const [over, code] of cases) {
      const { service, jupiter } = rig();
      jupiter.nextOrders = [metisOrder(over)];
      await expect(service.order(person(), { amountBaseUnits: METIS.inAmount.toString() })).rejects.toMatchObject({ code });
    }
    const limited = rig();
    limited.jupiter.nextOrders = [new JupiterHttpError(429)];
    await expect(limited.service.order(person(), { amountBaseUnits: METIS.inAmount.toString() })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const keyless = rig();
    keyless.jupiter.nextOrders = [new JupiterHttpError(401)];
    await expect(keyless.service.order(person(), { amountBaseUnits: METIS.inAmount.toString() })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("refuses a transaction that doesn't match its own quote", async () => {
    const wrongPayer = rig();
    wrongPayer.jupiter.nextOrders = [metisOrder({ signatureFeePayer: RFQ.feePayer, prioritizationFeePayer: RFQ.feePayer })];
    await expect(wrongPayer.service.order(person(), { amountBaseUnits: METIS.inAmount.toString() })).rejects.toMatchObject({ code: "SWAP_REJECTED" });
    const otherAmount = rig();
    otherAmount.jupiter.nextOrders = [metisOrder({ inAmount: "2000000" })];
    await expect(otherAmount.service.order(person(), { amountBaseUnits: "2000000" })).rejects.toMatchObject({ code: "SWAP_REJECTED" });
    const echo = rig();
    echo.jupiter.nextOrders = [metisOrder({ taker: stranger.publicKey.toBase58() })];
    await expect(echo.service.order(person(), { amountBaseUnits: METIS.inAmount.toString() })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("refuses when the mainnet simulation disagrees", async () => {
    for (const effect of [{ lamportsDelta: 1n, usdcDelta: -METIS.inAmount }, { lamportsDelta: 106_000_000n, usdcDelta: -METIS.inAmount - 1n }]) {
      const { service, jupiter } = rig({ inspector: { inspect: async () => effect } });
      jupiter.nextOrders = [metisOrder()];
      await expect(service.order(person(), { amountBaseUnits: METIS.inAmount.toString() })).rejects.toMatchObject({ code: "SWAP_REJECTED" });
    }
    const down = rig({ inspector: { inspect: async () => { throw new Error("rpc down"); } } });
    down.jupiter.nextOrders = [metisOrder()];
    await expect(down.service.order(person(), { amountBaseUnits: METIS.inAmount.toString() })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("checks amount, USDC and SOL before asking Jupiter", async () => {
    const { service, jupiter } = rig();
    await expect(service.order(person(), { amountBaseUnits: "26000000" })).rejects.toMatchObject({ code: "AMOUNT_OUT_OF_RANGE" });
    await expect(rig({ usdc: "100" }).service.order(person(), { amountBaseUnits: "1000000" })).rejects.toMatchObject({ code: "NEEDS_USDC" });
    await expect(rig({ lamports: "10000000" }).service.order(person(), { amountBaseUnits: "1000000" })).rejects.toMatchObject({ code: "ENOUGH_SOL" });
    expect(jupiter.orders).toHaveLength(0);
  });
});

describe("SolTopUpService.execute", () => {
  async function ordered() {
    const r = rig();
    r.jupiter.nextOrders = [metisOrder()];
    const view = await r.service.order(person(), { amountBaseUnits: METIS.inAmount.toString() });
    return { ...r, view };
  }

  test("forwards only the reviewed message, signed by the person, once", async () => {
    const { service, jupiter, view } = await ordered();
    const signed = signFixture(view.transaction);
    const result = await service.execute(person(), { requestId: view.requestId, signedTransaction: signed });
    expect(result).toEqual({ status: "SUCCESS", signature: "5".repeat(88), usdcSpentBaseUnits: "1000000", solReceivedLamports: "8470153" });
    expect(jupiter.executes).toEqual([{ signedTransaction: signed, requestId: view.requestId }]);
    // The same bytes again: the stored answer, no second send.
    expect(await service.execute(person(), { requestId: view.requestId, signedTransaction: signed })).toEqual(result);
    expect(jupiter.executes).toHaveLength(1);
  });

  test("refuses a signature from another key, a changed message, or an empty slot", async () => {
    const { service, jupiter, view } = await ordered();
    await expect(service.execute(person(), { requestId: view.requestId, signedTransaction: view.transaction })).rejects.toMatchObject({ code: "SIGNATURE_MISMATCH" });
    const forged = VersionedTransaction.deserialize(bytesOf(view.transaction));
    forged.signatures[1] = new Uint8Array(64).fill(1);
    await expect(service.execute(person(), { requestId: view.requestId, signedTransaction: Buffer.from(forged.serialize()).toString("base64") })).rejects.toMatchObject({ code: "SIGNATURE_MISMATCH" });
    const changed = mutate(view.transaction, ({ keys, ixs }) => {
      const ix = programIx(ixs, keys, "11111111111111111111111111111111");
      Buffer.from(ix.data.buffer, ix.data.byteOffset).writeBigUInt64LE(1_000_000n, 4);
    });
    const tx = VersionedTransaction.deserialize(changed);
    tx.sign([ownerKey]); // a valid signature, over a different message
    await expect(service.execute(person(), { requestId: view.requestId, signedTransaction: Buffer.from(tx.serialize()).toString("base64") })).rejects.toMatchObject({ code: "SIGNATURE_MISMATCH" });
    const fee = VersionedTransaction.deserialize(bytesOf(signFixture(view.transaction)));
    fee.signatures[0] = new Uint8Array(64).fill(3); // touching the sponsor's slot
    await expect(service.execute(person(), { requestId: view.requestId, signedTransaction: Buffer.from(fee.serialize()).toString("base64") })).rejects.toMatchObject({ code: "SIGNATURE_MISMATCH" });
    expect(jupiter.executes).toHaveLength(0);
  });

  test("someone else's order reads as missing; an expired one is refused", async () => {
    const { service, clock, view } = await ordered();
    await expect(service.execute(person({ userId: "10000000-0000-4000-8000-0000000000e2" }), { requestId: view.requestId, signedTransaction: signFixture(view.transaction) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    clock.now += 61_000;
    await expect(service.execute(person(), { requestId: view.requestId, signedTransaction: signFixture(view.transaction) })).rejects.toMatchObject({ code: "EXPIRED" });
  });

  test("a lost reply is UNKNOWN; only the identical bytes may be resent", async () => {
    const { service, jupiter, view } = await ordered();
    jupiter.nextExecute = new Error("socket hang up");
    const signed = signFixture(view.transaction);
    expect(await service.execute(person(), { requestId: view.requestId, signedTransaction: signed })).toMatchObject({ status: "UNKNOWN" });
    jupiter.nextExecute = { status: "Failed", code: -2003 };
    expect(await service.execute(person(), { requestId: view.requestId, signedTransaction: signed })).toEqual({ status: "FAILED", message: "The quote expired before it landed. Nothing was swapped. Get a fresh quote." });
    expect(jupiter.executes).toHaveLength(2);
  });
});

// ── config, transport, router ────────────────────────────────────────────────

describe("configuration", () => {
  const cfg = loadConfig({});
  test("paused unless switched on; honest without a key", () => {
    expect(resolveSolTopUp(cfg, {})).toMatchObject({ available: false, reason: { code: "PAUSED" } });
    expect(resolveSolTopUp(cfg, { SOL_TOPUP_ENABLED: "true" })).toMatchObject({ available: false, reason: { code: "NOT_CONFIGURED", message: "Swapping USDC for SOL isn't set up yet." } });
    expect(resolveSolTopUp(cfg, { SOL_TOPUP_ENABLED: "true", JUPITER_API_KEY: "bad key!" })).toMatchObject({ reason: { code: "MISCONFIGURED" } });
    expect(resolveSolTopUp(cfg, { SOL_TOPUP_ENABLED: "true", JUPITER_API_KEY: "synthetic-key-0123456789", SOL_TOPUP_MAX_USDC: "0.5" })).toMatchObject({ reason: { code: "MISCONFIGURED" } });
    const on = resolveSolTopUp(cfg, { SOL_TOPUP_ENABLED: "true", JUPITER_API_KEY: "synthetic-key-0123456789" });
    expect(on).toMatchObject({ available: true, config: { apiBase: "https://api.jup.ag/swap/v2", minUsdcBaseUnits: 1_000_000n, targetUsdcBaseUnits: 1_000_000n, maxUsdcBaseUnits: 5_000_000n } });
  });
  test("USDC amounts are exact", () => {
    expect(usdcToBaseUnits("1")).toBe(1_000_000n);
    expect(usdcToBaseUnits("2.25")).toBe(2_250_000n);
    expect(usdcToBaseUnits("1e3")).toBeNull();
    expect(usdcToBaseUnits("-1")).toBeNull();
  });
});

describe("HttpJupiterTransport", () => {
  test("the key goes only in x-api-key, only to api.jup.ag, with redirects refused", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(url.includes("/execute") ? { status: "Success", signature: "5".repeat(88), code: 0 } : { inputMint: USDC_MINT, outputMint: WSOL_MINT, inAmount: "1000000", outAmount: "8470153" }));
    }) as unknown as typeof fetch;
    const t = new HttpJupiterTransport(JUPITER_SWAP_API, "synthetic-key-0123456789", fetchImpl, 1_000, 0);
    await t.order({ inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: "1000000", taker: OWNER, excludeRouters: "dflow,okx" });
    await t.execute("c2lnbmVk", "req-1");
    expect(seen[0]!.url).toBe(`https://api.jup.ag/swap/v2/order?inputMint=${USDC_MINT}&outputMint=${WSOL_MINT}&amount=1000000&taker=${OWNER}&excludeRouters=dflow%2Cokx`);
    expect(seen[0]!.url).not.toContain("synthetic-key");
    expect((seen[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("synthetic-key-0123456789");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(seen[1]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ signedTransaction: "c2lnbmVk", requestId: "req-1" });
    expect(() => new HttpJupiterTransport("https://evil.example/swap/v2", "k")).toThrow();
    expect(() => new HttpJupiterTransport("http://api.jup.ag/swap/v2", "k")).toThrow();
  });

  test("a failure carries a status and code, never Jupiter's body", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: `bad request for ${OWNER}`, code: -1 }), { status: 400 })) as unknown as typeof fetch;
    const t = new HttpJupiterTransport(JUPITER_SWAP_API, "synthetic-key-0123456789", fetchImpl, 1_000, 0);
    const error = await t.order({ inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: "1" }).catch((e) => e);
    expect(error).toBeInstanceOf(JupiterHttpError);
    expect(error).toMatchObject({ status: 400, code: -1 });
    expect(String(error.message)).not.toContain(OWNER);
  });

  test("/order calls are spaced for the plan's rate limit", async () => {
    let clock = 0;
    const slept: number[] = [];
    const fetchImpl = (async () => new Response(JSON.stringify({ inputMint: USDC_MINT, outputMint: WSOL_MINT, inAmount: "1", outAmount: "1" }))) as unknown as typeof fetch;
    const t = new HttpJupiterTransport(JUPITER_SWAP_API, "synthetic-key-0123456789", fetchImpl, 1_000, 1_100, () => clock, async (ms) => {
      slept.push(ms);
      clock += ms;
    });
    await Promise.all([1, 2, 3].map(() => t.order({ inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: "1" })));
    expect(slept).toEqual([1_100, 1_100]);
  });
});

describe("solTopUp router", () => {
  async function routerRig(env: Record<string, string | undefined>) {
    const cfg = loadConfig({});
    const app = await createApp({ config: cfg });
    const deposits: DepositsRuntime = {
      readiness: { available: false, reason: null, config: null },
      service: null,
      accounts: {
        async resolve(token) {
          return token === "session-ok" ? { ok: true as const, person: person() } : { ok: false as const, reason: "SIGNED_OUT" as const };
        },
      },
      balances: null,
      limiter: new DepositRateLimiter(),
    };
    primeDepositsRuntime(cfg, deposits);
    const readiness = resolveSolTopUp(cfg, env);
    const { service } = rig({ usdc: "100" });
    primeSolTopUpRuntime(cfg, { readiness, service: readiness.available ? service : null });
    return { signedIn: solTopUpRouter.createCaller({ app, supabaseAccessToken: "session-ok" }), anonymous: solTopUpRouter.createCaller({ app }) };
  }

  test("is mounted as solTopUp.* and every procedure is a POST mutation", () => {
    const procedures = appRouter._def.procedures as Record<string, { _def?: { type?: string } }>;
    for (const name of ["status", "plan", "order", "execute"]) expect(procedures[`solTopUp.${name}`]?._def?.type).toBe("mutation");
  });

  test("unconfigured: says so in words, never shows a key, offers nothing to sign", async () => {
    const { signedIn, anonymous } = await routerRig({ SOL_TOPUP_ENABLED: "true" });
    const status = await anonymous.status();
    expect(status).toMatchObject({ available: false, reason: { code: "NOT_CONFIGURED" }, provider: "Jupiter", limits: null });
    await expect(signedIn.order({ amountBaseUnits: "1000000" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Swapping USDC for SOL isn't set up yet." });
  });

  test("configured: signed out is refused; a signed-in person gets a plan", async () => {
    const key = "synthetic-key-0123456789";
    const { signedIn, anonymous } = await routerRig({ SOL_TOPUP_ENABLED: "true", JUPITER_API_KEY: key });
    const status = await anonymous.status();
    expect(status.available).toBe(true);
    expect(JSON.stringify(status)).not.toContain(key);
    await expect(anonymous.plan({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect((await signedIn.plan({})).blocker).toBe("NEEDS_USDC");
    // An expected "no" is data the app acts on, not an error.
    expect(await signedIn.order({ amountBaseUnits: "1000000" })).toMatchObject({ status: "REFUSED", reason: "NEEDS_USDC" });
    await expect(signedIn.order({ amountBaseUnits: "1.5" as string })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

