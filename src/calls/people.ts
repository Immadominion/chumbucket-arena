/**
 * The people layer — who to listen to, computed only from what happened.
 *
 * Four read models over Packet D's rows, none of which invents anything:
 *
 *   publicRecord   a person's record as the public may see it
 *   leaderboard    people ranked by that record, inside a time window
 *   searchPeople   the directory, by handle or name
 *   topCalls       open calls worth answering, for Home's strip
 *
 * THE RULES THEY SHARE (and why each is enforced here, not in a client)
 *
 *   1. ONE RECORD. Every surface reads `publicRecord`, so the leaderboard, a
 *      profile and a top-call card can never disagree about the same person.
 *      Its scope is documented on `PublicRecord` in types.ts: public free
 *      calls, hidden ones INCLUDED (no laundering), followers-only EXCLUDED
 *      (no aggregate disclosure), funded never blended.
 *
 *   2. NO PERCENTAGE BELOW THE SAMPLE. `display` is `record.ts`'s `displayFor`,
 *      and the minimum is its `MIN_DECIDED_FOR_ACCURACY` — the same constant
 *      the schema's generated column uses. Nobody below it is given a rank.
 *
 *   3. RANK BY WHAT THE EVIDENCE SUPPORTS. Ranked people are ordered by the
 *      lower bound of the 95% Wilson interval on their accuracy, not by the raw
 *      ratio. Ten out of ten is a good start, not proof of a better caller than
 *      forty-seven out of fifty; record.ts's own threshold argument is made in
 *      the same interval, so the ordering continues that reasoning rather than
 *      abandoning it at the threshold. Both inputs are shown on every row.
 *
 *   4. NO CROWD DIRECTION BEFORE YOUR OWN CALL. Top calls are ordered by
 *      response VOLUME (backs + fades + challenges), which says nothing about
 *      which way people went. The back/fade split is attached only when the
 *      viewer already has a live call on that market — the same gate
 *      `markets.detail` applies to `crowdSplit`.
 *
 *   5. NO MONEY. There is no stake, P&L or balance field anywhere in this
 *      file, and no ranking reads one. Credibility is the call record.
 */

import { buildCounts, displayFor, MIN_DECIDED_FOR_ACCURACY, tally } from "../notifications/record.ts";
import type { Clock } from "../prediction/clock.ts";
import { acceptsNewCalls, type VenueMarketReader } from "./markets.ts";
import type { CallsStore } from "./store.ts";
import {
  toCall,
  type CallRecord,
  type CallResponseRecord,
  type Leaderboard,
  type LeaderboardRow,
  type LeaderboardWindow,
  type PeopleSearchResult,
  type Person,
  type PersonCard,
  type PublicRecord,
  type TopCall,
  type TopCallsPage,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back each window reaches. `all` has no floor. */
export const LEADERBOARD_WINDOWS: Readonly<Record<LeaderboardWindow, number | null>> = {
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  all: null,
};

export const LEADERBOARD_RULE =
  `Ranked by accuracy on at least ${MIN_DECIDED_FOR_ACCURACY} calls the venue decided. ` +
  "More decided calls count for more, so a short streak can't outrank a long record. " +
  "Void calls are never a win or a loss. Free public calls only; trades are separate.";

/** z for a two-sided 95% interval. */
const Z95 = 1.959963984540054;

/**
 * Lower bound of the Wilson score interval for `correct` successes in
 * `decided` trials. 0 for an empty sample. Monotone in both arguments the way
 * a ranking needs: more correct calls never lowers it, and the same ratio over
 * more calls raises it.
 */
export function wilsonLowerBound(correct: number, decided: number, z: number = Z95): number {
  if (decided <= 0) return 0;
  const p = correct / decided;
  const z2 = z * z;
  const centre = p + z2 / (2 * decided);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * decided)) / decided);
  return Math.max(0, (centre - margin) / (1 + z2 / decided));
}

export interface PeopleDirectoryDeps {
  store: CallsStore;
  markets: VenueMarketReader;
  clock: Clock;
  /** New calls close this long before the market does (M14); top calls follow it. Default 0. */
  callCutoffMs?: number;
}

