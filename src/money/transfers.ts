/**
 * USDC transfers the BFF builds for a person's own wallet to sign
 * (docs/money-api.md §c, §e): a cash out from the trading wallet to any
 * Solana wallet address, and a top-up from one of the account's linked
 * wallets into the trading wallet.
 *
 *   prepare  validate (address, not the same wallet, amount ≤ balance), then
 *            gas, then build exactly one shape of transaction (below), check
 *            it with the same rules every signer applies, and store the
 *            reviewed bytes BEFORE any wallet sees them
 *   submit   the owner's signature over exactly that message; the signed
 *            bytes are stored BEFORE broadcast, once; a retry re-sends them
 *   status   CONFIRMED only when the chain shows that exact message landed
 *            with exactly the amount leaving `from` and arriving at `to`;
 *            FAILED only when the chain says it failed or can never land
 *
 * The transaction: one v0 message, no lookup tables, one signer (`from`, the
 * fee payer); Compute Budget (limit, price) → the destination's USDC account
 * (CreateIdempotent, only when missing) → one SPL TransferChecked of mainnet
 * USDC. Nothing else. The server never holds a key.
 */
import { createHash } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { DepositPerson, DepositWallet } from "../deposits/accounts.ts";
import { MAINNET_GENESIS_HASH, MAINNET_USDC_MINT, PantaChain, validateSignedPantaTransaction, type SignedPantaTransaction } from "../prediction/PantaChain.ts";
import { MoneyError } from "./errors.ts";
import { TOKEN_ACCOUNT_BYTES, type GasPort } from "./gas.ts";
import type { BalancePort, WalletRef } from "./MoneyCallsService.ts";
import type { PreparedTransfer, TransferKind, WalletTransferRow, WalletTransferStore } from "./store.ts";

export const TRANSFER_COMPUTE_UNITS = 60_000;
export const TRANSFER_COMPUTE_PRICE = 10_000;
/** The signers' ceilings for a transfer's Compute Budget (docs/money-api.md). */
export const MAX_TRANSFER_COMPUTE_UNITS = 200_000n;
export const MAX_TRANSFER_COMPUTE_PRICE = 1_000_000n;
const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** A reviewed transfer is signable this long (a blockhash lives ~60–90 s). */
export const TRANSFER_TTL_MS = 60_000;
const USDC = new PublicKey(MAINNET_USDC_MINT);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const usdcAccountOf = (owner: string): string => getAssociatedTokenAddressSync(USDC, new PublicKey(owner), true).toBase58();

/**
 * What an address is, by its bytes alone: not an address at all (or the USDC
 * mint), a wallet key (on the ed25519 curve), or an off-curve address (a
 * program-derived one, such as somebody's USDC account).
 */
export function addressShape(value: string): "bad" | "wallet" | "off-curve" {
  if (!BASE58.test(value) || value === MAINNET_USDC_MINT) return "bad";
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) return "bad";
    return PublicKey.isOnCurve(key.toBytes()) ? "wallet" : "off-curve";
  } catch { return "bad"; }
}

/** A wallet address a transfer may go to: base58, 32 bytes, on the ed25519 curve, not the mint. */
export const walletAddressOk = (value: string): boolean => addressShape(value) === "wallet";

export interface TransferReview {
  from: string;
  to: string;
  amountBaseUnits: string;
  createsAccount: boolean;
}

