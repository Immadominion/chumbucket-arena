/**
 * The web app's Panta buy (web/lib/webapp/trade.ts, solanaTx.ts): the
 * browser only checks that a wallet signed exactly the transaction the BFF
 * built, in its own slot, then hands the bytes back to the BFF. Test doubles
 * stand in for the BFF and the wallet; the transactions are real v0 bytes.
 */

import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  base64ToBytes,
  bytesToBase64,
  messageBytes,
  signatureSection,
  signedOnlyInSlot,
  withSignature,
} from "../web/lib/webapp/solanaTx.ts";
import { isFinal, placeTrade, TradeError, usdToBaseUnits, type PreparedTrade, type TradeApi, type TradeOrder } from "../web/lib/webapp/trade.ts";
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

describe("placing a trade", () => {
  function rig(over: Partial<PreparedTrade["order"]> = {}, now = 1_000) {
    const payload = bytesToBase64(unsignedTx());
    const submitted: Array<{ orderId: string; signedTransaction: string }> = [];
    const prepared: Array<Record<string, unknown>> = [];
    const api: TradeApi = {
      async prepareTrade(input) {
        prepared.push(input);
        return {
          order: { orderId: "ord_1", owner: input.wallet, side: "YES", amountBaseUnits: input.amountBaseUnits, fundingState: "QUOTED",
            transaction: { encoding: "solana-tx-base64", payload, expiresAt: now + 60_000 }, expiresAt: now + 60_000, ...over },
          review: { amountUsdc: "5.000000", amountBaseUnits: input.amountBaseUnits, avgPrice: "0.5", feeUsdc: "0.01", expectedShares: "9.9" },
        };
      },
      async submitTrade(orderId, signedTransaction) {
        submitted.push({ orderId, signedTransaction });
        return { orderId, owner: owner.publicKey.toBase58(), side: "YES", amountBaseUnits: "5000000", fundingState: "SUBMITTED", fillTxSignature: null, updatedAt: now } satisfies TradeOrder;
      },
    };
    return { api, submitted, prepared, payload, now: () => now };
  }
  const signer = { address: owner.publicKey.toBase58(), sign: async (b: Uint8Array) => sign(b) };

  test("prepare for this wallet, sign the exact bytes, submit them: SUBMITTED, never funded", async () => {
    const h = rig();
    const order = await placeTrade({ api: h.api, callId, amountBaseUnits: usdToBaseUnits(5), idempotencyKey: "intent-1", signer, now: h.now });
    expect(order.fundingState).toBe("SUBMITTED");
    expect(isFinal(order)).toBe(false);
    expect(h.prepared).toEqual([{ callId, wallet: signer.address, amountBaseUnits: "5000000", idempotencyKey: "intent-1", maxSlippageBps: 100 }]);
    expect(h.submitted).toHaveLength(1);
    expect(signedOnlyInSlot(base64ToBytes(h.payload), base64ToBytes(h.submitted[0]!.signedTransaction))).toBe(true);
  });

  test("a quote for another wallet or amount, an expired quote, a refusal or a rewrite never reaches submit", async () => {
    const other = rig({ owner: stranger.publicKey.toBase58() });
    await expect(placeTrade({ api: other.api, callId, amountBaseUnits: "5000000", idempotencyKey: "k", signer, now: other.now })).rejects.toMatchObject({ kind: "mismatch" });
    const amount = rig({ amountBaseUnits: "6000000" });
    await expect(placeTrade({ api: amount.api, callId, amountBaseUnits: "5000000", idempotencyKey: "k", signer, now: amount.now })).rejects.toMatchObject({ kind: "mismatch" });
    const expired = rig({ transaction: { encoding: "solana-tx-base64", payload: bytesToBase64(unsignedTx()), expiresAt: 999 } });
    await expect(placeTrade({ api: expired.api, callId, amountBaseUnits: "5000000", idempotencyKey: "k", signer, now: expired.now })).rejects.toMatchObject({ kind: "expired" });
    const declined = rig();
    await expect(placeTrade({ api: declined.api, callId, amountBaseUnits: "5000000", idempotencyKey: "k", now: declined.now,
      signer: { address: signer.address, sign: async () => { throw new Error("user rejected"); } } })).rejects.toBeInstanceOf(TradeError);
    const rewritten = rig();
    await expect(placeTrade({ api: rewritten.api, callId, amountBaseUnits: "5000000", idempotencyKey: "k", now: rewritten.now,
      signer: { address: signer.address, sign: async () => sign(unsignedTx(owner.publicKey, 99)) } })).rejects.toMatchObject({ kind: "mismatch" });
    for (const h of [other, amount, expired, declined, rewritten]) expect(h.submitted).toHaveLength(0);
  });

  test("whole dollars only", () => {
    expect(usdToBaseUnits(25)).toBe("25000000");
    expect(() => usdToBaseUnits(0)).toThrow();
    expect(() => usdToBaseUnits(2.5)).toThrow();
  });
});

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
