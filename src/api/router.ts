/**
 * The API surface — typed RPC, not REST. Commands are mutations, reads are
 * queries, and the live views (a match's Pot, your Dossier, your settlement feed)
 * are subscriptions pushed over WebSocket. The exported AppRouter type is the
 * contract the frontend imports — no codegen, no drift.
 */

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { StoredEvent } from "../domain/events.ts";
import {
  asBucket,
  asChallengeId,
  asMarketId,
  asMatchId,
  asWallet,
  challengeStream,
  playerStream,
  type MatchId,
} from "../domain/ids.ts";
import type { DossierView } from "../core/projections/DossierProjection.ts";
import { DomainError } from "../domain/errors.ts";
import { streamEvents } from "./eventStream.ts";
import { authedProcedure, guard, publicProcedure, router } from "./trpc.ts";
import { verifyCallProof, verifyGenericAction, verifySocialAction } from "../auth/WalletSignature.ts";

const TRIGGER = z.enum(["BIG_RESULT", "PROMOTION", "DEMOTION", "ON_DEMAND", "SEASON_REVIEW"]);
const SIDE = z.enum(["HOME", "DRAW", "AWAY"]);
const amount = z.bigint().positive();
const baseUnits = z.string().regex(/^[0-9]+$/);

/** Constant-time string compare (avoids leaking the admin key via timing). */
const timingSafeEqualStr = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

const matchIdOf = (e: StoredEvent): string | undefined => {
  const p = e.payload;
  if (p.type === "MatchOpened") return p.fixture.matchId;
  if ("matchId" in p) return p.matchId;
  return undefined;
};

/** Public Dossier: the memory in action, minus the private money columns. */
function toPublic(d: DossierView) {
  const { balance: _b, locked: _l, bonus: _bonus, claimedGrant: _c, openCalls: _o, ...rest } = d;
  return rest;
}

