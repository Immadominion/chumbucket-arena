/**
 * Entrypoint. Boot the app, seed the Matchday, start the server, and run the
 * ingestion ticker (lock kicked-off matches, resolve finished ones). Everything
 * runs in one process; the ticker is the only background loop.
 */

import { createApp } from "./app.ts";
import { callsRuntimeFor } from "./calls/runtime.ts";
import { CallResultWorker } from "./calls/CallResultWorker.ts";
import { durableWriterNeedsRestart } from "./calls/durableFailure.ts";
import { isVenueError } from "./prediction/errors.ts";
import { startServer } from "./api/server.ts";
import { OnchainKeeper } from "./keeper/onchainDriver.ts";
import { installErrorReporting, reportError } from "./ops/errorReporting.ts";
import { heartbeats } from "./ops/heartbeats.ts";
import { setReadinessSource } from "./ops/readiness.ts";

// Sentry when SENTRY_DSN is set; absent = off and nothing changes.
console.log(`   Error reporting: ${installErrorReporting().reason}`);

const startedAt = Date.now();
let callsHydrated = false;

const app = await createApp();
const { port } = app.config;

// Listen first so the platform health check passes immediately; loading the
// Matchday from the live feed must never block startup.
startServer(app, port);
console.log(`⚽ The Gaffer backend listening on :${port}`);
console.log(`   wiring:          ${JSON.stringify(app.wiring)}`);
console.log(`   Sessions wallet: ${app.engine.custody.sessionsAddress()}`);

// ── the pivot's durable stores ───────────────────────────────────────────────
// Both stores serve reads from an in-process mirror built from Postgres, so
// awaiting hydration here is what stops the first request after a deploy from
// reading an empty feed. An empty feed on a database that has calls in it is a
// lie, however brief. Resolves immediately on an in-memory server.
const calls = callsRuntimeFor(app.config);
// /ready reports from here on; until hydration finishes it answers 503.
setReadinessSource({
  hydrated: () => callsHydrated,
  persisting: () => calls.persistence.persisting,
  writer: () => calls.durable?.queue ?? null,
  heartbeats,
  requireDurable: process.env.READY_REQUIRE_DURABLE === "true",
  startedAt,
});
await calls.ready;
callsHydrated = true;
console.log(
  `   Persistence:     ${calls.persistence.persisting ? "SUPABASE" : "IN-MEMORY"} — ${calls.persistence.reason}`,
);

// A transport failure on one write quarantines the shared FIFO. Request
// barriers then return 503, but /health does not inspect that writer. Fail
// closed and let Railway's ON_FAILURE policy restart from Postgres instead
// of leaving a superficially online social service stuck indefinitely.
if (calls.durable) {
  const queue = calls.durable.queue;
  let restarting = false;
  setInterval(() => {
    if (restarting || queue.failures.length === 0) return;
    restarting = true;
    void durableWriterNeedsRestart(queue).then((needed) => {
      if (!needed) {
        restarting = false;
        return;
      }
      console.error("[persist] durable writer failed; restarting to rehydrate from Postgres");
      process.exit(1);
    });
  }, 15_000);
}

// Keep venue_markets / market_snapshots / market_resolutions fresh. Without
// this the catalog only ever contains markets somebody happened to browse, and
// calls_guard_insert refuses a call on a market it cannot see. Idempotent and
// cursor-backed, so a tick overlapping a restart repairs rather than
// re-imports. Same shape as the reconciler loop below: on whenever Supabase is
// configured, off with one env var.
if (calls.prediction && calls.persistence.persisting && process.env.MARKET_SYNC_ENABLED !== "false") {
  const marketSyncTickMs = Number(process.env.MARKET_SYNC_TICK_MS ?? 60_000);
  const resultWorker = new CallResultWorker({ calls, prediction: calls.prediction });
  heartbeats.register("marketSync", { intervalMs: marketSyncTickMs, required: true });
  const marketSyncTick = async () => {
    try {
      const report = await resultWorker.runOnce();
      heartbeats.success("marketSync");
      if (report.catalog.marketsUpserted || report.catalog.snapshotsRecorded ||
          report.catalog.resolutionsRecorded || report.calledResolutionsRecorded ||
          report.results.resultsSettled) {
        console.log("[callResultSync]", JSON.stringify({
          markets: report.catalog.marketsUpserted,
          prices: report.catalog.snapshotsRecorded,
          catalogResolutions: report.catalog.resolutionsRecorded,
          calledResolutions: report.calledResolutionsRecorded,
          resultsSettled: report.results.resultsSettled,
          calledMarketsUnavailable: report.calledMarketsUnavailable,
        }));
      }
    } catch (err) {
      // No provider response body, signed bytes or private database cause in logs.
      const code = isVenueError(err) ? err.code : "DURABILITY_OR_WORKER_FAILURE";
      heartbeats.failure("marketSync", code);
      console.error("[callResultSync] tick failed:", code);
      if (!isVenueError(err)) reportError(err, { tags: { source: "worker", worker: "marketSync" } });
    }
  };
  console.log(`   Market/call result sync: ENABLED (tick every ${marketSyncTickMs}ms)`);
  setInterval(marketSyncTick, marketSyncTickMs);
  void marketSyncTick();
}

