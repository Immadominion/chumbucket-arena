/**
 * Backend → UI adapters. The backend speaks the domain (FROST bigints, full
 * team names, parimutuel buckets); the screens were built against the shapes in
 * lib/data. These map one to the other, fully typed off the live AppRouter, so a
 * server-side change surfaces here as a type error rather than a silent break.
 */

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/api/router";
import type { Fixture, LadderRow, OpenCall, Player, SettledCall } from "@/lib/data";
import { flagCode, frostToWal, kickoffLabel, shortWallet } from "@/lib/format";

type Out = inferRouterOutputs<AppRouter>;
export type MatchView = Out["matchday"][number];
export type MarketView = MatchView["markets"][number];
export type Dossier = NonNullable<Out["me"]>;
export type LeaderRow = Out["leaderboard"][number];
export type OpenCallView = Dossier["openCalls"][number];
export type SettledRow = Out["settledCalls"][number];
// trpc.activity and trpc.followingFeed both resolve to PredictionActivityRow[]
// server-side (the latter just applies a follow/friend filter) — one row shape.
export type ActivityRow = Out["activity"][number];

const BG = ["d9f2e1", "ffe0b2", "c7e8ff", "e1d5ff", "ffd6e0", "cde7d6"];
const bgFor = (seed: string) => BG[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % BG.length]!;

function resultMarket(m: MatchView) {
  return m.markets.find((mk) => mk.marketId === "RESULT") ?? m.markets[0];
}

/** MatchView → the UI's Fixture card shape (team flags, kickoff, pot, crowd %). */
export function toFixture(m: MatchView): Fixture {
  const f = m.fixture;
  const mk = resultMarket(m);
  const buck = (b: string) => mk?.buckets.find((x) => x.bucket === b);
  const pot = mk ? Math.round(frostToWal(mk.grossPot)) : 0;
  const raw = { home: buck("HOME")?.impliedProb ?? 0, draw: buck("DRAW")?.impliedProb ?? 0, away: buck("AWAY")?.impliedProb ?? 0 };
  const sum = raw.home + raw.draw + raw.away;
  const pct =
    sum === 0
      ? { home: 0, draw: 0, away: 0 } // empty pool — no crowd signal yet
      : { home: Math.round(raw.home * 100), draw: Math.round(raw.draw * 100), away: Math.round(raw.away * 100) };
  const { ko, koTag } = kickoffLabel(f.kickoff);
  return {
    matchId: f.matchId,
    home: { name: f.home, code: flagCode(f.home) ?? "" },
    away: { name: f.away, code: flagCode(f.away) ?? "" },
    group: f.group ?? f.stage ?? f.competition,
    ko,
    koTag,
    pot,
    pct,
  };
}

// ── Multi-market call screen ────────────────────────────────────────────────
// A fixture now carries several parimutuel markets (Result 1X2, Over/Under,
// Handicap). The call screen lets you switch between them and back any outcome.
// Each market places into its OWN on-chain pot (`potMatchId`), so the shapes
// below carry everything the screen needs to render + route money precisely.

const abbr3 = (s: string) => s.slice(0, 3).toUpperCase();

/** One backable outcome within a market, ready for the outcome tile + copy. */
export type CallBucket = {
  /** On-chain bucket key: HOME/DRAW/AWAY or OVER/UNDER. */
  bucket: string;
  /** On-chain bucket slot index — 0/1/2 (result) or 0/1 (line). THE money slot. */
  index: number;
  /** Short label on the outcome tile ("FRA", "DRAW", "Over 2.5", "France -1.5"). */
  tile: string;
  /** Natural subject for the pick-reactive copy ("France", "the draw", "Over 2.5 goals"). */
  subject: string;
  /** Tail for the "If …" payout row ("France win", "it's a draw", "Over 2.5 lands"). */
  settle: string;
  /** Crowd-implied share of this outcome, 0..100 (0 when the pool is empty). */
  pct: number;
  /** Live USDC staked on this outcome (the parimutuel pool for this bucket). */
  pool: number;
};

