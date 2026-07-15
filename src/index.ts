/**
 * Entrypoint. Boot the app, seed the Matchday, start the server, and run the
 * ingestion ticker (lock kicked-off matches, resolve finished ones). Everything
 * runs in one process; the ticker is the only background loop.
 */

import { createApp } from "./app.ts";
import { startServer } from "./api/server.ts";
import { OnchainKeeper } from "./keeper/onchainDriver.ts";

const app = await createApp();
const { port } = app.config;

// Listen first so the platform health check passes immediately; loading the
// Matchday from the live feed must never block startup.
startServer(app, port);
console.log(`⚽ The Gaffer backend listening on :${port}`);
console.log(`   wiring:          ${JSON.stringify(app.wiring)}`);
console.log(`   Sessions wallet: ${app.engine.custody.sessionsAddress()}`);

const TICK_MS = 30_000;
const tick = async () => {
  try {
    await app.engine.tick();
  } catch (err) {
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
    keeperTick = async () => {
      try {
        await keeper.tick();
      } catch (err) {
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

app.engine
  .syncFixtures()
  .then(() => console.log(`   Matchday:        ${app.readModel.pots.openFixtures().length} fixtures open`))
  .catch((err) => console.error("[boot] syncFixtures failed:", err))
  .finally(() => {
    setInterval(tick, TICK_MS);
    // First keeper pass runs after the Matchday is seeded, so it actually sees
    // the fixtures readModel.pots just hydrated (rather than an empty pass).
    void keeperTick?.();
  });
