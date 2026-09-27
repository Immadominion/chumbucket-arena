import { describe, expect, test } from "bun:test";
import { harness, market, person, T0 } from "./socialCallsFixtures.ts";

describe("cached OPEN status cannot extend the call window", () => {
  for (const boundary of [T0 - 1, T0]) {
    test(`deadline ${boundary} is excluded and cannot mint a call`, () => {
      const h = harness({ people: [person("a")], markets: [market("m", { closesAt: boundary })] });
      expect(h.rt.service.openMarkets()).toEqual([]);
      expect(() => h.rt.service.createCall({ marketId: "m", side: "YES" }, "a")).toThrow();
    });
  }
  test("a cached market expires as time advances without waiting for a sync", () => {
    const h = harness({ people: [person("a"), person("b")], markets: [market("m", { closesAt: T0 + 100 })] });
    const entry = h.rt.service.createCall({ marketId: "m", side: "YES" }, "a");
    expect(h.rt.service.openMarkets()).toHaveLength(1);
    h.clock.advance(100);
    expect(h.rt.service.openMarkets()).toEqual([]);
    for (const kind of ["back", "fade"] as const) {
      expect(() => h.rt.service.respond({ targetCallId: entry.call.id, kind }, "b")).toThrow();
    }
  });
  test("an unopened market cannot accept an early call", () => {
    const h = harness({ people: [person("a")], markets: [market("m", { opensAt: T0 + 100 })] });
    expect(h.rt.service.openMarkets()).toEqual([]);
    expect(() => h.rt.service.createCall({ marketId: "m", side: "YES" }, "a")).toThrow();
    h.clock.advance(100);
    expect(h.rt.service.openMarkets()).toHaveLength(1);
  });
  test("published evidence closes calls even if the catalog status lags", () => {
    const h = harness({ people: [person("a")], markets: [market("m")] });
    h.resolve("m", "YES");
    expect(h.rt.service.openMarkets()).toEqual([]);
    expect(() => h.rt.service.createCall({ marketId: "m", side: "YES" }, "a")).toThrow();
  });
});
