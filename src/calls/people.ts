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
  type LatestLiveCall,
  type PublicRecord,
  type SuggestedPeople,
  type SuggestedPerson,
  type SuggestionReason,
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
  /**
   * MONEY_CALLS_ENABLED only (docs/money-api.md). A call whose money has not
   * landed (PENDING) or never did (EXPIRED) is on no public surface and no
   * record; it was never public.
   */
  isPrivate?: (callId: string) => boolean;
  /** MONEY_CALLS_ENABLED only: a call backed by a confirmed fill. Funded calls rank first on call lists. */
  isFunded?: (callId: string) => boolean;
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
  private readonly isPrivate: (callId: string) => boolean;
  private readonly isFunded: ((callId: string) => boolean) | undefined;

  constructor(deps: PeopleDirectoryDeps) {
    this.store = deps.store;
    this.markets = deps.markets;
    this.clock = deps.clock;
    this.callCutoffMs = Math.max(0, deps.callCutoffMs ?? 0);
    this.isPrivate = deps.isPrivate ?? (() => false);
    this.isFunded = deps.isFunded;
  }

  /** Rule 1's scope, minus calls that were never public (a pending or expired money call). */
  private onRecord = (call: CallRecord): boolean => countsTowardsPublicRecord(call) && !this.isPrivate(call.id);

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
    if (!this.onRecord(call)) return;
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
    const funded = this.fundedCallsByAuthor(since);
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
        ...(funded ? { fundedCalls: funded.get(userId) ?? 0 } : {}),
      });
    }

    const ranked = rows
      .filter((r) => r.record.counts.decided >= MIN_DECIDED_FOR_ACCURACY)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.record.counts.decided - a.record.counts.decided ||
          b.record.counts.correct - a.record.counts.correct ||
          // MONEY_CALLS_ENABLED: an exact tie goes to the person with more funded calls.
          (b.fundedCalls ?? 0) - (a.fundedCalls ?? 0) ||
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
        ...(funded ? { fundedCalls: funded.get(me.id) ?? 0 } : {}),
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

  /**
   * MONEY_CALLS_ENABLED only: each author's public calls backed by a
   * confirmed fill (locked inside the window). Null with money calls off, so
   * a row keeps its exact earlier shape.
   */
  private fundedCallsByAuthor(since: number | null): Map<string, number> | null {
    const isFunded = this.isFunded;
    if (!isFunded) return null;
    const out = new Map<string, number>();
    for (const call of this.store.listCalls()) {
      if (call.visibility !== "public" || call.hiddenAt !== null || this.isPrivate(call.id) || !isFunded(call.id)) continue;
      if (since !== null && call.lockedAt < since) continue;
      out.set(call.userId, (out.get(call.userId) ?? 0) + 1);
    }
    return out;
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

    const isFunded = this.isFunded;
    const candidates = this.store
      .liveCalls()
      .filter((c) => c.visibility === "public" && c.userId !== viewerUserId && !hidden(c.userId) && !this.isPrivate(c.id))
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
          // MONEY_CALLS_ENABLED: funded calls first.
          (isFunded ? Number(isFunded(b.call.id)) - Number(isFunded(a.call.id)) : 0) ||
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

  // ── suggestions ───────────────────────────────────────────────────────────

  /**
   * Who to follow during onboarding: people with at least one public free
   * call (so a follow leads somewhere), the viewer and anyone they already
   * follow left out. Order: ranked (all time), then authors of top calls by
   * response volume, then people building a record by decided calls, then
   * the most recent callers. Nobody twice, nobody padded in, nobody ranked
   * by money. `friendIds` (the session's friends from the old app) come back
   * as `friends`, call or not, and are not repeated in `people`.
   */
  suggested(
    args: { limit: number; friendIds?: readonly string[] },
    viewerUserId: string | null,
    opts: PeopleViewOptions = {},
  ): SuggestedPeople {
    const hidden = hiddenBy(opts);
    const now = this.clock.now();
    const records = this.recordsByAuthor();
    const none = recordFrom(emptyTally());
    const latest = this.latestLiveCalls(now);
    // The viewer, anyone already followed, anyone blocked or muted either way
    // (src/trust), and deleted accounts: following any of them leads nowhere.
    const excluded = (id: string): boolean =>
      id === viewerUserId || hidden(id) || (viewerUserId !== null && this.store.isFollowing(viewerUserId, id));

    const cardOf = (person: Person, reason: SuggestionReason): SuggestedPerson => ({
      ...this.card(person, viewerUserId, records.get(person.id) ?? none),
      latestLiveCall: latest.get(person.id) ?? null,
      reason,
    });

    const friends: SuggestedPerson[] = [];
    const friendSet = new Set<string>();
    if (viewerUserId !== null) {
      for (const id of args.friendIds ?? []) {
        if (friendSet.has(id) || excluded(id)) continue;
        const person = this.store.getPerson(id);
        if (!person || isDeletedAccount(person)) continue;
        friendSet.add(id);
        friends.push(cardOf(person, "friend"));
        if (friends.length >= args.limit) break;
      }
    }

    const people: SuggestedPerson[] = [];
    const seen = new Set<string>(friendSet);
    const add = (userId: string, reason: SuggestionReason): void => {
      if (people.length >= args.limit || seen.has(userId) || excluded(userId)) return;
      const record = records.get(userId);
      if (!record || record.counts.decided + record.counts.voided + record.counts.pending === 0) return;
      const person = this.store.getPerson(userId);
      if (!person || isDeletedAccount(person)) return;
      seen.add(userId);
      people.push(cardOf(person, reason));
    };

    const board = this.leaderboard({ window: "all", limit: 100 }, null, opts);
    for (const row of board.ranked) add(row.person.id, "ranked");
    for (const top of this.topCalls({ limit: 20 }, null, opts).entries) add(top.author.id, "top_call");
    for (const row of board.building) add(row.person.id, "building");
    const recent = this.store
      .liveCalls()
      .filter(this.onRecord)
      .sort((a, b) => b.lockedAt - a.lockedAt || b.id.localeCompare(a.id));
    for (const call of recent) add(call.userId, "recent");

    return { friends, people, servedAt: now };
  }

  /** Each author's most recent live public free call on a market that still
   *  takes calls and has no result. */
  private latestLiveCalls(now: number): Map<string, LatestLiveCall> {
    const out = new Map<string, { call: CallRecord; at: number }>();
    for (const call of this.store.liveCalls()) {
      if (!this.onRecord(call)) continue;
      const market = this.markets.getMarket(call.marketId);
      // The same cut-off calls.create and back/fade use (M14): a "latest live
      // call" is one the viewer could still answer.
      if (!market || !acceptsNewCalls(market, now, this.callCutoffMs) || this.markets.getResolution(market.id) !== undefined) {
        continue;
      }
      const held = out.get(call.userId);
      if (!held || call.lockedAt > held.at) out.set(call.userId, { call, at: call.lockedAt });
    }
    const latest = new Map<string, LatestLiveCall>();
    for (const [userId, { call }] of out) {
      const market = this.markets.getMarket(call.marketId)!;
      latest.set(userId, {
        callId: call.id,
        side: call.side,
        marketId: market.id,
        question: market.question,
        closesAt: market.closesAt,
      });
    }
    return latest;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * An account anonymised by account deletion (20261002180000: full_name
 * "Deleted account", handle `deleted_<hex>` or none). Its calls stay public
 * records, but it is never suggested as someone to follow.
 */
export const isDeletedAccount = (person: Person): boolean =>
  person.displayName === "Deleted account" && (!person.handle || person.handle.startsWith("deleted_"));

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
    // The avatar the person chose (account.updateProfile), so people lists
    // show the same picture as their calls do.
    avatarId: person.avatarId ?? null,
  };
}

const emptyTally = () => ({ correct: 0, incorrect: 0, voided: 0, pending: 0 });

function recordFrom(acc: ReturnType<typeof emptyTally>): PublicRecord {
  const counts = buildCounts(acc);
  return { counts, display: displayFor(counts) };
}

function stripScore(row: LeaderboardRow & { score?: number }): LeaderboardRow {
  return { rank: row.rank, person: row.person, record: row.record,
    ...(row.fundedCalls !== undefined ? { fundedCalls: row.fundedCalls } : {}) };
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
