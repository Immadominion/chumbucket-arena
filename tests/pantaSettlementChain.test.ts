/** Chain facts for the lifecycle, against a SYNTHETIC JSON-RPC. Nothing is sent anywhere. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DROPPED_SAFETY_BLOCKS, PantaSettlementChain, usdcDeltaOf } from "../src/prediction/PantaSettlementChain.ts";
import { MAINNET_GENESIS_HASH, MAINNET_USDC_MINT } from "../src/prediction/PantaChain.ts";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(9));
const wallet = owner.publicKey.toBase58();
const addr = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const market = addr(3), program = addr(2);

function rpc(handlers: Record<string, (params: unknown[]) => unknown>, genesis = MAINNET_GENESIS_HASH) {
  const methods: string[] = [];
  const fetchImpl = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    methods.push(body.method);
    const result = body.method === "getGenesisHash" ? genesis : handlers[body.method]?.(body.params);
    if (result === undefined) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "synthetic: no handler" } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }, { preconnect: fetch.preconnect });
  return { chain: new PantaSettlementChain("https://synthetic-rpc.invalid", fetchImpl), methods };
}
const statuses = (value: unknown) => ({ context: { slot: 1 }, value: [value] });

test("the owner's USDC delta counts only their own native USDC", () => {
  const b = (amount: string, o = wallet, mint = MAINNET_USDC_MINT) => ({ owner: o, mint, uiTokenAmount: { amount, decimals: 6 } });
  expect(usdcDeltaOf({ preTokenBalances: [b("1000000")], postTokenBalances: [b("39400000")] }, wallet)).toBe(38_400_000n);
  expect(usdcDeltaOf({ preTokenBalances: [b("5")], postTokenBalances: [b("5"), b("9", addr(8))] }, wallet)).toBe(0n);
  expect(usdcDeltaOf({ preTokenBalances: [], postTokenBalances: [b("9", wallet, market)] }, wallet)).toBe(0n);
  expect(usdcDeltaOf({}, wallet)).toBeNull();
});

test("never-landed needs an unseen signature both before and after a finalized height well past expiry", async () => {
  const sig = "5".repeat(87);
  const past = rpc({ getSignatureStatuses: () => statuses(null), getBlockHeight: () => 1_000 + DROPPED_SAFETY_BLOCKS + 1 });
  expect(await past.chain.neverLanded(sig, 1_000)).toBe(true);
  expect(past.methods.filter(m => m === "getSignatureStatuses")).toHaveLength(2);
  const soon = rpc({ getSignatureStatuses: () => statuses(null), getBlockHeight: () => 1_000 + DROPPED_SAFETY_BLOCKS });
  expect(await soon.chain.neverLanded(sig, 1_000)).toBe(false);
  const seen = rpc({ getSignatureStatuses: () => statuses({ slot: 5, confirmations: null, err: null, confirmationStatus: "finalized" }), getBlockHeight: () => 99_999 });
  expect(await seen.chain.neverLanded(sig, 1_000)).toBe(false);
  const broken = rpc({ getBlockHeight: () => 99_999 });
  expect(await broken.chain.neverLanded(sig, 1_000)).toBe(false);
  const devnet = rpc({ getSignatureStatuses: () => statuses(null), getBlockHeight: () => 99_999 }, "synthetic-devnet");
  await expect(devnet.chain.neverLanded(sig, 1_000)).rejects.toThrow("mainnet verification");
});

function confirmedClaim(over: { err?: unknown; credit?: string; program?: string } = {}) {
  const ix = new TransactionInstruction({ programId: new PublicKey(over.program ?? program), data: Buffer.from([1, 2, 3]),
    keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: new PublicKey(market), isSigner: false, isWritable: true }] });
  const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: addr(4), instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(message); tx.sign([owner]);
  const signature = utils.bytes.bs58.encode(tx.signatures[0]!);
  const balance = (amount: string) => ({ accountIndex: 1, mint: MAINNET_USDC_MINT, owner: wallet, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } });
  const result = { slot: 77, blockTime: null, version: 0,
    transaction: { signatures: [signature], message: { accountKeys: message.staticAccountKeys.map(k => k.toBase58()), header: message.header,
      recentBlockhash: message.recentBlockhash, addressTableLookups: [],
      instructions: message.compiledInstructions.map(c => ({ programIdIndex: c.programIdIndex, accounts: c.accountKeyIndexes, data: utils.bytes.bs58.encode(Buffer.from(c.data)) })) } },
    meta: { err: over.err ?? null, fee: 5000, preBalances: [1, 1, 1], postBalances: [1, 1, 1], innerInstructions: [], logMessages: [],
      preTokenBalances: [balance("1000000")], postTokenBalances: [balance(over.credit ?? "39400000")], loadedAddresses: { writable: [], readonly: [] } } };
  return { signature, messageHash: createHash("sha256").update(message.serialize()).digest("hex"), result };
}

test("a claim is proven only by a successful exact message that paid the owner USDC", async () => {
  const good = confirmedClaim();
  const input = { signature: good.signature, owner: wallet, market, programId: program, messageHash: good.messageHash };
  expect(await rpc({ getTransaction: () => good.result }).chain.verifyClaim(input)).toEqual({ payoutBaseUnits: "38400000", slot: 77 });
  expect(await rpc({ getTransaction: () => good.result }).chain.verifyClaim({ ...input, messageHash: "0".repeat(64) })).toBeNull();
  expect(await rpc({ getTransaction: () => good.result }).chain.verifyClaim({ ...input, programId: addr(22) })).toBeNull();
  expect(await rpc({ getTransaction: () => good.result }).chain.verifyClaim({ ...input, owner: addr(23) })).toBeNull();
  const failed = confirmedClaim({ err: { InstructionError: [0, "Custom"] } });
  expect(await rpc({ getTransaction: () => failed.result }).chain.verifyClaim({ ...input, signature: failed.signature, messageHash: failed.messageHash })).toBeNull();
  const unpaid = confirmedClaim({ credit: "1000000" });
  expect(await rpc({ getTransaction: () => unpaid.result }).chain.verifyClaim({ ...input, signature: unpaid.signature, messageHash: unpaid.messageHash })).toBeNull();
  expect(await rpc({ getTransaction: () => null }).chain.verifyClaim(input)).toBeNull();
});

test("an insecure or credential-bearing RPC is refused at construction", () => {
  expect(() => new PantaSettlementChain("http://synthetic-rpc.invalid")).toThrow("secure mainnet RPC");
  expect(() => new PantaSettlementChain("https://user:pass@synthetic-rpc.invalid")).toThrow("secure mainnet RPC");
});
