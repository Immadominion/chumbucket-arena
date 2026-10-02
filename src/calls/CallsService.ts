/**
 * CallsService — the eight behaviours behind `src/api/calls.ts`.
 *
 * The three things a client CANNOT enforce, and this class must
 * (integration-requests/packet-c.md §5):
 *
 *   1. `crowdSplit` is null until the CALLER has a locked call on that market.
 *      Enforced in `marketDetail`, from the caller's session-derived id. A
 *      client that asks early is sent null, so there is nothing to leak.
 *   2. `back` and `fade` create the ACTOR'S OWN `Call` and return it.
 *      `challenge` creates NO call and carries no amount, no escrow and no
 *      transaction — `assertMoneyFree` proves the last part at runtime.
 *   3. `CallResult` is SERVICE-DERIVED ONLY. This class never computes an
 *      outcome: `CallsStore.writeResult` takes venue evidence (or its absence)
 *      and derives it through Packet B's `deriveCallOutcome`. There is no
 *      `outcome` parameter anywhere in this file.
 *
 * And the rule that governs every read here: the viewer is a canonical
 * `public.users.id` that the ROUTER derived from the verified session. No
 * method below takes a viewer as data from the caller of the API — see
 * `viewer.ts` for why that matters (§8 finding 4).
 */

import { systemClock, type Clock } from "../prediction/clock.ts";
import type { MarketResolutionRecord } from "../prediction/types.ts";
import { usableSharePrice } from "../prediction/sharePrices.ts";
import { CallsError } from "./errors.ts";
import { acceptsNewCalls, callsCloseAt, type VenueMarketReader } from "./markets.ts";
import type { CallFunding, CallFundingReader } from "../prediction/PantaFunding.ts";
import type { CallReceiptsProjection } from "./receipts.ts";
import { PeopleDirectory, type PeopleViewOptions } from "./people.ts";
import { accuracyOf, THESIS_UPDATE_MAX, type CallsStore } from "./store.ts";
import {
  assertMoneyFree,
  toCall,
  toCallResponse,
  type Call,
  type CallDetail,
  type CallFeedEntry,
  type CallFeedPage,
  type CallRecord,
  type CallResponseResult,
  type CallVisibility,
  type ChallengeInvitation,
  type CreateCallInput,
  type CrowdSplit,
  type Leaderboard,
  type LeaderboardWindow,
  type MarketDetail,
  type PeopleSearchResult,
  type PersonCard,
  type Person,
  type PersonDetail,
  type RespondToCallInput,
  type Side,
  type ThesisUpdate,
  type TopCallsPage,
  type VenueMarket,
} from "./types.ts";

export type FeedMode = "global" | "following";

/** What a generated id names. A persisted store needs a UUID for each. */
export type CallsIdKind = "call" | "response" | "update";

export interface CallsServiceDeps {
  /** Local integration seam; production runtime remains gated until release approval. */
  allowPantaCalls?: boolean;
  store: CallsStore;
  markets: VenueMarketReader;
  clock?: Clock;
  receipts?: CallReceiptsProjection;
  /** Injectable so ids are deterministic in a test. */
  newId?: (kind: CallsIdKind) => string;
  /** Bound on a feed page. */
  maxPageSize?: number;
  /** New calls close this long before the market does (M14). Default 0. */
  callCutoffMs?: number;
  /** Confirmed Panta fills, shown as the author's conviction. Never money. */
  funding?: CallFundingReader;
}

const THESIS_MAX = 280;

export class CallsService {
  private readonly store: CallsStore;
  private readonly markets: VenueMarketReader;
  private readonly clock: Clock;
  private readonly receipts: CallReceiptsProjection | undefined;
  private readonly maxPageSize: number;
  private readonly newId: (kind: CallsIdKind) => string;
  private seq = 0;
  private readonly allowPantaCalls: boolean;
  /** Leaderboard, search, top calls and the shared public record. */
  readonly people: PeopleDirectory;
  private readonly callCutoffMs: number;
  private readonly funding: CallFundingReader | undefined;

