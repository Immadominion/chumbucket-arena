/**
 * SocialStore — durable social prediction read models.
 *
 * The Engine/event log is still the domain brain, and the on-chain program is
 * still the funds source of truth. This adapter writes/querys the Supabase
 * social read model that powers mobile feeds, profiles, positions, and
 * settlement history.
 */

export interface SocialStoreConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  network: "devnet" | "mainnet-beta";
}

export interface RecordPredictionCallInput {
  wallet: string;
  matchId: string;
  marketId: string;
  bucket: string;
  stakeBaseUnits: string;
  txSignature: string;
  positionAddress?: string;
  slot?: number;
  metadata?: Record<string, unknown>;
}

export interface ConfirmPredictionSignatureInput {
  source: string;
  txSignature: string;
  slot?: number;
  payload?: Record<string, unknown>;
}

export interface PredictionPositionRow {
  id: string;
  network: string;
  wallet_address: string;
  market_id: string;
  match_id: string;
  position_address: string | null;
  bucket: string;
  stake_base_units: string;
  open_tx_signature: string;
  open_slot: number | null;
  status: string;
  payout_base_units: string | null;
  pnl_base_units: string | null;
  settlement_tx_signature: string | null;
  claim_tx_signature: string | null;
  claimed_at: string | null;
  placed_at: string;
  settled_at: string | null;
  metadata: Record<string, unknown>;
}

export interface PredictionActivityRow {
  id: string;
  network: string;
  actor_wallet_address: string;
  type: string;
  visibility: string;
  market_id: string | null;
  match_id: string | null;
  position_id: string | null;
  challenge_id: string | null;
  bucket: string | null;
  stake_base_units: string | null;
  tx_signature: string | null;
  slot: number | null;
  status: string;
  title: string | null;
  body: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SocialStore {
  readonly enabled: boolean;
  recordPredictionCall(input: RecordPredictionCallInput): Promise<{ ok: boolean; positionId?: string; reason?: string }>;
  confirmPredictionSignature(input: ConfirmPredictionSignatureInput): Promise<{ ok: boolean; result?: unknown; reason?: string }>;
  myPositions(wallet: string, limit: number): Promise<PredictionPositionRow[]>;
  activity(input: { matchId?: string; wallet?: string; limit: number }): Promise<PredictionActivityRow[]>;
}

export class NoopSocialStore implements SocialStore {
  readonly enabled = false;

  async recordPredictionCall(): Promise<{ ok: boolean; reason: string }> {
    return { ok: false, reason: "social store is not configured" };
  }

  async confirmPredictionSignature(): Promise<{ ok: boolean; reason: string }> {
    return { ok: false, reason: "social store is not configured" };
  }

  async myPositions(): Promise<PredictionPositionRow[]> {
    return [];
  }

  async activity(): Promise<PredictionActivityRow[]> {
    return [];
  }
}

export class SupabaseSocialStore implements SocialStore {
  readonly enabled = true;
  private readonly restBase: string;

  constructor(private readonly cfg: SocialStoreConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.restBase = `${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  }

  async recordPredictionCall(input: RecordPredictionCallInput): Promise<{ ok: boolean; positionId?: string; reason?: string }> {
    const data = await this.rpc<string>("record_prediction_call", {
      p_network: this.cfg.network,
      p_wallet_address: input.wallet,
      p_match_id: input.matchId,
      p_market_id: input.marketId,
      p_bucket: input.bucket,
      p_stake_base_units: input.stakeBaseUnits,
      p_tx_signature: input.txSignature,
      p_position_address: input.positionAddress ?? null,
      p_slot: input.slot ?? null,
      p_metadata: input.metadata ?? {},
    });
    return { ok: true, positionId: data };
  }

  async confirmPredictionSignature(input: ConfirmPredictionSignatureInput): Promise<{ ok: boolean; result?: unknown; reason?: string }> {
    const data = await this.rpc<unknown>("confirm_prediction_signature", {
      p_network: this.cfg.network,
      p_source: input.source,
      p_tx_signature: input.txSignature,
      p_slot: input.slot ?? null,
      p_payload: input.payload ?? {},
    });
    return { ok: true, result: data };
  }

  async myPositions(wallet: string, limit: number): Promise<PredictionPositionRow[]> {
    const params = new URLSearchParams({
      network: `eq.${this.cfg.network}`,
      wallet_address: `eq.${wallet}`,
      select: "*",
      order: "placed_at.desc",
      limit: String(limit),
    });
    return this.getRows<PredictionPositionRow>("prediction_positions", params);
  }

  async activity(input: { matchId?: string; wallet?: string; limit: number }): Promise<PredictionActivityRow[]> {
    const params = new URLSearchParams({
      network: `eq.${this.cfg.network}`,
      visibility: "eq.public",
      select: "*",
      order: "created_at.desc",
      limit: String(input.limit),
    });
    if (input.matchId) params.set("match_id", `eq.${input.matchId}`);
    if (input.wallet) params.set("actor_wallet_address", `eq.${input.wallet}`);
    return this.getRows<PredictionActivityRow>("prediction_activity", params);
  }

  private async rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.restBase}/rpc/${name}`, {
      method: "POST",
      headers: this.headers({ prefer: "return=representation" }),
      body: JSON.stringify(body),
    });
    return this.decode<T>(res, `rpc/${name}`);
  }

  private async getRows<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const res = await this.fetchImpl(`${this.restBase}/${table}?${params.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
    return this.decode<T[]>(res, table);
  }

  private headers(extra?: { prefer?: string }): Record<string, string> {
    return {
      apikey: this.cfg.serviceRoleKey,
      Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(extra?.prefer ? { Prefer: extra.prefer } : {}),
    };
  }

  private async decode<T>(res: Response, label: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`[social] ${label} HTTP ${res.status}: ${text}`);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}
