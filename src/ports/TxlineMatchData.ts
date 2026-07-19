/**
 * MatchData over TxLINE (TxODDS) — the live World Cup 2026 feed, cryptographically
 * anchored on Solana. Same shape as FootballDataProvider/ApiFootballProvider (poll
 * + short-TTL cache), so it drops into the existing MatchDataProvider seam with no
 * changes to Engine.
 *
 * Auth is a pre-activated (jwt + apiToken) pair — the guest-JWT + on-chain-subscribe
 * + signed-activation dance is a one-time setup step (see scripts/), not something
 * this adapter re-runs per request.
 *
 * Field shapes here are ROUND-TRIPPED against the live devnet API (2026-07-11):
 * `/api/fixtures/snapshot` returns a bare PascalCase array (FixtureId, Participant1,
 * StartTime as epoch ms, GameState), and `/api/scores/snapshot/{id}` returns a bare,
 * UNORDERED array of score events. Do not "normalise" these to camelCase — that was
 * this adapter's original bug (every field read undefined → 0 fixtures).
 */

import { asMatchId, type MatchId } from "../domain/ids.ts";
import type { Fixture } from "../domain/model.ts";
import type { LiveMatchState, MatchDataProvider, MatchResult } from "./MatchData.ts";

export interface TxlineConfig {
  apiBaseUrl: string; // e.g. https://txline.txodds.com or https://txline-dev.txodds.com
  jwt: string;
  apiToken: string;
  cacheTtlMs: number;
}

interface TxFixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Participant1IsHome?: boolean;
  Competition?: string;
  FixtureGroupId?: number;
  StartTime: number; // epoch ms
  GameState: number; // 1 = scheduled/upcoming
}

/**
 * One row of /api/scores/snapshot/{fixtureId}. The response is a bare,
 * UNORDERED array — the last element is routinely a stale mid-match row, so
 * finished-ness must be decided by scanning the WHOLE array for a terminal
 * status (proven live in onchain/…/devnet-lifecycle/lock-and-settle.ts, which
 * once mistook a frozen in-play row for "the feed lags days").
 */
export interface TxScoresEvent {
  Seq?: number;
  StatusId?: number;
  Action?: string; // "game_finalised" on the terminal record (corroboration only)
  Participant1IsHome?: boolean; // present on every scores row — orient P1/P2 → home/away
  Stats?: Record<string, number>; // keyed by stat id: "1"/"2" = participant 1/2 total goals
}

/**
 * Soccer game-phase StatusId values that are genuinely terminal
 * (documentation/scores/soccer-feed): 5 = F (ended in regulation), 10 = FET
 * (ended after extra time), 13 = FPE (ended after penalties). Everything else
 * — half-time, in-play, suspensions — can still change; never settle on it.
 */
export const FINISHED_STATUS_IDS: ReadonlySet<number> = new Set([5, 10, 13]);
/** Full-game stat keys: participant-1 / participant-2 total goals. */
export const STAT_KEY_P1_GOALS = 1;
export const STAT_KEY_P2_GOALS = 2;

/**
 * Pick the definitive final event out of an unordered scores-snapshot array:
 * the highest-Seq row whose StatusId is terminal. Returns undefined while the
 * match is still (or not yet) in play. Shared with TxlineSettlementVerifier so
 * "finished" means exactly one thing across the codebase.
 */
export function finalScoresEvent(events: TxScoresEvent[]): TxScoresEvent | undefined {
  let final: TxScoresEvent | undefined;
  for (const e of events) {
    if (!FINISHED_STATUS_IDS.has(e.StatusId ?? -1)) continue;
    if (!final || (e.Seq ?? 0) > (final.Seq ?? 0)) final = e;
  }
  return final;
}

export class TxlineMatchData implements MatchDataProvider {
  private fixturesCache: { at: number; data: TxFixture[] } | undefined;
  private readonly now: () => number;

  constructor(
    private readonly cfg: TxlineConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
    warnIfJwtStale(cfg.jwt, this.now());
  }

  private headers(): Record<string, string> {
    // Accept-Encoding: identity — the TxLINE server serves zstd/deflate by default,
    // which Bun's fetch fails to decompress (ZstdDecompressionError). Force plain.
    return { Authorization: `Bearer ${this.cfg.jwt}`, "X-Api-Token": this.cfg.apiToken, "Accept-Encoding": "identity" };
  }

  async fixtures(): Promise<Fixture[]> {
    const data = await this.fetchFixtures();
    return data.filter((f) => f.GameState === 1).map((f) => this.toFixture(f));
  }

  async results(matchIds: MatchId[]): Promise<MatchResult[]> {
    const fixturesById = new Map((await this.fetchFixtures()).map((f) => [String(f.FixtureId), f]));
    const out: MatchResult[] = [];
    for (const id of matchIds) {
      const fx = fixturesById.get(String(id));
      if (!fx) continue;
      try {
        // asOf busts any intermediate caching so a just-finished match is seen promptly.
        const res = await this.fetchImpl(`${this.cfg.apiBaseUrl}/api/scores/snapshot/${id}?asOf=${this.now()}`, {
          headers: this.headers(),
        });
        if (!res.ok) continue; // no snapshot yet (not kicked off) — try again next tick
        const raw = (await res.json()) as TxScoresEvent[] | null;
        const finalEvent = finalScoresEvent(Array.isArray(raw) ? raw : []);
        if (!finalEvent) continue; // still in play (or no events yet)
        const p1 = finalEvent.Stats?.[String(STAT_KEY_P1_GOALS)];
        const p2 = finalEvent.Stats?.[String(STAT_KEY_P2_GOALS)];
        if (p1 == null || p2 == null) {
          console.error(`[txline] fixture ${id}: terminal event (Seq=${finalEvent.Seq}) missing goal stats — not resolving`);
          continue;
        }
        // Stats are participant-1/participant-2 — orient to home/away per the fixture.
        const p1IsHome = fx.Participant1IsHome ?? true;
        out.push({
          matchId: asMatchId(String(id)),
          score: p1IsHome ? { home: p1, away: p2 } : { home: p2, away: p1 },
          finished: true,
        });
      } catch (err) {
        console.error(`[txline] scores snapshot for ${id} failed:`, (err as Error).message);
      }
    }
    return out;
  }