/** A selectable market on the call screen (Result / Over-Under / Handicap). */
export type CallMarket = {
  marketId: string;
  kind: MarketView["kind"];
  /** The on-chain match_id of THIS market's pot — what placeCall routes into. */
  potMatchId?: string;
  /** Short switcher label ("Result", "O/U 2.5", "Handicap"). */
  tab: string;
  buckets: CallBucket[];
};

// On-chain bucket slot per domain bucket key (mirrors keeper/onchainDriver.ts:
// BUCKET_HOME/DRAW/AWAY = 0/1/2, BUCKET_OVER/UNDER = 0/1).
const ONCHAIN_BUCKET_INDEX: Record<string, number> = { HOME: 0, DRAW: 1, AWAY: 2, OVER: 0, UNDER: 1 };

/** Short, plain label for the bet-type switcher (never "O/U" or "Handicap"). */
function marketTab(mk: MarketView): string {
  switch (mk.kind) {
    case "RESULT":
      return "Result";
    case "OVER_UNDER":
      // Include the line so three O/U markets don't all read "Total goals"
      // (mirrors mobile's "Goals 1.5 / 2.5 / 3.5").
      return `Goals ${mk.line?.line ?? ""}`.trim();
    case "HANDICAP": {
      const by = Math.floor(Math.abs(mk.line?.line ?? 0)) + 1; // 1.5 ⇒ win by 2+
      return `Win by ${by}+`;
    }
    default:
      return mk.label;
  }
}

/** Plain, newcomer-instant tile / copy phrasing for one bucket of a market. */
function bucketCopy(
  mk: MarketView,
  home: string,
  away: string,
  b: MarketView["buckets"][number],
): { tile: string; subject: string; settle: string } {
  if (mk.kind === "RESULT") {
    if (b.bucket === "HOME") return { tile: abbr3(home), subject: home, settle: `${home} win` };
    if (b.bucket === "AWAY") return { tile: abbr3(away), subject: away, settle: `${away} win` };
    return { tile: "DRAW", subject: "the draw", settle: "it's a draw" };
  }
  if (mk.kind === "OVER_UNDER") {
    // b.label is already plain ("Over 2.5" / "Under 2.5").
    return { tile: b.label, subject: `${b.label} goals`, settle: `${b.label} lands` };
  }
  if (mk.kind === "HANDICAP") {
    // Never show signed handicap outcomes ("Australia +1.5" / "-1.5") — a
    // newcomer can't read them. Spell out the winning margin in plain words.
    const line = mk.line?.line ?? 0;
    const by = Math.floor(Math.abs(line)) + 1; // 1.5 ⇒ win by 2+
    if (b.bucket === "OVER") {
      return { tile: `${abbr3(home)} by ${by}+`, subject: `${home} to win by ${by}+`, settle: `${home} to win by ${by}+` };
    }
    return { tile: `Not by ${by}+`, subject: `${away} not to lose by ${by}+`, settle: `${away} not to lose by ${by}+` };
  }
  return { tile: b.label, subject: b.label, settle: `${b.label} lands` };
}

/**
 * MatchView → the call screen's selectable markets. Result first (default tab),
 * then any line markets. Each bucket carries its on-chain slot index + its
 * market's `potMatchId` so the place-call path routes into the exact pot.
 */
export function toCallMarkets(m: MatchView): CallMarket[] {
  const { home, away } = m.fixture;
  const ordered = [...m.markets].sort((a, b) => (a.kind === "RESULT" ? -1 : b.kind === "RESULT" ? 1 : 0));
  return ordered.map((mk) => {
    const totalImplied = mk.buckets.reduce((s, b) => s + b.impliedProb, 0);
    return {
      marketId: mk.marketId,
      kind: mk.kind,
      potMatchId: mk.potMatchId,
      tab: marketTab(mk),
      buckets: mk.buckets.map((b) => {
        const copy = bucketCopy(mk, home, away, b);
        return {
          bucket: b.bucket,
          index: ONCHAIN_BUCKET_INDEX[b.bucket] ?? mk.buckets.indexOf(b),
          pct: totalImplied > 0 ? Math.round((b.impliedProb / totalImplied) * 100) : 0,
          pool: frostToWal(b.stake),
          ...copy,
        };
      }),
    };
  });
}

