/**
 * Who the landing page's "See who’s calling it" circles show: real
 * Chumbucket people from the public BFF, best record first. Pure functions,
 * tested in tests/webLanding.test.ts.
 *
 * Order: people.leaderboard's ranked callers (a percentage on at least ten
 * decided calls), then its building ones, then people.suggested and the
 * authors of recent public calls, each person once. Only people who have
 * made a call count; nobody is invented and no seat is filled to look busy.
 */

import { avatarSrc, type CallFeedEntry, type Leaderboard, type PersonRef, type RecordCounts, type Suggested } from "./callsBff";

export interface Caller {
  id: string;
  handle: string;
  displayName: string;
  /** https picture (X, Google), the app's preset picture, or null for initials. */
  avatar: string | null;
  /** Decided calls and how many were right, when the BFF said. */
  record: { correct: number; decided: number } | null;
}

/** As many people as the circles have room for. */
export const CALLER_SEATS = 5;

const hasCalled = (c: RecordCounts | null | undefined) => !!c && c.decided + c.pending + c.voided > 0;

function toCaller(p: PersonRef, counts: RecordCounts | null | undefined): Caller {
  return {
    id: p.id,
    handle: p.handle,
    displayName: p.displayName?.trim() || p.handle,
    avatar: avatarSrc(p),
    record: counts ? { correct: counts.correct, decided: counts.decided } : null,
  };
}

export function pickCallers(
  sources: {
    leaderboard: Leaderboard | null;
    suggested: Suggested | null;
    feed: { entries: CallFeedEntry[] } | null;
  },
  max = CALLER_SEATS,
): Caller[] {
  const out: Caller[] = [];
  const seen = new Set<string>();
  const add = (c: Caller) => {
    if (out.length >= max || seen.has(c.id) || !c.handle) return;
    seen.add(c.id);
    out.push(c);
  };
  const lb = sources.leaderboard;
  for (const row of [...(lb?.ranked ?? []), ...(lb?.building ?? [])]) add(toCaller(row.person, row.record?.counts));
  for (const p of sources.suggested?.people ?? []) if (hasCalled(p.record?.counts)) add(toCaller(p, p.record?.counts));
  for (const e of sources.feed?.entries ?? []) {
    const a = e.author;
    add(toCaller(a, { correct: a.correctCalls, decided: a.settledCalls, incorrect: 0, voided: 0, resolved: a.settledCalls, pending: 0 }));
  }
  return out;
}

const named = (c: Caller) => (c.displayName === c.handle ? `@${c.handle}` : `${c.displayName} (@${c.handle})`);

/**
 * The line under the section title, true for any number of people:
 * "Dominion (@dev) is calling it. There’s room for you." With nobody to
 * show, null (the section says so itself). "Others" only when there are
 * more real people than the two it names.
 */
export function callersLine(callers: Caller[]): string | null {
  const [a, b] = callers;
  if (!a) return null;
  // No-break space: "calling it." never splits across lines.
  if (!b) return `${named(a)} is calling\u00A0it. There’s room for you.`;
  if (callers.length === 2) return `${named(a)} and ${named(b)} are calling\u00A0it.`;
  return `@${a.handle}, @${b.handle} and others are calling\u00A0it.`;
}

/** "0 of 1 decided calls right" / "No decided calls yet", for labels. */
export function callerRecord(c: Caller): string {
  if (!c.record || c.record.decided === 0) return "No decided calls yet";
  return `${c.record.correct} of ${c.record.decided} decided ${c.record.decided === 1 ? "call" : "calls"} right`;
}