  constructor(deps: CallsServiceDeps) {
    this.allowPantaCalls = deps.allowPantaCalls === true;
    this.callCutoffMs = Math.max(0, deps.callCutoffMs ?? 0);
    this.funding = deps.funding;
    this.store = deps.store;
    this.markets = deps.markets;
    this.clock = deps.clock ?? systemClock;
    this.receipts = deps.receipts;
    this.maxPageSize = deps.maxPageSize ?? 50;
    this.newId = deps.newId ?? ((kind) => `${kind}_${++this.seq}_${this.clock.now().toString(36)}`);
    this.people = new PeopleDirectory({
      store: this.store,
      markets: this.markets,
      clock: this.clock,
      callCutoffMs: this.callCutoffMs,
    });
  }

  // ── 1. calls.feed ─────────────────────────────────────────────────────────

  /**
   * `following` mode REQUIRES a session: the router refuses with UNAUTHORIZED
   * before reaching here, so "you follow nobody" stays distinguishable from "we
   * do not know who you are".
   */
  feed(
    args: { mode: FeedMode; cursor?: string | null; limit?: number },
    viewerUserId: string | null,
    opts: { excludeAuthors?: ReadonlySet<string> } = {},
  ): CallFeedPage {
    const limit = clamp(args.limit ?? 20, 1, this.maxPageSize);
    const following = args.mode === "following" && viewerUserId ? new Set(this.store.followingOf(viewerUserId)) : null;
    // Blocked and muted authors (src/trust), filtered before paging so a page
    // is never short because of them.
    const excluded = opts.excludeAuthors;

    const rows = this.store
      .liveCalls()
      .filter((c) => this.canSee(c, viewerUserId))
      .filter((c) => (excluded && excluded.size > 0 ? !excluded.has(c.userId) : true))
      .filter((c) => (following ? following.has(c.userId) : true))
      .sort(newestFirst);

    const after = decodeCursor(args.cursor ?? null);
    const start = after ? rows.findIndex((c) => c.lockedAt === after.lockedAt && c.id === after.id) + 1 : 0;
    const page = rows.slice(start, start + limit);
    const more = rows.length > start + limit;
    const last = page[page.length - 1];

    return {
      entries: page.map((c) => this.entryOf(c, viewerUserId)),
      nextCursor: more && last ? encodeCursor(last) : null,
      servedAt: this.clock.now(),
    };
  }

  // ── 2. markets.open ───────────────────────────────────────────────────────

  /**
   * Markets a call can be made on right now. Reading needs no session.
   *
   * "Can be made on" is meant literally, which is why a market with no price
   * is excluded. A call pins `entryProbability` to the snapshot the person saw,
   * and `calls.snapshot_id` is a real foreign key the store refuses to null —
   * so offering a market with no snapshot would be offering an action that
   * fails the moment somebody takes it. In production this was most of the
   * catalog: 2,105 markets offered, and the soonest-closing ones had no price,
   * because the synchroniser prices markets on a budget and cannot cover
   * thousands at once.
   *
   * Better to show fewer markets that all work than a long list that mostly
   * does not.
   */
  openMarkets(args: { category?: string | null } = {}): VenueMarket[] {
    return this.markets
      .listMarkets()
      .filter((m) => acceptsNewCalls(m, this.clock.now(), this.callCutoffMs))
      .filter((m) => this.markets.getResolution(m.id) === undefined)
      .filter((m) => m.venue === "panta"
        ? this.allowPantaCalls && usableSharePrice(this.markets.latestSharePrice?.(m.id), this.clock.now())
        : this.markets.latestSnapshot(m.id) !== undefined)
      .filter((m) => (args.category ? m.category === args.category : true))
      .sort((a, b) => (a.closesAt ?? Number.MAX_SAFE_INTEGER) - (b.closesAt ?? Number.MAX_SAFE_INTEGER));
  }

  // ── 3. markets.detail ─────────────────────────────────────────────────────