  /**
   * Current in-play score + phase from the same scores snapshot results() reads,
   * but returning the LATEST score rather than only a terminal one — so the live
   * strip can show the score while a match is being played. Never settles: the
   * on-chain proof gate in the settlement verifier is the only source of truth
   * for payouts.
   */
  async liveScore(matchId: MatchId): Promise<LiveMatchState | null> {
    try {
      const res = await this.fetchImpl(`${this.cfg.apiBaseUrl}/api/scores/snapshot/${matchId}?asOf=${this.now()}`, {
        headers: this.headers(),
      });
      if (!res.ok) return null; // no snapshot yet (not kicked off)
      const raw = (await res.json()) as TxScoresEvent[] | null;
      const events = Array.isArray(raw) ? raw : [];

      const hasGoals = (e: TxScoresEvent | undefined): e is TxScoresEvent =>
        !!e && e.Stats?.[String(STAT_KEY_P1_GOALS)] != null && e.Stats?.[String(STAT_KEY_P2_GOALS)] != null;

      // Prefer a terminal event's score when the match is over; otherwise the
      // highest-Seq in-play event that actually carries both goal stats.
      const finalEv = finalScoresEvent(events);
      let latest: TxScoresEvent | undefined;
      for (const e of events) {
        if (!hasGoals(e)) continue;
        if (!latest || (e.Seq ?? 0) > (latest.Seq ?? 0)) latest = e;
      }
      const scoreEv = hasGoals(finalEv) ? finalEv : latest;
      if (!hasGoals(scoreEv)) return null; // events exist but no scored state yet → 0-0 not proven

      const p1 = scoreEv.Stats![String(STAT_KEY_P1_GOALS)]!;
      const p2 = scoreEv.Stats![String(STAT_KEY_P2_GOALS)]!;
      // Orient P1/P2 → home/away from the scores event's own flag (every row
      // carries it), falling back to the fixtures snapshot. This keeps working
      // after a finished match drops off the upcoming-fixtures list.
      const p1IsHome =
        scoreEv.Participant1IsHome ??
        events.find((e) => e.Participant1IsHome != null)?.Participant1IsHome ??
        (await this.fetchFixtures()).find((f) => String(f.FixtureId) === String(matchId))?.Participant1IsHome ??
        true;
      return {
        matchId: asMatchId(String(matchId)),
        score: p1IsHome ? { home: p1, away: p2 } : { home: p2, away: p1 },
        finished: finalEv !== undefined,
        statusId: scoreEv.StatusId,
      };
    } catch (err) {
      console.error(`[txline] liveScore for ${matchId} failed:`, (err as Error).message);
      return null;
    }
  }

  private async fetchFixtures(): Promise<TxFixture[]> {
    if (this.fixturesCache && this.now() - this.fixturesCache.at < this.cfg.cacheTtlMs) {
      return this.fixturesCache.data;
    }
    try {
      const res = await this.fetchImpl(`${this.cfg.apiBaseUrl}/api/fixtures/snapshot`, { headers: this.headers() });
      if (!res.ok) {
        console.error(`[txline] fixtures/snapshot HTTP ${res.status} (serving cache)`);
        return this.fixturesCache?.data ?? [];
      }
      const raw = (await res.json()) as TxFixture[] | { fixtures?: TxFixture[] };
      const data = Array.isArray(raw) ? raw : raw.fixtures ?? [];
      this.fixturesCache = { at: this.now(), data };
      return data;
    } catch (err) {
      console.error("[txline] fixtures/snapshot fetch failed, serving cache:", (err as Error).message);
      return this.fixturesCache?.data ?? [];
    }
  }

  private toFixture(f: TxFixture): Fixture {
    return {
      matchId: asMatchId(String(f.FixtureId)),
      home: f.Participant1,
      away: f.Participant2,
      competition: f.Competition ?? "FIFA World Cup 2026",
      stage: "GROUP",
      kickoff: f.StartTime,
      txline: { fixtureId: f.FixtureId, participant1IsHome: f.Participant1IsHome ?? true },
    };
  }
}

/**
 * The devnet JWT carries an exp claim; when it lapses every TxLINE call turns
 * into a silent 401→"serving cache" loop. Make that failure mode loud at boot
 * instead of mysterious at match time. Best-effort — a malformed token just
 * skips the warning.
 */
function warnIfJwtStale(jwt: string, nowMs: number): void {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64").toString("utf8")) as { exp?: number };
    if (!payload.exp) return;
    const msLeft = payload.exp * 1000 - nowMs;
    if (msLeft <= 0) {
      console.error(`[txline] JWT EXPIRED ${new Date(payload.exp * 1000).toISOString()} — all TxLINE calls will 401; re-run the activation flow`);
    } else if (msLeft < 48 * 60 * 60 * 1000) {
      console.warn(`[txline] JWT expires in ${(msLeft / 3_600_000).toFixed(1)}h (${new Date(payload.exp * 1000).toISOString()}) — refresh before it lapses`);
    }
  } catch {
    /* not a standard JWT — nothing to check */
  }
}
