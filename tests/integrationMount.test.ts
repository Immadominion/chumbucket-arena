/**
 * The mount itself.
 *
 * Packets A and B each build a complete, tested sub-router, but a tRPC
 * sub-router is unreachable until it is a key on the root router. Both packets'
 * own suites drive their routers directly via `xRouter.createCaller(...)`, so
 * they pass whether or not the mount exists. This file is the only thing that
 * fails if someone removes those two keys from `appRouter`.
 *
 * It also pins the client-visible paths. `auth.*` and `predictions.*` are what
 * mobile imports off `AppRouter`; renaming a namespace is a breaking client
 * change, and it should break here first.
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { withPredictionConfig } from "../src/prediction/config.ts";

const app = await createApp({ config: withPredictionConfig(loadConfig({}), { venue: "fixture" }) });

describe("pivot sub-routers are mounted on the root router", () => {
  test("auth and predictions are reachable namespaces", () => {
    const defs = appRouter._def.procedures as Record<string, unknown>;
    const paths = Object.keys(defs);

    const authPaths = paths.filter((p) => p.startsWith("auth."));
    const predictionPaths = paths.filter((p) => p.startsWith("predictions."));

    expect(authPaths.length).toBeGreaterThan(0);
    expect(predictionPaths.length).toBeGreaterThan(0);
  });

  test("the legacy surface is untouched by the mount", () => {
    const paths = Object.keys(appRouter._def.procedures as Record<string, unknown>);
    // Nesting adds keys; it must never shadow or remove an existing one.
    expect(paths).toContain("health");
    expect(paths.filter((p) => !p.includes(".")).length).toBeGreaterThan(20);
  });

  test("a prediction read works through the ROOT caller, not just the sub-router", async () => {
    const caller = appRouter.createCaller({ app });
    const status = await caller.predictions.tradingStatus();
    expect(status).toBeDefined();
  });

  test("funded_positions defaults OFF through the root caller", async () => {
    const caller = appRouter.createCaller({ app });
    const cfg = await caller.predictions.config();
    expect(cfg.fundedPositions).toBe(false);
    // The kill switch must never leak the provider key through a config read.
    expect(JSON.stringify(cfg)).not.toContain("apiKey");
  });

  test("an auth read works through the ROOT caller", async () => {
    const caller = appRouter.createCaller({ app });
    const status = await caller.auth.identityStatus();
    expect(status).toBeDefined();
  });

  test("loadConfig({}) selects Panta and funded positions off", () => {
    const cfg = loadConfig({});
    expect(cfg.predictions?.venue).toBe("panta");
    expect(cfg.predictions?.flags?.fundedPositions).toBe(false);
    expect(cfg.predictions?.jupiter).toBeUndefined();
  });

  test("old provider keys cannot select another provider", () => {
    const cfg = loadConfig({ JUPITER_API_KEY: "test-key-not-real" });
    expect(cfg.predictions?.venue).toBe("panta");
    expect(cfg.predictions?.flags?.fundedPositions).toBe(false);
  });

  test("FUNDED_POSITIONS requires exact true for the native signed-intent flow", () => {
    expect(loadConfig({ FUNDED_POSITIONS: "1" }).predictions?.flags?.fundedPositions).toBe(false);
    expect(loadConfig({ FUNDED_POSITIONS: "yes" }).predictions?.flags?.fundedPositions).toBe(false);
    expect(loadConfig({ FUNDED_POSITIONS: "true" }).predictions?.flags?.fundedPositions).toBe(true);
  });

  test("the SIWS allowlist parses to a real list, and is absent when unset", () => {
    expect(loadConfig({}).authIdentity).toBeUndefined();
    const cfg = loadConfig({ SIWS_DOMAINS: "chumbucket.app, staging.chumbucket.app ,," });
    expect(cfg.authIdentity?.siwsDomains).toEqual(["chumbucket.app", "staging.chumbucket.app"]);
  });
});
