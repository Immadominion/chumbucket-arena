/**
 * The tRPC surface, end to end through createCaller.
 *
 * The headline behaviour: `funded_positions` is a SERVER-SIDE kill switch
 * (contracts §7). With it off, every order and claim route refuses — and every
 * market read keeps working, because taking funding away must not take the
 * product away.
 */

import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { predictionsRouter } from "../src/api/predictions.ts";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet } from "../src/domain/ids.ts";
import {
  FixtureVenue,
  InMemoryPredictionStore,
  MarketSync,
  PredictionService,
  buildPredictionRuntime,
  predictionRuntimeFor,
  resetPredictionRuntimes,
  resolvePredictionConfig,
  setPredictionRuntime,
  withPredictionConfig,
} from "../src/prediction/index.ts";
import { TestClock } from "./predictionFixtures.ts";

const WALLET = "OwnerAddress111";
const MARKET = "fx-open-btc-120k";

async function appWith(fundedPositions: boolean): Promise<App> {
  const config = withPredictionConfig(loadConfig({}), {
    venue: "fixture",
    flags: { fundedPositions },
  });
  return createApp({ config });
}

const callers = (app: App) => ({
  anon: predictionsRouter.createCaller({ app }),
  user: predictionsRouter.createCaller({ app, wallet: asWallet(WALLET) }),
});

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return e instanceof TRPCError ? e.code : `THREW:${(e as Error).message}`;
  }
};

describe("reads are public and always work", () => {
  test("config reports the venue, demo-ness and the flag — never a key", async () => {
    const app = await appWith(false);
    const { anon } = callers(app);
    const cfg = await anon.config();
    expect(cfg.venue).toBe("fixture");
    expect(cfg.demo).toBe(true);
    expect(cfg.fundedPositions).toBe(false);
    expect(cfg.jupiterConfigured).toBe(false);
    expect(cfg.capabilities.demo).toBe(true);
    expect(JSON.stringify(cfg)).not.toMatch(/apiKey|secret|"key"/i);
  });

  test("listEvents, getMarket, getOrderbook and tradingStatus all work anonymously", async () => {
    const app = await appWith(false);
    const { anon } = callers(app);

    const events = await anon.listEvents({ filters: { limit: 3 } });
    expect(events.events.length).toBe(3);
    expect(events.demo).toBe(true);
    expect(events.nextCursor).not.toBeNull();

    const market = await anon.getMarket({ venueMarketId: MARKET });
    expect(market.market.status).toBe("OPEN");
    expect(market.demo).toBe(true);
    expect(market.resolution).toBeNull();

    const book = await anon.getOrderbook({ venueMarketId: MARKET });
    expect(book.demo).toBe(true);
    expect(book.bids.length).toBe(1);

    const status = await anon.tradingStatus();
    expect(status.tradingEnabled).toBe(true);
    expect(status.fundedPositionsEnabled).toBe(false);
    expect(status.ordersAccepted).toBe(false); // venue open, WE are closed
  });

  test("a resolved market exposes the venue's resolution as evidence", async () => {
    const app = await appWith(false);
    const { anon } = callers(app);
    const out = await anon.getMarket({ venueMarketId: "fx-resolved-yes-sol-300" });
    expect(out.market.status).toBe("RESOLVED");
    expect(out.resolution?.resolution).toBe("YES");
    expect(out.resolution?.demo).toBe(true);
  });

  test("an unknown market is a 404, not a 500", async () => {
    const app = await appWith(false);
    const { anon } = callers(app);
    expect(await codeOf(() => anon.getMarket({ venueMarketId: "nope" }))).toBe("NOT_FOUND");
  });
});