  /**
   * ★ The crowd-split gate. `crowdSplit` is non-null ONLY when the caller has a
   * live, locked call on this market. A caller with no session, or with a
   * session but no call here, is sent null — not a zeroed split, not a partial
   * one. It is withheld at the source, so no client can render it early even by
   * asking.
   */
  marketDetail(args: { marketId: string }, viewerUserId: string | null): MarketDetail {
    const market = this.requireMarket(args.marketId);
    const viewerCall = viewerUserId ? this.store.liveCallByUserOnMarket(viewerUserId, market.id) : undefined;

    return {
      market,
      snapshot: market.venue === "panta" ? null : this.markets.latestSnapshot(market.id) ?? null,
      ...(market.venue === "panta" ? { sharePrice: this.markets.latestSharePrice?.(market.id) ?? null } : {}),
      viewerCall: viewerCall ? this.entryOf(viewerCall, viewerUserId) : null,
      crowdSplit: viewerCall ? this.crowdSplitOf(market.id) : null,
      callsCloseAt: callsCloseAt(market, this.callCutoffMs),
      callCutoffMs: this.callCutoffMs,
      servedAt: this.clock.now(),
    };
  }

  // ── 4. calls.get ──────────────────────────────────────────────────────────

  getCall(
    args: { callId: string },
    viewerUserId: string | null,
    opts: PeopleViewOptions = {},
  ): CallDetail {
    const call = this.requireVisibleCall(args.callId, viewerUserId);
    const parent = call.parentCallId ? this.store.getCall(call.parentCallId) : undefined;
    // Blocked/muted people (src/trust). A call opened by its link still reads,
    // but the thread carries nothing more from somebody the viewer hid: not
    // their back/fade on it, and not the author's later updates if the author
    // is the one hidden.
    const excluded = opts.excludeAuthors;
    const hidden = (userId: string) => excluded !== undefined && excluded.size > 0 && excluded.has(userId);
    const authorHidden = hidden(call.userId);

    return {
      entry: this.entryOf(call, viewerUserId),
      parent: parent && this.canSee(parent, viewerUserId) ? this.entryOf(parent, viewerUserId) : null,
      responses: this.store
        .responsesForTarget(call.id)
        .filter((r) => !hidden(r.actorUserId))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(toCallResponse),
      // Exactly as visible as the call itself: requireVisibleCall above is
      // the only gate, so a thread can never be read around its call.
      updates: authorHidden ? [] : this.store.thesisUpdatesFor(call.id),
      // Only the author can see a withdrawn call, and it takes no new update
      // (appendThesisUpdate refuses it), so it offers none either.
      updatesAvailable: !authorHidden && this.store.thesisUpdatesAvailable() && call.hiddenAt === null,
    };
  }

  // ── 4b. calls.addUpdate — the thesis thread ──────────────────────────────

  /**
   * Append a timestamped follow-up to the actor's OWN call. The original
   * thesis is not touched — it is frozen with the call (§0.1) — so what was
   * said before the result and what was said after are always distinguishable.
   *
   * The actor comes from the verified session. Somebody else's call is refused
   * with the same "couldn't find" a followers-only call gets when the actor
   * cannot see it, and with a plain refusal when they can.
   */
  appendThesisUpdate(args: { callId: string; body: string }, actorUserId: string): ThesisUpdate {
    const call = this.requireVisibleCall(args.callId, actorUserId);
    if (call.userId !== actorUserId) {
      throw new CallsError("THESIS_NOT_AUTHOR", "Only the person who made this call can add to its thesis.", {
        details: { callId: call.id },
      });
    }
    if (call.hiddenAt !== null) {
      // A new update is always written now, so a withdrawn call takes none.
      throw new CallsError("CALL_HIDDEN", "This call was withdrawn, so its thesis can't take new updates.", {
        details: { callId: call.id },
      });
    }
    if (!this.store.thesisUpdatesAvailable()) {
      throw new CallsError(
        "THESIS_UPDATES_UNAVAILABLE",
        "Thesis updates aren't available yet. Your original call is unchanged.",
      );
    }
    const body = args.body.trim();
    if (body.length === 0) throw new CallsError("CALL_INVALID", "Write something before posting an update.");
    if (body.length > THESIS_UPDATE_MAX) {
      throw new CallsError("CALL_INVALID", `Keep an update to ${THESIS_UPDATE_MAX} characters.`);
    }
    return this.store.insertThesisUpdate({
      id: this.newId("update"),
      callId: call.id,
      authorUserId: actorUserId,
      body,
      createdAt: this.clock.now(),
    });
  }

