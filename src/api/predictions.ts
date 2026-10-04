/**
 * `predictionsRouter` — the isolated tRPC surface for Packet B.
 *
 * Deliberate properties:
 *  - it is ONE new file and touches no integration-owned file. Nesting it is a
 *    single added key in src/api/router.ts (contracts §1/§6), which the
 *    integration owner applies from docs/contracts/integration-requests/packet-b.md.
 *  - it reads config through `ctx.app.config` and builds its store/adapter
 *    behind a module-level memo (contracts §6) — nothing is constructed at
 *    import time, so importing this file costs nothing and starts nothing.
 *  - READS are public and always work. ORDER/CLAIM routes refuse whenever the
 *    server-side `funded_positions` flag is off (contracts §7). The check is
 *    enforced twice — here and inside PredictionService — because a client-side
 *    flag is not a kill switch and one layer is not a kill switch either.
 *  - no TxLINE / API-Football / Arena-pot / keeper / Gaffer dependency appears
 *    anywhere in this module, by design: a venue market has no fixture.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { AppConfig } from "../config.ts";
import { isVenueError, type VenueErrorCode } from "../prediction/errors.ts";
import { describePredictionConfig } from "../prediction/config.ts";
import { CATALOG_SCOPES, CATALOG_SORTS, catalogPage } from "../prediction/catalog.ts";
import { predictionRuntimeFor, type PredictionRuntime } from "../prediction/runtime.ts";
import { MARKET_STATUSES } from "../prediction/types.ts";
import { authedProcedure, guard, publicProcedure, router } from "./trpc.ts";

// ── input schemas ────────────────────────────────────────────────────────────

const SIDE = z.enum(["YES", "NO"]);
const MARKET_STATUS = z.enum(MARKET_STATUSES as unknown as [string, ...string[]]);
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,38})$/, "money must be integer base units as a string");
const probability = z.number().min(0).max(1);

const eventFilters = z.object({
  category: z.string().max(64).optional(),
  status: z.array(MARKET_STATUS).max(MARKET_STATUSES.length).optional(),
  query: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

// ── venue error → transport error ────────────────────────────────────────────

const VENUE_CODE_MAP: Record<VenueErrorCode, TRPCError["code"]> = {
  VENUE_SCHEMA: "INTERNAL_SERVER_ERROR", // loud on purpose: the adapter must be fixed
  VENUE_TIMEOUT: "TIMEOUT",
  VENUE_RATE_LIMITED: "TOO_MANY_REQUESTS",
  VENUE_UNAVAILABLE: "BAD_GATEWAY",
  VENUE_BAD_REQUEST: "BAD_REQUEST",
  VENUE_NOT_FOUND: "NOT_FOUND",
  CIRCUIT_OPEN: "BAD_GATEWAY",
  FUNDED_POSITIONS_DISABLED: "FORBIDDEN",
  IDEMPOTENCY_CONFLICT: "CONFLICT",
  INVALID_TRANSITION: "CONFLICT",
  VENUE_MISCONFIGURED: "INTERNAL_SERVER_ERROR",
  WALLET_NOT_LINKED: "UNPROCESSABLE_CONTENT",
};

/**
 * Run a service call, mapping VenueError to the right transport code. Nested in
 * guard() so a DomainError raised anywhere below still maps the usual way.
 * VenueError messages are redaction-scrubbed at construction, so nothing here
 * can leak the venue API key into a response body.
 */
function call<T>(fn: () => Promise<T> | T): Promise<T> {
  return guard(async () => {
    try {
      return await fn();
    } catch (err) {
      if (isVenueError(err)) {
        throw new TRPCError({ code: VENUE_CODE_MAP[err.code], message: err.message, cause: err });
      }
      throw err;
    }
  });
}

// ── the memo (contracts §6) ──────────────────────────────────────────────────

const runtime = (config: AppConfig): PredictionRuntime => predictionRuntimeFor(config);

/**
 * The server-side kill switch, at the transport edge. The service enforces it
 * too; this layer exists so a route can never be added that forgets.
 */
