/** Provider policy regression tests. No network, secrets or database. */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { harness, market, person } from "./socialCallsFixtures.ts";
import {
  buildPredictionRuntime, describePredictionConfig, FixtureVenue, PantaVenue,
  predictionRuntimeFor, resetPredictionRuntimes, resolvePredictionConfig,
  withPredictionConfig, type VenueId,
} from "../src/prediction/index.ts";

const key = "pk_live_synthetic_policy_test_only";

describe("Panta is the only live provider", () => {
  test("default config selects Panta without silently importing old credentials", () => {
    const app = loadConfig({ PANTA_API_KEY: key, JUPITER_API_KEY: "synthetic_old_key", FUNDED_POSITIONS: "true" });
    const cfg = resolvePredictionConfig(app, {});
    expect(cfg.venue).toBe("panta");
    expect(cfg.jupiter).toBeNull(); expect(cfg.polymarket).toBeNull();
    expect(app.predictions?.jupiter).toBeUndefined();
    expect(cfg.flags.fundedPositions).toBe(false);
    expect(buildPredictionRuntime(app).venue).toBeInstanceOf(PantaVenue);
  });

  for (const venue of ["polymarket", "jupiter", "fixture", "dflow", "unknown"]) {
    test(`environment selection refuses ${venue} instead of substituting data`, () => {
      const env = { PREDICTION_VENUE: venue, PANTA_API_KEY: key };
      expect(() => loadConfig(env)).toThrow("Panta only");
      expect(() => resolvePredictionConfig(undefined, env)).toThrow("Panta only");
    });
  }

  for (const venue of ["polymarket", "jupiter"] as const) {
    test(`explicit app config and runtime overrides cannot reactivate ${venue}`, () => {
      const app = withPredictionConfig(loadConfig({}), { venue });
      expect(() => resolvePredictionConfig(app, {})).toThrow("Panta only");
      const cfg = resolvePredictionConfig(undefined, { PANTA_API_KEY: key });
      expect(() => buildPredictionRuntime(undefined, { config: { ...cfg, venue } })).toThrow("only live prediction provider");
    });
  }

  test("missing/test keys refuse rather than serve fixture data", () => {
    for (const apiKey of [undefined, "", "pk_test_synthetic_only"]) {
      expect(() => resolvePredictionConfig(undefined, { PANTA_API_KEY: apiKey })).toThrow("live server key");
      expect(() => buildPredictionRuntime(loadConfig({ PANTA_API_KEY: apiKey }))).toThrow("live server key");
    }
  });

  test("memoized production runtime is Panta and exposes no key", () => {
    const app = loadConfig({ PANTA_API_KEY: key });
    const rt = predictionRuntimeFor(app);
    expect(rt.venue).toBeInstanceOf(PantaVenue);
    expect(predictionRuntimeFor(app)).toBe(rt);
    expect(describePredictionConfig(rt.config)).toMatchObject({
      venue: "panta", demo: false, pantaConfigured: true,
      jupiterConfigured: false, polymarketConfigured: false, fundedPositions: false,
    });
    expect(JSON.stringify(describePredictionConfig(rt.config))).not.toContain(key);
    resetPredictionRuntimes();
  });

  test("bad configuration values cannot escape via errors", () => {
    const value = "synthetic-sensitive-config-value";
    try { loadConfig({ PREDICTION_VENUE: value }); throw new Error("accepted"); }
    catch (error) { expect(String(error)).toContain("Panta only"); expect(String(error)).not.toContain(value); }
  });

  test("only explicit in-code fixtures keep synthetic order coverage reachable", () => {
    const app = withPredictionConfig(loadConfig({}), { venue: "fixture", flags: { fundedPositions: true } });
    const rt = buildPredictionRuntime(app);
    expect(rt.venue).toBeInstanceOf(FixtureVenue);
    expect(describePredictionConfig(rt.config)).toMatchObject({ demo: true, fundedPositions: true, pantaConfigured: false });
  });

  test("malformed runtime config does not fall back to fixtures", () => {
    const cfg = resolvePredictionConfig(undefined, { PANTA_API_KEY: key });
    expect(() => buildPredictionRuntime(undefined, { config: { ...cfg, panta: null } })).toThrow("live server key");
    expect(() => buildPredictionRuntime(undefined, { config: { ...cfg, venue: "invalid" as VenueId } })).toThrow("only live prediction provider");
  });
});

describe("historical provider data is not a live fallback", () => {
  for (const venue of ["polymarket", "jupiter"] as const) {
    test(`${venue} remains readable but is absent from discovery and refuses writes`, () => {
      const m = market("old-market", { venue });
      const h = harness({ people: [person("alice"), person("bob")], markets: [m] });
      h.calls.insertCall({
        id: "historical-call", userId: "alice", marketId: m.id, side: "YES",
        confidence: null, thesis: "Historical statement", visibility: "public",
        createdAt: h.clock.now(), lockedAt: h.clock.now(), entryProbability: 0.5,
        snapshotId: null, parentCallId: null, fundingState: "NONE",
        hiddenAt: null, hiddenReason: null,
      });
      expect(h.rt.service.openMarkets()).toEqual([]);
      expect(h.rt.service.getCall({ callId: "historical-call" }, null).entry.market.venue).toBe(venue);
      expect(h.rt.service.feed({ mode: "global" }, null).entries[0]?.market.venue).toBe(venue);
      expect(() => h.rt.service.createCall({ marketId: m.id, side: "NO" }, "bob")).toThrow("Panta only");
      for (const kind of ["back", "fade", "challenge"] as const) {
        expect(() => h.rt.service.respond({ targetCallId: "historical-call", kind }, "bob")).toThrow("Panta only");
      }
      expect(h.calls.listCalls()).toHaveLength(1);
      expect(h.calls.listResponses()).toHaveLength(0);
    });
  }
});