/** DossierView (+ optional ladder rank) → the UI's Player ("me") shape. */
export function toPlayer(d: Dossier, rank = 0): Player {
  const { won, lost, voided } = d.record;
  const decided = won + lost;
  const available = frostToWal(d.balance);
  const staked = frostToWal(d.locked);
  const seed = d.handle || d.wallet.slice(2, 8);
  return {
    handle: d.handle || "Chum",
    wallet: shortWallet(d.wallet),
    seed,
    bg: bgFor(seed),
    rating: Math.round(d.gr),
    rated: decided > 0, // the rating only means something once a call has settled
    ratingDelta: 0,
    record: `${won}–${lost}`,
    rank,
    tier: d.tier,
    balance: Math.round((available + staked) * 10) / 10,
    available: Math.round(available * 10) / 10,
    staked: Math.round(staked * 10) / 10,
    form: d.form.recent.filter((r): r is "W" | "L" => r === "W" || r === "L"),
    walWon: Math.round(frostToWal(d.pnl)),
    hitRate: decided > 0 ? Math.round((won / decided) * 100) : 0,
    calls: won + lost + voided + d.openCalls.length, // total made, incl. still-open
  };
}

/** Leaderboard rows → the UI's ladder rows (+ wallet, for profile links). */
export function toLadder(rows: LeaderRow[], myWallet?: string): (LadderRow & { wallet: string })[] {
  return rows.map((r) => {
    const seed = r.handle || r.wallet.slice(2, 8);
    const you = !!myWallet && r.wallet === myWallet;
    return {
      rank: r.rank,
      wallet: r.wallet,
      seed,
      bg: bgFor(seed),
      name: you ? `You · ${r.handle || seed}` : r.handle || seed,
      form: r.form.streak > 0 ? `${r.form.streakKind}${r.form.streak}` : "—",
      formGood: r.form.streakKind === "W",
      rating: Math.round(r.gr),
      ...(you ? { you: true } : {}),
    };
  });
}

const PICK_LABEL: Record<string, (home: string, away: string) => string> = {
  HOME: (h) => `${h} to win`,
  AWAY: (_h, a) => `${a} to win`,
  DRAW: () => "Draw",
};

/** An open call + its fixture → the UI's OpenCall card. */
export function toOpenCall(call: OpenCallView, match: MatchView | undefined): OpenCall {
  const f = match?.fixture;
  const home = f?.home ?? "Home";
  const away = f?.away ?? "Away";
  const staked = frostToWal(call.stake);
  // Parimutuel projection: your share of the pot if your bucket wins, approximated
  // from the implied probability at call time (lower implied prob ⇒ bigger payout).
  const projected = Math.round((staked / Math.max(call.impliedProbAtCall, 0.05)) * 10) / 10;
  const msToKo = (f?.kickoff ?? Date.now()) - Date.now();
  const lock = msToKo > 0 ? `${Math.floor(msToKo / 3_600_000)}h ${Math.floor((msToKo % 3_600_000) / 60_000)}m` : "Locked";
  return {
    home: { name: home, code: flagCode(home) ?? "" },
    away: { name: away, code: flagCode(away) ?? "" },
    pick: (PICK_LABEL[call.bucket] ?? (() => call.bucket))(home, away),
    staked: Math.round(staked * 10) / 10,
    projected,
    lock,
  };
}

const settledLine = (result: string, difficulty: number): string => {
  if (result === "VOID") return "Match abandoned — your bet came back. We'll never know how wrong you were.";
  if (result === "WON") {
    return difficulty >= 0.55
      ? "Backed yourself when the crowd didn't. That's the version of you I want to see."
      : "Right pick — but the whole world saw it coming. Barely moves the needle.";
  }
  return "Backed the favourite again. We've talked about this. You don't get paid for being safe.";
};

