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

export interface ApplySettlementInput {
  marketId: string;
  matchId: string;
  /** HOME | DRAW | AWAY */
  winningBucket: string;
  settleTxSignature: string;
  slot?: number;
  /** On-chain Pot.distributable (losers' pool minus rake), base units. */
  distributableBaseUnits: string;
  /** On-chain Pot.winners_stake, base units. 0 => the pot voided (refund all). */
  winnersStakeBaseUnits: string;
  scoreHome?: number;
  scoreAway?: number;
  fixtureId?: number;
  seq?: number;
  proofRef?: string;
  proof?: Record<string, unknown>;
}

export interface ApplyClaimInput {
  wallet: string;
  /** The Position PDA address the claim closed. */
  positionAddress: string;
  claimTxSignature: string;
  amountBaseUnits?: string;
  slot?: number;
}

export interface IndexerCursorRow {
  last_signature: string | null;
  last_slot: number | null;
}

export interface FollowCounts {
  followers: number;
  following: number;
}

export interface MatchCallerRow {
  wallet_address: string;
  handle: string | null;
  bucket: string;
  stake_base_units: string;
  status: string;
  payout_base_units: string | null;
  placed_at: string;
}

export interface LeaderboardRow {
  wallet_address: string;
  handle: string | null;
  display_name: string | null;
  calls_made: number;
  calls_won: number;
  calls_lost: number;
  calls_voided: number;
  pnl_base_units: string;
  current_streak: number;
  best_streak: number;
  win_rate: number;
}

export interface UserStatsRow {
  user_id: string;
  wallet_address: string | null;
  calls_made: number;
  calls_won: number;
  calls_lost: number;
  calls_voided: number;
  stake_base_units: string;
  pnl_base_units: string;
  current_streak: number;
  best_streak: number;
}

export interface NotificationRow {
  id: string;
  network: string;
  recipient_wallet_address: string | null;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  status: string;
  read_at: string | null;
  created_at: string;
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
  applySettlement(input: ApplySettlementInput): Promise<{ ok: boolean; result?: unknown; reason?: string }>;
  applyClaim(input: ApplyClaimInput): Promise<{ ok: boolean; result?: unknown; reason?: string }>;
  advanceCursor(source: string, cursorKey: string, signature: string, slot?: number): Promise<void>;
  readCursor(source: string, cursorKey: string): Promise<IndexerCursorRow | null>;
  myPositions(wallet: string, limit: number): Promise<PredictionPositionRow[]>;
  claimable(wallet: string, limit: number): Promise<PredictionPositionRow[]>;
  activity(input: { matchId?: string; wallet?: string; limit: number }): Promise<PredictionActivityRow[]>;
  // social graph
  follow(follower: string, followee: string): Promise<{ ok: boolean; result?: unknown; reason?: string }>;
  unfollow(follower: string, followee: string): Promise<{ ok: boolean; result?: unknown; reason?: string }>;
  followingFeed(wallet: string, limit: number): Promise<PredictionActivityRow[]>;
  followCounts(wallet: string): Promise<FollowCounts>;
  isFollowing(viewer: string, target: string): Promise<boolean>;
  matchCallers(matchId: string, limit: number): Promise<MatchCallerRow[]>;
  socialLeaderboard(by: string, limit: number): Promise<LeaderboardRow[]>;
  userStats(wallet: string): Promise<UserStatsRow | null>;
  // notifications
  notifications(wallet: string, limit: number, unreadOnly: boolean): Promise<NotificationRow[]>;
  unreadCount(wallet: string): Promise<number>;
  markNotificationsRead(wallet: string, ids?: string[]): Promise<{ ok: boolean; count?: number }>;
}

export class NoopSocialStore implements SocialStore {
  readonly enabled = false;

  async recordPredictionCall(): Promise<{ ok: boolean; reason: string }> {
    return { ok: false, reason: "social store is not configured" };
  }

  async confirmPredictionSignature(): Promise<{ ok: boolean; reason: string }> {
    return { ok: false, reason: "social store is not configured" };
  }

  async applySettlement(): Promise<{ ok: boolean; reason: string }> {
    return { ok: false, reason: "social store is not configured" };
  }

  async applyClaim(): Promise<{ ok: boolean; reason: string }> {
    return { ok: false, reason: "social store is not configured" };
  }

  async advanceCursor(): Promise<void> {
    // no-op
  }

  async readCursor(): Promise<IndexerCursorRow | null> {
    return null;
  }

  async myPositions(): Promise<PredictionPositionRow[]> {
    return [];
  }

  async claimable(): Promise<PredictionPositionRow[]> {
    return [];
  }

  async activity(): Promise<PredictionActivityRow[]> {
    return [];
  }

  async follow(): Promise<{ ok: boolean; reason: string }> {
    return { ok: false, reason: "social store is not configured" };
  }

  async unfollow(): Promise<{ ok: boolean; reason: string }> {
    return { ok: false, reason: "social store is not configured" };
  }

  async followingFeed(): Promise<PredictionActivityRow[]> {
    return [];
  }

  async followCounts(): Promise<FollowCounts> {
    return { followers: 0, following: 0 };
  }

  async isFollowing(): Promise<boolean> {
    return false;
  }

  async matchCallers(): Promise<MatchCallerRow[]> {
    return [];
  }

  async socialLeaderboard(): Promise<LeaderboardRow[]> {
    return [];
  }

  async userStats(): Promise<UserStatsRow | null> {
    return null;
  }

  async notifications(): Promise<NotificationRow[]> {
    return [];
  }

  async unreadCount(): Promise<number> {
    return 0;
  }

