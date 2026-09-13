/**
 * SIWS (Sign In With Solana) message — build, parse, and verify.
 *
 * Design rule: the SERVER owns every byte of this message. `requestWalletNonce`
 * returns the exact string to sign; `linkWallet` receives that string back and
 * proves it is byte-identical to what the server would have produced for the
 * fields it parsed out. Anything the client "adds" fails the re-serialisation
 * check, so there is no room to smuggle a second statement, an extra resource,
 * or a trailing instruction past the wallet's signing UI.
 *
 * The wire format is the standard SIWS/EIP-4361 layout, fixed at 13 lines:
 *
 *   {domain} wants you to sign in with your Solana account:
 *   {address}
 *                                          <- blank
 *   {statement}
 *                                          <- blank
 *   URI: {uri}
 *   Version: 1
 *   Chain ID: {chainId}
 *   Nonce: {nonce}
 *   Issued At: {issuedAt}
 *   Expiration Time: {expirationTime}
 *   Resources:
 *   - chumbucket:purpose:{purpose}
 *
 * Signature verification reuses `verifyWalletSignature` from WalletSignature.ts
 * verbatim — that function is exported, domain-free, and already the project's
 * audited ed25519 primitive. It is not modified or wrapped in new crypto.
 */

import { verifyWalletSignature } from "./WalletSignature.ts";
import { AuthIdentityError, failAuth } from "./AuthIdentityError.ts";

/** The message layout this module produces and accepts. Bumping this is a new
 *  constant, never an edit — old proofs must stay attributable to old rules. */
export const SIWS_PROOF_VERSION = 1;

/** The SIWS spec's own `Version:` field. Unrelated to SIWS_PROOF_VERSION. */
const SIWS_SPEC_VERSION = "1";

export type SiwsNetwork = "devnet" | "mainnet-beta";
export type SiwsPurpose = "link_wallet" | "transfer_wallet";

const HEADER_SUFFIX = " wants you to sign in with your Solana account:";
const RESOURCE_PREFIX = "- chumbucket:purpose:";

/**
 * CAIP-2 chain identifiers (the first 32 chars of each cluster's genesis hash).
 * Using the canonical ids rather than the words "devnet"/"mainnet" means a
 * wallet or an auditor can resolve exactly which cluster a proof was bound to.
 */
export const CHAIN_IDS: Record<SiwsNetwork, string> = {
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

/**
 * The statement is server-owned and purpose-derived, never client text. Both
 * spell out what the signature does NOT authorise, because the single biggest
 * risk in a sign-message flow is a user approving something they believe is a
 * login and that is actually a transfer.
 */
export const STATEMENTS: Record<SiwsPurpose, string> = {
  link_wallet:
    "Link this Solana wallet to your Chumbucket account. This request does not authorise any transaction, transfer or spend.",
  transfer_wallet:
    "Move this Solana wallet to this Chumbucket account. This request does not authorise any transaction, transfer or spend.",
};

export interface SiwsFields {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: string;
  /** 64 lowercase hex chars. The PLAINTEXT challenge — never logged, never stored. */
  nonce: string;
  /** ISO-8601 UTC, millisecond precision. */
  issuedAt: string;
  expirationTime: string;
  purpose: SiwsPurpose;
}

/** Render the canonical 13-line message. The only place this format is written. */
export function buildSiwsMessage(f: SiwsFields): string {
  return [
    `${f.domain}${HEADER_SUFFIX}`,
    f.address,
    "",
    f.statement,
    "",
    `URI: ${f.uri}`,
    `Version: ${SIWS_SPEC_VERSION}`,
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
    "Resources:",
    `${RESOURCE_PREFIX}${f.purpose}`,
  ].join("\n");
}

const isIsoUtcMs = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return false;
  const d = new Date(s);
  // Round-trip: rejects "2026-02-31T..." and other well-shaped nonsense.
  return Number.isFinite(d.getTime()) && d.toISOString() === s;
};

const isHex64 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

function requireLine(lines: string[], i: number, prefix: string): string {
  const line = lines[i];
  if (line === undefined || !line.startsWith(prefix)) {
    failAuth("SIWS_MALFORMED_MESSAGE", `line ${i} expected "${prefix}…"`);
  }
  return (line as string).slice(prefix.length);
}

/**
 * Strict parse. Throws AuthIdentityError("SIWS_MALFORMED_MESSAGE") on anything
 * that is not exactly the canonical layout — including a trailing newline, an
 * extra resource line, or a multi-line statement.
 *
 * The final re-serialisation check is the part that matters: even if every
 * individual field parsed, the message is rejected unless rebuilding it from
 * those fields reproduces the input byte for byte.
 */
