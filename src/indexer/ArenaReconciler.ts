/**
 * Arena reconciler — the pull-based backstop that makes the social read model
 * chain-authoritative rather than dependent on the mobile app mirroring
 * signatures (or the Helius webhook firing). It walks chumbucket_arena's
 * transaction history forward from a durable cursor and, for each instruction:
 *
 *   place_call  -> confirm the mobile-mirrored position (PENDING -> OPEN), or
 *                  CREATE it from chain state if the app never mirrored it;
 *   settle_pot  -> settle every open position for the pot from ON-CHAIN Pot
 *                  state (winning bucket + parimutuel distributable/winners),
 *                  write the settlement receipt, stats, and claim notifications;
 *   claim       -> mark the position CLAIMED.
 *
 * Robustness contract:
 *   - Every DB write is idempotent (unique keys + status-gated transitions), so
 *     re-processing a signature — after a crash, a retry, or a chain reorg
 *     replaying the same tx — changes nothing.
 *   - The cursor only advances through a *contiguous* run of processed
 *     signatures. A transient RPC/DB error (or a not-yet-available tx) stops the
 *     advance, so the next pass resumes from exactly there instead of skipping.
 *   - Failed transactions (meta.err) are walked past but never applied.
 *   - Pot lookups are cached per pass (many place_calls share one pot).
 *
 * The chain access sits behind ArenaChainSource so the orchestration/money logic
 * is unit-testable against fakes; SolanaArenaChainSource is the production impl.
 */

import { AnchorProvider, Program, type Wallet as AnchorWallet } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

import type { SocialStore } from "../social/SocialStore.ts";
import { extractArenaInstructions, type ParsedArenaInstruction } from "./ArenaInstructionParser.ts";
import type { ChumbucketArena } from "../../vendor/chumbucket_arena/chumbucket_arena.ts";
import idl from "../../vendor/chumbucket_arena/chumbucket_arena.json" with { type: "json" };

const CURSOR_SOURCE = "reconciler";
const CURSOR_KEY = "signatures";
const BUCKETS = ["HOME", "DRAW", "AWAY"] as const;
const LINE_BUCKETS = ["OVER", "UNDER"] as const;

/**
 * Label an on-chain bucket index for the social feed. A line-market pot (its
 * matchId carries a "#" market tag, e.g. "18202701#OU25") uses OVER/UNDER; the
 * RESULT pot uses HOME/DRAW/AWAY. Keeps the Supabase mirror from mislabelling an
 * over/under call as "HOME".
 */
function bucketLabelFor(matchId: string, index: number): string {
  if (matchId.includes("#")) return LINE_BUCKETS[index] ?? "OVER";
  return BUCKETS[index] ?? "HOME";
}
// A signature surfaced by getSignaturesForAddress but unfetchable via
// getParsedTransaction after this many passes is treated as permanently gone
// (reorg-dropped) and skipped, so one dead tx can't wedge the cursor forever.
const MAX_NULL_RETRIES = 5;

export interface SignatureRef {
  signature: string;
  slot: number;
  err: boolean;
}

export interface ArenaTx {
  /** true when the on-chain tx itself reverted — walked past, never applied. */
  err: boolean;
  instructions: ParsedArenaInstruction[];
}

export interface PotState {
  matchId: string;
  fixtureId: number;
  winningBucket: number;
  status: number;
  distributable: string;
  winnersStake: string;
}

/** The chain reads the reconciler needs, injectable for tests. */
export interface ArenaChainSource {
  /** The full delta of signatures strictly newer than `until`, newest-first. */
  signaturesSince(until: string | undefined): Promise<SignatureRef[]>;
  /** Parsed arena instructions for a signature; null when not available yet. */
  loadTx(signature: string): Promise<ArenaTx | null>;
  /** Decoded Pot account state, or undefined if it can't be read. */
  loadPot(potAddress: string): Promise<PotState | undefined>;
}

export interface ReconcileSummary {
  scanned: number;
  applied: number;
  placeCalls: number;
  created: number;
  settlements: number;
  claims: number;
  failedTxSkipped: number;
  errors: number;
  advancedTo?: string;
  stoppedEarly: boolean;
}

export class ArenaReconciler {
  /** Per-signature null-fetch counters (in-memory; bounds the wedge in finding [4]). */
  private readonly nullRetries = new Map<string, number>();