export const appRouter = router({
  // ── health / meta ────────────────────────────────────────────────────────
  health: publicProcedure.query(({ ctx }) => ({
    ok: true,
    wiring: ctx.app.wiring,
    readiness: {
      eventLogPersistent: ctx.app.wiring.eventStore === "sqlite",
      socialStore: ctx.app.social.enabled,
      socialNetwork: ctx.app.config.social?.network ?? null,
      heliusWebhookAuth: !!ctx.app.config.indexer?.heliusWebhookAuth,
      txlineSettlement: ctx.app.wiring.settlementVerifier === "txline",
    },
    sessionsWallet: ctx.app.engine.custody.sessionsAddress(),
    managersPot: ctx.app.readModel.managersPotTotal(),
    houseRevenue: ctx.app.readModel.houseRevenueTotal(),
    ledgerOnWalrus: ctx.app.ledgerMirror.count, // money events mirrored to Walrus this run
  })),

  // ── reads ──────────────────────────────────────────────────────────────────
  matchday: publicProcedure.query(({ ctx }) => ctx.app.readModel.pots.allMatches()),

  match: publicProcedure
    .input(z.object({ matchId: z.string() }))
    .query(({ ctx, input }) => ctx.app.readModel.pots.getMatch(asMatchId(input.matchId)) ?? null),

  leaderboard: publicProcedure
    .input(z.object({ by: z.enum(["gr", "pnl"]).default("gr"), limit: z.number().min(1).max(200).default(50) }))
    .query(({ ctx, input }) =>
      input.by === "pnl"
        ? ctx.app.readModel.leaderboardByPnl(input.limit)
        : ctx.app.readModel.leaderboardByGr(input.limit),
    ),

  managersPot: publicProcedure.query(({ ctx }) => ctx.app.readModel.managersPotTotal()),

  socialStatus: publicProcedure.query(({ ctx }) => ({
    enabled: ctx.app.social.enabled,
    wiring: ctx.app.wiring.social ?? "none",
    network: ctx.app.config.social?.network ?? null,
    heliusWebhookAuth: !!ctx.app.config.indexer?.heliusWebhookAuth,
  })),

  dossier: publicProcedure
    .input(z.object({ wallet: z.string() }))
    .query(({ ctx, input }) => {
      const d = ctx.app.readModel.getDossier(asWallet(input.wallet));
      return d ? toPublic(d) : null;
    }),

  me: authedProcedure.query(({ ctx }) => ctx.app.readModel.getDossier(ctx.wallet) ?? null),

  /** Public challenge view — the payload the shareable accept link renders. */
  challenge: publicProcedure
    .input(z.object({ challengeId: z.string() }))
    .query(({ ctx, input }) => {
      const ch = ctx.app.readModel.getChallenge(asChallengeId(input.challengeId));
      if (!ch) return null;
      return { ...ch, fixture: ctx.app.readModel.pots.getMatch(ch.matchId)?.fixture ?? null };
    }),

  myChallenges: authedProcedure.query(({ ctx }) => ctx.app.readModel.myChallenges(ctx.wallet)),

  settledCalls: authedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }).optional())
    .query(({ ctx, input }) => ctx.app.readModel.settledCalls(ctx.wallet, input?.limit ?? 50)),

  chatHistory: authedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }).optional())
    .query(({ ctx, input }) => ctx.app.readModel.chatHistory(ctx.wallet, input?.limit ?? 50)),

  touchline: authedProcedure.query(({ ctx }) => {
    const dossier = ctx.app.readModel.getDossier(ctx.wallet) ?? null;
    return {
      dossier,
      openFixtures: ctx.app.readModel.pots.openFixtures(),
      openCalls: dossier?.openCalls ?? [],
      managersPot: ctx.app.readModel.managersPotTotal(),
      leaderboardTop: ctx.app.readModel.leaderboardByGr(5),
    };
  }),

  preBetRead: authedProcedure
    .input(z.object({ matchId: z.string(), marketId: z.string(), bucket: z.string(), stake: z.bigint() }))
    .query(({ ctx, input }) =>
      guard(() =>
        ctx.app.engine.preBetRead(ctx.wallet, {
          matchId: asMatchId(input.matchId),
          marketId: asMarketId(input.marketId),
          bucket: input.bucket,
          stake: input.stake,
        }),
      ),
    ),

  myPositions: publicProcedure
    .input(z.object({ wallet: z.string(), limit: z.number().min(1).max(200).default(50) }))
    .query(({ ctx, input }) => ctx.app.social.myPositions(input.wallet, input.limit)),

  /** Settled positions with funds still to pull — powers the "claim your winnings" surface. */
  claimable: publicProcedure
    .input(z.object({ wallet: z.string(), limit: z.number().min(1).max(200).default(50) }))
    .query(({ ctx, input }) => ctx.app.social.claimable(input.wallet, input.limit)),

  activity: publicProcedure
    .input(
      z.object({
        matchId: z.string().optional(),
        wallet: z.string().optional(),
        limit: z.number().min(1).max(200).default(50),
      }),
    )
    .query(({ ctx, input }) => ctx.app.social.activity(input)),

  // ── social graph (FOMO) ────────────────────────────────────────────────────
  /** The following feed: what the wallets you follow (+ friends) are calling. */
  followingFeed: publicProcedure
    .input(z.object({ wallet: z.string(), limit: z.number().min(1).max(200).default(50) }))
    .query(({ ctx, input }) => ctx.app.social.followingFeed(input.wallet, input.limit)),

  followCounts: publicProcedure
    .input(z.object({ wallet: z.string() }))
    .query(({ ctx, input }) => ctx.app.social.followCounts(input.wallet)),

  isFollowing: publicProcedure
    .input(z.object({ viewer: z.string(), target: z.string() }))
    .query(({ ctx, input }) => ctx.app.social.isFollowing(input.viewer, input.target)),

  /** Who called what on a fixture — the match callers board. */
  matchCallers: publicProcedure
    .input(z.object({ matchId: z.string(), limit: z.number().min(1).max(500).default(100) }))
    .query(({ ctx, input }) => ctx.app.social.matchCallers(input.matchId, input.limit)),

  /** Record/PnL leaderboard from settled stats. */
  socialLeaderboard: publicProcedure
    .input(z.object({ by: z.enum(["pnl", "streak", "winrate"]).default("pnl"), limit: z.number().min(1).max(200).default(50) }))
    .query(({ ctx, input }) => ctx.app.social.socialLeaderboard(input.by, input.limit)),

  /** Composite public profile: stats + follow counts + recent positions + activity. */
  profile: publicProcedure
    .input(z.object({ wallet: z.string(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      const [stats, counts, positions, recent] = await Promise.all([
        ctx.app.social.userStats(input.wallet),
        ctx.app.social.followCounts(input.wallet),
        ctx.app.social.myPositions(input.wallet, input.limit),
        ctx.app.social.activity({ wallet: input.wallet, limit: input.limit }),
      ]);
      return { wallet: input.wallet, stats, counts, positions, activity: recent };
    }),

  /**
   * Follow / unfollow — authenticated by a WALLET SIGNATURE over a canonical,
   * timestamped message (proves the caller controls the follower wallet), so no
   * one can spam the graph on someone else's behalf. No session server needed.
   */
  follow: publicProcedure
    .input(z.object({ wallet: z.string(), target: z.string(), timestamp: z.number(), signature: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const check = verifySocialAction(
        { wallet: input.wallet, action: "follow", target: input.target, timestamp: input.timestamp, signature: input.signature },
        Date.now(),
        ctx.app.config.social?.network ?? "devnet",
      );
      if (!check.ok) throw new DomainError("INVALID", `follow rejected: ${check.reason}`);
      return ctx.app.social.follow(input.wallet, input.target);
    }),

  unfollow: publicProcedure
    .input(z.object({ wallet: z.string(), target: z.string(), timestamp: z.number(), signature: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const check = verifySocialAction(
        { wallet: input.wallet, action: "unfollow", target: input.target, timestamp: input.timestamp, signature: input.signature },
        Date.now(),
        ctx.app.config.social?.network ?? "devnet",
      );
      if (!check.ok) throw new DomainError("INVALID", `unfollow rejected: ${check.reason}`);
      return ctx.app.social.unfollow(input.wallet, input.target);
    }),

  // ── notifications ───────────────────────────────────────────────────────────
  /** A wallet's notifications (FOLLOWED_CALL, CLAIM_AVAILABLE, …), newest first. */
  notifications: publicProcedure
    .input(z.object({ wallet: z.string(), limit: z.number().min(1).max(200).default(50), unreadOnly: z.boolean().default(false) }))
    .query(({ ctx, input }) => ctx.app.social.notifications(input.wallet, input.limit, input.unreadOnly)),

  unreadCount: publicProcedure
    .input(z.object({ wallet: z.string() }))
    .query(({ ctx, input }) => ctx.app.social.unreadCount(input.wallet)),

  /** Mark notifications read — wallet-signature authed (only you mark your own). */
  markNotificationsRead: publicProcedure
    .input(z.object({ wallet: z.string(), ids: z.array(z.string()).optional(), timestamp: z.number(), signature: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const check = verifyGenericAction(
        { wallet: input.wallet, action: "read_notifications", timestamp: input.timestamp, signature: input.signature },
        Date.now(),
        ctx.app.config.social?.network ?? "devnet",
      );
      if (!check.ok) throw new DomainError("INVALID", `mark-read rejected: ${check.reason}`);
      return ctx.app.social.markNotificationsRead(input.wallet, input.ids);
    }),

  // ── identity linking (Google / X) ───────────────────────────────────────────
  /**
   * Link a Google/X identity to a wallet. Doubly authenticated: `accessToken` is
   * the Supabase Auth session from the OAuth sign-in (verified against GoTrue, so
   * we trust the provider identity), and the wallet SIGNATURE proves wallet
   * ownership — so no one can attach someone else's social account to a wallet,
   * or a wallet they don't own to a social account.
   */
  linkIdentity: publicProcedure
    .input(z.object({ wallet: z.string(), accessToken: z.string().min(10), timestamp: z.number(), signature: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const check = verifyGenericAction(
        { wallet: input.wallet, action: "link_identity", timestamp: input.timestamp, signature: input.signature },
        Date.now(),
        ctx.app.config.social?.network ?? "devnet",
      );
      if (!check.ok) throw new DomainError("INVALID", `link rejected: ${check.reason}`);
      const identity = await ctx.app.social.verifyOAuthUser(input.accessToken);
      if (!identity) throw new DomainError("INVALID", "could not verify the OAuth session");
      return ctx.app.social.linkIdentity(input.wallet, identity);
    }),

  /**
   * Web-only counterpart to linkIdentity: links ALL of the caller's already-
   * linked Privy X/Google identities to their wallet in one call. No separate
   * wallet-sig proof needed — unlike mobile's Supabase-Auth-based flow, the
   * Bearer token itself already IS Privy's proof of both the social identity
   * and wallet ownership (authedProcedure resolves ctx.wallet from the exact
   * same verified token). Fire-and-forget right after login; safe to call
   * repeatedly (link_identity is idempotent per provider+subject).
   */
  linkIdentityFromPrivy: authedProcedure.mutation(async ({ ctx }) => {
    if (!ctx.privyUserId) throw new DomainError("INVALID", "no Privy session on this request");
    const identities = await ctx.app.auth.fetchLinkedIdentities(ctx.privyUserId);
    const linked: string[] = [];
    for (const identity of identities) {
      await ctx.app.social.linkIdentity(ctx.wallet, identity);
      linked.push(identity.provider);
    }
    return { linked };
  }),

  /** Batch resolve wallets -> display (handle/name/avatar) for feed rendering. */
  walletProfiles: publicProcedure
    .input(z.object({ wallets: z.array(z.string()).min(1).max(200) }))
    .query(({ ctx, input }) => ctx.app.social.walletProfiles(input.wallets)),

  /**
   * Add a pending "follow this X handle once they join" target — Venmo's
   * "send to a number that isn't registered yet" pattern applied to the social
   * graph. Wallet-signature authed, same posture as follow/unfollow: proves
   * the caller controls the wallet before recording the intent. Resolves
   * immediately if the handle already belongs to a joined user.
   */
  createPendingTarget: publicProcedure
    .input(
      z.object({
        wallet: z.string(),
        // trim() + min(1) so a client bypassing normalizeHandle() (or a raw
        // API call) can't create a permanently-unresolvable empty/blank-handle
        // pending target — the resolution hook can never match against "".
        // max(15) + the charset regex mirror X's own username rules (letters,
        // digits, underscores, ≤15 chars) — bounding + validating here rejects
        // obvious garbage (multi-KB strings, "my friend bob") before it becomes
        // a pending_identity_targets row that can never match a real
        // OAuth-linked screen name.
        providerUsername: z
          .string()
          .trim()
          .min(1, "handle is required")
          .max(15, "X handles are at most 15 characters")
          .regex(/^\w+$/, "handle can only contain letters, numbers, and underscores"),
        provider: z.literal("twitter").default("twitter"),
        timestamp: z.number(),
        signature: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const check = verifySocialAction(
        {
          wallet: input.wallet,
          action: "add_pending_target",
          target: input.providerUsername,
          timestamp: input.timestamp,
          signature: input.signature,
        },
        Date.now(),
        ctx.app.config.social?.network ?? "devnet",
      );
      if (!check.ok) throw new DomainError("INVALID", `add-target rejected: ${check.reason}`);
      return ctx.app.social.createPendingTarget(input.wallet, input.provider, input.providerUsername);
    }),

  /** A wallet's pending + resolved identity targets, newest first. */
  pendingTargets: publicProcedure
    .input(z.object({ wallet: z.string(), limit: z.number().min(1).max(200).default(50) }))
    .query(({ ctx, input }) => ctx.app.social.pendingTargets(input.wallet, input.limit)),

  // ── commands ─────────────────────────────────────────────────────────────
  signContract: authedProcedure
    .input(z.object({ handle: z.string().max(40).optional() }))
    .mutation(({ ctx, input }) =>
      guard(() => ctx.app.engine.signContract(ctx.wallet, input.handle)),
    ),

  deposit: authedProcedure
    .input(z.object({ amount, proof: z.string().optional() }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.deposit(ctx.wallet, input.amount, input.proof))),

  /** The player's deposit address (their own Privy Solana wallet) — send USDC here. */
  depositAddress: authedProcedure.query(({ ctx }) => ({
    address: ctx.wallet,
    available: !!ctx.privyWalletId, // custodial sweep wired for this player
  })),

  /** Sweep + credit any USDC that has arrived at the deposit address. Idempotent. */
  syncDeposit: authedProcedure.mutation(({ ctx }) =>
    guard(() =>
      ctx.app.engine.syncDeposits(ctx.wallet, {
        address: ctx.wallet,
        ...(ctx.privyWalletId ? { walletId: ctx.privyWalletId } : {}),
      }),
    ),
  ),

  claimWelcomeGrant: authedProcedure.mutation(({ ctx }) =>
    guard(() => ctx.app.engine.claimWelcomeGrant(ctx.wallet)),
  ),

  withdraw: authedProcedure
    .input(z.object({ amount }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.withdraw(ctx.wallet, input.amount))),

  makeCall: authedProcedure
    .input(
      z.object({
        matchId: z.string(),
        marketId: z.string().default("RESULT"),
        bucket: z.string(),
        stake: amount,
        note: z.string().max(280).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(() =>
        ctx.app.engine.makeCall(ctx.wallet, {
          matchId: asMatchId(input.matchId),
          marketId: asMarketId(input.marketId),
          bucket: input.bucket,
          stake: input.stake,
          ...(input.note ? { note: input.note } : {}),
        }),
      ),
    ),

  createChallenge: authedProcedure
    .input(
      z.object({
        matchId: z.string(),
        side: SIDE,
        stake: amount,
        opponentSide: SIDE.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(() =>
        ctx.app.engine.createChallenge(ctx.wallet, {
          matchId: asMatchId(input.matchId),
          side: asBucket(input.side),
          stake: input.stake,
          ...(input.opponentSide ? { opponentSide: asBucket(input.opponentSide) } : {}),
        }),
      ),
    ),

  acceptChallenge: authedProcedure
    .input(z.object({ challengeId: z.string() }))
    .mutation(({ ctx, input }) =>
      guard(() => ctx.app.engine.acceptChallenge(ctx.wallet, asChallengeId(input.challengeId))),
    ),

  cancelChallenge: authedProcedure
    .input(z.object({ challengeId: z.string() }))
    .mutation(({ ctx, input }) =>
      guard(() => ctx.app.engine.cancelChallenge(ctx.wallet, asChallengeId(input.challengeId))),
    ),

  declareHotTake: authedProcedure
    .input(z.object({ text: z.string().min(1).max(280) }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.declareHotTake(ctx.wallet, input.text))),

  requestVerdict: authedProcedure
    .input(z.object({ trigger: TRIGGER.default("ON_DEMAND") }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.requestVerdict(ctx.wallet, input.trigger))),

  chat: authedProcedure
    .input(z.object({ message: z.string().min(1).max(500) }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.chat(ctx.wallet, input.message))),

  /**
   * Mobile MWA flow: the wallet signs/sends directly to chumbucket_arena, then
   * the app submits the tx signature here so the social read model can show the
   * call immediately. The indexer/reconciler later upgrades the record with slot
   * and parsed account data; the unique signature makes retries harmless.
   */
  recordPredictionCall: publicProcedure
    .input(
      z.object({
        wallet: z.string(),
        matchId: z.string(),
        marketId: z.string().default("RESULT"),
        bucket: SIDE,
        stakeBaseUnits: baseUnits,
        txSignature: z.string().min(32),
        positionAddress: z.string().optional(),
        slot: z.number().int().nonnegative().optional(),
        metadata: z.record(z.unknown()).optional(),
        // Wallet-signature proof so this optimistic mirror can't attribute a
        // call to a wallet the caller doesn't own (the reconciler remains the
        // chain-authoritative source; this is only for instant UI feedback).
        timestamp: z.number(),
        signature: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const check = verifyCallProof(
        {
          wallet: input.wallet,
          matchId: input.matchId,
          bucket: input.bucket,
          stake: input.stakeBaseUnits,
          txSignature: input.txSignature,
          timestamp: input.timestamp,
          signature: input.signature,
        },
        Date.now(),
        ctx.app.config.social?.network ?? "devnet",
      );
      if (!check.ok) throw new DomainError("INVALID", `call rejected: ${check.reason}`);
      const { timestamp: _t, signature: _s, ...call } = input;
      return ctx.app.social.recordPredictionCall(call);
    }),

  // ── demo / ops ─────────────────────────────────────────────────────────────
  // Resolve a match on command so settlement can be shown live without waiting
  // for the real final whistle. Gated by DEMO_ADMIN_KEY; disabled if it's unset.
  resolveMatchNow: publicProcedure
    .input(
      z.object({
        matchId: z.string(),
        home: z.number().int().min(0).max(99),
        away: z.number().int().min(0).max(99),
        key: z.string(),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(async () => {
        // Never let a demo force-resolve move REAL funds. With real custody,
        // settlement must come from an on-chain validate_stat proof, not here.
        if (ctx.app.wiring.custody === "solana" || ctx.app.wiring.custody === "privy") {
          throw new DomainError("INVALID", "demo resolution is disabled under real custody");
        }
        const expected = ctx.app.config.demoAdminKey;
        if (!expected || !timingSafeEqualStr(input.key, expected)) {
          throw new DomainError("INVALID", "not authorized to resolve matches");
        }
        const mid = asMatchId(input.matchId);
        // Seed a counterparty first (no-op if already seeded or locked), so even a
        // solo bet placed before house liquidity existed settles for real, not void.
        await ctx.app.engine.house.ensureSeeded(mid);
        await ctx.app.engine.resolveMatch(mid, { home: input.home, away: input.away }, "demo");
        return { ok: true, matchId: input.matchId, score: { home: input.home, away: input.away } };
      }),
    ),

  // Run one reconciler pass on command (walk chain history -> repair the social
  // read model: confirm/create positions, settle pots, mark claims). Gated by
  // DEMO_ADMIN_KEY so the settlement/claim story can be shown live in the demo.
  reconcile: publicProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const expected = ctx.app.config.demoAdminKey;
      if (!expected || !timingSafeEqualStr(input.key, expected)) {
        throw new DomainError("INVALID", "not authorized to run the reconciler");
      }
      if (!ctx.app.reconciler) return { ok: false as const, reason: "reconciler not configured" };
      const summary = await ctx.app.reconciler.reconcile();
      return { ok: true as const, summary };
    }),

  // ── live subscriptions (pushed over WS) ────────────────────────────────────
  onMatch: publicProcedure
    .input(z.object({ matchId: z.string() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const id = asMatchId(input.matchId);
      yield ctx.app.readModel.pots.getMatch(id) ?? null;
      for await (const e of streamEvents(ctx.app.store, signal, (ev) => matchIdOf(ev) === id)) {
        void e;
        yield ctx.app.readModel.pots.getMatch(id) ?? null;
      }
    }),

  onChallenge: publicProcedure
    .input(z.object({ challengeId: z.string() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const id = asChallengeId(input.challengeId);
      const stream = challengeStream(id);
      yield ctx.app.readModel.getChallenge(id) ?? null;
      for await (const e of streamEvents(ctx.app.store, signal, (ev) => ev.meta.streamId === stream)) {
        void e;
        yield ctx.app.readModel.getChallenge(id) ?? null;
      }
    }),

  onDossier: authedProcedure.subscription(async function* ({ ctx, signal }) {
    const stream = playerStream(ctx.wallet);
    yield ctx.app.readModel.getDossier(ctx.wallet) ?? null;
    for await (const e of streamEvents(ctx.app.store, signal, (ev) => ev.meta.streamId === stream)) {
      void e;
      yield ctx.app.readModel.getDossier(ctx.wallet) ?? null;
    }
  }),

  onFeed: authedProcedure.subscription(async function* ({ ctx, signal }) {
    const stream = playerStream(ctx.wallet);
    const watched = new Set(["CallSettled", "CallVoided", "TierChanged", "VerdictIssued"]);
    for await (const e of streamEvents(
      ctx.app.store,
      signal,
      (ev) => ev.meta.streamId === stream && watched.has(ev.payload.type),
    )) {
      yield { type: e.payload.type, at: e.meta.at, payload: e.payload };
    }
  }),
});

export type AppRouter = typeof appRouter;