const TICK_MS = 30_000;
heartbeats.register("engineTick", { intervalMs: TICK_MS, required: false });
const tick = async () => {
  try {
    await app.engine.tick();
    heartbeats.success("engineTick");
  } catch (err) {
    heartbeats.failure("engineTick", "ENGINE_TICK_FAILED");
    console.error("[tick] failed:", err);
  }
};

// On-chain keeper — a SEPARATE poll loop driving chumbucket_arena on devnet.
// Opt-in (ONCHAIN_KEEPER_ENABLED=true) so it never runs in tests/CI/plain `bun
// start` by default, and never touches the custodial Engine's off-chain ledger.
let keeperTick: (() => Promise<void>) | undefined;
if (app.config.onchainKeeper?.enabled) {
  try {
    const keeper = new OnchainKeeper(app, app.config.onchainKeeper);
    heartbeats.register("onchainKeeper", { intervalMs: app.config.onchainKeeper.tickMs, required: false });
    keeperTick = async () => {
      try {
        await keeper.tick();
        heartbeats.success("onchainKeeper");
      } catch (err) {
        heartbeats.failure("onchainKeeper", "KEEPER_TICK_FAILED");
        console.error("[keeper] tick failed:", err);
      }
    };
    console.log(`   On-chain keeper: ENABLED (tick every ${app.config.onchainKeeper.tickMs}ms)`);
    setInterval(keeperTick, app.config.onchainKeeper.tickMs);
  } catch (err) {
    console.error("[keeper] failed to start on-chain keeper:", err);
  }
} else {
  console.log("   On-chain keeper: disabled (set ONCHAIN_KEEPER_ENABLED=true to enable)");
}

// Reconciler — a SEPARATE poll loop that walks chumbucket_arena's tx history and
// repairs the Supabase social read model from on-chain truth (positions,
// settlements, claims). On whenever the social store is configured; independent
// of the keeper. Every write is idempotent, so a re-scan is always safe.
let reconcilerTick: (() => Promise<void>) | undefined;
if (app.reconciler) {
  heartbeats.register("reconciler", { intervalMs: app.config.reconciler!.tickMs, required: false });
  reconcilerTick = async () => {
    try {
      const s = await app.reconciler!.reconcile();
      heartbeats.success("reconciler");
      if (s.applied > 0 || s.errors > 0 || s.created > 0 || s.settlements > 0 || s.claims > 0) {
        console.log("[reconciler]", JSON.stringify(s));
      }
    } catch (err) {
      heartbeats.failure("reconciler", "RECONCILER_TICK_FAILED");
      console.error("[reconciler] tick failed:", err);
    }
  };
  console.log(`   Reconciler:      ENABLED (tick every ${app.config.reconciler!.tickMs}ms)`);
  setInterval(reconcilerTick, app.config.reconciler!.tickMs);
} else {
  console.log("   Reconciler:      disabled (needs Supabase social config; off if RECONCILER_ENABLED=false)");
}

app.engine
  .syncFixtures()
  .then(() => console.log(`   Matchday:        ${app.readModel.pots.openFixtures().length} fixtures open`))
  .catch((err) => console.error("[boot] syncFixtures failed:", err))
  .finally(() => {
    setInterval(tick, TICK_MS);
    // First keeper pass runs after the Matchday is seeded, so it actually sees
    // the fixtures readModel.pots just hydrated (rather than an empty pass).
    void keeperTick?.();
    // First reconciler pass — catch up on any history since the last boot.
    void reconcilerTick?.();
  });