/**
 * People the viewer should not see (src/trust: blocked, muted, or who blocked
 * them). Lists drop them before slicing, so a page is never short because of
 * them; ranks stay the public ranks.
 */
export interface PeopleViewOptions {
  excludeAuthors?: ReadonlySet<string>;
}

const hiddenBy = (opts: PeopleViewOptions) => {
  const excluded = opts.excludeAuthors;
  return (userId: string): boolean => excluded !== undefined && excluded.size > 0 && excluded.has(userId);
};

export class PeopleDirectory {
  private readonly store: CallsStore;
  private readonly markets: VenueMarketReader;
  private readonly clock: Clock;
  private readonly callCutoffMs: number;

  constructor(deps: PeopleDirectoryDeps) {
    this.store = deps.store;
    this.markets = deps.markets;
    this.clock = deps.clock;
    this.callCutoffMs = Math.max(0, deps.callCutoffMs ?? 0);
  }

  // ── the one record ────────────────────────────────────────────────────────

  /**
   * A person's public record. With `since`, only calls the venue RESOLVED at
   * or after that instant count — a window is about results, and a pending
   * call has none, so it belongs to no window. Without `since`, pending calls
   * are reported (towards nothing) alongside everything resolved.
   */
  publicRecord(userId: string, since: number | null = null): PublicRecord {
    const acc = emptyTally();
    for (const call of this.store.callsByAuthor(userId)) this.fold(acc, call, since);
    return recordFrom(acc);
  }

  /**
   * Every author's public record in ONE pass over the calls — what the
   * directory-wide surfaces read, so a board over thousands of accounts costs
   * one scan rather than one per person. Same fold as `publicRecord`, so the
   * two cannot disagree. Authors with no counted call are absent.
   */
  recordsByAuthor(since: number | null = null): Map<string, PublicRecord> {
    const tallies = new Map<string, ReturnType<typeof emptyTally>>();
    for (const call of this.store.listCalls()) {
      let acc = tallies.get(call.userId);
      if (!acc) {
        acc = emptyTally();
        tallies.set(call.userId, acc);
      }
      this.fold(acc, call, since);
    }
    const out = new Map<string, PublicRecord>();
    for (const [userId, acc] of tallies) out.set(userId, recordFrom(acc));
    return out;
  }

  private fold(acc: ReturnType<typeof emptyTally>, call: CallRecord, since: number | null): void {
    if (!countsTowardsPublicRecord(call)) return;
    const result = this.store.getResult(call.id);
    const outcome = result?.outcome ?? "PENDING";
    if (since !== null) {
      if (outcome === "PENDING") return;
      if (result?.resolvedAt === null || result?.resolvedAt === undefined || result.resolvedAt < since) return;
    }
    tally(acc, outcome);
  }

  /** A listable person. `viewerUserId` only decides `viewerIsFollowing`. */
  card(person: Person, viewerUserId: string | null, record: PublicRecord = this.publicRecord(person.id)): PersonCard {
    return {
      ...summaryOf(person),
      record,
      viewerIsFollowing:
        viewerUserId !== null && viewerUserId !== person.id && this.store.isFollowing(viewerUserId, person.id),
    };
  }

  // ── leaderboard ───────────────────────────────────────────────────────────

  leaderboard(
    args: { window: LeaderboardWindow; limit: number },
    viewerUserId: string | null,
    opts: PeopleViewOptions = {},
  ): Leaderboard {
    const hidden = hiddenBy(opts);
    const now = this.clock.now();
    const span = LEADERBOARD_WINDOWS[args.window];
    const since = span === null ? null : now - span;

    const records = this.recordsByAuthor(since);
    const rows: (LeaderboardRow & { score: number })[] = [];
    for (const [userId, record] of records) {
      if (record.counts.decided === 0) continue;
      const person = this.store.getPerson(userId);
      if (!person) continue;
      rows.push({
        rank: null,
        person: summaryOf(person),
        record,
        score: wilsonLowerBound(record.counts.correct, record.counts.decided),
      });
    }

    const ranked = rows
      .filter((r) => r.record.counts.decided >= MIN_DECIDED_FOR_ACCURACY)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.record.counts.decided - a.record.counts.decided ||
          b.record.counts.correct - a.record.counts.correct ||
          a.person.handle.localeCompare(b.person.handle),
      )
      .map((r, i) => ({ ...stripScore(r), rank: i + 1 }));