  constructor(
    private readonly social: SocialStore,
    private readonly source: ArenaChainSource,
    private readonly maxPerPass = 1000,
  ) {}

  async reconcile(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      scanned: 0,
      applied: 0,
      placeCalls: 0,
      created: 0,
      settlements: 0,
      claims: 0,
      failedTxSkipped: 0,
      errors: 0,
      stoppedEarly: false,
    };

    const cursor = await this.social.readCursor(CURSOR_SOURCE, CURSOR_KEY);
    const until = cursor?.last_signature ?? undefined;

    // Fetch the WHOLE delta since the cursor (the source pages all the way down
    // to `until`), then process the OLDEST maxPerPass first. Advancing the cursor
    // to the newest of that oldest-chunk drains a large backlog over successive
    // passes WITHOUT ever skipping the cursor-adjacent signatures (finding [3]/[6]).
    const delta = await this.source.signaturesSince(until);
    summary.scanned = delta.length;
    if (delta.length === 0) return summary;

    const oldestFirst = [...delta].reverse().slice(0, this.maxPerPass);
    const potCache = new Map<string, PotState>();

    let advanceTo: { signature: string; slot: number } | undefined;
    for (const entry of oldestFirst) {
      try {
        if (entry.err) {
          summary.failedTxSkipped++;
        } else {
          await this.processSignature(entry.signature, entry.slot, potCache, summary);
        }
        // Success (or a walked-past failed tx): extend the contiguous cursor.
        advanceTo = { signature: entry.signature, slot: entry.slot };
      } catch (err) {
        // Transient RPC/DB error or a not-yet-available tx: stop advancing so the
        // next pass retries from exactly here. Everything already applied is
        // idempotent, so a re-scan is harmless.
        summary.errors++;
        summary.stoppedEarly = true;
        console.error(`[reconciler] stop at ${entry.signature}:`, (err as Error)?.message ?? err);
        break;
      }
    }

