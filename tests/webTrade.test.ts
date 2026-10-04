/**
 * The web app's Panta buy (web/lib/webapp/trade.ts, pantaBuyCheck.ts,
 * solanaTx.ts): before any wallet signs, the browser checks the BFF's bytes
 * are exactly the reviewed buy; after, that the wallet signed only its own
 * slot. Test doubles stand in for the BFF and the wallet; the transactions
 * are real v0 bytes in the BFF's shape.
 */

import { describe, expect, test } from "bun:test";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash, randomBytes } from "node:crypto";
import { checkPantaBuy, isOnCurve, UnsafeTransaction, usdcAccountOf } from "../web/lib/webapp/pantaBuyCheck.ts";
import {
  base64ToBytes,
  bytesToBase64,
  messageBytes,
  signatureSection,
  signedOnlyInSlot,
  withSignature,
} from "../web/lib/webapp/solanaTx.ts";
import {
  confirmTrade,
  isFinal,
  placeTrade,
  reviewTrade,
  TradeError,
  usdToBaseUnits,
  type PreparedTrade,
  type TradeApi,
  type TradeOrder,
} from "../web/lib/webapp/trade.ts";
import { sign as nodeSign } from "node:crypto";
import { isLinkChallenge, LINK_DOMAIN, LINK_URI, linkChumbucketWallet, type WalletLinkApi } from "../web/lib/webapp/chumbucketLink.ts";
import { WalletLinkService } from "../src/auth/WalletLinkService.ts";
import { FakeIdentityStore, FakeJwtVerifier, makeWallet, TEST_DOMAIN, TEST_URI, testPolicy } from "./authIdentityFixtures.ts";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const stranger = Keypair.fromSeed(new Uint8Array(32).fill(8));
const blockhash = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
const callId = "30000000-0000-4000-8000-000000000001";

function unsignedTx(payer = owner.publicKey, lamports = 1): Uint8Array {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: stranger.publicKey, lamports })],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}
function sign(bytes: Uint8Array, signer = owner): Uint8Array {
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([signer]);
  return tx.serialize();
}

describe("solana transaction bytes", () => {
  test("reads the signature section and the message", () => {
    const tx = unsignedTx();
    expect(signatureSection(tx)).toEqual({ count: 1, messageOffset: 65 });
    expect(Buffer.from(messageBytes(tx))).toEqual(Buffer.from(VersionedTransaction.deserialize(tx).message.serialize()));
    expect(base64ToBytes(bytesToBase64(tx))).toEqual(tx);
    expect(() => signatureSection(new Uint8Array([1, 0, 0]))).toThrow();
    expect(() => signatureSection(new Uint8Array([]))).toThrow();
  });

  test("accepts only the same message with the owner's slot signed", () => {
    const tx = unsignedTx();
    const signed = sign(tx);
    expect(signedOnlyInSlot(tx, signed)).toBe(true);
    // Unsigned, a rewritten message, or a different transaction entirely.
    expect(signedOnlyInSlot(tx, tx)).toBe(false);
    expect(signedOnlyInSlot(tx, sign(unsignedTx(owner.publicKey, 2)))).toBe(false);
    expect(signedOnlyInSlot(tx, sign(unsignedTx(stranger.publicKey), stranger))).toBe(false);
    expect(signedOnlyInSlot(tx, signed.subarray(0, signed.length - 1))).toBe(false);
  });

  test("a detached signature lands in its slot and nowhere else", () => {
    const tx = unsignedTx();
    const signed = sign(tx);
    expect(withSignature(tx, signed.subarray(1, 65))).toEqual(signed);
    expect(() => withSignature(tx, new Uint8Array(63))).toThrow();
    expect(() => withSignature(tx, new Uint8Array(64), 1)).toThrow();
  });
});

// ── a real Panta primary buy, as the BFF's PantaExecution builds it ──
const PANTA = "6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const market = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const pda = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const usdcAta = (who: PublicKey) => PublicKey.findProgramAddressSync([who.toBuffer(), TOKEN.toBuffer(), USDC.toBuffer()], ATA)[0];