/** The unsigned v0 transfer, in the one allowed shape. Pure. */
export function buildUsdcTransfer(review: TransferReview, recentBlockhash: string): { transaction: string; messageHash: string } {
  const from = new PublicKey(review.from);
  const to = new PublicKey(review.to);
  const fromAta = getAssociatedTokenAddressSync(USDC, from, true);
  const toAta = getAssociatedTokenAddressSync(USDC, to, true);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: TRANSFER_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: TRANSFER_COMPUTE_PRICE }),
    ...(review.createsAccount ? [createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, USDC)] : []),
    createTransferCheckedInstruction(fromAta, USDC, toAta, from, BigInt(review.amountBaseUnits), 6),
  ];
  const message = new TransactionMessage({ payerKey: from, recentBlockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return { transaction: Buffer.from(tx.serialize()).toString("base64"), messageHash: hash(message.serialize()) };
}

export class UnsafeTransfer extends Error {}

const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const readLe = (data: Uint8Array, offset: number, length: number): bigint => {
  let value = 0n;
  for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
};

/**
 * The rules every signer applies before signing a transfer (docs/money-api.md
 * §c), checked here on the server's own bytes before they are stored or
 * shown. Throws [UnsafeTransfer] on anything else.
 */
export function checkUsdcTransfer(bytes: Uint8Array, review: TransferReview): void {
  const require = (ok: boolean, why: string) => { if (!ok) throw new UnsafeTransfer(why); };
  require(bytes.length > 65 && bytes.length <= 1232, "size");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(bytes); } catch { throw new UnsafeTransfer("parse"); }
  const m = tx.message;
  require(m.version === 0, "not v0");
  require(m.addressTableLookups.length === 0, "lookup tables");
  require(m.header.numRequiredSignatures === 1 && m.header.numReadonlySignedAccounts === 0, "signers");
  require(tx.signatures.length === 1 && tx.signatures[0]!.every(b => b === 0), "signed");
  const keys = m.staticAccountKeys.map(k => k.toBase58());
  require(keys[0] === review.from, "fee payer");
  require(new Set(keys).size === keys.length, "duplicate keys");
  require(/^[1-9][0-9]{0,19}$/.test(review.amountBaseUnits) && BigInt(review.amountBaseUnits) < 1n << 64n, "amount");
  const fromAta = usdcAccountOf(review.from);
  const toAta = usdcAccountOf(review.to);
  const token = TOKEN_PROGRAM_ID.toBase58();
  const ix = m.compiledInstructions;
  let at = 0, limit = false, price = false;
  while (at < ix.length && keys[ix[at]!.programIdIndex] === COMPUTE_BUDGET) {
    const { data, accountKeyIndexes } = ix[at]!;
    require(accountKeyIndexes.length === 0, "compute budget");
    if (data.length === 5 && data[0] === 2 && !limit) { limit = true; require(readLe(data, 1, 4) <= MAX_TRANSFER_COMPUTE_UNITS, "compute units"); }
    else if (data.length === 9 && data[0] === 3 && !price) { price = true; require(readLe(data, 1, 8) <= MAX_TRANSFER_COMPUTE_PRICE, "compute price"); }
    else require(false, "compute budget");
    at++;
  }
  const accounts = (i: number) => ix[i]!.accountKeyIndexes.map(k => keys[k]);
  if (review.createsAccount) {
    require(at < ix.length && keys[ix[at]!.programIdIndex] === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), "usdc account");
    require(ix[at]!.data.length === 1 && ix[at]!.data[0] === 1 &&
      accounts(at).join() === [review.from, toAta, review.to, MAINNET_USDC_MINT, SystemProgram.programId.toBase58(), token].join(), "usdc account");
    at++;
  }
  require(at === ix.length - 1 && keys[ix[at]!.programIdIndex] === token, "transfer");
  const data = ix[at]!.data;
  require(data.length === 10 && data[0] === 12 && readLe(data, 1, 8) === BigInt(review.amountBaseUnits) && data[9] === 6, "transfer data");
  require(accounts(at).join() === [fromAta, MAINNET_USDC_MINT, toAta, review.from].join(), "transfer accounts");
}

// ── the chain ────────────────────────────────────────────────────────────────

export type AccountKind = "none" | "wallet" | "token" | "executable" | "other";
export type TransferLookup = { status: "confirmed"; slot: number } | { status: "missing" } | { status: "unknown" };

