/**
 * Venue-backed free-call RECEIPTS — the generalisation of the arena's
 * `CallMade` / `CallSettled` event shapes and of `SettledCallsProjection`.
 *
 * WHAT A RECEIPT IS
 *
 * The artefact the whole free loop exists to produce: proof that a named person
 * said a specific thing, at a specific moment, before the answer was known. It
 * carries exactly five things — when, which side, at what probability, what the
 * venue then published, and which market — and nothing else.
 *
 * WHAT THE GENERALISATION ACTUALLY IS
 *
 *   arena `CallMade`     -> matchId + marketId + bucket + STAKE (Frost) + impliedProbAtCall
 *   arena `CallSettled`  -> result WON|LOST + stake + payout + pnlDelta + grDelta
 *   arena `CallVoided`   -> refund
 *
 *   venue receipt        -> marketId + venue provenance + side + entryProbability
 *                           + CallOutcome (PENDING|CORRECT|INCORRECT|VOID)
 *                           + the market_resolutions row it was derived from
 *                           + NO MONEY, AT ALL
 *
 * Three things changed and each is deliberate:
 *   1. the money legs are DROPPED. A free call has no stake, so a receipt built
 *      from one cannot have a payout. `assertMoneyFree` is run over every
 *      receipt before it is stored, so even a legacy arena event that DOES
 *      carry a stake cannot leak one into a receipt.
 *   2. `WON | LOST` becomes the §3 `CallOutcome`, which has a fourth value the
 *      arena pair could not express at all: VOID is neither a win nor a loss.
 *   3. provenance is added: which venue, which venue market, which
 *      `market_resolutions` row. §0.2 — the venue is the only source of a
 *      result — is only checkable if the receipt says which evidence it came
 *      from. `origin` names whether a receipt is venue-backed or arena-era, so
 *      an arena receipt can never present as venue evidence.
 *
 * WHY THIS IS NOT A PROJECTION IN `ReadModel`
 *
 * §6: `ReadModel.ts:36-42` is a hardcoded projection array and is "friction,
 * not a seam"; a packet must not edit it. §1: `EventStore.subscribe()` returns
 * an unsubscribe thunk and is NOT exclusive. So this read side tails the live
 * log independently — `attach(store)` returns the unsubscribe thunk — and the
 * receipt event types are declared HERE, inside `src/calls/**`, rather than
 * added to the integration-owned `DomainEvent` union.
 */

import type { EventStore } from "../core/eventstore/EventStore.ts";
import type { StoredEvent } from "../domain/events.ts";
import type { Wallet } from "../domain/ids.ts";
import type { CallOutcome, Resolution, Side, VenueId, VenueMarket } from "../prediction/types.ts";
import { assertMoneyFree, type Call, type CallResult } from "./types.ts";

/** Where a receipt came from. An arena-era receipt is not venue evidence. */
export type ReceiptOrigin = "venue" | "arena";

/** The provenance half of a receipt. Null throughout for an arena-era row. */
export interface ReceiptMarketRef {
  marketId: string;
  venue: VenueId | null;
  venueMarketId: string | null;
  question: string | null;
  resolutionSource: string | null;
  /** true only for the fixture catalog — a demo receipt can never read as live. */
  demo: boolean;
}

/**
 * "A person went on record." The generalisation of arena `CallMade`, with the
 * stake removed and venue provenance added.
 */
export interface CallReceiptMade {
  type: "CallMade";
  origin: ReceiptOrigin;
  callId: string;
  /** canonical public.users.id — never a wallet (§0.3) */
  userId: string;
  market: ReceiptMarketRef;
  side: Side;
  /** The crowd-implied probability at the moment of the call. */
  entryProbability: number | null;
  thesis: string | null;
  lockedAt: number;
  /** 'NONE' for a free call. A receipt is never issued for money. */
  fundingState: "NONE";
}

/**
 * "The venue published, and here is what that made of the call." The
 * generalisation of arena `CallSettled` + `CallVoided` into one shape, because
 * §3 already has one type that covers both: `CallOutcome`.
 */
export interface CallReceiptSettled {
  type: "CallSettled";
  origin: ReceiptOrigin;
  callId: string;
  userId: string;
  market: ReceiptMarketRef;
  side: Side;
  entryProbability: number | null;
  outcome: CallOutcome;
  resolution: Resolution | null;
  resolvedAt: number | null;
  /** The venue evidence this was derived from. Null for an arena-era receipt. */
  marketResolutionId: string | null;
  lockedAt: number;
  settledAt: number;
}