interface BuyOpts {
  side?: "YES" | "NO";
  amount?: bigint;
  units?: number;
  payer?: PublicKey;
  tokenAccount?: PublicKey;
  extra?: TransactionInstruction[];
  memo?: boolean;
  lookup?: boolean;
}
function pantaBuy(o: BuyOpts = {}): Uint8Array {
  const who = owner.publicKey;
  const ata = o.tokenAccount ?? usdcAta(who);
  const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const data = Buffer.alloc(17);
  createHash("sha256").update("global:primary_order_usdc").digest().copy(data, 0, 0, 8);
  data[8] = (o.side ?? "YES") === "YES" ? 0 : 1;
  data.writeBigUInt64LE(o.amount ?? 5_000_000n, 9);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: o.units ?? 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [m(who, true, true), m(ata, true), m(who), m(USDC), m(SystemProgram.programId), m(TOKEN)] }),
    new TransactionInstruction({ programId: new PublicKey(PANTA), data, keys: [m(who, true, true), m(new PublicKey(market), true), m(pda(5)), m(pda(6)), m(pda(7), true), m(pda(8), true), m(USDC), m(ata, true), m(pda(10), true), m(TOKEN), m(ATA), m(SystemProgram.programId)] }),
    ...(o.extra ?? []),
    ...(o.memo === false ? [] : [new TransactionInstruction({ programId: MEMO, data: Buffer.from("panta:v1:usr_synthetic:qt_1:ord_1"), keys: [m(who, false, true)] })]),
  ];
  const lookups = o.lookup
    ? [new AddressLookupTableAccount({ key: pda(20), state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [pda(5), pda(6)] } })]
    : [];
  const message = new TransactionMessage({ payerKey: o.payer ?? who, recentBlockhash: blockhash, instructions }).compileToV0Message(lookups);
  return new VersionedTransaction(message).serialize();
}
const reviewedBuy = { owner: owner.publicKey.toBase58(), venueMarketId: market, side: "YES" as const, amountBaseUnits: "5000000" };

describe("the browser's own check before any wallet signs", () => {
  test("exactly the reviewed buy passes", async () => {
    await checkPantaBuy(pantaBuy(), reviewedBuy);
    await checkPantaBuy(pantaBuy({ side: "NO" }), { ...reviewedBuy, side: "NO" });
  });

  test("a USDC transfer, an extra instruction, the wrong side or amount, a foreign fee payer: refused", async () => {
    const thief = stranger.publicKey;
    const cases: Array<[string, Uint8Array]> = [
      ["usdc transfer", pantaBuy({ extra: [createTransferInstructionLike(usdcAta(owner.publicKey), usdcAta(thief), owner.publicKey, 5_000_000n)] })],
      ["sol transfer", pantaBuy({ extra: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: thief, lamports: 1 })] })],
      ["wrong side", pantaBuy({ side: "NO" })],
      ["wrong amount", pantaBuy({ amount: 9_000_000n })],
      ["foreign fee payer", pantaBuy({ payer: thief })],
      ["not the owner's USDC account", pantaBuy({ tokenAccount: usdcAta(thief) })],
      ["compute units over the cap", pantaBuy({ units: 1_400_001 })],
      ["no attribution memo", pantaBuy({ memo: false })],
      ["address lookup table", pantaBuy({ lookup: true })],
    ];
    for (const [name, tx] of cases) {
      expect({ name, refused: await checkPantaBuy(tx, reviewedBuy).then(() => false, (e) => e instanceof UnsafeTransaction) }).toEqual({ name, refused: true });
    }
    // Another market is another buy.
    await expect(checkPantaBuy(pantaBuy(), { ...reviewedBuy, venueMarketId: thief.toBase58() })).rejects.toBeInstanceOf(UnsafeTransaction);
    // A signed transaction is not a review.
    await expect(checkPantaBuy(sign(pantaBuy()), reviewedBuy)).rejects.toBeInstanceOf(UnsafeTransaction);
  });

  test("program addresses and the curve check agree with @solana/web3.js", async () => {
    for (let i = 0; i < 40; i++) {
      const who = Keypair.generate().publicKey;
      expect(await usdcAccountOf(who.toBase58())).toBe(usdcAta(who).toBase58());
      const bytes = new Uint8Array(randomBytes(32));
      expect(isOnCurve(bytes)).toBe(PublicKey.isOnCurve(bytes));
      expect(isOnCurve(who.toBytes())).toBe(true);
    }
  });
});

