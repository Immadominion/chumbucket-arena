/**
 * Seed fixtures. Placeholder World Cup 2026 fixtures so the app is playable
 * before the live MatchData API is wired. Kickoffs are relative to "now" so the
 * Matchday always has something open. Swap for the real feed by setting
 * FOOTBALL_API_BASE and implementing a MatchDataProvider over it.
 */
import type { Fixture } from "../domain/model";
export declare function seedFixtures(now: number): Fixture[];