export function parseSiwsMessage(message: string): SiwsFields {
  if (typeof message !== "string" || message.length === 0 || message.length > 4096) {
    failAuth("SIWS_MALFORMED_MESSAGE", "empty or oversized message");
  }
  const lines = message.split("\n");
  if (lines.length !== 13) {
    failAuth("SIWS_MALFORMED_MESSAGE", `expected 13 lines, got ${lines.length}`);
  }

  const header = lines[0] as string;
  if (!header.endsWith(HEADER_SUFFIX)) failAuth("SIWS_MALFORMED_MESSAGE", "bad header line");
  const domain = header.slice(0, header.length - HEADER_SUFFIX.length);
  if (domain.length === 0 || /\s/.test(domain)) failAuth("SIWS_MALFORMED_MESSAGE", "bad domain");

  const address = lines[1] as string;
  if (address.length === 0 || /\s/.test(address)) failAuth("SIWS_MALFORMED_MESSAGE", "bad address line");
  if (lines[2] !== "" || lines[4] !== "") failAuth("SIWS_MALFORMED_MESSAGE", "missing blank separators");

  const statement = lines[3] as string;
  if (statement.length === 0) failAuth("SIWS_MALFORMED_MESSAGE", "empty statement");

  const uri = requireLine(lines, 5, "URI: ");
  const version = requireLine(lines, 6, "Version: ");
  // A different spec version is a DIFFERENT error from a malformed message: the
  // client is speaking a format we may simply not support yet.
  if (version !== SIWS_SPEC_VERSION) failAuth("SIWS_UNSUPPORTED_VERSION", `version ${version}`);

  const chainId = requireLine(lines, 7, "Chain ID: ");
  const nonce = requireLine(lines, 8, "Nonce: ");
  if (!isHex64(nonce)) failAuth("SIWS_MALFORMED_MESSAGE", "bad nonce format");

  const issuedAt = requireLine(lines, 9, "Issued At: ");
  const expirationTime = requireLine(lines, 10, "Expiration Time: ");
  if (!isIsoUtcMs(issuedAt) || !isIsoUtcMs(expirationTime)) {
    failAuth("SIWS_MALFORMED_MESSAGE", "timestamps must be ISO-8601 UTC with ms");
  }
  if (lines[11] !== "Resources:") failAuth("SIWS_MALFORMED_MESSAGE", "missing Resources header");

  const resource = lines[12] as string;
  if (!resource.startsWith(RESOURCE_PREFIX)) failAuth("SIWS_MALFORMED_MESSAGE", "missing purpose resource");
  const purposeRaw = resource.slice(RESOURCE_PREFIX.length);
  if (purposeRaw !== "link_wallet" && purposeRaw !== "transfer_wallet") {
    failAuth("SIWS_PURPOSE_MISMATCH", "unknown purpose");
  }

  const fields: SiwsFields = {
    domain,
    address,
    statement,
    uri,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    purpose: purposeRaw as SiwsPurpose,
  };

  // The anti-smuggling check.
  if (buildSiwsMessage(fields) !== message) {
    failAuth("SIWS_MALFORMED_MESSAGE", "message is not canonical");
  }
  return fields;
}

export interface SiwsExpectation {
  /** Domains the server will ever accept. Not a hint — an allowlist. */
  allowedDomains: readonly string[];
  allowedUris: readonly string[];
  network: SiwsNetwork;
  purpose: SiwsPurpose;
  /** The address the caller claims. Must equal the address inside the message. */
  address: string;
  /** Evaluated against the message's Expiration Time. */
  now: number;
}

/**
 * Validate every binding that can be checked WITHOUT touching the nonce store,
 * then verify the ed25519 signature.
 *
 * Order is deliberate: all static rejections happen before any database write,
 * so a malformed or mis-bound attempt never burns the user's live challenge.
 * The nonce is consumed by the caller, after this returns.
 */
export function verifySiwsProof(
  message: string,
  signature: string,
  expect: SiwsExpectation,
): SiwsFields {
  const f = parseSiwsMessage(message);

  if (f.purpose !== expect.purpose) failAuth("SIWS_PURPOSE_MISMATCH");
  if (f.address !== expect.address) failAuth("SIWS_ADDRESS_MISMATCH");
  if (!expect.allowedDomains.includes(f.domain)) failAuth("SIWS_DOMAIN_MISMATCH");
  if (!expect.allowedUris.includes(f.uri)) failAuth("SIWS_URI_MISMATCH");
  if (f.chainId !== CHAIN_IDS[expect.network]) failAuth("SIWS_NETWORK_MISMATCH");
  if (f.statement !== STATEMENTS[expect.purpose]) failAuth("SIWS_STATEMENT_MISMATCH");

  // Client-visible expiry. The wallet_nonces row is still the authority (its
  // expires_at is re-checked inside the atomic consume), but rejecting here
  // means an expired attempt is cheap and never reaches the database.
  if (Date.parse(f.expirationTime) <= expect.now) failAuth("NONCE_EXPIRED");
  if (Date.parse(f.issuedAt) > Date.parse(f.expirationTime)) {
    failAuth("SIWS_MALFORMED_MESSAGE", "issued after expiry");
  }

  if (!verifyWalletSignature(f.address, message, signature)) failAuth("SIWS_BAD_SIGNATURE");

  return f;
}

/** Narrow an unknown thrown value to our error type without instanceof gymnastics. */
export function isAuthIdentityError(e: unknown): e is AuthIdentityError {
  return e instanceof AuthIdentityError;
}