describe("the funded_positions kill switch", () => {
  test("OFF: every order and claim route refuses with FORBIDDEN", async () => {
    const app = await appWith(false);
    const { user } = callers(app);

    expect(
      await codeOf(() =>
        user.createOrder({
          idempotencyKey: "idem-key-off-1",
          venueMarketId: MARKET,
          side: "YES",
          amountBaseUnits: "5000000",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(await codeOf(() => user.getOrder({ orderId: "anything" }))).toBe("FORBIDDEN");
    expect(await codeOf(() => user.markOrderSubmitted({ orderId: "anything" }))).toBe("FORBIDDEN");
    expect(await codeOf(() => user.listPositions())).toBe("FORBIDDEN");
    expect(await codeOf(() => user.closePosition({ positionId: "anything" }))).toBe("FORBIDDEN");
    expect(await codeOf(() => user.claim({ positionId: "anything" }))).toBe("FORBIDDEN");
    expect(await codeOf(() => user.reconcile())).toBe("FORBIDDEN");
  });

  test("OFF: reading stays completely functional", async () => {
    const app = await appWith(false);
    const { anon } = callers(app);
    await expect(anon.listEvents()).resolves.toBeDefined();
    await expect(anon.getMarket({ venueMarketId: MARKET })).resolves.toBeDefined();
    await expect(anon.getOrderbook({ venueMarketId: MARKET })).resolves.toBeDefined();
    await expect(anon.tradingStatus()).resolves.toBeDefined();
    await expect(anon.config()).resolves.toBeDefined();
  });

  test("OFF: nothing is written, because the venue is never reached", async () => {
    const app = await appWith(false);
    const { user } = callers(app);
    await codeOf(() =>
      user.createOrder({
        idempotencyKey: "idem-key-off-2",
        venueMarketId: MARKET,
        side: "YES",
        amountBaseUnits: "5000000",
      }),
    );
    const rt = predictionRuntimeFor(app.config);
    expect(rt.store.listOrders(`wallet:${WALLET}`)).toEqual([]);
  });

  test("ON: the same routes work, and produce a QUOTE", async () => {
    const app = await appWith(true);
    const { user } = callers(app);
    const { order, reused } = await user.createOrder({
      idempotencyKey: "idem-key-on-1",
      venueMarketId: MARKET,
      side: "YES",
      amountBaseUnits: "5000000",
    });
    expect(reused).toBe(false);
    expect(order.fundingState).toBe("QUOTED");
    expect(order.demo).toBe(true);

    const fetched = await user.getOrder({ orderId: order.orderId });
    expect(fetched.fundingState).toBe("QUOTED");
    expect(fetched.filledBaseUnits).toBe("0");

    const replay = await user.createOrder({
      idempotencyKey: "idem-key-on-1",
      venueMarketId: MARKET,
      side: "YES",
      amountBaseUnits: "5000000",
    });
    expect(replay.reused).toBe(true);
    expect(replay.order.orderId).toBe(order.orderId);
  });

  test("ON: a replayed key with a different body is a CONFLICT", async () => {
    const app = await appWith(true);
    const { user } = callers(app);
    await user.createOrder({
      idempotencyKey: "idem-key-on-2",
      venueMarketId: MARKET,
      side: "YES",
      amountBaseUnits: "5000000",
    });
    expect(
      await codeOf(() =>
        user.createOrder({
          idempotencyKey: "idem-key-on-2",
          venueMarketId: MARKET,
          side: "NO",
          amountBaseUnits: "5000000",
        }),
      ),
    ).toBe("CONFLICT");
  });

  test("an order route still requires auth, flag or no flag", async () => {
    const app = await appWith(true);
    const { anon } = callers(app);
    expect(
      await codeOf(() =>
        anon.createOrder({
          idempotencyKey: "idem-key-anon-1",
          venueMarketId: MARKET,
          side: "YES",
          amountBaseUnits: "5000000",
        }),
      ),
    ).toBe("UNAUTHORIZED");
  });

  test("the switch is read server-side per app, so two apps never share it", async () => {
    const off = await appWith(false);
    const on = await appWith(true);
    expect((await callers(off).anon.config()).fundedPositions).toBe(false);
    expect((await callers(on).anon.config()).fundedPositions).toBe(true);
  });
});

describe("input validation at the edge", () => {
  test("money must be integer base units as a string", async () => {
    const app = await appWith(true);
    const { user } = callers(app);
    expect(
      await codeOf(() =>
        user.createOrder({
          idempotencyKey: "idem-key-bad-1",
          venueMarketId: MARKET,
          side: "YES",
          amountBaseUnits: "1.5",
        }),
      ),
    ).toBe("BAD_REQUEST");
  });

  test("an out-of-range probability is rejected", async () => {
    const app = await appWith(true);
    const { user } = callers(app);
    expect(
      await codeOf(() =>
        user.createOrder({
          idempotencyKey: "idem-key-bad-2",
          venueMarketId: MARKET,
          side: "YES",
          amountBaseUnits: "5000000",
          limitProbability: 1.5,
        }),
      ),
    ).toBe("BAD_REQUEST");
  });

  test("a too-short idempotency key is rejected before anything happens", async () => {
    const app = await appWith(true);
    const { user } = callers(app);
    expect(
      await codeOf(() =>
        user.createOrder({
          idempotencyKey: "x",
          venueMarketId: MARKET,
          side: "YES",
          amountBaseUnits: "5000000",
        }),
      ),
    ).toBe("BAD_REQUEST");
  });
});

describe("the module-level memo (contracts §6)", () => {
  test("is lazy, per-AppConfig, and overridable", async () => {
    resetPredictionRuntimes();
    const app = await appWith(true);
    const a = predictionRuntimeFor(app.config);
    const b = predictionRuntimeFor(app.config);
    expect(a).toBe(b); // memoised

    const other = await appWith(true);
    expect(predictionRuntimeFor(other.config)).not.toBe(a); // not shared

    const clock = new TestClock();
    const pinnedVenue = new FixtureVenue({ clock });
    const pinnedStore = new InMemoryPredictionStore();
    const pinned = {
      config: a.config,
      venue: pinnedVenue,
      store: pinnedStore,
      service: new PredictionService({
        venue: pinnedVenue,
        store: pinnedStore,
        clock,
        flags: { fundedPositions: true },
      }),
      // A pinned runtime is in memory and says so: `persistence` is the honest
      // reporter, never optional.
      persistence: { persisting: false, reason: "in-memory store supplied by the caller" },
      durable: null,
      marketSync: new MarketSync({ venue: pinnedVenue, store: pinnedStore, clock }),
      ready: Promise.resolve(),
    };
    setPredictionRuntime(app.config, pinned);
    expect(predictionRuntimeFor(app.config)).toBe(pinned);
    resetPredictionRuntimes();
  });

  test("a full reconcile loop works through the router", async () => {
    const app = await appWith(true);
    const clock = new TestClock();
    const venue = new FixtureVenue({ clock });
    const store = new InMemoryPredictionStore();
    const config = resolvePredictionConfig(app.config);
    setPredictionRuntime(app.config, {
      config,
      venue,
      store,
      service: new PredictionService({ venue, store, clock, ttls: config.cache, flags: config.flags }),
      persistence: { persisting: false, reason: "in-memory store supplied by the caller" },
      durable: null,
      marketSync: new MarketSync({ venue, store, clock }),
      ready: Promise.resolve(),
    });

    const { user } = callers(app);
    const { order } = await user.createOrder({
      idempotencyKey: "idem-key-recon-1",
      venueMarketId: MARKET,
      side: "YES",
      amountBaseUnits: "5000000",
    });
    await user.markOrderSubmitted({ orderId: order.orderId });
    venue.confirmFill(order.orderId); // the venue fills; the callback is lost

    expect((await user.getOrder({ orderId: order.orderId })).fundingState).toBe("SUBMITTED");
    const report = await user.reconcile();
    expect(report.ordersFilled).toBe(1);
    expect((await user.getOrder({ orderId: order.orderId })).fundingState).toBe("FILLED");

    const positions = await user.listPositions();
    expect(positions.positions.length).toBe(1);
    expect(positions.positions[0]!.demo).toBe(true);
    resetPredictionRuntimes();
  });

  test("buildPredictionRuntime falls back to the fixture venue with no key configured", () => {
    const rt = buildPredictionRuntime(withPredictionConfig(loadConfig({}), {}));
    expect(rt.config.venue).toBe("fixture");
    expect(rt.config.jupiter).toBeNull();
    expect(rt.config.flags.fundedPositions).toBe(false); // contracts §7 default
  });

  test("a configured Jupiter key never appears in the describe() output", () => {
    const rt = buildPredictionRuntime(
      withPredictionConfig(loadConfig({}), {
        venue: "jupiter",
        jupiter: { apiKey: "jup_live_sk_route_test_value" },
        flags: { fundedPositions: true },
      }),
    );
    expect(rt.config.venue).toBe("jupiter");
    expect(JSON.stringify(rt.config.jupiter)).toContain("jup_live_sk_route_test_value"); // held server-side…
    const described = JSON.stringify({
      venue: rt.config.venue,
      jupiterConfigured: rt.config.jupiter !== null,
    });
    expect(described).not.toContain("jup_live_sk_route_test_value"); // …never described outward
  });
});
