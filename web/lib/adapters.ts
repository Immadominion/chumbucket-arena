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
  if (result === "VOID") return "Match abandoned — stake returned. We'll never know how wrong you were.";
  if (result === "WON") {
    return difficulty >= 0.55
      ? "Backed yourself when the crowd didn't. That's the version of you I want to see."
      : "Right call — but the whole world saw it coming. Barely moves the needle.";
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
  HOME: { color: "#F2385A", bg: "#FFE7EC" },
  DRAW: { color: "#C57A12", bg: "rgba(197,122,18,.12)" },
  AWAY: { color: "#2F6BFF", bg: "rgba(47,107,255,.12)" },
};
const BUCKET_FALLBACK = { color: "#988990", bg: "#F5EEF1" };

/** "now" / "5m" / "3h" / "2d" / "Jul 12" — mirrors mobile's Calls tab _relativeTime exactly. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diffMs = now - new Date(iso).getTime();
  if (diffMs < 45_000) return "now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Mirrors mobile's _eventVerb exactly (the feed subtitle's leading verb). */
function activityVerb(row: ActivityRow, displayBucket: string): string {
  switch (row.type) {
    case "CALL_COPIED":
      return "copied a call";
    case "CALL_SETTLED":
      return "call settled";
    case "CLAIMED":
      return "claimed winnings";
    default:
      return `called ${displayBucket}`;
  }
}

export type ActivityCall = {
  id: string;
  wallet: string;
  verb: string;
  when: string;
  home: string;
  away: string;
  bucketLabel: string; // always non-empty — "HOME"/"DRAW"/"AWAY" or a "?" fallback, mirrors mobile's displayBucket
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
  return {
    id: row.id,
    wallet: row.actor_wallet_address,
    verb: activityVerb(row, displayBucket),
    when: relativeTime(row.created_at),
    home: typeof meta.home === "string" ? meta.home : "Home",
    away: typeof meta.away === "string" ? meta.away : "Away",
    bucketLabel: displayBucket,
    bucketColor: style.color,
    bucketBg: style.bg,
    stake: row.stake_base_units ? frostToWal(BigInt(row.stake_base_units)) : null,
    matchId: row.match_id,
    isSettled: row.status === "SETTLED",
    status: row.status,
  };
}