    // Below the sample: ordered by evidence, never by a ratio they have not
    // earned, and never numbered — a position here would be a rank by another
    // name.
    const building = rows
      .filter((r) => r.record.counts.decided < MIN_DECIDED_FOR_ACCURACY)
      .sort((a, b) => b.record.counts.decided - a.record.counts.decided || a.person.handle.localeCompare(b.person.handle))
      .map(stripScore);

    // The viewer's own row, wherever they stand — ranked beyond the page,
    // building, or with nothing decided in this window yet (all zeros, never
    // somebody else's numbers).
    let viewer: Leaderboard["viewer"] = null;
    const me = viewerUserId === null ? undefined : this.store.getPerson(viewerUserId);
    if (me) {
      const base: LeaderboardRow = ranked.find((r) => r.person.id === me.id) ?? {
        rank: null,
        person: summaryOf(me),
        record: records.get(me.id) ?? recordFrom(emptyTally()),
      };
      viewer = { ...base, decidedToRank: Math.max(0, MIN_DECIDED_FOR_ACCURACY - base.record.counts.decided) };
    }

    return {
      window: args.window,
      // Ranks are assigned over everyone first, so hiding someone from this
      // viewer never renumbers anybody else.
      ranked: ranked.filter((r) => !hidden(r.person.id)).slice(0, args.limit),
      building: building.filter((r) => !hidden(r.person.id)).slice(0, args.limit),
      viewer,
      minimumDecided: MIN_DECIDED_FOR_ACCURACY,
      rule: LEADERBOARD_RULE,
      servedAt: now,
    };
  }

  // ── search ────────────────────────────────────────────────────────────────

  /**
   * The directory, by handle or display name. Case-insensitive; a leading `@`
   * is ignored. Never matches a wallet: a wallet is a credential, and this
   * surface is public (§0.3).
   *
   * Ordering is by how well the name matches, then by evidence (decided
   * calls), then alphabetically — a search is not a ranking, so accuracy does
   * not reorder it.
   */
  searchPeople(
    args: { query: string; limit: number },
    viewerUserId: string | null,
    opts: PeopleViewOptions = {},
  ): PeopleSearchResult {
    const hidden = hiddenBy(opts);
    const query = normaliseQuery(args.query);
    const hits: { person: Person; tier: number; record: PublicRecord }[] = [];
    if (query.length > 0) {
      const records = this.recordsByAuthor();
      const none = recordFrom(emptyTally());
      for (const person of this.store.listPeople()) {
        if (hidden(person.id)) continue;
        const tier = matchTier(person, query);
        if (tier === null) continue;
        hits.push({ person, tier, record: records.get(person.id) ?? none });
      }
    }
    hits.sort(
      (a, b) =>
        a.tier - b.tier ||
        b.record.counts.decided - a.record.counts.decided ||
        a.person.handle.localeCompare(b.person.handle),
    );
    return {
      query,
      people: hits.slice(0, args.limit).map((h) => this.card(h.person, viewerUserId, h.record)),
      servedAt: this.clock.now(),
    };
  }

  /** The people the viewer follows, as cards. The viewer's own data only. */
  following(viewerUserId: string): PersonCard[] {
    return this.store
      .followingOf(viewerUserId)
      .map((id) => this.store.getPerson(id))
      .filter((p): p is Person => p !== undefined)
      .map((p) => this.card(p, viewerUserId))
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.handle.localeCompare(b.handle));
  }

  // ── top calls ─────────────────────────────────────────────────────────────

  /**
   * Open calls worth answering: public, live, on a market that still takes
   * calls, by somebody other than the viewer. One per market (so the strip is
   * a spread of questions, not five takes on one) and at most two per author.
   *
   * Order: response volume, then the author's evidence-weighted record, then
   * recency. Volume carries no direction (rule 4 in the header); the record
   * term only ever compares people who have cleared the sample, because below
   * it there is no accuracy to weigh.
   */
  topCalls(args: { limit: number }, viewerUserId: string | null, opts: PeopleViewOptions = {}): TopCallsPage {
    const hidden = hiddenBy(opts);
    const now = this.clock.now();
    const records = this.recordsByAuthor();
    const none = recordFrom(emptyTally());
    const recordOf = (userId: string): PublicRecord => records.get(userId) ?? none;
    // One pass over responses, not one per candidate.
    const responsesByTarget = new Map<string, CallResponseRecord[]>();
    for (const r of this.store.listResponses()) {
      const list = responsesByTarget.get(r.targetCallId);
      if (list) list.push(r);
      else responsesByTarget.set(r.targetCallId, [r]);
    }

    const candidates = this.store
      .liveCalls()
      .filter((c) => c.visibility === "public" && c.userId !== viewerUserId && !hidden(c.userId))
      .filter((c) => {
        const market = this.markets.getMarket(c.marketId);
        // Only calls the viewer can still answer: the same cut-off back/fade use.
        return market !== undefined && acceptsNewCalls(market, now, this.callCutoffMs) &&
          this.markets.getResolution(market.id) === undefined;
      })
      .map((c) => {
        const responses = responsesByTarget.get(c.id) ?? [];
        const record = recordOf(c.userId);
        return {
          call: c,
          responses,
          volume: responses.length,
          credibility:
            record.display.mode === "accuracy" ? wilsonLowerBound(record.counts.correct, record.counts.decided) : 0,
          record,
        };
      })
      .sort(
        (a, b) =>
          b.volume - a.volume ||
          b.credibility - a.credibility ||
          b.call.lockedAt - a.call.lockedAt ||
          b.call.id.localeCompare(a.call.id),
      );

    const seenMarkets = new Set<string>();
    const perAuthor = new Map<string, number>();
    const entries: TopCall[] = [];
    for (const c of candidates) {
      if (entries.length >= args.limit) break;
      if (seenMarkets.has(c.call.marketId)) continue;
      if ((perAuthor.get(c.call.userId) ?? 0) >= 2) continue;
      const market = this.markets.getMarket(c.call.marketId);
      const author = this.store.getPerson(c.call.userId);
      if (!market || !author) continue;
      seenMarkets.add(c.call.marketId);
      perAuthor.set(c.call.userId, (perAuthor.get(c.call.userId) ?? 0) + 1);

      const viewerHasCalled =
        viewerUserId !== null && this.store.liveCallByUserOnMarket(viewerUserId, market.id) !== undefined;
      entries.push({
        call: toCall(c.call),
        author: { ...summaryOf(author), record: c.record },
        market,
        responses: c.volume,
        // ★ The crowd-split gate. Withheld at the source, not hidden in a UI.
        split: viewerHasCalled
          ? {
              backs: c.responses.filter((r) => r.kind === "back").length,
              fades: c.responses.filter((r) => r.kind === "fade").length,
            }
          : null,
        viewerHasCalled,
      });
    }
    return { entries, servedAt: now };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Rule 1's scope, in one place. */
export const countsTowardsPublicRecord = (call: CallRecord): boolean =>
  call.visibility === "public" && call.fundingState === "NONE";

/** A person as a list shows them. No wallet, no counts that could disagree
 *  with `publicRecord`. */
function summaryOf(person: Person): LeaderboardRow["person"] {
  return {
    id: person.id,
    handle: person.handle,
    displayName: person.displayName,
    avatarUrl: person.avatarUrl,
  };
}

const emptyTally = () => ({ correct: 0, incorrect: 0, voided: 0, pending: 0 });

function recordFrom(acc: ReturnType<typeof emptyTally>): PublicRecord {
  const counts = buildCounts(acc);
  return { counts, display: displayFor(counts) };
}

function stripScore(row: LeaderboardRow & { score?: number }): LeaderboardRow {
  return { rank: row.rank, person: row.person, record: row.record };
}

export function normaliseQuery(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

/**
 * 0: the handle starts with the query. 1: the display name, or any word in
 * it, does. 2: either contains it. null: no match.
 */
function matchTier(person: Person, query: string): number | null {
  const handle = person.handle.replace(/^@/, "").toLowerCase();
  const name = person.displayName.toLowerCase();
  if (handle.startsWith(query)) return 0;
  if (name.startsWith(query) || name.split(/\s+/).some((w) => w.startsWith(query))) return 1;
  if (handle.includes(query) || name.includes(query)) return 2;
  return null;
}
