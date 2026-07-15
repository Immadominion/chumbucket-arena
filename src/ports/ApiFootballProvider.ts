/**
 * MatchData over API-Football (api-sports). Football is the first sport, with the
 * World Cup as the flagship competition — but this is competition-agnostic: feed
 * it any league/season and it works, so the product reads as a general sports
 * platform, not a World-Cup-only hack.
 *
 * Caching is the whole game here. One `/fixtures?league&season` call per
 * competition per TTL window serves *every* client and *every* engine tick — we
 * never call the API per request. A single cached fetch yields both upcoming
 * fixtures and finished results (status + goals live on the same payload), so a
 * featured competition costs ~ (1 day / TTL) calls/day. On a failed fetch we
 * serve the last good cache rather than crash the tick.
 */

import { asMatchId, type MatchId } from "../domain/ids.ts";
import type { Fixture } from "../domain/model.ts";
import type { MatchDataProvider, MatchResult } from "./MatchData.ts";

export interface Competition {
  league: number; // API-Football league id (World Cup = 1)
  season: number; // e.g. 2026
}

export interface ApiFootballConfig {
  apiKey: string;
  baseUrl: string; // https://v3.football.api-sports.io (direct) — or a RapidAPI base
  competitions: Competition[];
  cacheTtlMs: number;
  /** Header name for the key. Direct api-football.com → x-apisports-key. */
  apiKeyHeader?: string;
  now?: () => number;
}

interface AfFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { id: number; name: string; round?: string };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
}

const FINISHED = new Set(["FT", "AET", "PEN"]);

export class ApiFootballProvider implements MatchDataProvider {
  private readonly cache = new Map<string, { at: number; data: AfFixture[] }>();
  private readonly now: () => number;
  private readonly header: string;

  constructor(
    private readonly cfg: ApiFootballConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.now = cfg.now ?? (() => Date.now());
    this.header = cfg.apiKeyHeader ?? "x-apisports-key";
  }

  async fixtures(): Promise<Fixture[]> {
    return (await this.allRaw()).map((f) => this.toFixture(f));
  }

  async results(matchIds: MatchId[]): Promise<MatchResult[]> {
    const wanted = new Set(matchIds.map(String));
    return (await this.allRaw())
      .filter(
        (f) =>
          FINISHED.has(f.fixture.status.short) &&
          f.goals.home !== null &&
          f.goals.away !== null &&
          wanted.has(String(f.fixture.id)),
      )
      .map((f) => ({
        matchId: asMatchId(String(f.fixture.id)),
        score: { home: f.goals.home as number, away: f.goals.away as number },
        finished: true,
      }));
  }

  private async allRaw(): Promise<AfFixture[]> {
    const lists = await Promise.all(this.cfg.competitions.map((c) => this.fetchCompetition(c)));
    return lists.flat();
  }

  private async fetchCompetition(comp: Competition): Promise<AfFixture[]> {
    const key = `${comp.league}:${comp.season}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.cfg.cacheTtlMs) return cached.data;

    try {
      const url = `${this.cfg.baseUrl}/fixtures?league=${comp.league}&season=${comp.season}`;
      const res = await this.fetchImpl(url, { headers: { [this.header]: this.cfg.apiKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { response?: AfFixture[]; errors?: unknown };
      const errs = body.errors;
      const hasErr = Array.isArray(errs) ? errs.length > 0 : !!errs && typeof errs === "object" && Object.keys(errs).length > 0;
      if (hasErr) console.error(`[api-football] ${key} API error (e.g. plan/season access):`, JSON.stringify(errs));
      const data = body.response ?? [];
      this.cache.set(key, { at: this.now(), data });
      return data;
    } catch (err) {
      console.error(`[api-football] ${key} fetch failed, serving cache:`, (err as Error).message);
      return cached?.data ?? [];
    }
  }

  private toFixture(f: AfFixture): Fixture {
    const round = f.league.round ?? "";
    return {
      matchId: asMatchId(String(f.fixture.id)),
      home: f.teams.home.name,
      away: f.teams.away.name,
      competition: f.league.name,
      ...(round.toLowerCase().includes("group") ? { group: round } : {}),
      stage: round || "REGULAR",
      kickoff: Date.parse(f.fixture.date),
    };
  }
}