  // ── 5. people.get ─────────────────────────────────────────────────────────

  /** `personRef` is a canonical user id or a handle. Never a wallet: a wallet is
   *  a credential and this surface is public. */
  getPerson(args: { personRef: string }, viewerUserId: string | null): PersonDetail {
    const person = this.resolvePerson(args.personRef);
    const calls = this.store
      .callsByAuthor(person.id)
      .filter((c) => c.hiddenAt === null)
      .filter((c) => this.canSee(c, viewerUserId))
      .sort(newestFirst);

    return {
      person: this.decorate(person),
      calls: calls.map((c) => this.entryOf(c, viewerUserId)),
      viewerIsFollowing: viewerUserId !== null && viewerUserId !== person.id
        ? this.store.isFollowing(viewerUserId, person.id) : false,
      servedAt: this.clock.now(),
      followerCount: this.store.followersOf(person.id).length,
      followingCount: this.store.followingOf(person.id).length,
      record: this.people.publicRecord(person.id),
    };
  }

  // ── 5b. the people layer ─────────────────────────────────────────────────

  /** people.leaderboard — see `PeopleDirectory.leaderboard`. */
  leaderboard(
    args: { window: LeaderboardWindow; limit?: number },
    viewerUserId: string | null,
    opts: PeopleViewOptions = {},
  ): Leaderboard {
    return this.people.leaderboard({ window: args.window, limit: clamp(args.limit ?? 50, 1, 100) }, viewerUserId, opts);
  }

  /** people.search — by handle or name, never by wallet. */
  searchPeople(
    args: { query: string; limit?: number },
    viewerUserId: string | null,
    opts: PeopleViewOptions = {},
  ): PeopleSearchResult {
    return this.people.searchPeople({ query: args.query, limit: clamp(args.limit ?? 20, 1, 50) }, viewerUserId, opts);
  }

  /** people.following — the session's own follow list, and nobody else's. */
  followingOf(viewerUserId: string): PersonCard[] {
    return this.people.following(viewerUserId);
  }

  /** calls.top — open calls worth answering, crowd direction gated. */
  topCalls(args: { limit?: number }, viewerUserId: string | null, opts: PeopleViewOptions = {}): TopCallsPage {
    return this.people.topCalls({ limit: clamp(args.limit ?? 10, 1, 20) }, viewerUserId, opts);
  }

  /** The actor is supplied by the verified session, never by the request. */
  setFollowing(args: { personRef: string; following: boolean }, actorUserId: string): {
    personId: string; following: boolean;
  } {
    const person = this.resolvePerson(args.personRef);
    if (person.id === actorUserId) {
      throw new CallsError("FOLLOW_SELF", "You can't follow yourself.");
    }
    if (args.following) this.store.follow(actorUserId, person.id);
    else this.store.unfollow(actorUserId, person.id);
    return { personId: person.id, following: args.following };
  }

  // ── 6. calls.create ───────────────────────────────────────────────────────