/** A settled call + its fixture → the UI's Results / Verdict card shape. */
export function toSettledCall(c: SettledRow, match: MatchView | undefined): SettledCall {
  const home = match?.fixture.home ?? "Home";
  const away = match?.fixture.away ?? "Away";
  const pnl = frostToWal(c.pnlDelta);
  const gr = Math.round(c.grDelta);
  return {
    id: c.callId,
    home: { name: home, code: flagCode(home) ?? "" },
    away: { name: away, code: flagCode(away) ?? "" },
    score: c.score ? [c.score.home, c.score.away] : [0, 0],
    backed: c.bucket === "HOME" ? home : c.bucket === "AWAY" ? away : "Draw",
    outcome: c.result,
    pnl: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}`,
    gr: `${gr >= 0 ? "+" : ""}${gr}`,
    when: new Date(c.at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
    line: settledLine(c.result, c.difficulty),
  };
}

// ── Calls feed (trpc.activity / trpc.followingFeed) ─────────────────────────

const BUCKET_STYLE: Record<string, { color: string; bg: string }> = {
  HOME: { color: "#FF3355", bg: "#FFE7EC" },
  DRAW: { color: "#C57A12", bg: "rgba(197,122,18,.12)" },
  AWAY: { color: "#2F6BFF", bg: "rgba(47,107,255,.12)" },
};
const BUCKET_FALLBACK = { color: "#988990", bg: "#F5EEF1" };

/** "just now" / "5m ago" / "3h ago" / "2d ago" / "Jul 12" — mirrors mobile's Calls tab _relativeTime exactly. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diffMs = now - new Date(iso).getTime();
  // A negative diff (timestamp in the future) is clock skew, not a real future
  // event — never show it as a raw negative number.
  if (diffMs < 45_000) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The feed subtitle's leading verb — plain, "call"-free, real team names. */
function activityVerb(row: ActivityRow, pickLabel: string | null): string {
  switch (row.type) {
    case "CALL_COPIED":
      return "made the same pick";
    case "CALL_SETTLED":
      return "match finished";
    case "CLAIMED":
      return "collected winnings";
    default:
      return pickLabel ? `picked ${pickLabel}` : "made a pick";
  }
}

export type ActivityCall = {
  id: string;
  wallet: string;
  verb: string;
  when: string;
  home: string;
  away: string;
  bucketLabel: string; // always a real team name or "Draw" (never a raw HOME/DRAW/AWAY code or "?")
  bucketColor: string;
  bucketBg: string;
  stake: number | null; // USDC, null when the row carries no stake (e.g. a claim/settlement event)
  matchId: string | null;
  isSettled: boolean;
  status: string;
};

/** A raw activity/followingFeed row → the Calls feed card shape. */
export function toActivityCall(row: ActivityRow): ActivityCall {
  const meta = row.metadata ?? {};
  const displayBucket = row.bucket ?? (row.body ? row.body.toUpperCase() : "?");
  const style = BUCKET_STYLE[displayBucket] ?? BUCKET_FALLBACK;
  const home = typeof meta.home === "string" ? meta.home : "Home";
  const away = typeof meta.away === "string" ? meta.away : "Away";
  // Real team names + "Draw" — never a raw HOME/DRAW/AWAY code or "?" in the UI.
  const pickTeam = displayBucket === "HOME" ? home : displayBucket === "AWAY" ? away : null;
  const pickLabel = displayBucket === "DRAW" ? "the draw" : pickTeam ? `${pickTeam} to win` : null;
  return {
    id: row.id,
    wallet: row.actor_wallet_address,
    verb: activityVerb(row, pickLabel),
    when: relativeTime(row.created_at),
    home,
    away,
    bucketLabel: displayBucket === "DRAW" ? "Draw" : pickTeam ?? "Pick",
    bucketColor: style.color,
    bucketBg: style.bg,
    stake: row.stake_base_units ? frostToWal(BigInt(row.stake_base_units)) : null,
    matchId: row.match_id,
    isSettled: row.status === "SETTLED",
    status: row.status,
  };
}
