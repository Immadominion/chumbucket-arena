/**
 * The two private money ledgers (docs/money-api.md):
 *
 *   money_calls       one row per call made with an amount: PENDING until a
 *                     confirmed fill (FUNDED), or kept free (FREE), or never
 *                     finished (EXPIRED). 20261004140000_money_calls.sql.
 *   wallet_transfers  USDC cash outs and wallet top-ups the BFF built for a
 *                     person's own wallet. 20261004140500_wallet_transfers.sql.
 *
 * Every write is conditional on the state the caller read (optimistic
 * concurrency), so two replicas or a retried request can never apply one
 * transition twice. The in-memory stores refuse what the SQL guards refuse;
 * they back the tests and a server with no account database.
 */
import { Pgrest, type PgrestConfig } from "../prediction/pgrest.ts";
import type { Side } from "../prediction/types.ts";

export type MoneyCallState = "PENDING" | "FUNDED" | "FREE" | "EXPIRED";
export type MoneyCallKind = "own" | "back" | "fade";
export type MoneyCallEnd = "filled" | "kept_free" | "discarded" | "expired" | "market_closed" | "not_created";

export interface MoneyCallRow {
  call_id: string;
  user_id: string;
  market_id: string;
  side: Side;
  kind: MoneyCallKind;
  target_call_id: string | null;
  amount_base_units: string;
  max_slippage_bps: number;
  wallet_address: string;
  idempotency_key: string;
  request_fingerprint: string;
  attempts: number;
  state: MoneyCallState;
  ended_reason: MoneyCallEnd | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export type MoneyCallIntent = Omit<MoneyCallRow, "attempts" | "state" | "ended_reason" | "created_at" | "updated_at">
  & { created_at?: string };
export type MoneyCallPatch = Partial<Pick<MoneyCallRow, "state" | "ended_reason" | "attempts" | "wallet_address" | "expires_at">>;

export interface MoneyCallStore {
  /** Null when the idempotency key is already taken (read it back with byKey). */
  insert(intent: MoneyCallIntent): Promise<MoneyCallRow | null>;
  byKey(userId: string, idempotencyKey: string): Promise<MoneyCallRow | null>;
  byCall(userId: string, callId: string): Promise<MoneyCallRow | null>;
  /** Applied only while the row is still in `expected` (state and attempts). Null otherwise. */
  update(callId: string, expected: { state: MoneyCallState; attempts: number }, patch: MoneyCallPatch): Promise<MoneyCallRow | null>;
  /** Every row that is not FUNDED, for the visibility index. Throws past a hard cap rather than truncate. */
  privateRows(): Promise<MoneyCallRow[]>;
  /** The person's PENDING rows, newest first. */
  pendingForUser(userId: string, limit?: number): Promise<MoneyCallRow[]>;
  /** The amount of the person's newest money call, or null. */
  lastAmount(userId: string): Promise<string | null>;
}

const CAP = 50_000;
const PAGE = 1000;
const moneyCallColumns = "call_id,user_id,market_id,side,kind,target_call_id,amount_base_units::text,max_slippage_bps,wallet_address," +
  "idempotency_key,request_fingerprint,attempts,state,ended_reason,expires_at,created_at,updated_at";

export class SupabaseMoneyCallStore implements MoneyCallStore {
  private readonly pg: Pgrest;
  constructor(config: PgrestConfig, fetchImpl: typeof fetch = fetch) { this.pg = new Pgrest(config, fetchImpl); }
  private async one(params: Record<string, string>): Promise<MoneyCallRow | null> {
    return (await this.pg.select<MoneyCallRow>("money_calls", new URLSearchParams({ ...params, select: moneyCallColumns, limit: "1" })))[0] ?? null;
  }
  async insert(intent: MoneyCallIntent) {
    const rows = await this.pg.insert<MoneyCallRow>("money_calls", [intent], { onConflict: "user_id,idempotency_key", ignoreDuplicates: true, returning: true });
    return rows[0] ? normalizeMoneyCall(rows[0]) : null;
  }
  async byKey(userId: string, idempotencyKey: string) {
    const row = await this.one({ user_id: `eq.${userId}`, idempotency_key: `eq.${idempotencyKey}` });
    return row && normalizeMoneyCall(row);
  }
  async byCall(userId: string, callId: string) {
    const row = await this.one({ user_id: `eq.${userId}`, call_id: `eq.${callId}` });
    return row && normalizeMoneyCall(row);
  }
  async update(callId: string, expected: { state: MoneyCallState; attempts: number }, patch: MoneyCallPatch) {
    const rows = await this.pg.patch<MoneyCallRow>("money_calls", new URLSearchParams({
      call_id: `eq.${callId}`, state: `eq.${expected.state}`, attempts: `eq.${expected.attempts}`, select: moneyCallColumns,
    }), { ...patch, updated_at: new Date().toISOString() }, { returning: true });
    return rows[0] ? normalizeMoneyCall(rows[0]) : null;
  }
  async privateRows() {
    const out: MoneyCallRow[] = [];
    for (let offset = 0; offset < CAP; offset += PAGE) {
      const batch = await this.pg.select<MoneyCallRow>("money_calls", new URLSearchParams({
        state: "in.(PENDING,EXPIRED,FREE)", select: moneyCallColumns, order: "created_at.asc,call_id.asc", limit: String(PAGE), offset: String(offset),
      }));
      out.push(...batch.map(normalizeMoneyCall));
      if (batch.length < PAGE) return out;
    }
    throw new Error("money_calls: more private rows than one read may hold");
  }
  async pendingForUser(userId: string, limit = 20) {
    const rows = await this.pg.select<MoneyCallRow>("money_calls", new URLSearchParams({
      user_id: `eq.${userId}`, state: "eq.PENDING", select: moneyCallColumns, order: "created_at.desc", limit: String(Math.max(1, Math.min(50, limit))),
    }));
    return rows.map(normalizeMoneyCall);
  }
  async lastAmount(userId: string) {
    const rows = await this.pg.select<{ amount_base_units: string }>("money_calls", new URLSearchParams({
      user_id: `eq.${userId}`, select: "amount_base_units::text", order: "created_at.desc", limit: "1",
    }));
    return rows[0] ? String(rows[0].amount_base_units) : null;
  }
}

function normalizeMoneyCall(row: MoneyCallRow): MoneyCallRow {
  return { ...row, amount_base_units: String(row.amount_base_units), attempts: Number(row.attempts), max_slippage_bps: Number(row.max_slippage_bps) };
}

/**
 * The SQL guard's rules, in memory. `filled` answers "does this call have a
 * FILLED trade" and `inFlight` "a SUBMITTED or FILLED one", like the guard's
 * reads of panta_trade_sessions.
 */
export class InMemoryMoneyCallStore implements MoneyCallStore {
  readonly rows = new Map<string, MoneyCallRow>();
  constructor(private readonly opts: {
    now?: () => number;
    filled?: (userId: string, callId: string) => Promise<boolean>;
    inFlight?: (userId: string, callId: string) => Promise<boolean>;
    callExists?: (callId: string) => boolean;
  } = {}) {}
  private now() { return new Date(this.opts.now?.() ?? Date.now()).toISOString(); }
  async insert(intent: MoneyCallIntent) {
    for (const row of this.rows.values()) if (row.user_id === intent.user_id && row.idempotency_key === intent.idempotency_key) return null;
    if (this.rows.has(intent.call_id)) throw new Error("money_calls: duplicate call");
    if (this.opts.callExists?.(intent.call_id)) throw new Error("A money call is recorded before its call exists");
    if ((intent.kind === "own") !== (intent.target_call_id === null)) throw new Error("money_calls_target_matches_kind");
    const at = intent.created_at ?? this.now();
    const row: MoneyCallRow = { ...intent, attempts: 1, state: "PENDING", ended_reason: null, created_at: at, updated_at: at };
    if (Date.parse(row.expires_at) <= Date.parse(row.created_at)) throw new Error("money_calls_expiry_after_creation");
    this.rows.set(row.call_id, row);
    return { ...row };
  }
  async byKey(userId: string, key: string) {
    for (const row of this.rows.values()) if (row.user_id === userId && row.idempotency_key === key) return { ...row };
    return null;
  }
  async byCall(userId: string, callId: string) {
    const row = this.rows.get(callId);
    return row && row.user_id === userId ? { ...row } : null;
  }
  async update(callId: string, expected: { state: MoneyCallState; attempts: number }, patch: MoneyCallPatch) {
    const row = this.rows.get(callId);
    if (!row || row.state !== expected.state || row.attempts !== expected.attempts) return null;
    if (row.state === "FUNDED") throw new Error("A funded money call is final");
    const next: MoneyCallRow = { ...row, ...patch, updated_at: this.now() };
    if (next.attempts < row.attempts) throw new Error("Money call attempts only go up");
    if (row.state !== "PENDING" && (next.attempts !== row.attempts || next.wallet_address !== row.wallet_address || next.expires_at !== row.expires_at)) {
      throw new Error("Only a pending money call can be quoted again");
    }
    if (next.state !== row.state) {
      const ok = (row.state === "PENDING" && ["FUNDED", "FREE", "EXPIRED"].includes(next.state)) ||
        ((row.state === "FREE" || row.state === "EXPIRED") && next.state === "FUNDED");
      if (!ok) throw new Error("Invalid money call transition");
      if (next.state === "FUNDED" && this.opts.filled && !(await this.opts.filled(row.user_id, callId))) {
        throw new Error("A money call is funded only by a confirmed fill");
      }
      if (next.state === "EXPIRED" && this.opts.inFlight && await this.opts.inFlight(row.user_id, callId)) {
        throw new Error("A money call with a trade going through cannot expire");
      }
    }
    const reasonOk = (next.state === "PENDING" && next.ended_reason === null) || (next.state === "FUNDED" && next.ended_reason === "filled") ||
      (next.state === "FREE" && next.ended_reason === "kept_free") ||
      (next.state === "EXPIRED" && ["discarded", "expired", "market_closed", "not_created"].includes(next.ended_reason ?? ""));
    if (!reasonOk) throw new Error("money_calls_reason_matches_state");
    this.rows.set(callId, next);
    return { ...next };
  }
  async privateRows() { return [...this.rows.values()].filter(r => r.state !== "FUNDED").map(r => ({ ...r })); }
  async pendingForUser(userId: string, limit = 20) {
    return [...this.rows.values()].filter(r => r.user_id === userId && r.state === "PENDING")
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(r => ({ ...r }));
  }
  async lastAmount(userId: string) {
    const mine = [...this.rows.values()].filter(r => r.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return mine[0]?.amount_base_units ?? null;
  }
}

// ── wallet_transfers ─────────────────────────────────────────────────────────

export type TransferKind = "cash_out" | "deposit";
export type TransferState = "BUILT" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface PreparedTransfer {
  version: 1;
  from: string;
  to: string;
  amountBaseUnits: string;
  mint: string;
  encoding: "solana-tx-base64";
  transaction: string;
  messageHash: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  createsAccount: boolean;
  networkFeeLamports: string;
  rentLamports: string;
  createdAt: number;
  expiresAt: number;
}
export interface TransferEvidence {
  independentlyVerified: true;
  messageHash: string;
  signature: string;
  amountBaseUnits: string;
  slot: number;
}
export interface WalletTransferRow {
  id: string;
  user_id: string;
  kind: TransferKind;
  from_wallet: string;
  to_wallet: string;
  amount_base_units: string;
  idempotency_key: string;
  request_fingerprint: string;
  state: TransferState;
  prepared: PreparedTransfer;
  signed_transaction: string | null;
  signature: string | null;
  confirm_evidence: TransferEvidence | null;
  created_at: string;
  updated_at: string;
}
export type TransferIntent = Omit<WalletTransferRow, "state" | "signed_transaction" | "signature" | "confirm_evidence" | "created_at" | "updated_at">;
export type TransferPatch = Partial<Pick<WalletTransferRow, "state" | "signed_transaction" | "signature" | "confirm_evidence">>;

export interface WalletTransferStore {
  insert(intent: TransferIntent): Promise<WalletTransferRow | null>;
  byKey(userId: string, key: string): Promise<WalletTransferRow | null>;
  byId(userId: string, id: string): Promise<WalletTransferRow | null>;
  update(id: string, previous: TransferState, patch: TransferPatch): Promise<WalletTransferRow | null>;
  listForUser(userId: string, limit?: number): Promise<WalletTransferRow[]>;
  /** SUBMITTED across all people, oldest change first. Server worker only. */
  submitted(limit: number): Promise<WalletTransferRow[]>;
}

const transferColumns = "id,user_id,kind,from_wallet,to_wallet,amount_base_units::text,idempotency_key,request_fingerprint,state,prepared," +
  "signed_transaction,signature,confirm_evidence,created_at,updated_at";
const normalizeTransfer = (row: WalletTransferRow): WalletTransferRow => ({ ...row, amount_base_units: String(row.amount_base_units) });

export class SupabaseWalletTransferStore implements WalletTransferStore {
  private readonly pg: Pgrest;
  constructor(config: PgrestConfig, fetchImpl: typeof fetch = fetch) { this.pg = new Pgrest(config, fetchImpl); }
  private async one(params: Record<string, string>) {
    const row = (await this.pg.select<WalletTransferRow>("wallet_transfers", new URLSearchParams({ ...params, select: transferColumns, limit: "1" })))[0];
    return row ? normalizeTransfer(row) : null;
  }
  async insert(intent: TransferIntent) {
    const rows = await this.pg.insert<WalletTransferRow>("wallet_transfers", [intent], { onConflict: "user_id,idempotency_key", ignoreDuplicates: true, returning: true });
    return rows[0] ? normalizeTransfer(rows[0]) : null;
  }
  byKey(userId: string, key: string) { return this.one({ user_id: `eq.${userId}`, idempotency_key: `eq.${key}` }); }
  byId(userId: string, id: string) { return this.one({ user_id: `eq.${userId}`, id: `eq.${id}` }); }
  async update(id: string, previous: TransferState, patch: TransferPatch) {
    const rows = await this.pg.patch<WalletTransferRow>("wallet_transfers", new URLSearchParams({ id: `eq.${id}`, state: `eq.${previous}`, select: transferColumns }),
      { ...patch, updated_at: new Date().toISOString() }, { returning: true });
    return rows[0] ? normalizeTransfer(rows[0]) : null;
  }
  async listForUser(userId: string, limit = 50) {
    return (await this.pg.select<WalletTransferRow>("wallet_transfers", new URLSearchParams({
      user_id: `eq.${userId}`, state: "in.(SUBMITTED,CONFIRMED,FAILED)", signature: "not.is.null",
      select: transferColumns, order: "created_at.desc", limit: String(Math.max(1, Math.min(200, limit))),
    }))).map(normalizeTransfer);
  }
  async submitted(limit: number) {
    return (await this.pg.select<WalletTransferRow>("wallet_transfers", new URLSearchParams({
      state: "eq.SUBMITTED", select: transferColumns, order: "updated_at.asc", limit: String(Math.max(1, Math.min(100, limit))),
    }))).map(normalizeTransfer);
  }
}

export class InMemoryWalletTransferStore implements WalletTransferStore {
  readonly rows = new Map<string, WalletTransferRow>();
  constructor(private readonly now: () => number = Date.now) {}
  private iso() { return new Date(this.now()).toISOString(); }
  async insert(intent: TransferIntent) {
    for (const row of this.rows.values()) if (row.user_id === intent.user_id && row.idempotency_key === intent.idempotency_key) return null;
    if (intent.from_wallet === intent.to_wallet) throw new Error("wallet_transfers_not_to_self");
    const at = this.iso();
    const row: WalletTransferRow = { ...intent, state: "BUILT", signed_transaction: null, signature: null, confirm_evidence: null, created_at: at, updated_at: at };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }
  async byKey(userId: string, key: string) {
    for (const row of this.rows.values()) if (row.user_id === userId && row.idempotency_key === key) return structuredClone(row);
    return null;
  }
  async byId(userId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.user_id === userId ? structuredClone(row) : null;
  }
  async update(id: string, previous: TransferState, patch: TransferPatch) {
    const row = this.rows.get(id);
    if (!row || row.state !== previous) return null;
    if (row.state === "CONFIRMED" || row.state === "FAILED") throw new Error("A settled wallet transfer is final");
    if (row.signature !== null && ((patch.signature !== undefined && patch.signature !== row.signature) ||
      (patch.signed_transaction !== undefined && patch.signed_transaction !== row.signed_transaction))) {
      throw new Error("A wallet transfer can approve only one transaction");
    }
    const next = { ...row, ...patch, updated_at: this.iso() };
    if (next.state !== row.state && !((row.state === "BUILT" && ["SUBMITTED", "FAILED"].includes(next.state)) ||
      (row.state === "SUBMITTED" && ["CONFIRMED", "FAILED"].includes(next.state)))) throw new Error("Invalid wallet transfer transition");
    if ((next.state === "CONFIRMED") !== (next.confirm_evidence !== null)) throw new Error("wallet_transfers_evidence_state");
    this.rows.set(id, next);
    return structuredClone(next);
  }
  async listForUser(userId: string, limit = 50) {
    return [...this.rows.values()].filter(r => r.user_id === userId && r.signature !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(r => structuredClone(r));
  }
  async submitted(limit: number) {
    return [...this.rows.values()].filter(r => r.state === "SUBMITTED").sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, limit)
      .map(r => structuredClone(r));
  }
}