export interface TransferChainPort {
  accountKind(address: string): Promise<AccountKind>;
  accountExists(address: string): Promise<boolean>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  rent(bytes: number): Promise<bigint>;
  broadcast(tx: SignedPantaTransaction): Promise<void>;
  failed(signature: string): Promise<boolean>;
  neverLanded(signature: string, lastValidBlockHeight: number, recentBlockhash: string): Promise<boolean>;
  /**
   * What the chain says about this signature:
   *   confirmed  exactly this message landed and moved exactly this USDC from `from` to `to`
   *   missing    the RPC answered and has no such transaction
   *   unknown    the RPC could not answer, or what landed is not that transfer
   * Only `missing` may ever lead to FAILED (with an expired blockhash): an
   * RPC that cannot see a landed transfer must never mark it failed.
   */
  verifyTransfer(input: { signature: string; from: string; to: string; amountBaseUnits: string; messageHash: string }): Promise<TransferLookup>;
}

type TokenBalance = { owner?: string; mint: string; uiTokenAmount: { amount: string; decimals: number } };
/** The owner's mainnet USDC after minus before, from a transaction's own balances. */
export function usdcDelta(meta: { preTokenBalances?: readonly TokenBalance[] | null; postTokenBalances?: readonly TokenBalance[] | null }, owner: string): bigint | null {
  if (!meta.preTokenBalances || !meta.postTokenBalances) return null;
  try {
    const total = (list: readonly TokenBalance[]) => list.reduce((sum, b) => {
      if (b.owner !== owner || b.mint !== MAINNET_USDC_MINT) return sum;
      if (b.uiTokenAmount.decimals !== 6 || !/^[0-9]+$/.test(b.uiTokenAmount.amount)) throw new Error();
      return sum + BigInt(b.uiTokenAmount.amount);
    }, 0n);
    return total(meta.postTokenBalances) - total(meta.preTokenBalances);
  } catch { return null; }
}

/** Genesis-pinned mainnet reads, and PantaChain's broadcast / failure checks on the same RPC. */
export class RpcTransferChain implements TransferChainPort {
  private readonly connection: Connection;
  private readonly panta: PantaChain;
  private mainnet: Promise<void> | undefined;
  constructor(rpcUrl: string, fetchImpl: typeof fetch = fetch) {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Transfers need a secure mainnet RPC");
    this.panta = new PantaChain(rpcUrl, fetchImpl);
    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed", disableRetryOnRateLimit: true,
      fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }), { preconnect: fetchImpl.preconnect }),
    });
  }
  private assertMainnet(): Promise<void> {
    this.mainnet ??= this.connection.getGenesisHash().then(genesis => { if (genesis !== MAINNET_GENESIS_HASH) throw new Error("not mainnet"); })
      .catch(error => { this.mainnet = undefined; throw error; });
    return this.mainnet;
  }
  async accountKind(address: string): Promise<AccountKind> {
    await this.assertMainnet();
    const info = await this.connection.getAccountInfo(new PublicKey(address), "confirmed");
    if (!info) return "none";
    if (info.executable) return "executable";
    if (info.owner.equals(SystemProgram.programId)) return "wallet";
    if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) return "token";
    return "other";
  }
  async accountExists(address: string): Promise<boolean> {
    await this.assertMainnet();
    return (await this.connection.getAccountInfo(new PublicKey(address), "confirmed")) !== null;
  }
  async latestBlockhash() {
    await this.assertMainnet();
    return this.connection.getLatestBlockhash("confirmed");
  }
  async rent(bytes: number): Promise<bigint> {
    await this.assertMainnet();
    return BigInt(await this.connection.getMinimumBalanceForRentExemption(bytes, "confirmed"));
  }
  broadcast(tx: SignedPantaTransaction) { return this.panta.broadcast(tx); }
  failed(signature: string) { return this.panta.failed(signature); }
  neverLanded(signature: string, lastValidBlockHeight: number, recentBlockhash: string) {
    return this.panta.neverLanded(signature, lastValidBlockHeight, recentBlockhash);
  }
  async verifyTransfer(input: { signature: string; from: string; to: string; amountBaseUnits: string; messageHash: string }): Promise<TransferLookup> {
    await this.assertMainnet();
    let result: Awaited<ReturnType<Connection["getTransaction"]>>;
    try {
      result = await this.connection.getTransaction(input.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    } catch { return { status: "unknown" }; }
    if (result === null) return { status: "missing" };
    try {
      if (!result.meta || result.meta.err !== null || result.transaction.signatures[0] !== input.signature) return { status: "unknown" };
      const message = result.transaction.message;
      if (message.header.numRequiredSignatures !== 1 || message.staticAccountKeys[0]?.toBase58() !== input.from ||
          hash(message.serialize()) !== input.messageHash) return { status: "unknown" };
      const amount = BigInt(input.amountBaseUnits);
      if (usdcDelta(result.meta, input.from) !== -amount || usdcDelta(result.meta, input.to) !== amount) return { status: "unknown" };
      return { status: "confirmed", slot: result.slot };
    } catch { return { status: "unknown" }; }
  }
}

