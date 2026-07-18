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
import { type MatchId } from "../domain/ids";
import type { Fixture } from "../domain/model";
import type { MatchDataProvider, MatchResult } from "./MatchData";
export interface FootballDataConfig {
    apiKey: string;
    baseUrl: string;
    competitions: string[];
    cacheTtlMs: number;
}
export declare class FootballDataProvider implements MatchDataProvider {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly cache;
    private readonly now;
    constructor(cfg: FootballDataConfig, fetchImpl?: typeof fetch, now?: () => number);
    fixtures(): Promise<Fixture[]>;
    results(matchIds: MatchId[]): Promise<MatchResult[]>;
    private fetchCompetition;
    private toFixture;
}