describe("placing a trade", () => {
  function rig(over: Partial<PreparedTrade["order"]> = {}, now = 1_000, payload = bytesToBase64(pantaBuy())) {
    const submitted: Array<{ orderId: string; signedTransaction: string }> = [];
    const prepared: Array<Record<string, unknown>> = [];
    const api: TradeApi = {
      async prepareTrade(input) {
        prepared.push(input);
        return {
          order: { orderId: "ord_1", owner: input.wallet, side: "YES", amountBaseUnits: input.amountBaseUnits, fundingState: "QUOTED",
            transaction: { encoding: "solana-tx-base64", payload, expiresAt: now + 60_000 }, expiresAt: now + 60_000, ...over },
          review: { amountUsdc: "5.000000", amountBaseUnits: input.amountBaseUnits, avgPrice: "0.5", feeUsdc: "0.01", expectedShares: "9.2" },
        };
      },
      async submitTrade(orderId, signedTransaction) {
        submitted.push({ orderId, signedTransaction });
        return { orderId, owner: owner.publicKey.toBase58(), side: "YES", amountBaseUnits: "5000000", fundingState: "SUBMITTED", fillTxSignature: null, updatedAt: now } satisfies TradeOrder;
      },
    };
    return { api, submitted, prepared, payload, now: () => now };
  }
  const signs: Uint8Array[] = [];
  const signer = { address: owner.publicKey.toBase58(), sign: async (b: Uint8Array) => { signs.push(b); return sign(b); } };
  const trade = (h: ReturnType<typeof rig>, s = signer) =>
    placeTrade({ api: h.api, callId, venueMarketId: market, side: "YES", amountBaseUnits: usdToBaseUnits(5), idempotencyKey: "intent-1", signer: s, now: h.now });

  test("review shows dollars only, then the exact bytes are signed and submitted: SUBMITTED, never funded", async () => {
    const h = rig();
    const reviewed = await reviewTrade({ api: h.api, callId, venueMarketId: market, side: "YES", amountBaseUnits: "5000000", idempotencyKey: "intent-1", signer, now: h.now });
    expect([reviewed.pay, reviewed.win, reviewed.fee]).toEqual(["$5.00", "~$9.20", "$0.01"]);
    expect(h.submitted).toHaveLength(0);
    const order = await confirmTrade({ api: h.api, reviewed, now: h.now });
    expect(order.fundingState).toBe("SUBMITTED");
    expect(isFinal(order)).toBe(false);
    expect(h.prepared).toEqual([{ callId, wallet: signer.address, amountBaseUnits: "5000000", idempotencyKey: "intent-1", maxSlippageBps: 100 }]);
    expect(signedOnlyInSlot(base64ToBytes(h.payload), base64ToBytes(h.submitted[0]!.signedTransaction))).toBe(true);
  });

  test("a malicious payload never reaches a wallet, let alone submit", async () => {
    signs.length = 0;
    const thief = stranger.publicKey;
    for (const tx of [
      pantaBuy({ extra: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: thief, lamports: 1 })] }),
      pantaBuy({ amount: 50_000_000n }),
      pantaBuy({ side: "NO" }),
      pantaBuy({ payer: thief }),
    ]) {
      const h = rig({}, 1_000, bytesToBase64(tx));
      await expect(trade(h)).rejects.toMatchObject({ kind: "unsafe" });
      expect(h.submitted).toHaveLength(0);
    }
    expect(signs).toHaveLength(0);
  });

  test("a quote for another wallet or amount, an expired quote, a refusal or a rewrite never reaches submit", async () => {
    const other = rig({ owner: stranger.publicKey.toBase58() });
    await expect(trade(other)).rejects.toMatchObject({ kind: "mismatch" });
    const amount = rig({ amountBaseUnits: "6000000" });
    await expect(trade(amount)).rejects.toMatchObject({ kind: "mismatch" });
    const expired = rig({ transaction: { encoding: "solana-tx-base64", payload: bytesToBase64(pantaBuy()), expiresAt: 999 } });
    await expect(trade(expired)).rejects.toMatchObject({ kind: "expired" });
    const declined = rig();
    await expect(trade(declined, { address: signer.address, sign: async () => { throw new Error("user rejected"); } })).rejects.toBeInstanceOf(TradeError);
    const rewritten = rig();
    await expect(trade(rewritten, { address: signer.address, sign: async () => sign(pantaBuy({ amount: 1n })) })).rejects.toMatchObject({ kind: "mismatch" });
    for (const h of [other, amount, expired, declined, rewritten]) expect(h.submitted).toHaveLength(0);
  });

  test("whole dollars only", () => {
    expect(usdToBaseUnits(25)).toBe("25000000");
    expect(() => usdToBaseUnits(0)).toThrow();
    expect(() => usdToBaseUnits(2.5)).toThrow();
  });
});