  /**
   * Lock a new, free, immutable call. `entryProbability` and `snapshotId` are
   * stamped by the SERVER from the price it actually holds: a client cannot
   * forge the probability it claims to have seen. (The SQL side gets the same
   * property from the column-level INSERT grant, which withholds both columns
   * from `authenticated`.)
   */
  createCall(input: CreateCallInput, actorUserId: string): CallFeedEntry {
    const market = this.requireMarket(input.marketId);
    this.assertCurrentVenue(market);
    if (market.venue === "panta" && !this.allowPantaCalls) {
      throw new CallsError("CALL_INVALID", "Panta market reads are available, but Panta calls and share-price receipts are not enabled yet.");
    }
    this.assertBeforeCutoff(market, "make a call");
    if (!acceptsNewCalls(market, this.clock.now(), this.callCutoffMs) || this.markets.getResolution(market.id)) {
      throw new CallsError(
        "CALL_MARKET_CLOSED",
        market.status === "OPEN"
          ? "This market is outside its call window or already has a venue result."
          : `This market is ${humanStatus(market.status)}, so it is not taking new calls.`,
        { details: { marketId: market.id, status: market.status } },
      );
    }
    const call = this.lockCall({
      actorUserId,
      market,
      side: input.side,
      confidence: input.confidence ?? null,
      thesis: input.thesis ?? null,
      visibility: input.visibility ?? "public",
      parentCallId: input.parentCallId ?? null,
    });
    return this.entryOf(call, actorUserId);
  }

  // ── 7. calls.respond ──────────────────────────────────────────────────────

  /**
   * ★ back/fade mint the actor's OWN call and return it. challenge creates NO
   *   call, carries no amount, no escrow and no transaction, and returns an
   *   invitation instead.
   */
  respond(input: RespondToCallInput, actorUserId: string): CallResponseResult {
    const target = this.requireVisibleCall(input.targetCallId, actorUserId);
    if (target.userId === actorUserId) {
      throw new CallsError("RESPONSE_SELF", "You can't respond to your own call.", {
        details: { targetCallId: target.id },
      });
    }
    const market = this.requireMarket(target.marketId);
    this.assertCurrentVenue(market);
    if (market.venue === "panta" && !this.allowPantaCalls) {
      throw new CallsError("CALL_INVALID", "Panta calls and share-price receipts are not enabled yet.");
    }
    const at = this.clock.now();

    if (input.kind === "challenge") {
      // No call. No money. Not even a field that could hold one.
      const response = this.store.insertResponse({
        id: this.newId("response"),
        actorUserId,
        targetCallId: target.id,
        kind: "challenge",
        resultingCallId: null,
        note: trimOrNull(input.note, THESIS_MAX),
        createdAt: at,
      });
      const invitation: ChallengeInvitation = {
        id: `inv_${response.id}`,
        fromUserId: actorUserId,
        toUserId: target.userId,
        marketId: target.marketId,
        sourceCallId: target.id,
        responseId: response.id,
        note: response.note,
        createdAt: response.createdAt,
      };
      assertMoneyFree(invitation, "a challenge invitation");
      return { response: toCallResponse(response), resultingCall: null, invitation };
    }

    // back = the same side. fade = the other side. Those are the words.
    this.assertBeforeCutoff(market, `${input.kind} this call`);
    if (!acceptsNewCalls(market, this.clock.now(), this.callCutoffMs) || this.markets.getResolution(market.id)) {
      throw new CallsError(
        "CALL_MARKET_CLOSED",
        `This market is not accepting new calls, so you can't ${input.kind} this call any more.`,
        { details: { marketId: market.id, status: market.status } },
      );
    }
    const side: Side = input.kind === "back" ? target.side : opposite(target.side);
    const own = this.lockCall({
      actorUserId,
      market,
      side,
      confidence: input.confidence ?? null,
      thesis: trimOrNull(input.thesis, THESIS_MAX),
      visibility: input.visibility ?? "public",
      parentCallId: target.id,
    });
    const response = this.store.insertResponse({
      id: this.newId("response"),
      actorUserId,
      targetCallId: target.id,
      kind: input.kind,
      resultingCallId: own.id,
      note: null,
      createdAt: at,
    });

    return {
      response: toCallResponse(response),
      resultingCall: this.entryOf(own, actorUserId),
      invitation: null,
    };
  }