    if (advanceTo) {
      await this.social.advanceCursor(CURSOR_SOURCE, CURSOR_KEY, advanceTo.signature, advanceTo.slot);
      summary.advancedTo = advanceTo.signature;
    }
    return summary;
  }

  private async processSignature(
    signature: string,
    slot: number,
    potCache: Map<string, PotState>,
    summary: ReconcileSummary,
  ): Promise<void> {
    const tx = await this.source.loadTx(signature);
    if (!tx) {
      // Not available yet: retry (stop the cursor here) up to MAX_NULL_RETRIES,
      // then treat as permanently gone (reorg-dropped) and skip so a single dead
      // signature can't wedge the cursor forever (finding [4]).
      const n = (this.nullRetries.get(signature) ?? 0) + 1;
      if (n > MAX_NULL_RETRIES) {
        console.warn(`[reconciler] skipping ${signature}: unfetchable after ${MAX_NULL_RETRIES} passes`);
        this.nullRetries.delete(signature);
        summary.failedTxSkipped++;
        return;
      }
      this.nullRetries.set(signature, n);
      throw new Error(`transaction not found yet (attempt ${n})`);
    }
    this.nullRetries.delete(signature);
    if (tx.err) {
      summary.failedTxSkipped++;
      return;
    }
    for (const ix of tx.instructions) {
      if (ix.name === "place_call") {
        await this.applyPlaceCall(ix, signature, slot, potCache, summary);
      } else if (ix.name === "settle_pot" || ix.name === "settle_market" || ix.name === "void_pot") {
        // All terminate the pot: settle_pot/settle_market prove a winner (or
        // auto-void a thin pool / no-staker bucket), void_pot force-voids a stuck
        // pot. applySettle reads the fresh Pot; winners_stake == 0 => void/refund.
        // settle_market is the line-market (over/under, handicap) equivalent.
        await this.applySettle(ix, signature, slot, potCache, summary);
      } else if (ix.name === "claim") {
        await this.applyClaim(ix, signature, slot, summary);
      }
      summary.applied++;
    }
  }

  private async applyPlaceCall(
    ix: ParsedArenaInstruction,
    signature: string,
    slot: number,
    potCache: Map<string, PotState>,
    summary: ReconcileSummary,
  ): Promise<void> {
    summary.placeCalls++;
    const potAddr = ix.namedAccounts.pot;
    const player = ix.namedAccounts.player;
    const positionAddr = ix.namedAccounts.position;
    if (!potAddr || !player) return;
    const pot = await this.getPot(potAddr, potCache, false);
    if (!pot) return;

    // record_prediction_call is idempotent by open_tx_signature: it CREATES a
    // chain-only position, or REPAIRS a mobile-mirrored one — backfilling
    // position_address + slot and upgrading PENDING -> OPEN, and only bumping
    // calls_made on first insert. Running it for EVERY place_call (from chain
    // truth) guarantees position_address is set, so a later claim can always be
    // linked to its position by the Position PDA (mobile does not send it).
    await this.social.recordPredictionCall({
      wallet: player,
      matchId: pot.matchId,
      // One RESULT market per fixture: key it by the fixture id so markets and
      // settlement receipts are per-match, not collapsed onto a single "RESULT"
      // row (finding [7]). record_prediction_call repairs a mobile row's market_id
      // to this while it is still PENDING/OPEN.
      marketId: pot.matchId,
      bucket: bucketLabelFor(pot.matchId, Number(ix.args.bucket ?? 0)),
      stakeBaseUnits: String(ix.args.amount ?? "0"),
      txSignature: signature,
      ...(positionAddr ? { positionAddress: positionAddr } : {}),
      slot,
      metadata: { source: "reconciler", fixtureId: pot.fixtureId, pot: potAddr },
    });
    summary.created++;
  }

  private async applySettle(
    ix: ParsedArenaInstruction,
    signature: string,
    slot: number,
    potCache: Map<string, PotState>,
    summary: ReconcileSummary,
  ): Promise<void> {
    const potAddr = ix.namedAccounts.pot;
    if (!potAddr) return;
    // Fresh read: the settle tx just mutated the Pot; a cached pre-settle copy
    // would carry the wrong winning bucket / distributable.
    const pot = await this.getPot(potAddr, potCache, true);
    if (!pot) return;

    await this.social.applySettlement({
      marketId: pot.matchId,
      matchId: pot.matchId,
      winningBucket: bucketLabelFor(pot.matchId, pot.winningBucket),
      settleTxSignature: signature,
      slot,
      distributableBaseUnits: pot.distributable,
      winnersStakeBaseUnits: pot.winnersStake,
      fixtureId: pot.fixtureId,
      proofRef: signature,
    });
    summary.settlements++;
  }

  private async applyClaim(
    ix: ParsedArenaInstruction,
    signature: string,
    slot: number,
    summary: ReconcileSummary,
  ): Promise<void> {
    const player = ix.namedAccounts.player;
    const positionAddr = ix.namedAccounts.position;
    if (!player || !positionAddr) return;
    await this.social.applyClaim({
      wallet: player,
      positionAddress: positionAddr,
      claimTxSignature: signature,
      slot,
    });
    summary.claims++;
  }

  private async getPot(
    potAddr: string,
    cache: Map<string, PotState>,
    fresh: boolean,
  ): Promise<PotState | undefined> {
    if (!fresh) {
      const cached = cache.get(potAddr);
      if (cached) return cached;
    }
    const state = await this.source.loadPot(potAddr);
    if (state) cache.set(potAddr, state);
    return state;
  }
}

// ─── production chain source ────────────────────────────────────────────────

export interface ArenaChainSourceConfig {
  rpcUrl: string;
  programId: string;
}

/** Minimal read-only wallet — the source only fetches accounts, never signs. */
const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async <T>(t: T): Promise<T> => t,
  signAllTransactions: async <T>(t: T[]): Promise<T[]> => t,
} as unknown as AnchorWallet;

export class SolanaArenaChainSource implements ArenaChainSource {
  private readonly connection: Connection;
  private readonly program: Program<ChumbucketArena>;
  private readonly programId: PublicKey;
  private readonly programIdStr: string;

  constructor(cfg: ArenaChainSourceConfig) {
    this.connection = new Connection(cfg.rpcUrl, "confirmed");
    this.programId = new PublicKey(cfg.programId);
    this.programIdStr = this.programId.toBase58();
    const provider = new AnchorProvider(this.connection, READ_ONLY_WALLET, { commitment: "confirmed" });
    // Anchor derives Program.programId from idl.address; override to the
    // configured deployment (same reasoning as the keeper).
    this.program = new Program(
      { ...(idl as unknown as Record<string, unknown>), address: this.programIdStr } as unknown as ChumbucketArena,
      provider,
    );
  }