  async markNotificationsRead(): Promise<{ ok: boolean }> {
    return { ok: false };
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

  async applySettlement(input: ApplySettlementInput): Promise<{ ok: boolean; result?: unknown; reason?: string }> {
    // distributable/winners_stake are u64 base units that overflow JS safe ints,
    // so pass them as strings — PostgREST casts text -> NUMERIC without precision loss.
    const result = await this.rpc<unknown>("apply_settlement", {
      p_network: this.cfg.network,
      p_market_id: input.marketId,
      p_match_id: input.matchId,
      p_winning_bucket: input.winningBucket,
      p_settle_tx: input.settleTxSignature,
      p_slot: input.slot ?? null,
      p_distributable: input.distributableBaseUnits,
      p_winners_stake: input.winnersStakeBaseUnits,
      p_score_home: input.scoreHome ?? null,
      p_score_away: input.scoreAway ?? null,
      p_fixture_id: input.fixtureId ?? null,
      p_seq: input.seq ?? null,
      p_proof_ref: input.proofRef ?? null,
      p_proof: input.proof ?? null,
    });
    return { ok: true, result };
  }

  async applyClaim(input: ApplyClaimInput): Promise<{ ok: boolean; result?: unknown; reason?: string }> {
    const result = await this.rpc<unknown>("apply_claim_fact", {
      p_network: this.cfg.network,
      p_wallet: input.wallet,
      p_position_address: input.positionAddress,
      p_claim_tx: input.claimTxSignature,
      p_amount: input.amountBaseUnits ?? null,
      p_slot: input.slot ?? null,
    });
    return { ok: true, result };
  }

  async advanceCursor(source: string, cursorKey: string, signature: string, slot?: number): Promise<void> {
    await this.rpc<unknown>("advance_indexer_cursor", {
      p_network: this.cfg.network,
      p_source: source,
      p_cursor_key: cursorKey,
      p_signature: signature,
      p_slot: slot ?? null,
    });
  }

  async readCursor(source: string, cursorKey: string): Promise<IndexerCursorRow | null> {
    const params = new URLSearchParams({
      network: `eq.${this.cfg.network}`,
      source: `eq.${source}`,
      cursor_key: `eq.${cursorKey}`,
      select: "last_signature,last_slot",
      limit: "1",
    });
    const rows = await this.getRows<IndexerCursorRow>("indexer_cursors", params);
    return rows[0] ?? null;
  }

  async claimable(wallet: string, limit: number): Promise<PredictionPositionRow[]> {
    const params = new URLSearchParams({
      network: `eq.${this.cfg.network}`,
      wallet_address: `eq.${wallet}`,
      status: "eq.CLAIMABLE",
      select: "*",
      order: "settled_at.desc",
      limit: String(limit),
    });
    return this.getRows<PredictionPositionRow>("prediction_positions", params);
  }

  async follow(follower: string, followee: string): Promise<{ ok: boolean; result?: unknown }> {
    const result = await this.rpc<unknown>("follow_wallet", {
      p_network: this.cfg.network,
      p_follower: follower,
      p_followee: followee,
    });
    return { ok: true, result };
  }

  async unfollow(follower: string, followee: string): Promise<{ ok: boolean; result?: unknown }> {
    const result = await this.rpc<unknown>("unfollow_wallet", {
      p_network: this.cfg.network,
      p_follower: follower,
      p_followee: followee,
    });
    return { ok: true, result };
  }

  async followingFeed(wallet: string, limit: number): Promise<PredictionActivityRow[]> {
    return (
      (await this.rpc<PredictionActivityRow[]>("feed_following", {
        p_network: this.cfg.network,
        p_wallet: wallet,
        p_limit: limit,
      })) ?? []
    );
  }

  async followCounts(wallet: string): Promise<FollowCounts> {
    const r = await this.rpc<FollowCounts>("follow_counts", { p_network: this.cfg.network, p_wallet: wallet });
    return r ?? { followers: 0, following: 0 };
  }

  async isFollowing(viewer: string, target: string): Promise<boolean> {
    return !!(await this.rpc<boolean>("is_following", {
      p_network: this.cfg.network,
      p_viewer: viewer,
      p_target: target,
    }));
  }

  async matchCallers(matchId: string, limit: number): Promise<MatchCallerRow[]> {
    return (
      (await this.rpc<MatchCallerRow[]>("match_callers", {
        p_network: this.cfg.network,
        p_match_id: matchId,
        p_limit: limit,
      })) ?? []
    );
  }

  async socialLeaderboard(by: string, limit: number): Promise<LeaderboardRow[]> {
    return (await this.rpc<LeaderboardRow[]>("social_leaderboard", { p_by: by, p_limit: limit })) ?? [];
  }

  async userStats(wallet: string): Promise<UserStatsRow | null> {
    const params = new URLSearchParams({ wallet_address: `eq.${wallet}`, select: "*", limit: "1" });
    const rows = await this.getRows<UserStatsRow>("user_stats", params);
    return rows[0] ?? null;
  }

  async notifications(wallet: string, limit: number, unreadOnly: boolean): Promise<NotificationRow[]> {
    return (
      (await this.rpc<NotificationRow[]>("get_notifications", {
        p_network: this.cfg.network,
        p_wallet: wallet,
        p_limit: limit,
        p_unread_only: unreadOnly,
      })) ?? []
    );
  }

  async unreadCount(wallet: string): Promise<number> {
    return Number(await this.rpc<number>("unread_notification_count", { p_network: this.cfg.network, p_wallet: wallet })) || 0;
  }

  async markNotificationsRead(wallet: string, ids?: string[]): Promise<{ ok: boolean; count?: number }> {
    const count = await this.rpc<number>("mark_notifications_read", {
      p_network: this.cfg.network,
      p_wallet: wallet,
      p_ids: ids ?? null,
    });
    return { ok: true, count: Number(count) || 0 };
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