// ── the service ──────────────────────────────────────────────────────────────

export type TransferInvalid = "ADDRESS" | "SAME_WALLET" | "TOKEN_ACCOUNT" | "OVER_BALANCE" | "AMOUNT" | "NOT_YOUR_WALLET";

export interface TransferView {
  transferId: string;
  kind: TransferKind;
  from: string;
  to: string;
  amountBaseUnits: string;
  state: WalletTransferRow["state"];
  signature: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type TransferPrepareResult =
  | { status: "INVALID"; reason: TransferInvalid; message: string }
  /** The same tap again, after its transfer was signed: its actual state, never a fresh review. */
  | { status: "SENT"; transfer: TransferView }
  | { status: "NEEDS_GAS"; wallet: WalletRef; topUp: { amountBaseUnits: string } | null }
  | { status: "READY"; transfer: TransferView;
      transaction: { encoding: "solana-tx-base64"; payload: string; expiresAt: number };
      review: TransferReview & { networkFeeLamports: string; rentLamports: string } };

const INVALID_COPY: Record<TransferInvalid, string> = {
  ADDRESS: "That isn't a Solana wallet address.",
  SAME_WALLET: "That's this wallet. Choose another address.",
  TOKEN_ACCOUNT: "That's a token account. Use the wallet address instead.",
  OVER_BALANCE: "That's more than this wallet holds.",
  AMOUNT: "Choose an amount above zero.",
  NOT_YOUR_WALLET: "Link this wallet to your account first",
};
const invalid = (reason: TransferInvalid) => ({ status: "INVALID" as const, reason, message: INVALID_COPY[reason] });

export class TransferService {
  constructor(private readonly deps: {
    store: WalletTransferStore;
    chain: TransferChainPort | null;
    balances: BalancePort | null;
    gas: GasPort;
    now?: () => number;
    newId?: () => string;
  }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private chain(): TransferChainPort {
    if (!this.deps.chain) throw new MoneyError("UNAVAILABLE", "Transfers aren't available on this server.");
    return this.deps.chain;
  }

  /** A cash out from the trading wallet to any wallet address. */
  cashOut(person: DepositPerson, trading: DepositWallet, input: { destination: string; amountBaseUnits: string; idempotencyKey: string }) {
    return this.prepare(person, { kind: "cash_out", from: trading, to: input.destination.trim(), amountBaseUnits: input.amountBaseUnits,
      idempotencyKey: input.idempotencyKey });
  }

  /** A top-up from one of the account's own linked wallets into the trading wallet. */
  depositFromWallet(person: DepositPerson, trading: DepositWallet, input: { fromWallet: string; amountBaseUnits: string; idempotencyKey: string }) {
    const from = person.wallets.find(w => w.address === input.fromWallet);
    if (!from) return Promise.resolve(invalid("NOT_YOUR_WALLET"));
    if (from.address === trading.address) return Promise.resolve(invalid("SAME_WALLET"));
    return this.prepare(person, { kind: "deposit", from, to: trading.address, amountBaseUnits: input.amountBaseUnits, idempotencyKey: input.idempotencyKey });
  }

  private async prepare(person: DepositPerson, input: { kind: TransferKind; from: DepositWallet; to: string; amountBaseUnits: string; idempotencyKey: string }): Promise<TransferPrepareResult> {
    if (!/^[1-9][0-9]{0,15}$/.test(input.amountBaseUnits)) return invalid("AMOUNT");
    const shape = addressShape(input.to);
    if (shape === "bad") return invalid("ADDRESS");
    if (input.to === input.from.address) return invalid("SAME_WALLET");
    const fingerprint = hash(Buffer.from(JSON.stringify(["transfer", input.kind, input.from.address, input.to, input.amountBaseUnits])));
    const existing = await this.deps.store.byKey(person.userId, input.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new MoneyError("IDEMPOTENCY_CONFLICT", "This tap was already used for a different transfer. Try again.");
      if (existing.state !== "BUILT") return { status: "SENT", transfer: this.view(await this.reconcile(existing)) };
      if (existing.prepared.expiresAt <= this.now()) {
        await this.deps.store.update(existing.id, "BUILT", { state: "FAILED" }).catch(() => null);
        throw new MoneyError("EXPIRED", "This review expired. Nothing was sent. Start again.", { reason: "REVIEW_EXPIRED" });
      }
      return this.ready(existing);
    }
    // One transfer in flight per source wallet: an expired review is retired, anything else waits.
    await this.assertNothingInFlight(input.from.address);
    const chain = this.chain();
    const amount = BigInt(input.amountBaseUnits);
    let kind: AccountKind;
    try { kind = await chain.accountKind(input.to); }
    catch { throw new MoneyError("UNAVAILABLE", "We couldn't check that address just now. Nothing was sent. Try again in a moment."); }
    // A pasted USDC account (off-curve, owned by the token program) gets its own words.
    if (kind === "token") return invalid("TOKEN_ACCOUNT");
    if (shape !== "wallet" || kind === "executable" || kind === "other") return invalid("ADDRESS");
    if (!this.deps.balances) throw new MoneyError("UNAVAILABLE", "Balances aren't available on this server.");
    let balance: { usdcBaseUnits: string; lamports: string };
    try { balance = await this.deps.balances.read(input.from.address); }
    catch { throw new MoneyError("UNAVAILABLE", "We couldn't read your balance just now. Nothing was sent. Try again in a moment."); }
    if (BigInt(balance.usdcBaseUnits) < amount) return invalid("OVER_BALANCE");
    let createsAccount: boolean, rent: bigint, blockhash: { blockhash: string; lastValidBlockHeight: number };
    try {
      createsAccount = !(await chain.accountExists(usdcAccountOf(input.to)));
      rent = createsAccount ? await chain.rent(TOKEN_ACCOUNT_BYTES) : 0n;
    } catch { throw new MoneyError("UNAVAILABLE", "We couldn't check that address just now. Nothing was sent. Try again in a moment."); }
    const gas = await this.deps.gas.forTransfer(person, input.from.address, BigInt(balance.lamports), rent);
    if (gas.needsSol) return { status: "NEEDS_GAS", wallet: { address: input.from.address, walletType: input.from.walletType }, topUp: gas.topUp };
    try { blockhash = await chain.latestBlockhash(); }
    catch { throw new MoneyError("UNAVAILABLE", "We couldn't reach Solana just now. Nothing was sent. Try again in a moment."); }

    const review: TransferReview = { from: input.from.address, to: input.to, amountBaseUnits: input.amountBaseUnits, createsAccount };
    const built = buildUsdcTransfer(review, blockhash.blockhash);
    // The server's own bytes pass the signers' rules before anyone sees them.
    checkUsdcTransfer(Buffer.from(built.transaction, "base64"), review);
    const now = this.now();
    const fee = SIGNATURE_FEE_LAMPORTS + BigInt(Math.ceil((TRANSFER_COMPUTE_UNITS * TRANSFER_COMPUTE_PRICE) / 1_000_000));
    const prepared: PreparedTransfer = {
      version: 1, from: review.from, to: review.to, amountBaseUnits: review.amountBaseUnits, mint: MAINNET_USDC_MINT,
      encoding: "solana-tx-base64", transaction: built.transaction, messageHash: built.messageHash,
      recentBlockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, createsAccount,
      networkFeeLamports: fee.toString(), rentLamports: rent.toString(), createdAt: now, expiresAt: now + TRANSFER_TTL_MS,
    };
    let row: WalletTransferRow | null;
    try {
      row = await this.deps.store.insert({
        id: this.deps.newId?.() ?? crypto.randomUUID(), user_id: person.userId, kind: input.kind, from_wallet: review.from, to_wallet: review.to,
        amount_base_units: review.amountBaseUnits, idempotency_key: input.idempotencyKey, request_fingerprint: fingerprint, prepared,
      });
    } catch (error) {
      // Another transfer from this wallet got in first (the one-in-flight index).
      await this.assertNothingInFlight(input.from.address);
      throw error;
    }
    if (row) return this.ready(row);
    const raced = await this.deps.store.byKey(person.userId, input.idempotencyKey);
    if (!raced || raced.request_fingerprint !== fingerprint) throw new MoneyError("IDEMPOTENCY_CONFLICT", "This tap was already used for a different transfer. Try again.");
    return this.ready(raced);
  }

  private async assertNothingInFlight(fromWallet: string): Promise<void> {
    const flying = await this.deps.store.inFlightFrom(fromWallet);
    if (!flying) return;
    if (flying.state === "BUILT" && flying.prepared.expiresAt <= this.now() &&
        await this.deps.store.update(flying.id, "BUILT", { state: "FAILED" })) return;
    throw new MoneyError("TRANSFER_IN_FLIGHT", "Another transfer from this wallet is still going through. Try again when it's done.",
      { reason: "TRANSFER_IN_FLIGHT", transferId: flying.id });
  }

  private ready(row: WalletTransferRow): TransferPrepareResult {
    const p = row.prepared;
    return {
      status: "READY", transfer: this.view(row),
      transaction: { encoding: "solana-tx-base64", payload: p.transaction, expiresAt: p.expiresAt },
      review: { from: p.from, to: p.to, amountBaseUnits: p.amountBaseUnits, createsAccount: p.createsAccount,
        networkFeeLamports: p.networkFeeLamports, rentLamports: p.rentLamports },
    };
  }

  async submit(userId: string, transferId: string, signedTransaction: string): Promise<TransferView> {
    let row = await this.own(userId, transferId);
    if (row.state === "FAILED") throw new MoneyError("STATE", "This transfer didn't go through. Start a new one.");
    let tx: SignedPantaTransaction;
    try { tx = validateSignedPantaTransaction(signedTransaction, row.from_wallet, row.prepared.messageHash); }
    catch { throw new MoneyError("BAD_SIGNATURE", "The wallet approval doesn't match the reviewed transfer. Nothing was sent."); }
    if (row.signature !== null && (row.signature !== tx.signature || row.signed_transaction !== signedTransaction)) {
      throw new MoneyError("BAD_SIGNATURE", "This transfer already approved a different transaction.");
    }
    if (row.state === "CONFIRMED") return this.view(row);
    if (row.state === "BUILT") {
      if (row.prepared.expiresAt <= this.now()) {
        throw new MoneyError("EXPIRED", "The approval arrived after the review expired. Nothing was sent.", { reason: "REVIEW_EXPIRED" });
      }
      const saved = await this.deps.store.update(row.id, "BUILT", { state: "SUBMITTED", signature: tx.signature, signed_transaction: signedTransaction });
      row = saved ?? await this.own(userId, transferId);
      if (row.signature !== tx.signature || row.signed_transaction !== signedTransaction) {
        throw new MoneyError("BAD_SIGNATURE", "This transfer already approved a different transaction.");
      }
    }
    // Durable approval BEFORE RPC. A lost reply re-sends the identical bytes only.
    try { await this.chain().broadcast(tx); }
    catch { /* uncertain: status decides from chain evidence, never by rebuilding */ }
    return this.view(row);
  }

  async status(userId: string, transferId: string): Promise<TransferView> {
    return this.view(await this.reconcile(await this.own(userId, transferId)));
  }

  /** The one SUBMITTED -> CONFIRMED/FAILED transition, for the person's check and the sweeper. */
  async reconcile(row: WalletTransferRow): Promise<WalletTransferRow> {
    if (row.state !== "SUBMITTED" || !row.signature) return row;
    const chain = this.chain();
    const p = row.prepared;
    const lookup = await chain.verifyTransfer({ signature: row.signature, from: row.from_wallet, to: row.to_wallet,
      amountBaseUnits: row.amount_base_units, messageHash: p.messageHash });
    if (lookup.status === "confirmed") {
      const saved = await this.deps.store.update(row.id, "SUBMITTED", { state: "CONFIRMED", confirm_evidence: {
        independentlyVerified: true, messageHash: p.messageHash, signature: row.signature, amountBaseUnits: row.amount_base_units, slot: lookup.slot } });
      return saved ?? row;
    }
    // FAILED only on proof: the chain says it failed, or the RPC answered that
    // it has no such transaction AND its blockhash can no longer land it. An
    // RPC that could not answer (or pruned history) is never proof.
    if (await chain.failed(row.signature) ||
        (lookup.status === "missing" && await chain.neverLanded(row.signature, p.lastValidBlockHeight, p.recentBlockhash))) {
      const saved = await this.deps.store.update(row.id, "SUBMITTED", { state: "FAILED" });
      return saved ?? row;
    }
    return row;
  }

  /** Re-check every SUBMITTED transfer once. */
  async sweep(): Promise<{ confirmed: number; failed: number; errors: string[] }> {
    const report = { confirmed: 0, failed: 0, errors: [] as string[] };
    if (!this.deps.chain) return report;
    let rows: WalletTransferRow[] = [];
    try { rows = await this.deps.store.submitted(50); }
    catch { report.errors.push("TRANSFER_LEDGER_UNAVAILABLE"); return report; }
    for (const row of rows) {
      try {
        const next = await this.reconcile(row);
        if (next.state === "CONFIRMED") report.confirmed++;
        else if (next.state === "FAILED") report.failed++;
      } catch { report.errors.push("TRANSFER_RECONCILE_FAILED"); }
    }
    return report;
  }

  async listForUser(userId: string, limit = 50): Promise<WalletTransferRow[]> {
    return this.deps.store.listForUser(userId, limit);
  }

  private async own(userId: string, id: string): Promise<WalletTransferRow> {
    const row = await this.deps.store.byId(userId, id);
    if (!row) throw new MoneyError("NOT_FOUND", "We couldn't find that transfer.");
    return row;
  }

  view(row: WalletTransferRow): TransferView {
    return {
      transferId: row.id, kind: row.kind, from: row.from_wallet, to: row.to_wallet, amountBaseUnits: row.amount_base_units,
      state: row.state, signature: row.state === "SUBMITTED" || row.state === "CONFIRMED" ? row.signature : null,
      createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at), expiresAt: row.prepared.expiresAt,
    };
  }
}

/** bs58 signature of a signed v0 transaction's first slot (tests and tooling). */
export const signatureOf = (signed: Uint8Array): string => utils.bytes.bs58.encode(VersionedTransaction.deserialize(signed).signatures[0]!);