function requireFundedPositions(rt: PredictionRuntime): void {
  if (rt.config.venue === "panta") {
    // DevAuth can treat an x-wallet string as identity. Never activate that
    // legacy surface for real Panta money, even when the native flag is on.
    throw new TRPCError({ code: "FORBIDDEN", message: "Use the reviewed, wallet-signed Panta trading flow" });
  }
  if (!rt.config.flags.fundedPositions) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "funded positions are disabled on this server (`funded_positions` is off). Market reads and free calls are unaffected.",
    });
  }
}

/** The BFF's key for "who is asking". See the note in the integration request. */
const ownerKeyOf = (wallet: string): string => `wallet:${wallet}`;

export const predictionsRouter = router({
  // ── meta ───────────────────────────────────────────────────────────────────

  /** Which venue is serving, whether it is demo data, and whether funding is on. */
  config: publicProcedure.query(({ ctx }) => {
    const rt = runtime(ctx.app.config);
    return {
      ...describePredictionConfig(rt.config), // reports key PRESENCE, never the key
      capabilities: rt.service.capabilities(),
    };
  }),

  // ── reads: unaffected by the kill switch ──────────────────────────────────

  /** Discovery is independent of price availability and call/trade eligibility.
   * Read the normalized durable mirror, not a fan-out to the venue per phone.
   * The worker refreshes every category; never return another live provider.
   * With no options this is the legacy whole-mirror walk in id order; the app
   * asks for `scope: "open"` sorted by close time (see ../prediction/catalog.ts). */
  catalog: publicProcedure
    .input(z.object({
      cursor: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(100).default(100),
      scope: z.enum(CATALOG_SCOPES).optional(),
      category: z.string().trim().min(1).max(64).optional(),
      query: z.string().max(120).optional(),
      sort: z.enum(CATALOG_SORTS).optional(),
    }).strict().default({}))
    .query(({ ctx, input }) => call(async () => {
      const rt = runtime(ctx.app.config);
      await rt.ready;
      return catalogPage(rt.store.listMarkets(), {
        venue: rt.config.venue, now: rt.clock.now(), limit: input.limit, cursor: input.cursor,
        scope: input.scope, category: input.category, query: input.query, sort: input.sort,
        isResolved: id => rt.store.getResolution(id) !== undefined,
      });
    })),

  listEvents: publicProcedure
    .input(z.object({ filters: eventFilters.optional(), cursor: z.string().max(512).optional() }).optional())
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      const filters = (input?.filters ?? {}) as Parameters<typeof rt.service.listEvents>[0];
      return call(async () => {
        const page = await rt.service.listEvents(filters, input?.cursor);
        return { ...page, venue: rt.config.venue, demo: rt.config.venue === "fixture" };
      });
    }),

  getMarket: publicProcedure
    .input(z.object({ venueMarketId: z.string().min(1).max(256) }))
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(async () => {
        const market = await rt.service.getMarket(input.venueMarketId);
        const snapshot = rt.store.latestSnapshot(market.id) ?? null;
        const resolution = rt.store.getResolution(market.id) ?? null;
        return {
          market,
          snapshot,
          // Venue evidence only. Never an inference, never an admin override.
          resolution: resolution && {
            resolution: resolution.resolution,
            resolvedAt: resolution.resolvedAt,
            evidenceSource: resolution.evidenceSource,
            demo: resolution.demo,
          },
          demo: market.venue === "fixture",
        };
      });
    }),

  getOrderbook: publicProcedure
    .input(z.object({ venueMarketId: z.string().min(1).max(256) }))
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      return call(() => rt.service.getOrderbook(input.venueMarketId));
    }),

  /** Independent USDC/share prices; never a complementary probability or quote. */
  indicativePrices: publicProcedure
    .input(z.object({ venueMarketId: z.string().min(1).max(256) }).strict())
    .query(({ ctx, input }) => call(() => runtime(ctx.app.config).service.getIndicativePrices(input.venueMarketId))),

  tradingStatus: publicProcedure.query(({ ctx }) => {
    const rt = runtime(ctx.app.config);
    return call(async () => {
      const venueStatus = await rt.service.getTradingStatus();
      return {
        ...venueStatus,
        // The venue may be open while WE are closed. Both must be true to trade.
        fundedPositionsEnabled: rt.config.flags.fundedPositions,
        ordersAccepted: venueStatus.tradingEnabled && rt.config.flags.fundedPositions,
      };
    });
  }),

  // ── orders & claims: every one refuses while the kill switch is off ───────

  createOrder: authedProcedure
    .input(
      z.object({
        idempotencyKey: z.string().min(8).max(128),
        venueMarketId: z.string().min(1).max(256),
        side: SIDE,
        amountBaseUnits: baseUnits,
        limitProbability: probability.nullish(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      requireFundedPositions(rt);
      return call(async () => {
        const { order, reused } = await rt.service.createOrder({
          ownerKey: ownerKeyOf(ctx.wallet),
          ownerAddress: ctx.wallet,
          venueMarketId: input.venueMarketId,
          side: input.side,
          amountBaseUnits: input.amountBaseUnits,
          limitProbability: input.limitProbability ?? null,
          idempotencyKey: input.idempotencyKey,
        });
        // A quote is not money: fundingState is QUOTED, never "funded".
        return { order, reused };
      });
    }),

  /** Record that the client signed and sent. SUBMITTED is NOT money. */
  markOrderSubmitted: authedProcedure
    .input(z.object({ orderId: z.string().min(1).max(256) }))
    .mutation(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      requireFundedPositions(rt);
      return call(() => rt.service.markSubmitted(ownerKeyOf(ctx.wallet), input.orderId));
    }),

  getOrder: authedProcedure
    .input(z.object({ orderId: z.string().min(1).max(256) }))
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      requireFundedPositions(rt);
      return call(() => {
        const rec = rt.service.getOrderRecord(ownerKeyOf(ctx.wallet), input.orderId);
        return {
          orderId: rec.orderId,
          venue: rec.venue,
          venueMarketId: rec.venueMarketId,
          marketId: rec.marketId,
          side: rec.side,
          amountBaseUnits: rec.amountBaseUnits,
          filledBaseUnits: rec.filledBaseUnits,
          fundingState: rec.fundingState,
          venueOrderId: rec.venueOrderId,
          fillTxSignature: rec.fillTxSignature,
          reconciledAt: rec.reconciledAt,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          demo: rec.demo,
        };
      });
    }),

  listPositions: authedProcedure
    .input(z.object({ cursor: z.string().max(512).optional() }).optional())
    .query(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      requireFundedPositions(rt);
      return call(() => rt.service.listPositions(ownerKeyOf(ctx.wallet), ctx.wallet, input?.cursor));
    }),

  closePosition: authedProcedure
    .input(z.object({ positionId: z.string().min(1).max(256) }))
    .mutation(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      requireFundedPositions(rt);
      return call(() => rt.service.closePosition(ownerKeyOf(ctx.wallet), ctx.wallet, input.positionId));
    }),

  claim: authedProcedure
    .input(z.object({ positionId: z.string().min(1).max(256) }))
    .mutation(({ ctx, input }) => {
      const rt = runtime(ctx.app.config);
      requireFundedPositions(rt);
      return call(() => rt.service.createClaim(ownerKeyOf(ctx.wallet), ctx.wallet, input.positionId));
    }),

  /**
   * Repair from venue history after a dropped callback or a restart. Idempotent
   * and cursor-backed — safe to call on a timer or from a pull-to-refresh.
   */
  reconcile: authedProcedure.mutation(({ ctx }) => {
    const rt = runtime(ctx.app.config);
    requireFundedPositions(rt);
    return call(() => rt.service.reconcile(ownerKeyOf(ctx.wallet), ctx.wallet));
  }),
});

export type PredictionsRouter = typeof predictionsRouter;