  // ── 8. calls.invitations ──────────────────────────────────────────────────

  /** Challenges pointed at calls the caller made. No escrow, ever. */
  invitations(viewerUserId: string): ChallengeInvitation[] {
    const mine = new Set(this.store.callsByAuthor(viewerUserId).map((c) => c.id));
    const out = this.store
      .listResponses()
      .filter((r) => r.kind === "challenge" && mine.has(r.targetCallId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => {
        const target = this.store.getCall(r.targetCallId);
        const invitation: ChallengeInvitation = {
          id: `inv_${r.id}`,
          fromUserId: r.actorUserId,
          toUserId: viewerUserId,
          marketId: target?.marketId ?? "",
          sourceCallId: r.targetCallId,
          responseId: r.id,
          note: r.note,
          createdAt: r.createdAt,
        };
        return invitation;
      });
    assertMoneyFree(out, "a challenge invitation list");
    return out;
  }

  // ── withdrawal: hide, never delete ────────────────────────────────────────

  /**
   * "Delete" a call. §3: it is hidden from distribution and NOTHING is
   * rewritten — the call row, its CallResult and the person's accuracy history
   * all survive. There is no method on this service that removes a call.
   */
  hideCall(callId: string, actorUserId: string): Call {
    const call = this.store.getCall(callId);
    if (!call) throw new CallsError("CALL_NOT_FOUND", "That call no longer exists.");
    if (call.userId !== actorUserId) {
      throw new CallsError("CALL_NOT_VISIBLE", "You can only withdraw your own call.");
    }
    return toCall(this.store.hideCall(callId, "withdrawn by author"));
  }

  // ── receipts ─────────────────────────────────────────────────────────────

  /** Re-issue the settled receipt for one call. Idempotent. */
  emitSettledReceipt(callId: string): void {
    if (!this.receipts) return;
    const call = this.store.getCall(callId);
    const result = this.store.getResult(callId);
    if (!call || !result) return;
    this.receipts.recordSettled(toCall(call), result, this.markets.getMarket(call.marketId), this.clock.now());
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * M14: an open market inside its cut-off window refuses new calls with copy
   * that names the window, so the person knows why and when it closed.
   */
  private assertBeforeCutoff(market: VenueMarket, action: string): void {
    const now = this.clock.now();
    const closeAt = callsCloseAt(market, this.callCutoffMs);
    if (this.callCutoffMs > 0 && market.status === "OPEN" && market.closesAt !== null &&
        market.closesAt > now && closeAt !== null && closeAt <= now) {
      const minutes = Math.round(this.callCutoffMs / 60_000);
      throw new CallsError(
        "CALL_MARKET_CLOSED",
        `Calls close ${minutes} minute${minutes === 1 ? "" : "s"} before this market does, so you can't ${action} now.`,
        { details: { marketId: market.id, status: market.status, callsCloseAt: closeAt } },
      );
    }
  }

  private assertCurrentVenue(market: VenueMarket): void {
    if (market.venue !== "panta" && market.venue !== "fixture") {
      throw new CallsError("CALL_INVALID", "New calls and responses use Panta only. This historical call remains available to read and share.");
    }
  }

  /** The one place a call is created. Everything else routes through it. */
  private lockCall(args: {
    actorUserId: string;
    market: VenueMarket;
    side: Side;
    confidence: number | null;
    thesis: string | null;
    visibility: CallVisibility;
    parentCallId: string | null;
  }): CallRecord {
    if (args.confidence !== null && !(args.confidence >= 0 && args.confidence <= 1)) {
      throw new CallsError("CALL_INVALID", "Confidence must be between 0 and 100%.");
    }
    if (args.thesis !== null && args.thesis.length > THESIS_MAX) {
      throw new CallsError("CALL_INVALID", `Keep your thesis to ${THESIS_MAX} characters.`);
    }

    const at = this.clock.now();
    const entryPrice = args.market.venue === "panta" ? this.markets.latestSharePrice?.(args.market.id) : undefined;
    if (args.market.venue === "panta" && !usableSharePrice(entryPrice, at)) {
      throw new CallsError("CALL_INVALID", "Panta prices are missing or stale. Refresh before locking your call.");
    }
    const snapshot = args.market.venue === "panta" ? undefined : this.markets.latestSnapshot(args.market.id);
    const call = this.store.insertCall({
      id: this.newId("call"),
      userId: args.actorUserId,
      marketId: args.market.id,
      side: args.side,
      confidence: args.confidence,
      thesis: args.thesis,
      // Server-stamped. A client cannot assert the price it says it saw.
      entryProbability: snapshot ? snapshot.yesProbability : null,
      snapshotId: snapshot ? snapshotIdOf(snapshot.marketId, snapshot.observedAt, snapshot.source) : null,
      ...(entryPrice ? { entryPrice } : {}),
      visibility: args.visibility,
      createdAt: at,
      lockedAt: at,
      parentCallId: args.parentCallId,
      // §3: 'NONE' is the free call, and this column is immutable. A funded
      // artefact is a separate venue_positions row that references this call.
      fundingState: "NONE",
      hiddenAt: null,
      hiddenReason: null,
    });

    // A PENDING result exists from the instant the call locks, derived from the
    // ABSENCE of venue evidence — which is the only thing PENDING ever means.
    // Materialising it here is what lets a hidden call still have a result.
    this.store.writeResult({ callId: call.id, evidence: this.evidenceFor(call.marketId) }, at, {
      actor: "service",
    });

    this.receipts?.recordMade(toCall(call), args.market);
    return call;
  }

  /**
   * The ONLY source of a resolution in this packet: Packet B's venue evidence.
   * There is no fallback, no inference from `MarketStatus`, and no timeout — a
   * market whose status reads RESOLVED but which has published no
   * `market_resolutions` row yields undefined, and undefined is PENDING (§0.2).
   */
  private evidenceFor(marketId: string): MarketResolutionRecord | null {
    return this.markets.getResolution(marketId) ?? null;
  }

  private crowdSplitOf(marketId: string): CrowdSplit {
    let yesCalls = 0;
    let noCalls = 0;
    for (const c of this.store.liveCallsOnMarket(marketId)) {
      if (c.side === "YES") yesCalls++;
      else noCalls++;
    }
    return { marketId, yesCalls, noCalls };
  }

  /** public -> anyone. followers -> the author or a follower. hidden -> the author. */
  canSee(call: CallRecord, viewerUserId: string | null): boolean {
    if (call.userId === viewerUserId) return true;
    if (call.hiddenAt !== null) return false;
    if (call.visibility === "public") return true;
    if (!viewerUserId) return false;
    return this.store.isFollowing(viewerUserId, call.userId);
  }

  private requireVisibleCall(callId: string, viewerUserId: string | null): CallRecord {
    const call = this.store.getCall(callId);
    if (!call) throw new CallsError("CALL_NOT_FOUND", "We couldn't find that call.");
    if (!this.canSee(call, viewerUserId)) {
      // Deliberately the same message for "hidden" and "followers-only": a
      // distinguishable refusal would confirm the row exists and who made it.
      throw new CallsError("CALL_NOT_VISIBLE", "We couldn't find that call.", { details: { callId } });
    }
    return call;
  }

  private requireMarket(marketId: string): VenueMarket {
    const market = this.markets.getMarket(marketId);
    if (!market) {
      throw new CallsError("CALL_MARKET_UNKNOWN", "We couldn't find that market.", { details: { marketId } });
    }
    return market;
  }

  private resolvePerson(ref: string): Person {
    const person = this.store.getPerson(ref) ?? this.store.getPersonByHandle(ref);
    if (!person) throw new CallsError("PERSON_NOT_FOUND", "We couldn't find that person.", { details: { ref } });
    return person;
  }

  /** Accuracy is recomputed from call_results — which survive a hidden call, so
   *  a person's record cannot be laundered by withdrawing the losses (§3). */
  private decorate(person: Person): Person {
    const results = this.store
      .callsByAuthor(person.id)
      .map((c) => this.store.getResult(c.id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    return { ...person, ...accuracyOf(results) };
  }

  private entryOf(call: CallRecord, viewerUserId: string | null): CallFeedEntry {
    const responses = this.store.responsesForTarget(call.id);
    const author =
      this.store.getPerson(call.userId) ??
      ({
        id: call.userId,
        handle: call.userId,
        displayName: call.userId,
        avatarUrl: null,
        walletAddress: null,
        settledCalls: 0,
        correctCalls: 0,
      } satisfies Person);

    return {
      call: toCall(call),
      author: this.decorate(author),
      market: this.markets.getMarket(call.marketId) ?? unknownMarket(call.marketId),
      result: this.store.getResult(call.id) ?? null,
      backCount: responses.filter((r) => r.kind === "back").length,
      fadeCount: responses.filter((r) => r.kind === "fade").length,
      viewerHasCalled: viewerUserId
        ? this.store.liveCallByUserOnMarket(viewerUserId, call.marketId) !== undefined
        : false,
      // Present only on a call backed by a confirmed fill; a free call's
      // entry keeps its exact shape.
      ...funded(this.funding?.fundingOf(call.id) ?? null),
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const opposite = (s: Side): Side => (s === "YES" ? "NO" : "YES");

const funded = (funding: CallFunding | null): { funding?: CallFunding } => (funding ? { funding } : {});

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.trunc(n)));

const newestFirst = (a: CallRecord, b: CallRecord): number =>
  b.lockedAt - a.lockedAt || b.id.localeCompare(a.id);

const trimOrNull = (s: string | null | undefined, max: number): string | null => {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  if (!t) return null;
  if (t.length > max) throw new CallsError("CALL_INVALID", `Keep that to ${max} characters.`);
  return t;
};

/**
 * A deterministic snapshot id, derived the same way the SQL side identifies a
 * snapshot row (`UNIQUE (market_id, observed_at, source)`). Server-derived, so
 * the client's own `snapshotId` is never trusted — it cannot name a price that
 * was never published.
 */
export const snapshotIdOf = (marketId: string, observedAt: number, source: string): string =>
  `snap:${marketId}:${observedAt}:${source}`;

const encodeCursor = (c: CallRecord): string =>
  Buffer.from(`${c.lockedAt}:${c.id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string | null): { lockedAt: number; id: string } | null => {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const at = raw.indexOf(":");
    if (at <= 0) return null;
    const lockedAt = Number(raw.slice(0, at));
    if (!Number.isFinite(lockedAt)) return null;
    return { lockedAt, id: raw.slice(at + 1) };
  } catch {
    return null;
  }
};

/** Copy a person reads. Never the raw MarketStatus code. */
const humanStatus = (s: VenueMarket["status"]): string =>
  s === "CLOSED_PENDING_RESOLUTION"
    ? "closed and awaiting its result"
    : s === "RESOLVED"
      ? "already resolved"
      : s === "CANCELLED"
        ? "cancelled by the venue"
        : s === "PAUSED"
          ? "paused by the venue"
          : "open";

/**
 * A placeholder for a market the BFF no longer holds. Never presents as live:
 * status is PAUSED and the question says what happened, so a stale feed row
 * degrades honestly instead of rendering an empty card.
 */
function unknownMarket(marketId: string): VenueMarket {
  return {
    id: marketId,
    venue: "fixture",
    venueEventId: "",
    venueMarketId: "",
    question: "This market is no longer available.",
    rulesText: "",
    category: "",
    outcomes: [
      { side: "YES", label: "Yes" },
      { side: "NO", label: "No" },
    ],
    status: "PAUSED",
    rawStatus: "unavailable",
    opensAt: null,
    closesAt: null,
    resolvesAt: null,
    resolutionSource: null,
    lastSyncedAt: 0,
    payloadVersion: 0,
  };
}
