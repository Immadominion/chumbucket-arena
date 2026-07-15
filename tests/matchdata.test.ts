import { describe, expect, test } from "bun:test";
import { ApiFootballProvider } from "../src/ports/ApiFootballProvider.ts";
import { asMatchId } from "../src/domain/ids.ts";

const BODY = {
  response: [
    {
      fixture: { id: 100, date: "2026-06-21T18:00:00+00:00", status: { short: "NS" } },
      league: { id: 1, name: "World Cup", round: "Group Stage - 1" },
      teams: { home: { name: "Argentina" }, away: { name: "Croatia" } },
      goals: { home: null, away: null },
    },
    {
      fixture: { id: 101, date: "2026-06-20T18:00:00+00:00", status: { short: "FT" } },
      league: { id: 1, name: "World Cup", round: "Group Stage - 1" },
      teams: { home: { name: "Brazil" }, away: { name: "Serbia" } },
      goals: { home: 2, away: 0 },
    },
  ],
};

function makeProvider(ttlMs: number) {
  let calls = 0;
  let clock = 1_000_000;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(BODY), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new ApiFootballProvider(
    {
      apiKey: "k",
      baseUrl: "https://x",
      competitions: [{ league: 1, season: 2026 }],
      cacheTtlMs: ttlMs,
      now: () => clock,
    },
    fetchImpl,
  );
  return { provider, calls: () => calls, advance: (ms: number) => (clock += ms) };
}

describe("ApiFootballProvider", () => {
  test("maps fixtures and finished results from one payload", async () => {
    const { provider } = makeProvider(60_000);
    const fixtures = await provider.fixtures();
    expect(fixtures.length).toBe(2);
    expect(fixtures.find((f) => f.matchId === asMatchId("100"))?.home).toBe("Argentina");

    const results = await provider.results([asMatchId("100"), asMatchId("101")]);
    expect(results.length).toBe(1); // only the FT match
    expect(results[0]?.matchId).toBe(asMatchId("101"));
    expect(results[0]?.score).toEqual({ home: 2, away: 0 });
  });

  test("caches: repeated reads within TTL make a single API call", async () => {
    const { provider, calls } = makeProvider(60_000);
    await provider.fixtures();
    await provider.results([asMatchId("101")]);
    await provider.fixtures();
    expect(calls()).toBe(1);
  });

  test("refetches once the TTL expires", async () => {
    const { provider, calls, advance } = makeProvider(60_000);
    await provider.fixtures();
    expect(calls()).toBe(1);
    advance(60_001);
    await provider.fixtures();
    expect(calls()).toBe(2);
  });
});
