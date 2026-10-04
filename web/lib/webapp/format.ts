/**
 * How the web app writes the BFF's facts for people: short, and never more
 * than the screen needs. Pure (no DOM, no clock of its own: every function
 * that depends on time takes `now`), so it is tested in the BFF repo.
 */

import { callMark, entryPercent, pairPercent, percentLabel, sidePercent } from "../callsBff";
import type { Call, CallFeedEntry, CallOutcome, Market, PublicRecord, SharePrice, Side } from "./types";

export { callMark, entryPercent, pairPercent, percentLabel, sidePercent };

/** A Panta price is only shown while it is this fresh (the BFF's own limit). */
export const PRICE_MAX_AGE_MS = 10 * 60_000;

/**
 * One side's live percent, weighed against the other so the two add up
 * (see pairPercent): 0.62 / 0.43 reads 59% / 41%, the same for a USDC and a
 * SOL-quoted market. Null when it should not be shown: no snapshot, a missing
 * side, or a snapshot older than the BFF would call on. Screens show a quiet
 * "—" for null; they never say the price is stale.
 */
export function livePercent(snapshot: SharePrice | null | undefined, side: Side, now: number): string | null {
  if (!snapshot) return null;
  if (snapshot.observedAt > now + 60_000 || now - snapshot.observedAt > PRICE_MAX_AGE_MS) return null;
  return sidePercent(snapshot, side);
}

/** The percent a call was made at, for its own side ("62%"), or null. */
export const calledAt = (call: Pick<Call, "side" | "entryPrice">): string | null => entryPercent(call);

/**
 * Whether a trade can be offered on this market: a Panta market the BFF does
 * not mark untradable. A SOL-quoted market takes free calls, never a trade.
 */
export const tradableMarket = (market: Pick<Market, "venue" | "tradable">): boolean =>
  market.venue === "panta" && market.tradable !== false;

export function sideLabel(market: Pick<Market, "outcomes">, side: Side): string {
  return market.outcomes.find((o) => o.side === side)?.label ?? (side === "YES" ? "Yes" : "No");
}

export const opposite = (side: Side): Side => (side === "YES" ? "NO" : "YES");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Time left before a market closes, in one short token: "47d", "5h", "12m"; null when closed or unknown. */
export function closesIn(closesAt: number | null | undefined, now: number): string | null {
  if (!closesAt) return null;
  const left = closesAt - now;
  if (left <= 0) return null;
  if (left < HOUR) return `${Math.max(1, Math.floor(left / MIN))}m`;
  if (left < 2 * DAY) return `${Math.floor(left / HOUR)}h`;
  return `${Math.floor(left / DAY)}d`;
}

/** Closing within a day: the clock chip turns coral. */
export const closingSoon = (closesAt: number | null | undefined, now: number): boolean =>
  !!closesAt && closesAt > now && closesAt - now < DAY;

/** Month names written out here, so every browser (and the tests) print the same. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Feed time: "now", "5m", "3h", "2d", then the date ("3 Oct"). */
export function ago(ms: number, now: number): string {
  const d = now - ms;
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  const t = new Date(ms);
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}

/** The exact instant a receipt proves: "3 Oct 2026, 14:05 UTC". */
export function stamp(ms: number): string {
  const t = new Date(ms);
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`;
}

/**
 * A day for a chip or a band, where the exact instant would crowd the line:
 * "3 Oct" this year, "3 Oct 2025" otherwise. The exact instant (`stamp`) goes
 * in the accessible label and on the public receipt.
 */
export function shortDay(ms: number, now: number): string {
  const t = new Date(ms);
  const day = `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
  return t.getUTCFullYear() === new Date(now).getUTCFullYear() ? day : `${day} ${t.getUTCFullYear()}`;
}

/** "Joined Oct 2026". */
export function joined(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const t = new Date(ms);
  return `Joined ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/** "pop-culture" -> "Pop culture": the venue's own slug, made readable. */
export function topicLabel(slug: string | null | undefined): string {
  const s = (slug ?? "").replace(/[-_]+/g, " ").trim();
  if (!s) return "Other";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The Basil icon for a venue category — the app's own mapping
 * (call_market_card.dart `categoryIcon`), so a topic looks the same on the
 * phone and the web.
 */
export function topicIcon(slug: string | null | undefined): string {
  switch ((slug ?? "").toLowerCase()) {
    case "crypto":
      return "lightning";
    case "meme-coins":
      return "fire";
    case "sports":
      return "award";
    case "finance":
    case "macroeconomics":
    case "business":
      return "chart-pie";
    case "stocks":
      return "chart-pie-alt";
    case "commodities":
      return "box";
    case "politics":
      return "bank";
    case "entertainment":
    case "pop-culture":
      return "star";
    case "gaming":
      return "gamepad";
    case "science":
    case "space-universe":
      return "flask";
    case "tech":
    case "technology":
      return "processor";
    case "weather":
      return "sun";
    case "world":
      return "globe";
    default:
      return "lightbulb";
  }
}

export function isSettled(entry: Pick<CallFeedEntry, "result">): boolean {
  const o = entry.result?.outcome;
  return o === "CORRECT" || o === "INCORRECT" || o === "VOID";
}

export function outcomeOf(entry: Pick<CallFeedEntry, "result">): CallOutcome {
  return entry.result?.outcome ?? "PENDING";
}

/** The app's receipt words (call_badges.dart). */
export function outcomeLabel(outcome: CallOutcome): string {
  switch (outcome) {
    case "CORRECT":
      return "Correct";
    case "INCORRECT":
      return "Incorrect";
    case "VOID":
      return "Void";
    default:
      return "Open";
  }
}

/** A market still takes new calls: open, inside its window and before its close. */
export function takesCalls(market: Pick<Market, "status" | "opensAt" | "closesAt">, now: number, callsCloseAt?: number | null): boolean {
  if (market.status !== "OPEN") return false;
  if (market.opensAt !== null && market.opensAt > now) return false;
  const close = callsCloseAt ?? market.closesAt;
  return close === null || close > now;
}

/**
 * Whether Back and Fade can be offered on a call: someone else's, on a market
 * still taking calls, not settled, and the viewer has no call there yet (the
 * BFF allows one call per person per market).
 */
export function canAnswer(entry: CallFeedEntry, viewerId: string | null, now: number): boolean {
  return (
    !!viewerId &&
    entry.call.userId !== viewerId &&
    !entry.viewerHasCalled &&
    !isSettled(entry) &&
    takesCalls(entry.market, now)
  );
}

/**
 * A record in one short token. With enough decided calls the BFF sends an
 * accuracy ("75%"); below that only counts ("3–1"), because a percentage over
 * two calls says nothing. Null when nothing is decided yet.
 */
export function recordToken(record: PublicRecord | null | undefined): string | null {
  if (!record) return null;
  const d = record.display;
  if (d.mode === "accuracy") return `${Math.round(d.accuracy * 100)}%`;
  if (d.decided === 0) return null;
  return `${d.correct}–${d.incorrect}`;
}

/** The same record, for a screen reader: "3 right, 1 wrong". */
export function recordA11y(record: PublicRecord | null | undefined): string {
  if (!record || record.display.decided === 0) return "No settled calls yet";
  const d = record.display;
  const base = `${d.correct} right, ${d.incorrect} wrong`;
  return d.mode === "accuracy" ? `${Math.round(d.accuracy * 100)}% right: ${base}` : base;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A shortened wallet for the owner's own settings: "7xKX…gAsU". */
export function shortWallet(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Compact counts: 999, 1.2k, 12k. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}
