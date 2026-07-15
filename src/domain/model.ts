/**
 * Value objects shared across the domain: fixtures, markets, tiers, traits.
 * No behaviour here — just the shapes the events and projections speak in.
 */

import type { Bucket, MarketId, MatchId } from "./ids.ts";

// ── The Squad Ladder ────────────────────────────────────────────────────────
// Order matters: index is the rank. Driven by Gaffer Rating only — never money.
export const TIERS = [
  "Trialist",
  "Squad Player",
  "First Team",
  "Captain",
  "Assistant Manager",
  "Director of Football",
] as const;
export type Tier = (typeof TIERS)[number];

/** Common World Cup stages — a hint, not a constraint (any competition's round string is valid). */
export type Stage = "GROUP" | "R32" | "R16" | "QF" | "SF" | "FINAL";

export interface Fixture {
  matchId: MatchId;
  home: string;
  away: string;
  competition: string; // "FIFA World Cup 2026", "Premier League", …
  group?: string; // "Group F"
  stage: string; // round/stage label from the data source
  kickoff: number; // unix ms
  /** TxLINE's own fixture numbering, once resolved — the seam SettlementVerifier reads. */
  txline?: { fixtureId: number; participant1IsHome: boolean };
}

export type MarketKind = "RESULT" | "BOLD";

export interface BucketDef {
  bucket: Bucket;
  label: string;
}

export interface MarketDef {
  marketId: MarketId;
  kind: MarketKind;
  label: string; // "Full time result", "Exact score", "First scorer"
  buckets: BucketDef[];
}

/** A market resolves to exactly one winning bucket, or VOID (refund all). */
export const VOID = "VOID" as const;
export type Outcome = Bucket | typeof VOID;

export type FormResult = "W" | "L" | "VOID";

export type VerdictTrigger =
  | "BIG_RESULT"
  | "PROMOTION"
  | "DEMOTION"
  | "ON_DEMAND"
  | "SEASON_REVIEW";

/**
 * A behavioural trait the Gaffer has distilled about a player — the psychology
 * layer of the memory. Written by the Gaffer's analyze pass, read before bets.
 */
export interface Trait {
  key: string; // stable slug, e.g. "chases-losses"
  label: string; // "Chases losses — doubles stake after losing"
  confidence: number; // 0..1, hardens over time
  evidence: string; // the receipt: which calls support it
  firstSeen: number;
  lastSeen: number;
}

/** Standard result-market buckets. */
export const RESULT_BUCKETS = {
  HOME: "HOME" as Bucket,
  DRAW: "DRAW" as Bucket,
  AWAY: "AWAY" as Bucket,
};
