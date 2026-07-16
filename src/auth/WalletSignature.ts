/**
 * Wallet-signature verification — the reusable identity primitive that
 * authenticates social writes. A Solana wallet (ed25519) signs a canonical,
 * network-bound, timestamped message with MWA; the backend verifies it against
 * the claimed wallet before acting. This proves the caller controls the wallet,
 * so no one can attribute a follow — or a prediction call — to a wallet they
 * don't own. No custody, no session server.
 *
 * Zero extra dependencies: Node's built-in ed25519 verify (a Solana pubkey IS a
 * raw ed25519 public key, wrapped in the standard SPKI DER header) + Anchor's
 * bundled bs58 (already a direct dependency).
 *
 * Replay note: proofs are bound to (action, target/params, network, timestamp)
 * and accepted only within SIGNATURE_MAX_AGE_MS. There is no server nonce store,
 * so a *leaked* proof is replayable within that window (re-asserting an action
 * the wallet itself signed). Accepted tradeoff: the proof only travels TLS from
 * the owner's device to the trusted backend, the affected state is a public
 * self-authored edge/optimistic row, and it self-heals on the next legit action
 * or on-chain reconciliation. Add a nonce/used-signature store if that changes.
 */

import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { utils } from "@coral-xyz/anchor";

const bs58 = utils.bytes.bs58;
/** 12-byte DER SubjectPublicKeyInfo header identifying an Ed25519 key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** How far the signed timestamp may drift from now (replay / stale-proof window). */
export const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export type SocialAction = "follow" | "unfollow";

/**
 * The exact string a wallet must sign for a follow/unfollow. Deterministic and
 * human-readable so the wallet's signing UI shows what's being authorized.
 */
export function socialActionMessage(action: SocialAction, target: string, network: string, timestamp: number): string {
  return `ChumBucket: ${action} ${target}\nnet:${network}\nts:${timestamp}`;
}

/** A parameterless signed action (e.g. "read_notifications"). */
export function genericActionMessage(action: string, network: string, timestamp: number): string {
  return `ChumBucket: ${action}\nnet:${network}\nts:${timestamp}`;
}

export interface GenericActionProof {
  wallet: string;
  action: string;
  timestamp: number;
  signature: string;
}

/** Verify a parameterless action proof against the backend's `network`. */
export function verifyGenericAction(proof: GenericActionProof, now: number, network: string): { ok: boolean; reason?: string } {
  if (!proof.wallet || !proof.action || !proof.signature) return { ok: false, reason: "missing fields" };
  const fresh = freshness(proof.timestamp, now);
  if (!fresh.ok) return fresh;
  const message = genericActionMessage(proof.action, network, proof.timestamp);
  return verifyWalletSignature(proof.wallet, message, proof.signature)
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}

/** The exact string a wallet must sign to attribute a prediction call to itself. */
export function callProofMessage(params: {
  matchId: string;
  bucket: string;
  stake: string;
  txSignature: string;
  network: string;
  timestamp: number;
}): string {
  return `ChumBucket: call ${params.matchId} ${params.bucket} ${params.stake} ${params.txSignature}\nnet:${params.network}\nts:${params.timestamp}`;
}

/** Verify an ed25519 signature (base58 or base64) by `wallet` over `message`. */
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  try {
    const pub = safeBs58Decode(wallet);
    if (!pub || pub.length !== 32) return false;
    const sig = decodeSignature(signature);
    if (sig.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub)]),
      format: "der",
      type: "spki",
    });
    return nodeVerify(null, Buffer.from(new TextEncoder().encode(message)), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

function freshness(timestamp: number, now: number): { ok: boolean; reason?: string } {
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(now - timestamp) > SIGNATURE_MAX_AGE_MS) return { ok: false, reason: "stale or future timestamp" };
  return { ok: true };
}

export interface SocialActionProof {
  wallet: string;
  action: SocialAction;
  target: string;
  timestamp: number; // unix ms
  signature: string; // base58 or base64
}

/** Verify a follow/unfollow proof against the backend's configured `network`. */
export function verifySocialAction(proof: SocialActionProof, now: number, network: string): { ok: boolean; reason?: string } {
  if (!proof.wallet || !proof.target || !proof.signature) return { ok: false, reason: "missing fields" };
  if (proof.action !== "follow" && proof.action !== "unfollow") return { ok: false, reason: "unknown action" };
  const fresh = freshness(proof.timestamp, now);
  if (!fresh.ok) return fresh;
  const message = socialActionMessage(proof.action, proof.target, network, proof.timestamp);
  return verifyWalletSignature(proof.wallet, message, proof.signature)
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}

export interface CallProof {
  wallet: string;
  matchId: string;
  bucket: string;
  stake: string;
  txSignature: string;
  timestamp: number;
  signature: string;
}

/** Verify a prediction-call attribution proof against the backend's `network`. */
export function verifyCallProof(proof: CallProof, now: number, network: string): { ok: boolean; reason?: string } {
  if (!proof.wallet || !proof.txSignature || !proof.signature) return { ok: false, reason: "missing fields" };
  const fresh = freshness(proof.timestamp, now);
  if (!fresh.ok) return fresh;
  const message = callProofMessage({
    matchId: proof.matchId,
    bucket: proof.bucket,
    stake: proof.stake,
    txSignature: proof.txSignature,
    network,
    timestamp: proof.timestamp,
  });
  return verifyWalletSignature(proof.wallet, message, proof.signature)
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}

function safeBs58Decode(s: string): Uint8Array | undefined {
  try {
    return bs58.decode(s);
  } catch {
    return undefined;
  }
}

function decodeSignature(signature: string): Uint8Array {
  const b58 = safeBs58Decode(signature);
  if (b58 && b58.length === 64) return b58;
  return new Uint8Array(Buffer.from(signature, "base64"));
}
