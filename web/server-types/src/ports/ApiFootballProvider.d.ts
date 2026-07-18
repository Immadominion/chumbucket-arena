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
import { type MatchId } from "../domain/ids";
import type { Fixture } from "../domain/model";
import type { MatchDataProvider, MatchResult } from "./MatchData";
export interface Competition {
    league: number;
    season: number;
}
export interface ApiFootballConfig {
    apiKey: string;
    baseUrl: string;
    competitions: Competition[];
    cacheTtlMs: number;
    /** Header name for the key. Direct api-football.com → x-apisports-key. */
    apiKeyHeader?: string;
    now?: () => number;
}
export declare class ApiFootballProvider implements MatchDataProvider {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly cache;
    private readonly now;
    private readonly header;
    constructor(cfg: ApiFootballConfig, fetchImpl?: typeof fetch);
    fixtures(): Promise<Fixture[]>;
    results(matchIds: MatchId[]): Promise<MatchResult[]>;
    private allRaw;
    private fetchCompetition;
    private toFixture;
}