  async signaturesSince(until: string | undefined): Promise<SignatureRef[]> {
    const out: SignatureRef[] = [];
    let before: string | undefined;
    // Page ALL the way down to `until` (or the chain's beginning) so the returned
    // delta is contiguous with the cursor and never truncated from the newest end.
    // Per-pass processing is bounded by maxPerPass in reconcile(), not here.
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(this.programId, {
        limit: 1000,
        ...(before ? { before } : {}),
        ...(until ? { until } : {}),
      });
      if (page.length === 0) break;
      for (const s of page) out.push({ signature: s.signature, slot: s.slot, err: s.err != null });
      before = page[page.length - 1]!.signature;
      if (page.length < 1000) break; // reached `until` or the chain's beginning
      if (out.length % 10000 === 0) console.warn(`[reconciler] large signature backlog: ${out.length}+ since cursor`);
    }
    return out;
  }

  async loadTx(signature: string): Promise<ArenaTx | null> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) return null;
    if (tx.meta?.err) return { err: true, instructions: [] };
    const normalized = collectInstructions(tx);
    return { err: false, instructions: extractArenaInstructions(normalized, this.programIdStr) };
  }

  async loadPot(potAddress: string): Promise<PotState | undefined> {
    let raw: Record<string, unknown>;
    try {
      raw = (await (this.program.account as { pot: { fetch(a: PublicKey): Promise<Record<string, unknown>> } }).pot.fetch(
        new PublicKey(potAddress),
      )) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[reconciler] pot ${potAddress} fetch failed:`, (err as Error)?.message ?? err);
      return undefined;
    }
    return {
      matchId: decodeMatchId(raw.matchId as number[] | undefined),
      fixtureId: bnToNumber(raw.txlineFixtureId),
      winningBucket: Number(raw.winningBucket ?? 0),
      status: Number(raw.status ?? 0),
      distributable: bnToString(raw.distributable),
      winnersStake: bnToString(raw.winnersStake),
    };
  }
}

// ─── decode helpers ─────────────────────────────────────────────────────────

/** ASCII bytes of the fixture id, left-padded to 32 — strip the zero padding. */
export function decodeMatchId(bytes: number[] | undefined): string {
  if (!bytes || bytes.length === 0) return "";
  const buf = Buffer.from(bytes);
  let start = 0;
  while (start < buf.length && buf[start] === 0) start++;
  return buf.subarray(start).toString("ascii");
}

function bnToString(v: unknown): string {
  if (v == null) return "0";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof (v as { toString?: () => string }).toString === "function") return (v as { toString(): string }).toString();
  return "0";
}

function bnToNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(bnToString(v));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Flatten a parsed transaction's top-level + inner instructions into the
 * { programId, accounts, data } shape ArenaInstructionParser understands.
 */
function collectInstructions(tx: unknown): Array<{ programId: string; accounts: string[]; data: string }> {
  const out: Array<{ programId: string; accounts: string[]; data: string }> = [];
  const t = tx as {
    transaction?: { message?: { instructions?: unknown[] } };
    meta?: { innerInstructions?: Array<{ instructions?: unknown[] }> | null };
  };
  const push = (list: unknown[] | undefined) => {
    for (const ix of list ?? []) {
      const n = normalizeInstruction(ix);
      if (n) out.push(n);
    }
  };
  push(t.transaction?.message?.instructions);
  for (const inner of t.meta?.innerInstructions ?? []) push(inner.instructions);
  return out;
}

function normalizeInstruction(ix: unknown): { programId: string; accounts: string[]; data: string } | undefined {
  if (!ix || typeof ix !== "object") return undefined;
  const o = ix as { programId?: unknown; accounts?: unknown; data?: unknown };
  if (o.data == null || o.accounts == null || o.programId == null) return undefined;
  const programId = toBase58(o.programId);
  const accounts = Array.isArray(o.accounts) ? o.accounts.map(toBase58).filter((s): s is string => !!s) : [];
  const data = typeof o.data === "string" ? o.data : "";
  if (!programId || !data) return undefined;
  return { programId, accounts, data };
}

function toBase58(v: unknown): string {
  if (typeof v === "string") return v;
  const asBase58 = (v as { toBase58?: () => string })?.toBase58;
  if (typeof asBase58 === "function") return asBase58.call(v);
  return String(v ?? "");
}
