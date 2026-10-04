/**
 * What the landing page's social-proof section ("See who’s calling it")
 * shows, decided from the public calls feed. Pure functions, so the honest
 * empty and failure states are tested (tests/webLanding.test.ts).
 *
 * The section only ever shows real public calls: who called it, which side,
 * the locked price and what Panta decided. No quotes, counts or names are
 * made up; with nothing to show it says so.
 */

import { callMark, entryPercent, outcomeCopy, sideLabel, type CallFeedEntry, type Person } from "./callsBff";

export type ProofState =
  /** The feed could not be read (BFF down or slow). */
  | { kind: "unavailable" }
  /** The feed answered with no public calls. */
  | { kind: "empty" }
  /** A real call to feature, and the distinct people behind recent calls. */
  | { kind: "call"; featured: CallFeedEntry; people: Person[] };

const isSettled = (e: CallFeedEntry) => !!e.result && e.result.outcome !== "PENDING";

/** The newest settled call (it already has a receipt), else the newest call. */
export function pickFeatured(entries: CallFeedEntry[]): CallFeedEntry | null {
  return entries.find(isSettled) ?? entries[0] ?? null;
}

/** Distinct authors in feed order, the featured author first, at most `max`. */
export function recentPeople(entries: CallFeedEntry[], featured: CallFeedEntry, max = 5): Person[] {
  const seen = new Set<string>([featured.author.id]);
  const people: Person[] = [featured.author];
  for (const e of entries) {
    if (people.length >= max) break;
    if (seen.has(e.author.id)) continue;
    seen.add(e.author.id);
    people.push(e.author);
  }
  return people;
}

export function proofState(feed: { entries: CallFeedEntry[] } | null): ProofState {
  if (!feed) return { kind: "unavailable" };
  const featured = pickFeatured(feed.entries);
  if (!featured) return { kind: "empty" };
  return { kind: "call", featured, people: recentPeople(feed.entries, featured) };
}

const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "1 Oct 2026" (UTC), or null for a missing timestamp. */
export function dayLabel(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return dayFmt.format(new Date(ms));
}

/**
 * The plain account of a call, in the app's words:
 * "Dominion (@dev) made a free call: Yes at 62% on 1 Oct 2026. Panta settled it No."
 * Only an unfunded call is called free; a confirmed fill is a funded call.
 */
export function callSentence(entry: CallFeedEntry): string {
  const { call, author, market, result } = entry;
  const pct = entryPercent(call);
  // No-break spaces: "2 Oct 2026" never splits across lines.
  const day = dayLabel(call.lockedAt)?.replace(/ /g, "\u00A0");
  const who = `${author.displayName} (@${author.handle})`;
  const mark = callMark(entry);
  const verb = mark === "free" ? "made a free call:" : mark === "funded" ? "made a funded call:" : "called";
  const said = `${who} ${verb} ${sideLabel(market, call.side)}${pct ? ` at ${pct}` : ""}${day ? ` on ${day}` : ""}.`;

  let outcome: string;
  if (!result || result.outcome === "PENDING") outcome = "Panta hasn’t settled it yet.";
  else if (result.outcome === "VOID" || result.resolution === "VOID" || !result.resolution) outcome = "Panta voided the market.";
  else outcome = `Panta settled it ${sideLabel(market, result.resolution)}.`;

  const thesis = call.thesis?.trim();
  return thesis ? `“${thesis}” ${said} ${outcome}` : `${said} ${outcome}`;
}

/** The bold line under the people row, and where it links. */
export function statusLine(entry: CallFeedEntry): { label: string; href: string; linkText: string } {
  const href = `/c/${encodeURIComponent(entry.call.id)}`;
  if (!isSettled(entry)) return { label: "Open · not settled yet", href, linkText: "See the call" };
  return { label: `Settled · ${outcomeCopy(entry.result).label}`, href, linkText: "See the receipt" };
}

/** What the hero's secondary link opens, which picks its icon. */
export type HeroLinkKind = "web" | "receipt" | "call" | "live";

/**
 * The hero's secondary link: the web app when one serves the calls product
 * (NEXT_PUBLIC_WEB_APP_URL), else a real receipt when there is one, else the
 * live-calls section.
 */
export function heroProofLink(
  state: ProofState,
  webAppUrl: string | null = null,
): { href: string; label: string; kind: HeroLinkKind } {
  if (webAppUrl) return { href: webAppUrl, label: "open web app", kind: "web" };
  if (state.kind !== "call") return { href: "#live", label: "see live calls", kind: "live" };
  const href = `/c/${encodeURIComponent(state.featured.call.id)}`;
  return isSettled(state.featured)
    ? { href, label: "see a receipt", kind: "receipt" }
    : { href, label: "see a live call", kind: "call" };
}
