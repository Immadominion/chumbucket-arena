import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import {
  callProofMessage,
  genericActionMessage,
  SIGNATURE_MAX_AGE_MS,
  socialActionMessage,
  verifyCallProof,
  verifyGenericAction,
  verifySocialAction,
  verifyWalletSignature,
  type SocialAction,
} from "../src/auth/WalletSignature.ts";

const NET = "devnet";

const bs58 = utils.bytes.bs58;

function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = new Uint8Array(der.subarray(der.length - 32));
  return { privateKey, walletB58: bs58.encode(raw) };
}
function signB58(privateKey: KeyObject, message: string): string {
  return bs58.encode(new Uint8Array(nodeSign(null, Buffer.from(message), privateKey)));
}
function signB64(privateKey: KeyObject, message: string): string {
  return nodeSign(null, Buffer.from(message), privateKey).toString("base64");
}

describe("verifyWalletSignature", () => {
  test("accepts a valid signature (base58)", () => {
    const { privateKey, walletB58 } = makeWallet();
    const msg = "hello chumbucket";
    expect(verifyWalletSignature(walletB58, msg, signB58(privateKey, msg))).toBe(true);
  });

  test("accepts a valid signature (base64)", () => {
    const { privateKey, walletB58 } = makeWallet();
    const msg = "hello chumbucket";
    expect(verifyWalletSignature(walletB58, msg, signB64(privateKey, msg))).toBe(true);
  });

  test("rejects a tampered message", () => {
    const { privateKey, walletB58 } = makeWallet();
    const sig = signB58(privateKey, "original message");
    expect(verifyWalletSignature(walletB58, "tampered message", sig)).toBe(false);
  });

  test("rejects a signature from a different wallet", () => {
    const a = makeWallet();
    const b = makeWallet();
    const msg = "same message";
    expect(verifyWalletSignature(b.walletB58, msg, signB58(a.privateKey, msg))).toBe(false);
  });

  test("rejects garbage inputs without throwing", () => {
    expect(verifyWalletSignature("not-base58-0OIl", "m", "sig")).toBe(false);
    expect(verifyWalletSignature("", "", "")).toBe(false);
  });
});

describe("verifySocialAction", () => {
  const target = "TargetWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ts = 1_700_000_000_000;

  function proof(action: SocialAction, privateKey: KeyObject, walletB58: string, opts: { target?: string; ts?: number } = {}) {
    const t = opts.target ?? target;
    const time = opts.ts ?? ts;
    return {
      wallet: walletB58,
      action,
      target: t,
      timestamp: time,
      signature: signB58(privateKey, socialActionMessage(action, t, NET, time)),
    };
  }

  test("accepts a fresh, correctly-signed follow proof", () => {
    const { privateKey, walletB58 } = makeWallet();
    expect(verifySocialAction(proof("follow", privateKey, walletB58), ts, NET).ok).toBe(true);
  });

  test("accepts a fresh, correctly-signed add_pending_target proof", () => {
    const { privateKey, walletB58 } = makeWallet();
    expect(verifySocialAction(proof("add_pending_target", privateKey, walletB58), ts, NET).ok).toBe(true);
  });

  test("rejects a stale or future timestamp", () => {
    const { privateKey, walletB58 } = makeWallet();
    const p = proof("follow", privateKey, walletB58);
    expect(verifySocialAction(p, ts + SIGNATURE_MAX_AGE_MS + 1, NET).ok).toBe(false);
    expect(verifySocialAction(p, ts - SIGNATURE_MAX_AGE_MS - 1, NET).ok).toBe(false);
  });

  test("rejects an action mismatch (signed follow, claimed unfollow)", () => {
    const { privateKey, walletB58 } = makeWallet();
    const p = proof("follow", privateKey, walletB58);
    expect(verifySocialAction({ ...p, action: "unfollow" }, ts, NET).ok).toBe(false);
  });

  test("rejects a target mismatch (can't retarget a signed follow)", () => {
    const { privateKey, walletB58 } = makeWallet();
    const p = proof("follow", privateKey, walletB58);
    expect(verifySocialAction({ ...p, target: "SomeoneElse" }, ts, NET).ok).toBe(false);
  });

  test("rejects a network mismatch (proof signed for another network)", () => {
    const { privateKey, walletB58 } = makeWallet();
    const p = proof("follow", privateKey, walletB58); // signed for devnet
    expect(verifySocialAction(p, ts, "mainnet-beta").ok).toBe(false);
  });

  test("rejects a proof whose signature belongs to another wallet", () => {
    const a = makeWallet();
    const b = makeWallet();
    const p = proof("follow", a.privateKey, a.walletB58);
    expect(verifySocialAction({ ...p, wallet: b.walletB58 }, ts, NET).ok).toBe(false);
  });

  test("rejects missing fields", () => {
    expect(verifySocialAction({ wallet: "", action: "follow", target: "x", timestamp: ts, signature: "s" }, ts, NET).ok).toBe(false);
  });
});

describe("verifyCallProof", () => {
  const ts = 1_700_000_000_000;
  const call = { matchId: "18202701", bucket: "HOME", stake: "20000000", txSignature: "SigForThisCallXXXXXXXXXXXXXXXXXXXX" };

  function callProof(privateKey: KeyObject, walletB58: string, over: Partial<typeof call> = {}) {
    const c = { ...call, ...over };
    return {
      wallet: walletB58,
      ...c,
      timestamp: ts,
      signature: signB58(privateKey, callProofMessage({ ...c, network: NET, timestamp: ts })),
    };
  }

  test("accepts a correctly-signed call proof", () => {
    const { privateKey, walletB58 } = makeWallet();
    expect(verifyCallProof(callProof(privateKey, walletB58), ts, NET).ok).toBe(true);
  });

  test("rejects if any call param is swapped (bucket/stake/tx/match all bound)", () => {
    const { privateKey, walletB58 } = makeWallet();
    const p = callProof(privateKey, walletB58);
    expect(verifyCallProof({ ...p, bucket: "AWAY" }, ts, NET).ok).toBe(false);
    expect(verifyCallProof({ ...p, stake: "999" }, ts, NET).ok).toBe(false);
    expect(verifyCallProof({ ...p, txSignature: "OtherSig" }, ts, NET).ok).toBe(false);
    expect(verifyCallProof({ ...p, matchId: "999" }, ts, NET).ok).toBe(false);
  });

  test("rejects a stale proof and a wrong-wallet proof", () => {
    const a = makeWallet();
    const b = makeWallet();
    const p = callProof(a.privateKey, a.walletB58);
    expect(verifyCallProof(p, ts + SIGNATURE_MAX_AGE_MS + 1, NET).ok).toBe(false);
    expect(verifyCallProof({ ...p, wallet: b.walletB58 }, ts, NET).ok).toBe(false);
  });
});

describe("verifyGenericAction", () => {
  const ts = 1_700_000_000_000;
  test("accepts a correctly-signed action, rejects action/network mismatch", () => {
    const { privateKey, walletB58 } = makeWallet();
    const sig = signB58(privateKey, genericActionMessage("read_notifications", NET, ts));
    const p = { wallet: walletB58, action: "read_notifications", timestamp: ts, signature: sig };
    expect(verifyGenericAction(p, ts, NET).ok).toBe(true);
    expect(verifyGenericAction({ ...p, action: "delete_account" }, ts, NET).ok).toBe(false);
    expect(verifyGenericAction(p, ts, "mainnet-beta").ok).toBe(false);
    expect(verifyGenericAction(p, ts + SIGNATURE_MAX_AGE_MS + 1, NET).ok).toBe(false);
  });
});