/** An SPL Token `Transfer` (instruction 3) from one token account to another. */
function createTransferInstructionLike(from: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: TOKEN, data, keys: [
    { pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false },
  ] });
}

describe("linking the Chumbucket wallet from the browser", () => {
  // The web helper against the BFF's real WalletLinkService (in-memory store).
  function rig(chumbucketWallet = true) {
    const store = new FakeIdentityStore().addUser("auth-web", "user-web");
    const verifier = new FakeJwtVerifier().issue("tok-web", "auth-web");
    const service = new WalletLinkService({
      store, verifier, chumbucketWallet,
      policy: { ...testPolicy, allowedDomains: [...testPolicy.allowedDomains], allowedUris: [...testPolicy.allowedUris] },
    });
    const api: WalletLinkApi = {
      requestWalletLink: (token, address) =>
        service.requestWalletNonce({ accessToken: token, address, domain: LINK_DOMAIN, uri: LINK_URI, purpose: "link_wallet" }),
      linkWallet: (token, input) => service.linkWallet({ accessToken: token, purpose: "link_wallet", ...input }),
    };
    return { store, api };
  }

  test("the browser's domain is the BFF's own, so the challenge is issued and the proof links it as chumbucket", async () => {
    expect([LINK_DOMAIN, LINK_URI]).toEqual([TEST_DOMAIN, TEST_URI]);
    const { store, api } = rig();
    const wallet = makeWallet();
    let signed = "";
    await linkChumbucketWallet({
      api, token: "tok-web", address: wallet.address,
      signMessage: async (message) => {
        signed = new TextDecoder().decode(message);
        return new Uint8Array(nodeSign(null, Buffer.from(message), wallet.privateKey));
      },
    });
    expect(isLinkChallenge(signed, wallet.address)).toBe(true);
    expect(store.walletOwner(wallet.address)).toBe("user-web");
    expect(store.walletTypeOf(wallet.address)).toBe("chumbucket");
  });

  test("a challenge for another address, a short signature, or the flag off: nothing is linked", async () => {
    const wallet = makeWallet();
    const other = makeWallet();
    const sign = async (message: Uint8Array) => new Uint8Array(nodeSign(null, Buffer.from(message), wallet.privateKey));
    const swapped = rig();
    await expect(linkChumbucketWallet({
      api: { ...swapped.api, requestWalletLink: (token) => swapped.api.requestWalletLink(token, other.address) },
      token: "tok-web", address: wallet.address, signMessage: sign,
    })).rejects.toThrow("challenge");
    const short = rig();
    await expect(linkChumbucketWallet({ api: short.api, token: "tok-web", address: wallet.address, signMessage: async () => new Uint8Array(63) }))
      .rejects.toThrow("signature");
    const off = rig(false);
    await expect(linkChumbucketWallet({ api: off.api, token: "tok-web", address: wallet.address, signMessage: sign }))
      .rejects.toMatchObject({ code: "WALLET_TYPE_UNAVAILABLE" });
    for (const h of [swapped, short, off]) expect(h.store.walletOwner(wallet.address)).toBeUndefined();
  });
});