export type CallReceiptEvent = CallReceiptMade | CallReceiptSettled;

/** One person's receipt for one call: what they said, and what became of it. */
export interface CallReceiptView {
  callId: string;
  userId: string;
  origin: ReceiptOrigin;
  market: ReceiptMarketRef;
  side: Side;
  entryProbability: number | null;
  thesis: string | null;
  lockedAt: number;
  outcome: CallOutcome;
  resolution: Resolution | null;
  resolvedAt: number | null;
  marketResolutionId: string | null;
  settledAt: number | null;
  /** A receipt is only shareable once the venue has actually settled it. */
  shareable: boolean;
}

/** Resolve a wallet to its canonical user id, or undefined. Never mints (§8.2). */
export type WalletToUserId = (wallet: string) => string | undefined;

/**
 * The receipts read side.
 *
 * It has the same `{ name, apply(event) }` shape as `Projection` on purpose —
 * so it COULD be registered if `ReadModel` ever becomes a seam — but it is
 * never added to that array, and it does not import `Projection`, so it cannot
 * create a compile-time dependency on an integration-owned file.
 */
export class CallReceiptsProjection {
  readonly name = "callReceipts";

  private readonly byUser = new Map<string, CallReceiptView[]>();
  private readonly byCall = new Map<string, CallReceiptView>();
  /** Arena CallMade seen but not yet settled — the SettledCallsProjection idea. */
  private readonly openArena = new Map<string, { userId: string; marketId: string; side: Side; entryProbability: number | null; lockedAt: number }>();
  private readonly walletToUserId: WalletToUserId;

  constructor(opts: { walletToUserId?: WalletToUserId } = {}) {
    this.walletToUserId = opts.walletToUserId ?? (() => undefined);
  }

  // ── the venue-backed path: fed directly by CallsService ───────────────────

  /** Record "a person went on record", from a locked free call. */
  recordMade(call: Call, market: VenueMarket | undefined): CallReceiptMade {
    const event: CallReceiptMade = {
      type: "CallMade",
      origin: "venue",
      callId: call.id,
      userId: call.userId,
      market: marketRef(call.marketId, market),
      side: call.side,
      entryProbability: call.entryProbability,
      thesis: call.thesis,
      lockedAt: call.lockedAt,
      fundingState: "NONE",
    };
    this.ingest(event);
    return event;
  }

  /** Record what the venue made of it. Derived, never asserted. */
  recordSettled(call: Call, result: CallResult, market: VenueMarket | undefined, at: number): CallReceiptSettled {
    const event: CallReceiptSettled = {
      type: "CallSettled",
      origin: "venue",
      callId: call.id,
      userId: call.userId,
      market: marketRef(call.marketId, market),
      side: call.side,
      entryProbability: call.entryProbability,
      outcome: result.outcome,
      resolution: result.resolution,
      resolvedAt: result.resolvedAt,
      marketResolutionId: result.marketResolutionId,
      lockedAt: call.lockedAt,
      settledAt: at,
    };
    this.ingest(event);
    return event;
  }

  // ── the arena path: tail the live log, independently of ReadModel ─────────

  /**
   * Subscribe to the event log and generalise the arena's own call events into
   * receipts. Returns the unsubscribe thunk `EventStore.subscribe()` gives us
   * (§1: it is not exclusive, so this costs no existing subscriber anything).
   */
  attach(store: EventStore): () => void {
    return store.subscribe((event) => {
      this.apply(event);
    });
  }

