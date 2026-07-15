/**
 * MatchData over football-data.org (v4). The free tier covers the FIFA World Cup
 * (competition code "WC") with live 2026 data — real fixtures, statuses, scores.
 * Auth is the `X-Auth-Token` header.
 *
 * Rate limit (free tier) is 10 requests/minute. Like the api-football adapter we
 * cache one `/competitions/{code}/matches` call per competition per TTL window
 * and serve every fixture lookup and engine tick from it — one competition is
 * ~one request per TTL, far under the limit. A failed fetch serves the last good
 * cache rather than crash the tick.
 */

import { asMatchId, type MatchId } from "../domain/ids.ts";
import type { Fixture } from "../domain/model.ts";
import type { MatchDataProvider, MatchResult } from "./MatchData.ts";

export interface FootballDataConfig {
  apiKey: string;
  baseUrl: string; // https://api.football-data.org/v4
  competitions: string[]; // ["WC"]
  cacheTtlMs: number;
}

interface FdTeam {
  name: string | null;
}
interface FdMatch {
  id: number;
  utcDate: string;
  status: string; // SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED | POSTPONED | …
  stage?: string;
  group?: string | null;
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score?: { fullTime?: { home: number | null; away: number | null } };
}

const FINISHED = "FINISHED";

/** "GROUP_A" → "Group A", "LAST_16" → "Last 16". */
const prettify = (s: string | undefined | null): string =>
  (s ?? "")
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");

export class FootballDataProvider implements MatchDataProvider {
  private readonly cache = new Map<string, { at: number; data: FdMatch[]; competition: string }>();
  private readonly now: () => number;

  constructor(
    private readonly cfg: FootballDataConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  async fixtures(): Promise<Fixture[]> {
    const out: Fixture[] = [];
    for (const code of this.cfg.competitions) {
      const { data, competition } = await this.fetchCompetition(code);
      for (const m of data) {
        if (!m.homeTeam?.name || !m.awayTeam?.name) continue; // knockout slots not yet drawn
        if (m.status !== "SCHEDULED" && m.status !== "TIMED") continue; // only matches still open for calls
        out.push(this.toFixture(m, competition));
      }
    }
    return out;
  }

  async results(matchIds: MatchId[]): Promise<MatchResult[]> {
    const wanted = new Set(matchIds.map(String));
    const out: MatchResult[] = [];
    for (const code of this.cfg.competitions) {
      const { data } = await this.fetchCompetition(code);
      for (const m of data) {
        if (m.status !== FINISHED || !wanted.has(String(m.id))) continue;
        const ft = m.score?.fullTime;
        if (ft?.home == null || ft?.away == null) continue;
        // Full-Time (90') result drives Home/Draw/Away — ET/penalties don't count,
        // matching standard "Full Time Result" markets.
        out.push({ matchId: asMatchId(String(m.id)), score: { home: ft.home, away: ft.away }, finished: true });
      }
    }
    return out;
  }

  private async fetchCompetition(code: string): Promise<{ data: FdMatch[]; competition: string }> {
    const cached = this.cache.get(code);
    if (cached && this.now() - cached.at < this.cfg.cacheTtlMs) {
      return { data: cached.data, competition: cached.competition };
    }
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/competitions/${code}/matches`, {
        headers: { "X-Auth-Token": this.cfg.apiKey },
      });
      const body = (await res.json()) as { matches?: FdMatch[]; competition?: { name?: string }; message?: string };
      if (!res.ok) {
        console.error(`[football-data] ${code} HTTP ${res.status}: ${body.message ?? ""} (serving cache)`);
        return { data: cached?.data ?? [], competition: cached?.competition ?? code };
      }
      const data = body.matches ?? [];
      const competition = body.competition?.name ?? code;
      this.cache.set(code, { at: this.now(), data, competition });
      return { data, competition };
    } catch (err) {
      console.error(`[football-data] ${code} fetch failed, serving cache:`, (err as Error).message);
      return { data: cached?.data ?? [], competition: cached?.competition ?? code };
    }
  }

  private toFixture(m: FdMatch, competition: string): Fixture {
    const group = m.group ? prettify(m.group) : undefined;
    return {
      matchId: asMatchId(String(m.id)),
      home: m.homeTeam.name as string,
      away: m.awayTeam.name as string,
      competition,
      ...(group ? { group } : {}),
      stage: prettify(m.stage) || "REGULAR",
      kickoff: Date.parse(m.utcDate),
    };
  }
}
