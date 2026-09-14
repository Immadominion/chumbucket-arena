/**
 * Wiring: `PREDICTION_VENUE=polymarket` must actually select the Polymarket
 * adapter, and must not disturb the existing fixture/Jupiter selection.
 *
 * Nothing here makes a network call: a runtime is BUILT and inspected, never
 * driven.
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import {
  buildPredictionRuntime,
  describePredictionConfig,
  FixtureVenue,
  JupiterVenue,
  PolymarketVenue,
  POLYMARKET_BASE_URL,
  POLYMARKET_VENUE_ID,
  predictionRuntimeFor,
  resetPredictionRuntimes,
  resolvePredictionConfig,
  withPredictionConfig,
} from "../src/prediction/index.ts";

describe("resolvePredictionConfig understands the venue", () => {
  test("PREDICTION_VENUE=polymarket selects it, with no key involved", () => {
    const cfg = resolvePredictionConfig(undefined, { PREDICTION_VENUE: "polymarket" });
    expect(cfg.venue).toBe(POLYMARKET_VENUE_ID);
    expect(cfg.polymarket?.baseUrl).toBe(POLYMARKET_BASE_URL);
    expect(cfg.polymarket?.timeoutMs).toBe(8_000);
    expect(cfg.jupiter).toBeNull();
    // contracts §7: funded positions stay OFF by default whatever the venue.
    expect(cfg.flags.fundedPositions).toBe(false);
  });

  test("the integration-owned AppConfig now carries it through, unaltered", () => {
    // This test used to assert the opposite — that src/config.ts collapsed
    // PREDICTION_VENUE=polymarket to "fixture", and that resolvePredictionConfig
    // had to override it. The integration patch in packet-poly.md has since
    // landed, so the coercion is gone and the honest assertion is that the two
    // layers now agree.
    const app = loadConfig({ PREDICTION_VENUE: "polymarket" });
    expect((app as { predictions?: { venue?: string } }).predictions?.venue).toBe(
      POLYMARKET_VENUE_ID,
    );

    const cfg = resolvePredictionConfig(app, { PREDICTION_VENUE: "polymarket" });
    expect(cfg.venue).toBe(POLYMARKET_VENUE_ID);
  });

  test("polymarket needs no key, where jupiter without one falls back", () => {
    // The asymmetry is deliberate: Polymarket is keyless real data, so its name
    // is enough. Jupiter without a key is a venue that cannot answer, so it
    // degrades to the clearly-labelled demo catalog rather than pretending.
    const poly = loadConfig({ PREDICTION_VENUE: "polymarket" });
    expect((poly as { predictions?: { venue?: string } }).predictions?.venue).toBe(
      POLYMARKET_VENUE_ID,
    );

    const jup = loadConfig({ PREDICTION_VENUE: "jupiter" });
    expect((jup as { predictions?: { venue?: string } }).predictions?.venue).toBe("fixture");
  });

  test("an explicit app-config venue selects it without any environment at all", () => {
    const app = withPredictionConfig(loadConfig({}), { venue: POLYMARKET_VENUE_ID });
    expect(resolvePredictionConfig(app, {}).venue).toBe(POLYMARKET_VENUE_ID);
  });

  test("the base URL and timeout are overridable", () => {
    const cfg = resolvePredictionConfig(undefined, {
      PREDICTION_VENUE: "polymarket",
      POLYMARKET_BASE_URL: "https://gamma-api.example.invalid",
      POLYMARKET_TIMEOUT_MS: "2500",
    });
    expect(cfg.polymarket?.baseUrl).toBe("https://gamma-api.example.invalid");
    expect(cfg.polymarket?.timeoutMs).toBe(2_500);
  });

  test("nothing about the existing fixture/Jupiter selection changes", () => {
    expect(resolvePredictionConfig(undefined, {}).venue).toBe("fixture");
    expect(resolvePredictionConfig(undefined, { PREDICTION_VENUE: "fixture" }).venue).toBe("fixture");
    expect(resolvePredictionConfig(undefined, { PREDICTION_VENUE: "jupiter" }).venue).toBe("fixture"); // no key
    expect(
      resolvePredictionConfig(undefined, {
        PREDICTION_VENUE: "jupiter",
        JUPITER_API_KEY: "jup_not_a_real_key_value",
      }).venue,
    ).toBe("jupiter");
    expect(resolvePredictionConfig(undefined, { PREDICTION_VENUE: "nonsense" }).venue).toBe("fixture");
  });
});

describe("buildPredictionRuntime constructs the right adapter", () => {
  test("polymarket", () => {
    const rt = buildPredictionRuntime(
      withPredictionConfig(loadConfig({}), { venue: POLYMARKET_VENUE_ID }),
    );
    expect(rt.venue).toBeInstanceOf(PolymarketVenue);
    expect(rt.config.venue).toBe(POLYMARKET_VENUE_ID);
    expect(rt.venue.capabilities().trade).toBe(false);
    expect(rt.venue.capabilities().demo).toBe(false);
  });

  test("fixture and jupiter still build as before", () => {
    expect(
      buildPredictionRuntime(withPredictionConfig(loadConfig({}), { venue: "fixture" })).venue,
    ).toBeInstanceOf(FixtureVenue);
    expect(
      buildPredictionRuntime(
        withPredictionConfig(loadConfig({}), {
          venue: "jupiter",
          jupiter: { apiKey: "jup_not_a_real_key_value" },
        }),
      ).venue,
    ).toBeInstanceOf(JupiterVenue);
  });

  test("the memoised runtime serves it too", () => {
    const app = withPredictionConfig(loadConfig({}), { venue: POLYMARKET_VENUE_ID });
    const rt = predictionRuntimeFor(app);
    expect(rt.venue).toBeInstanceOf(PolymarketVenue);
    expect(predictionRuntimeFor(app)).toBe(rt);
    resetPredictionRuntimes();
  });
});

describe("what a route may report about the config", () => {
  test("describe() marks it live (not demo) and leaks nothing", () => {
    const cfg = resolvePredictionConfig(undefined, { PREDICTION_VENUE: "polymarket" });
    const described = describePredictionConfig(cfg);
    expect(described.venue).toBe(POLYMARKET_VENUE_ID);
    // Real venue, real prices — it must never wear the demo banner.
    expect(described.demo).toBe(false);
    expect(described.polymarketConfigured).toBe(true);
    expect(described.jupiterConfigured).toBe(false);
    expect(JSON.stringify(described)).not.toMatch(/apiKey|secret|token|"key"/i);
  });

  test("the fixture venue is still the one flagged demo", () => {
    expect(describePredictionConfig(resolvePredictionConfig(undefined, {})).demo).toBe(true);
  });
});

describe("the adapter needs no credential of any kind", () => {
  test("it constructs with no config at all", () => {
    const v = new PolymarketVenue();
    expect(v.capabilities().read).toBe(true);
    expect(v.capabilities().trade).toBe(false);
  });

  test("a non-http base URL is refused at construction", () => {
    let code = "NO_ERROR";
    try {
      new PolymarketVenue({ baseUrl: "gamma-api.polymarket.com" });
    } catch (e) {
      code = (e as { code?: string }).code ?? "OTHER";
    }
    expect(code).toBe("VENUE_MISCONFIGURED");
  });
});