  /** Fold one arena event. Unknown events are ignored, exactly like every
   *  existing projection's `default: return`. */
  apply(event: StoredEvent): void {
    const p = event.payload;
    switch (p.type) {
      case "CallMade": {
        const userId = this.userIdFor(event.meta.streamId);
        if (!userId) return; // never invent an identity for an unmapped wallet
        const side = asSide(p.bucket);
        if (!side) return; // an arena bucket outside YES/NO is not a call receipt
        this.openArena.set(p.callId, {
          userId,
          marketId: p.marketId,
          side,
          entryProbability: p.impliedProbAtCall,
          lockedAt: event.meta.at,
        });
        this.ingest({
          type: "CallMade",
          origin: "arena",
          callId: p.callId,
          userId,
          market: marketRef(p.marketId, undefined),
          side,
          entryProbability: p.impliedProbAtCall,
          thesis: p.note ?? null,
          lockedAt: event.meta.at,
          fundingState: "NONE", // the stake on the arena event is DROPPED here
        });
        return;
      }
      case "CallSettled": {
        const open = this.openArena.get(p.callId);
        if (!open) return;
        this.ingest({
          type: "CallSettled",
          origin: "arena",
          callId: p.callId,
          userId: open.userId,
          market: marketRef(open.marketId, undefined),
          side: open.side,
          entryProbability: open.entryProbability,
          // WON|LOST generalises to the §3 CallOutcome.
          outcome: p.result === "WON" ? "CORRECT" : "INCORRECT",
          // An arena settlement is not venue evidence, so it cites none.
          resolution: null,
          resolvedAt: event.meta.at,
          marketResolutionId: null,
          lockedAt: open.lockedAt,
          settledAt: event.meta.at,
        });
        this.openArena.delete(p.callId);
        return;
      }
      case "CallVoided": {
        const open = this.openArena.get(p.callId);
        if (!open) return;
        this.ingest({
          type: "CallSettled",
          origin: "arena",
          callId: p.callId,
          userId: open.userId,
          market: marketRef(open.marketId, undefined),
          side: open.side,
          entryProbability: open.entryProbability,
          // The value the arena pair could not express: never a win, never a loss.
          outcome: "VOID",
          resolution: null,
          resolvedAt: event.meta.at,
          marketResolutionId: null,
          lockedAt: open.lockedAt,
          settledAt: event.meta.at,
        });
        this.openArena.delete(p.callId);
        return;
      }
      default:
        return;
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  receiptsFor(userId: string, limit = 50): CallReceiptView[] {
    return (this.byUser.get(userId) ?? []).slice(0, limit);
  }

  receiptForCall(callId: string): CallReceiptView | undefined {
    return this.byCall.get(callId);
  }

  get size(): number {
    return this.byCall.size;
  }

  // ── the one place a receipt is written ───────────────────────────────────

  private ingest(event: CallReceiptEvent): void {
    // A receipt may never carry money, whatever it was generalised FROM. An
    // arena CallMade has a `stake` (Frost) and a CallSettled has a `payout`;
    // this is the guarantee that neither can reach a receipt.
    assertMoneyFree(event, "a call receipt");

    const existing = this.byCall.get(event.callId);
    const view: CallReceiptView =
      event.type === "CallMade"
        ? {
            callId: event.callId,
            userId: event.userId,
            origin: event.origin,
            market: event.market,
            side: event.side,
            entryProbability: event.entryProbability,
            thesis: event.thesis,
            lockedAt: event.lockedAt,
            outcome: "PENDING",
            resolution: null,
            resolvedAt: null,
            marketResolutionId: null,
            settledAt: null,
            shareable: false,
          }
        : {
            callId: event.callId,
            userId: event.userId,
            origin: event.origin,
            market: event.market,
            side: event.side,
            entryProbability: event.entryProbability,
            thesis: existing?.thesis ?? null,
            lockedAt: event.lockedAt,
            outcome: event.outcome,
            resolution: event.resolution,
            resolvedAt: event.resolvedAt,
            marketResolutionId: event.marketResolutionId,
            settledAt: event.settledAt,
            shareable: event.outcome !== "PENDING",
          };

    this.byCall.set(view.callId, view);
    const list = this.byUser.get(view.userId) ?? [];
    const at = list.findIndex((r) => r.callId === view.callId);
    if (at >= 0) list[at] = view;
    else list.unshift(view); // newest first
    this.byUser.set(view.userId, list);
  }

  private userIdFor(streamId: string): string | undefined {
    const wallet = streamWallet(streamId);
    return wallet ? this.walletToUserId(wallet) : undefined;
  }
}

function marketRef(marketId: string, market: VenueMarket | undefined): ReceiptMarketRef {
  return {
    marketId,
    venue: market?.venue ?? null,
    venueMarketId: market?.venueMarketId ?? null,
    question: market?.question ?? null,
    resolutionSource: market?.resolutionSource ?? null,
    demo: market?.venue === "fixture",
  };
}

/** `Bucket` is an open string brand, so 'YES'/'NO' are already legal (§1). */
const asSide = (bucket: string): Side | null => (bucket === "YES" || bucket === "NO" ? bucket : null);

/** Same stream-id convention `SettledCallsProjection` uses. */
const streamWallet = (streamId: string): Wallet | undefined =>
  streamId.startsWith("gaffer:") && !streamId.startsWith("gaffer:match:")
    ? (streamId.slice("gaffer:".length) as Wallet)
    : undefined;
