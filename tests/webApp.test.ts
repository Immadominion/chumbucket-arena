/**
 * The web app at chumbucket.fun/app (web/app/app, web/components/webapp,
 * web/lib/webapp). Its pages are proven by `next build` in CI; these pin the
 * logic under them and the rules the owner set for every screen: compact,
 * stateful (no refresh buttons, no "updated X ago"), no internal states, the
 * app's own art for empty and error screens, truthful copy, and no identity
 * in any input.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import superjson from "superjson";
import { makeApi } from "../web/lib/webapp/api.ts";
import {
  BFF_URL,
  BffFailure,
  BffOffline,
  BffRejected,
  BffSignedOut,
  bffCall,
  parseTrpcResponse,
  queryUrl,
} from "../web/lib/webapp/bff.ts";
import {
  CACHE_MAX_AGE_MS,
  CACHE_MAX_BYTES,
  cacheKey,
  clearCache,
  loadCache,
  readPref,
  saveCache,
  trimForStorage,
  writePref,
  type KeyValueStorage,
} from "../web/lib/webapp/cache.ts";
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  catalogInput,
  parseFilters,
  withinWindow,
} from "../web/lib/webapp/filters.ts";
import {
  ago,
  callMark,
  calledAt,
  canAnswer,
  closesIn,
  closingSoon,
  joined,
  livePercent,
  recordA11y,
  recordToken,
  shortDay,
  shortWallet,
  stamp,
  takesCalls,
  topicIcon,
  topicLabel,
  tradableMarket,
} from "../web/lib/webapp/format.ts";
import { USERNAME_FORMAT, identityCopy, nameHint, normaliseUsername, suggestUsername, xUsernameHint } from "../web/lib/webapp/identity.ts";
import { APP_BASE, TRAIL_MAX, appPath, canGoBack, nextTrail, publicPath, safeDecode, safeReturnPath } from "../web/lib/webapp/paths.ts";
import { PRICE_UPDATING, isPriceRefusal, retryAfterPriceRefresh } from "../web/lib/webapp/prices.ts";
import { SIGN_IN_STATEMENT, sameBytes, signInMessage } from "../web/lib/webapp/siws.ts";
import { KINDS, LINK_CALLBACK_PATH, accountName, linkCopy, methodLabel } from "../web/lib/webapp/linking.ts";
import type { CallFeedEntry, PublicRecord, SharePrice } from "../web/lib/webapp/types.ts";
import { webAppHref } from "../web/lib/webAppLink.ts";

const WEB = join(import.meta.dir, "../web");
const NOW = Date.UTC(2026, 9, 4, 12, 0);
const H = 3_600_000;
const D = 24 * H;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const okBody = (json: unknown) => ({ result: { data: superjson.serialize(json) } });
const errBody = (code: string, message: string) => ({ error: { json: { message, code: -32000, data: { code } } } });

function price(over: Partial<SharePrice> = {}): SharePrice {
  return { marketId: "m1", venue: "panta", currency: "USDC", unit: "per_share", yesPrice: "0.62", noPrice: "0.43", observedAt: NOW - 60_000, ...over };
}

function entry(over: { userId?: string; outcome?: "PENDING" | "CORRECT"; closesAt?: number | null; viewerHasCalled?: boolean; status?: string } = {}): CallFeedEntry {
  return {
    call: {
      id: "c1",
      userId: over.userId ?? "u-ada",
      marketId: "m1",
      side: "YES",
      confidence: null,
      thesis: null,
      entryProbability: null,
      entryPrice: price({ yesPrice: "0.5" }),
      visibility: "public",
      createdAt: NOW - H,
      lockedAt: NOW - H,
      parentCallId: null,
      fundingState: "NONE",
    },
    author: { id: over.userId ?? "u-ada", handle: "ada", displayName: "Ada", avatarUrl: null, settledCalls: 0, correctCalls: 0 },
    market: {
      id: "m1",
      venue: "panta",
      venueMarketId: "X",
      question: "Will it?",
      rulesText: "Rules.",
      category: "crypto",
      outcomes: [
        { side: "YES", label: "Yes" },
        { side: "NO", label: "No" },
      ],
      status: (over.status ?? "OPEN") as "OPEN",
      opensAt: null,
      closesAt: over.closesAt === undefined ? NOW + 2 * D : over.closesAt,
      resolvesAt: null,
      resolutionSource: null,
    },
    result: { callId: "c1", outcome: over.outcome ?? "PENDING", resolution: over.outcome === "CORRECT" ? "YES" : null, resolvedAt: null },
    backCount: 0,
    fadeCount: 0,
    viewerHasCalled: over.viewerHasCalled ?? false,
  };
}

function record(correct: number, incorrect: number, accuracy = false): PublicRecord {
  const decided = correct + incorrect;
  return {
    counts: { correct, incorrect, voided: 0, resolved: decided, decided, pending: 0 },
    display: accuracy
      ? { mode: "accuracy", accuracy: correct / decided, correct, incorrect, decided }
      : { mode: "counts", correct, incorrect, decided, minimumDecided: 5 },
  };
}

// ── the BFF transport ────────────────────────────────────────────────────────

describe("web app BFF transport", () => {
  test("a query is tRPC's GET with a superjson input; the token is a header, never in the URL", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify(okBody({ entries: [], nextCursor: null })));
    }) as unknown as typeof fetch;
    const page = await bffCall<{ entries: unknown[] }>({ path: "calls.feed", input: { mode: "global" }, kind: "query", token: "secret-token", base: "https://bff.test" });
    expect(page.entries).toEqual([]);
    expect(seen[0]!.url).toBe(`https://bff.test/calls.feed?input=${encodeURIComponent(JSON.stringify({ json: { mode: "global" } }))}`);
    expect(seen[0]!.url).not.toContain("secret-token");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect(seen[0]!.init.method).toBe("GET");
  });

  test("a mutation is a POST with the input in a JSON body", async () => {
    let body = "";
    let method = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      method = String(init.method);
      return new Response(JSON.stringify(okBody({ userId: "u1" })));
    }) as unknown as typeof fetch;
    await bffCall({ path: "auth.whoami", input: { supabaseAccessToken: "tok" }, kind: "mutation", base: "https://bff.test" });
    expect(method).toBe("POST");
    expect(JSON.parse(body)).toEqual({ json: { supabaseAccessToken: "tok" } });
  });

  test("no token, no authorization header", async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify(okBody([])));
    }) as unknown as typeof fetch;
    await bffCall({ path: "markets.open", input: {}, kind: "query", token: null, base: "https://bff.test" });
    expect(headers.authorization).toBeUndefined();
  });

  test("errors come back as the four kinds the screens tell apart", () => {
    expect(() => parseTrpcResponse(401, errBody("UNAUTHORIZED", "Sign in to do that."))).toThrow(BffSignedOut);
    try {
      parseTrpcResponse(409, errBody("CONFLICT", "You already called this market."));
    } catch (e) {
      expect(e).toBeInstanceOf(BffRejected);
      expect((e as BffRejected).message).toBe("You already called this market.");
      expect((e as BffRejected).code).toBe("CONFLICT");
    }
    // A zod failure is serialized issues, not a sentence: never shown as-is.
    try {
      parseTrpcResponse(400, errBody("BAD_REQUEST", '[{"code":"invalid_type"}]'));
    } catch (e) {
      expect((e as Error).message).toBe("That didn’t work. Try again.");
    }
    expect(() => parseTrpcResponse(500, errBody("INTERNAL_SERVER_ERROR", "db exploded"))).toThrow(BffFailure);
    expect(() => parseTrpcResponse(503, errBody("SERVICE_UNAVAILABLE", "x"))).toThrow(BffFailure);
    expect(() => parseTrpcResponse(200, { nothing: true })).toThrow(BffFailure);
  });

  test("an identity refusal keeps its machine code (the session maps it to copy)", () => {
    try {
      parseTrpcResponse(403, errBody("FORBIDDEN", "AUTH_USER_UNLINKED"));
    } catch (e) {
      expect(e).toBeInstanceOf(BffRejected);
      expect((e as Error).message).toBe("AUTH_USER_UNLINKED");
    }
  });

  test("a request that never completes is Offline", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await expect(bffCall({ path: "calls.feed", input: {}, kind: "query", base: "https://bff.test" })).rejects.toBeInstanceOf(BffOffline);
  });

  test("superjson data comes back as real values", () => {
    const at = new Date(NOW);
    expect(parseTrpcResponse<{ at: Date }>(200, okBody({ at })).at.getTime()).toBe(NOW);
  });

  test("defaults to the production calls BFF and builds plain query URLs", () => {
    expect(BFF_URL).toMatch(/^https:\/\/.+[^/]$/);
    expect(queryUrl("https://b", "x.y", undefined)).toBe("https://b/x.y");
  });
});

// ── procedures ───────────────────────────────────────────────────────────────

describe("web app procedures", () => {
  function recorder() {
    const calls: Array<{ path: string; input: unknown; kind: string }> = [];
    const api = makeApi(async <T,>(path: string, input: unknown, kind: "query" | "mutation") => {
      calls.push({ path, input, kind });
      return {} as T;
    });
    return { api, calls };
  }

  test("token-taking identity procedures and people.find are mutations (bodies, not URLs)", async () => {
    const { api, calls } = recorder();
    await api.whoami("tok");
    await api.completeProfile("tok", "Joel", "joel");
    await api.claimUsername("tok", "joel");
    await api.find("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(calls.map((c) => [c.path, c.kind])).toEqual([
      ["auth.whoami", "mutation"],
      ["auth.completeProfile", "mutation"],
      ["auth.claimUsername", "mutation"],
      ["people.find", "mutation"],
    ]);
  });

  test("no input ever names a viewer, a user id or a wallet as identity", async () => {
    const { api, calls } = recorder();
    await api.feed("following", "cursor-1");
    await api.feed("global");
    await api.call("c1");
    await api.createCall({ marketId: "m1", side: "YES", thesis: "", visibility: "followers" });
    await api.respond({ targetCallId: "c1", kind: "challenge", note: "go on" });
    await api.addUpdate("c1", "still holding");
    await api.catalog(catalogInput(DEFAULT_FILTERS));
    await api.openMarkets();
    await api.market("m1");
    await api.person("@ada");
    await api.follow("u-ada");
    await api.unfollow("u-ada");
    await api.following();
    await api.suggested();
    await api.leaderboard("7d");
    await api.inbox();
    await api.unread();
    await api.markAllRead();
    await api.me();
    await api.updateProfile({ bio: "" });
    await api.usernameStatus("joel");
    const keys = calls.flatMap((c) => Object.keys((c.input ?? {}) as object));
    for (const banned of ["viewerUserId", "userId", "viewer", "wallet", "walletAddress", "recipient"]) {
      expect(keys).not.toContain(banned);
    }
  });

  test("inputs match the BFF's strict schemas", async () => {
    const { api, calls } = recorder();
    await api.createCall({ marketId: "m1", side: "NO", thesis: "" });
    await api.respond({ targetCallId: "c1", kind: "back", thesis: "because" });
    await api.person("@ada");
    await api.feed("global");
    expect(calls[0]!.input).toEqual({ marketId: "m1", side: "NO", visibility: "public" });
    expect(calls[1]!.input).toEqual({ targetCallId: "c1", kind: "back", thesis: "because" });
    expect(calls[2]!.input).toEqual({ personRef: "ada" });
    expect(calls[3]!.input).toEqual({ mode: "global", limit: 20 });
  });
});

// ── formatting ───────────────────────────────────────────────────────────────

describe("web app formatting", () => {
  test("a Panta price shows as percents that add up, only while fresh; otherwise a quiet null (never 'stale')", () => {
    // Independent USDC prices (0.62 + 0.43 > 1): YES = yes / (yes + no), NO = 100 − YES.
    expect(livePercent(price(), "YES", NOW)).toBe("59%");
    expect(livePercent(price(), "NO", NOW)).toBe("41%");
    expect(livePercent(price({ yesPrice: "1.25", noPrice: "0.35" }), "YES", NOW)).toBe("78%");
    expect(livePercent(price({ yesPrice: "1.25", noPrice: "0.35" }), "NO", NOW)).toBe("22%");
    expect(livePercent(price({ yesPrice: "0.625", noPrice: "0.375" }), "YES", NOW)).toBe("63%");
    expect(livePercent(price({ yesPrice: "0.625", noPrice: "0.375" }), "NO", NOW)).toBe("37%");
    expect(livePercent(price({ observedAt: NOW - 11 * 60_000 }), "YES", NOW)).toBeNull();
    // One side missing: the other reads alone; above a whole share, alone, is null.
    expect(livePercent(price({ noPrice: null }), "NO", NOW)).toBeNull();
    expect(livePercent(price({ noPrice: null }), "YES", NOW)).toBe("62%");
    expect(livePercent(price({ yesPrice: "1.2", noPrice: null }), "YES", NOW)).toBeNull();
    expect(livePercent(null, "YES", NOW)).toBeNull();
  });

  test("the percent a call was made at is the call's own side", () => {
    expect(calledAt({ side: "NO", entryPrice: price({ yesPrice: "0.53", noPrice: "0.47" }) })).toBe("47%");
    expect(calledAt({ side: "NO", entryPrice: price() })).toBe("41%");
    expect(calledAt({ side: "YES", entryPrice: null })).toBeNull();
  });

  test("a SOL-quoted market reads as the same percent, never in SOL, cents or dollars", () => {
    // last_yes_price / 1e9 and its complement: the figure panta.market shows.
    const sol = price({ currency: "SOL", yesPrice: "0.671739755", noPrice: "0.328260245" });
    expect(livePercent(sol, "YES", NOW)).toBe("67%");
    expect(livePercent(sol, "NO", NOW)).toBe("33%");
    expect(livePercent({ ...sol, observedAt: NOW - 11 * 60_000 }, "YES", NOW)).toBeNull();
    expect(calledAt({ side: "YES", entryPrice: sol })).toBe("67%");
    for (const label of [livePercent(sol, "YES", NOW), calledAt({ side: "NO", entryPrice: sol }), livePercent(price(), "YES", NOW)]) {
      expect(label).toMatch(/^\d{1,3}%$/);
      expect(label).not.toMatch(/[¢$]|USDC|SOL/);
    }
  });

  test("a call is marked Free, Funded only on a confirmed fill, and nothing in between", () => {
    const free = entry();
    expect(callMark(free)).toBe("free");
    expect(callMark({ ...free, funding: { venue: "panta" } })).toBe("funded");
    expect(callMark({ ...free, call: { ...free.call, fundingState: "FILLED" } })).toBe("funded");
    for (const state of ["QUOTED", "SUBMITTED", "PARTIAL", "FAILED"] as const) {
      expect(callMark({ ...free, call: { ...free.call, fundingState: state } })).toBeNull();
    }
  });

  test("a trade is offered only on a Panta market the BFF does not mark untradable", () => {
    expect(tradableMarket({ venue: "panta" })).toBe(true); // an older BFF: USDC only
    expect(tradableMarket({ venue: "panta", tradable: true })).toBe(true);
    expect(tradableMarket({ venue: "panta", tradable: false })).toBe(false); // SOL-quoted
    expect(tradableMarket({ venue: "fixture", tradable: true })).toBe(false);
  });

  test("time is one short token", () => {
    expect(closesIn(NOW + 47 * D + H, NOW)).toBe("47d");
    expect(closesIn(NOW + 5 * H, NOW)).toBe("5h");
    expect(closesIn(NOW + 30 * H, NOW)).toBe("30h");
    expect(closesIn(NOW + 12 * 60_000, NOW)).toBe("12m");
    expect(closesIn(NOW - 1, NOW)).toBeNull();
    expect(closesIn(null, NOW)).toBeNull();
    expect(closingSoon(NOW + 5 * H, NOW)).toBe(true);
    expect(closingSoon(NOW + 2 * D, NOW)).toBe(false);
    expect(ago(NOW - 10_000, NOW)).toBe("now");
    expect(ago(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(ago(NOW - 3 * H, NOW)).toBe("3h");
    expect(ago(NOW - 2 * D, NOW)).toBe("2d");
    expect(ago(Date.UTC(2026, 8, 3), NOW)).toBe("3 Sep");
    expect(stamp(Date.UTC(2026, 9, 3, 14, 5))).toBe("3 Oct 2026, 14:05 UTC");
    expect(joined(Date.UTC(2026, 7, 20))).toBe("Joined Aug 2026");
  });

  test("a day for a band or a chip is short; the year shows only when it is not this one", () => {
    expect(shortDay(Date.UTC(2026, 9, 1, 7, 50), NOW)).toBe("1 Oct");
    expect(shortDay(Date.UTC(2025, 11, 31, 23, 59), NOW)).toBe("31 Dec 2025");
    expect(stamp(Date.UTC(2026, 9, 1, 7, 50))).toBe("1 Oct 2026, 07:50 UTC");
  });

  test("a record is counts until enough calls settle, then an accuracy the BFF sent", () => {
    expect(recordToken(record(3, 1))).toBe("3–1");
    expect(recordToken(record(8, 2, true))).toBe("80%");
    expect(recordToken(record(0, 0))).toBeNull();
    expect(recordA11y(record(3, 1))).toBe("3 right, 1 wrong");
    expect(recordA11y(record(0, 0))).toBe("No settled calls yet");
  });

  test("Back and Fade are offered only where the BFF would accept them", () => {
    expect(canAnswer(entry(), "u-me", NOW)).toBe(true);
    expect(canAnswer(entry({ userId: "u-me" }), "u-me", NOW)).toBe(false); // own call
    expect(canAnswer(entry({ viewerHasCalled: true }), "u-me", NOW)).toBe(false); // one call per market
    expect(canAnswer(entry({ outcome: "CORRECT" }), "u-me", NOW)).toBe(false); // settled
    expect(canAnswer(entry({ closesAt: NOW - 1 }), "u-me", NOW)).toBe(false); // closed
    expect(canAnswer(entry({ status: "PAUSED" }), "u-me", NOW)).toBe(false);
    expect(takesCalls(entry().market, NOW, NOW - 1)).toBe(false); // past the call cut-off
  });

  test("topics look the same as in the app", () => {
    expect(topicLabel("pop-culture")).toBe("Pop culture");
    expect(topicIcon("crypto")).toBe("lightning");
    expect(topicIcon("sports")).toBe("award");
    expect(topicIcon("gaming")).toBe("gamepad");
    expect(topicIcon("something-new")).toBe("lightbulb");
    expect(shortWallet("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX…gAsU");
  });
});

// ── markets filters ──────────────────────────────────────────────────────────

describe("web app price refusals", () => {
  // The BFF's own words (CallsService.lockCall), as a 400 the screens can read.
  const lapsed = () => new BffRejected("Panta prices are missing or stale. Refresh before locking your call.", "BAD_REQUEST");

  test("a lapsed price is re-read and the call locked once more, with nothing said", async () => {
    let attempts = 0;
    let refreshes = 0;
    const out = await retryAfterPriceRefresh(
      async () => {
        attempts++;
        if (attempts === 1) throw lapsed();
        return "locked";
      },
      async () => {
        refreshes++;
      },
    );
    expect({ out, attempts, refreshes }).toEqual({ out: "locked", attempts: 2, refreshes: 1 });
  });

  test("a second refusal comes back to the screen, which says only that prices are updating", async () => {
    let attempts = 0;
    const failed = await retryAfterPriceRefresh(
      async () => {
        attempts++;
        throw lapsed();
      },
      async () => undefined,
    ).catch((e: unknown) => e);
    expect(attempts).toBe(2);
    expect(isPriceRefusal(failed)).toBe(true);
    expect(PRICE_UPDATING).not.toMatch(/stale|missing|incomplete|refresh/i);
  });

  test("any other refusal is not retried, and a failed re-read still gets its one retry", async () => {
    let attempts = 0;
    let refreshes = 0;
    const closed = await retryAfterPriceRefresh(
      async () => {
        attempts++;
        throw new BffRejected("This market has closed.", "BAD_REQUEST");
      },
      async () => {
        refreshes++;
      },
    ).catch((e: unknown) => e);
    expect({ message: (closed as Error).message, attempts, refreshes }).toEqual({ message: "This market has closed.", attempts: 1, refreshes: 0 });

    attempts = 0;
    const out = await retryAfterPriceRefresh(
      async () => {
        attempts++;
        if (attempts === 1) throw lapsed();
        return "locked";
      },
      async () => {
        throw new BffOffline("You’re offline.", "OFFLINE");
      },
    );
    expect({ out, attempts }).toEqual({ out: "locked", attempts: 2 });
    expect(isPriceRefusal("Panta prices are missing or stale")).toBe(false);
    expect(isPriceRefusal(new Error("Nothing to do with prices"))).toBe(false);
  });
});

describe("web app market filters", () => {
  const ms = [
    { id: "a", closesAt: NOW + 5 * H },
    { id: "b", closesAt: NOW + 3 * D },
    { id: "c", closesAt: NOW + 20 * D },
    { id: "d", closesAt: null },
  ];
  test("the close-time window keeps markets closing inside it", () => {
    expect(withinWindow(ms, "any", NOW).map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(withinWindow(ms, "24h", NOW).map((m) => m.id)).toEqual(["a"]);
    expect(withinWindow(ms, "7d", NOW).map((m) => m.id)).toEqual(["a", "b"]);
    expect(withinWindow(ms, "30d", NOW).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("search, topic and sort go to the catalog; the badge counts what is on", () => {
    const f = { query: "  bitcoin ", topic: "crypto", sort: "closing" as const, window: "7d" as const };
    expect(catalogInput(f, "k1.next")).toEqual({ scope: "open", sort: "closing", limit: 50, category: "crypto", query: "bitcoin", cursor: "k1.next" });
    expect(catalogInput(DEFAULT_FILTERS)).toEqual({ scope: "open", sort: "volume", limit: 50 });
    expect(activeFilterCount(f)).toBe(3);
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });

  test("saved filters are restored only when they are known values; search is per visit", () => {
    expect(parseFilters({ topic: "sports", sort: "closing", window: "24h", query: "x" })).toEqual({ query: "", topic: "sports", sort: "closing", window: "24h" });
    expect(parseFilters({ topic: "<script>", sort: "random", window: "1y" })).toEqual(DEFAULT_FILTERS);
    expect(parseFilters(null)).toEqual(DEFAULT_FILTERS);
  });
});

// ── sign-in ──────────────────────────────────────────────────────────────────

describe("web app sign-in", () => {
  test("the Sign-in-with-Solana message is the app's, line for line", () => {
    const msg = signInMessage({
      domain: "chumbucket.fun",
      uri: "https://chumbucket.fun",
      address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      issuedAt: new Date(NOW),
    });
    // solana_sign_in.dart `solanaSignInMessage`, with its constants.
    expect(msg).toBe(
      [
        "chumbucket.fun wants you to sign in with your Solana account:",
        "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        "",
        "Sign in to Chumbucket. This is a signature, not a transaction: it costs nothing and moves nothing.",
        "",
        "Version: 1",
        "URI: https://chumbucket.fun",
        "Issued At: 2026-10-04T12:00:00.000Z",
      ].join("\n"),
    );
    expect(SIGN_IN_STATEMENT).not.toContain("\n");
    // Cross-repo check when the mobile checkout sits beside this one.
    const dart = join(import.meta.dir, "../../chumbucket-social-calls/lib/features/authentication/session/solana_sign_in.dart");
    if (existsSync(dart)) expect(readFileSync(dart, "utf8").replace(/'\s*\n\s*'/g, "")).toContain(SIGN_IN_STATEMENT);
  });

  test("the wallet must sign exactly the message it was given", () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  test("usernames: the BFF's format, suggested from the provider, never invented", () => {
    expect(USERNAME_FORMAT.test("joel_99")).toBe(true);
    expect(USERNAME_FORMAT.test("Jo")).toBe(false);
    expect(normaliseUsername("  @@Joel ")).toBe("joel");
    expect(suggestUsername({ xUsername: "Joel_X" })).toBe("joel_x");
    expect(suggestUsername({ name: "Ada Okafor" })).toBe("ada_okafor");
    expect(suggestUsername({ email: "zara.b@example.com" })).toBe("zarab");
    expect(suggestUsername({ name: "李" })).toBe("");
    expect(xUsernameHint({ user_name: "joel" }, "x")).toBe("joel");
    expect(xUsernameHint({ user_name: "joel" }, "google")).toBeNull();
    expect(nameHint({ full_name: " Joel Example " })).toBe("Joel Example");
  });

  test("identity refusals are short lines, and unknown codes say only that it failed", () => {
    expect(identityCopy("USERNAME_TAKEN")).toBe("That username is taken.");
    expect(identityCopy("SOMETHING_ELSE")).toBe("Couldn’t reach Chumbucket. Try again.");
  });
});

// ── state that persists ──────────────────────────────────────────────────────

describe("web app saved state", () => {
  test("one slot per account; a different account sees nothing", () => {
    const s = memoryStorage();
    expect(saveCache(s, "u1", { queries: [{ queryKey: ["me"], state: { data: { a: 1 } } }] }, NOW)).toBe(true);
    expect(loadCache(s, "u1", NOW + H)).toEqual({ mutations: [], queries: [{ queryKey: ["me"], state: { data: { a: 1 } } }] });
    expect(loadCache(s, "u2", NOW)).toBeNull();
    clearCache(s, "u1");
    expect(s.data.has(cacheKey("u1"))).toBe(false);
  });

  test("a cache older than a week is dropped", () => {
    const s = memoryStorage();
    saveCache(s, "u1", { queries: [] }, NOW);
    expect(loadCache(s, "u1", NOW + CACHE_MAX_AGE_MS + 1)).toBeNull();
    expect(s.data.size).toBe(0);
  });

  test("infinite lists keep their first page; oversize caches are not written", () => {
    const trimmed = trimForStorage({
      queries: [{ queryKey: ["feed"], state: { data: { pages: [1, 2, 3], pageParams: [null, "a", "b"] } } }],
      mutations: [{ x: 1 }],
    }) as { queries: Array<{ state: { data: unknown } }>; mutations: unknown[] };
    expect(trimmed.queries[0]!.state.data).toEqual({ pages: [1], pageParams: [null] });
    expect(trimmed.mutations).toEqual([]);
    const s = memoryStorage();
    expect(saveCache(s, "u1", { queries: [{ state: { data: "x".repeat(CACHE_MAX_BYTES) } }] }, NOW)).toBe(false);
    expect(s.data.size).toBe(0);
  });

  test("storage that throws (private windows) never breaks the app", () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(saveCache(broken, "u1", {}, NOW)).toBe(false);
    expect(loadCache(broken, "u1", NOW)).toBeNull();
    expect(readPref(broken, "homeTab", String, "global")).toBe("global");
    expect(() => writePref(broken, "homeTab", "x")).not.toThrow();
    expect(() => clearCache(broken, "u1")).not.toThrow();
  });
});

// ── paths ────────────────────────────────────────────────────────────────────

describe("web app paths", () => {
  test("the web app lives at /app and mirrors the share pages' paths", () => {
    expect(APP_BASE).toBe("/app");
    expect(appPath.call("c 1")).toBe("/app/c/c%201");
    expect(appPath.person("@ada")).toBe("/app/u/ada");
    expect(appPath.market("m1")).toBe("/app/m/m1");
    // A wallet the BFF refuses as unlinked is linked in Settings → Sign-in methods.
    expect(appPath.signInMethods).toBe("/app/me?settings=sign-in");
    expect(safeReturnPath(appPath.signInMethods)).toBe(appPath.signInMethods);
    expect(publicPath.receipt("c1")).toBe("/c/c1");
    expect(publicPath.profile("@ada")).toBe("/u/ada");
  });

  test("Back goes back only to a screen this visit saw in the app, never off the site", () => {
    // Opened straight from a link (on X, say): nothing in the app to go back to.
    let trail = nextTrail([], "/app/c/c1");
    expect(canGoBack(trail)).toBe(false);
    // A step into a profile: Back returns to the call.
    trail = nextTrail(trail, "/app/u/ada");
    expect(trail).toEqual(["/app/c/c1", "/app/u/ada"]);
    expect(canGoBack(trail)).toBe(true);
    // The browser's own Back to the call: the trail shortens, so the top bar's
    // Back now goes Home instead of history.back() off the site (a screen
    // counter got this wrong: it had seen three screens).
    trail = nextTrail(trail, "/app/c/c1");
    expect(trail).toEqual(["/app/c/c1"]);
    expect(canGoBack(trail)).toBe(false);
    // The same path again (a re-render, a query string change) is not a step.
    expect(nextTrail(trail, "/app/c/c1")).toEqual(["/app/c/c1"]);
    // A long visit stays bounded.
    let long: string[] = [];
    for (let i = 0; i < TRAIL_MAX + 25; i++) long = nextTrail(long, `/app/c/${i}`);
    expect(long.length).toBe(TRAIL_MAX);
    expect(long[long.length - 1]).toBe(`/app/c/${TRAIL_MAX + 24}`);
  });

  test("sign-in only ever returns inside the web app", () => {
    expect(safeReturnPath("/app/c/123")).toBe("/app/c/123");
    expect(safeReturnPath("/app")).toBe("/app");
    expect(safeReturnPath("//evil.example/app")).toBe("/app");
    expect(safeReturnPath("https://evil.example")).toBe("/app");
    expect(safeReturnPath("/apps/elsewhere")).toBe("/app");
    expect(safeReturnPath("/app\\@evil")).toBe("/app");
    expect(safeReturnPath(null)).toBe("/app");
    expect(safeDecode("%E0%A4%A")).toBe("%E0%A4%A");
    expect(safeDecode("ada%20b")).toBe("ada b");
  });

  test("share pages open the same thing in the web app, only when a deploy names one", () => {
    expect(webAppHref("/app", "c", "c1")).toBe("/app/c/c1");
    expect(webAppHref("/app/", "u", "@ada")).toBe("/app/u/ada");
    expect(webAppHref("https://chumbucket.fun/app", "m", "m 1")).toBe("https://chumbucket.fun/app/m/m%201");
    expect(webAppHref(null, "c", "c1")).toBeNull();
    expect(webAppHref("javascript:alert(1)", "c", "c1")).toBeNull();
    expect(webAppHref("//evil.example", "c", "c1")).toBeNull();
  });
});

// ── the owner's rules, checked over the source ───────────────────────────────

function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(tsx?|css)$/.test(name) && name !== "Icon.tsx") out.push({ file: path, text: readCode(path) });
  }
  return out;
}

describe("web app rules", () => {
  const files = [...sources(join(WEB, "components/webapp")), ...sources(join(WEB, "app/app")), ...sources(join(WEB, "lib/webapp"))];

  test("there is a web app at /app, with every screen the app has", () => {
    expect(files.length).toBeGreaterThan(20);
    for (const route of ["page.tsx", "markets/page.tsx", "m/[marketId]/page.tsx", "c/[callId]/page.tsx", "u/[handle]/page.tsx", "me/page.tsx", "activity/page.tsx", "friends/page.tsx", "leaderboard/page.tsx"]) {
      expect({ route, exists: existsSync(join(WEB, "app/app", route)) }).toEqual({ route, exists: true });
    }
  });

  test("uses none of the banned words", () => {
    const BANNED = [/\bbets?\b/i, /\bbetting\b/i, /\bwin money\b/i, /\bearn\b/i, /\brisk-free\b/i, /\bguaranteed?\b/i, /\bodds\b/i, /\bjackpot\b/i, /\bairdrop\b/i, /\bplay money\b/i, /\bstake\b/i, /\bpots?\b/i, /\bTxLINE\b/, /\bfootball\b/i, /\bwager\b/i];
    for (const { file, text } of files) {
      for (const word of BANNED) expect({ file, match: text.match(word)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });

  test("stateful: no refresh buttons and no 'updated X ago' anywhere", () => {
    const STALE_UI = [/["'>]\s*Refresh\b/, /\bRetry\b/, /Last (updated|refreshed)/i, /updated \S+ ago/i, /refreshed \S+ ago/i, /icon[=:]\s*\{?["']refresh/];
    for (const { file, text } of files) {
      for (const pattern of STALE_UI) expect({ file, match: text.match(pattern)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });

  test("no meta text nobody needs, and no internal states", () => {
    const NOISE = [/Powered by Panta/, /USDC\s*\/\s*share/i, /USDC per share/i, /stale or incomplete/i, /\d+ open markets/, /soonest to close/i, /\bincomplete\b/i];
    for (const { file, text } of files) {
      for (const pattern of NOISE) expect({ file, match: text.match(pattern)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });

  test("calls are free and trades can lose money, said plainly", () => {
    const all = files.map((f) => f.text).join("\n");
    expect(all).toMatch(/Calls are free/);
    expect(all).toMatch(/can lose (what you put in|money)/);
  });

  test("empty and error screens use the app's state art, and every image exists", () => {
    const arts = new Set<string>();
    for (const { text } of files) for (const m of text.matchAll(/art(?:=|:\s*)\{?\s*[^}\n]*?"(empty_calls|error|inbox|offline|people|record|search|success)"/g)) arts.add(m[1]!);
    for (const { text } of files) for (const m of text.matchAll(/\/img\/states\/([a-z_]+)\.webp/g)) arts.add(m[1]!);
    expect(arts.size).toBeGreaterThanOrEqual(6);
    for (const art of arts) expect({ art, exists: existsSync(join(WEB, "public/img/states", `${art}.webp`)) }).toEqual({ art, exists: true });
  });

  test("every icon a screen names is one the app ships", () => {
    const icons = readFileSync(join(WEB, "components/webapp/Icon.tsx"), "utf8");
    const known = new Set([...icons.matchAll(/^\s+"([a-z0-9-]+)":/gm)].map((m) => m[1]!));
    known.add("x-brand");
    const used = new Set<string>();
    for (const { text } of files) for (const m of text.matchAll(/<Icon name="([a-z0-9-]+)"/g)) used.add(m[1]!);
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) {
      expect({ name, known: known.has(name) || known.has(`${name}-outline`) }).toEqual({ name, known: true });
    }
  });

  test("sheets have no X close button: they close by drag, handle, backdrop or Escape", () => {
    const ui = readCode(join(WEB, "components/webapp/ui.tsx"));
    const sheet = ui.slice(ui.indexOf("export function Sheet("), ui.indexOf("export function TopBar("));
    expect(sheet).toContain('aria-label="Close"');
    expect(sheet).toContain("wa-sheet-handle");
    expect(sheet).not.toMatch(/name="cross"/);
    expect(sheet).toContain('e.key === "Escape"');
  });

  test("the web app ships none of the Arena: no Arena session, no escrow; Privy only as the Chumbucket wallet", () => {
    for (const { file, text } of files) {
      expect({ file, match: text.match(/@\/lib\/session|@\/lib\/trpc|arena-onchain|AppProviders|@solana\/web3\.js/)?.[0] ?? null }).toEqual({ file, match: null });
      // Privy is the Chumbucket wallet's provider, imported in exactly one file, loaded on first need.
      if (!file.endsWith("ChumbucketWalletPrivy.tsx")) expect({ file, match: text.match(/@privy-io/)?.[0] ?? null }).toEqual({ file, match: null });
    }
    const root = readCode(join(WEB, "components/webapp/chumbucketWallet.tsx"));
    expect(root).toContain('dynamic(() => import("./ChumbucketWalletPrivy"), { ssr: false })');
    expect(root).toContain('process.env.NEXT_PUBLIC_CHUMBUCKET_WALLET_ENABLED === "true"');
  });

  test("a wallet only ever signs a trade the BFF built; the browser never sends one", () => {
    for (const { file, text } of files) {
      expect({ file, match: text.match(/signAndSendTransaction|sendTransaction|sendRawTransaction/)?.[0] ?? null }).toEqual({ file, match: null });
    }
    // The one Wallet Standard signing path, and it checks the bytes it got back.
    const wallets = readCode(join(WEB, "components/webapp/wallets.ts"));
    expect(wallets).toContain('"solana:signTransaction"');
    expect(wallets).toContain("signedOnlyInSlot(transaction, signed, 0)");
  });

  test("the retired Arena pages are gone and their paths lead to the web app", () => {
    expect(existsSync(join(WEB, "app/(app)"))).toBe(false);
    expect(existsSync(join(WEB, "app/signin"))).toBe(false);
    const config = readFileSync(join(WEB, "next.config.ts"), "utf8");
    for (const path of ["/signin", "/arena", "/matchday", "/bet", "/challenge/:matchId", "/caller/:wallet", "/wallet", "/send"]) {
      expect(config).toContain(`toApp("${path}"`);
    }
    // Old challenge links keep rendering.
    expect(config).toContain("/legacy-challenge/:challengeId");
    expect(existsSync(join(WEB, "app/legacy-challenge/[challengeId]/page.tsx"))).toBe(true);
  });

  test("a call you can no longer answer shows no inert Back or Fade", () => {
    const screen = readCode(join(WEB, "components/webapp/screens/CallScreen.tsx"));
    // Back and Fade render only where the BFF would take them…
    expect(screen).toMatch(/\{answerable \? \(/);
    expect(screen).toContain("wa-respond--two");
    // …so none of the response tiles is ever a disabled button that looks live.
    for (const m of screen.matchAll(/<button[^>]*wa-respond-btn[^>]*>/g)) expect(m[0]).not.toContain("disabled");
  });

  test("a free call never reads as a trade: percent only, the Free mark, and no 'Lock'", () => {
    const MONEYISH = [/¢/, /a share on Panta/i, /per share/i, /USDC\s*\/\s*share/i, /SOL\s*\/\s*share/i, /Locked at/i, /\bLock \{/, /["'>]\s*Lock\b/, /Traded/];
    for (const { file, text } of files) {
      if (file.endsWith(".css")) continue;
      for (const pattern of MONEYISH) expect({ file, match: text.match(pattern)?.[0] ?? null }).toEqual({ file, match: null });
    }
    const ui = readCode(join(WEB, "components/webapp/ui.tsx"));
    expect(ui).toMatch(/export function FreeChip\(\)[\s\S]*?wa-chip--free[\s\S]*?name="present"[\s\S]*?Free call[\s\S]*?>Free</);
    expect(ui).toMatch(/export function FundedChip[\s\S]*?wa-chip--funded[\s\S]*?"Funded"/);
    // One marker everywhere a call shows.
    for (const screen of ["cards.tsx", "screens/CallScreen.tsx", "screens/MarketScreen.tsx", "screens/DoorScreens.tsx"]) {
      expect({ screen, marked: /<CallMarkChip entry=/.test(readCode(join(WEB, "components/webapp", screen))) }).toEqual({ screen, marked: true });
    }
    const market = readCode(join(WEB, "components/webapp/screens/MarketScreen.tsx"));
    // The CTA is a call, carrying the Free mark; the toast says free.
    expect(market).toMatch(/<span className="wa-btn-label">Call \{sideLabel\(market, pick\)\}<\/span>\s*<FreeChip \/>/);
    expect(market).toContain('toast(`Called ${sideLabel(market, entry.call.side)}${callMark(entry) === "free" ? " · Free" : ""}`)');
    expect(market).toContain("You called {sideLabel(market, viewerCall.call.side)}");
    const respond = readCode(join(WEB, "components/webapp/ResponseSheet.tsx"));
    expect(respond).toContain("<FreeChip />");
    expect(respond).not.toMatch(/Locked once you tap/);
    const css = readFileSync(join(WEB, "components/webapp/app.css"), "utf8");
    expect(css).toMatch(/\.wa-chip--free \{[^}]*background: transparent/);
    expect(css).toMatch(/\.wa-chip--funded \{[^}]*background: var\(--wa-coral\)/);
  });

  test("pink is money: a free call's action is the strong ink button", () => {
    const css = readFileSync(join(WEB, "components/webapp/app.css"), "utf8");
    expect(css).toMatch(/\.wa-btn--ink \{[^}]*min-height: 56px[^}]*background: var\(--wa-ink\)/);
    // The lock bar, the response sheet and the rail's "Make a call" are free calls.
    const market = readCode(join(WEB, "components/webapp/screens/MarketScreen.tsx"));
    expect(market).toMatch(/className="wa-btn wa-btn--ink"[\s\S]*?Call \{sideLabel\(market, pick\)\}<\/span>\s*<FreeChip \/>/);
    const respond = readCode(join(WEB, "components/webapp/ResponseSheet.tsx"));
    expect(respond).toMatch(/className="wa-btn wa-btn--ink wa-btn--block"[\s\S]*?<span className="wa-btn-label">\{cta\}<\/span>\s*<FreeChip \/>/);
    expect(respond).not.toContain("wa-btn--primary");
    expect(readCode(join(WEB, "components/webapp/Shell.tsx"))).toMatch(/wa-btn--ink wa-railcta" aria-label="Make a call"/);
    // A dare is free too: neutral ink, never the pink of money.
    expect(css).toMatch(/\.wa-respond-btn--dare \{[^}]*color: var\(--wa-ink\)/);
    expect(css).not.toMatch(/\.wa-respond-btn--dare \{[^}]*pink/);
    expect(readCode(join(WEB, "components/webapp/screens/ActivityScreen.tsx"))).toContain('dare: { bg: "var(--wa-line)", fg: "var(--wa-ink)" }');
  });

  test("the free call's button never pushes a 320px page sideways", () => {
    const css = readFileSync(join(WEB, "components/webapp/app.css"), "utf8");
    // It may shrink (min-width 0), its label ellipsises, the Free chip keeps its size…
    expect(css).toMatch(/\.wa-btn--ink \{\s*min-width: 0;/);
    expect(css).toMatch(/\.wa-btn-label \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.wa-btn \.wa-chip--free \{\s*flex: none;/);
    // …and below 360px the chip is its gift alone (the words stay for screen readers).
    expect(css).toMatch(/@media \(max-width: 359px\) \{[\s\S]*?\.wa-btn \.wa-chip--free > span\[aria-hidden\] \{\s*display: none;/);
  });

  test("Panta's compact mark sits beside the market's trade, never as a sentence", () => {
    const ui = readCode(join(WEB, "components/webapp/ui.tsx"));
    expect(ui).toMatch(/export function PantaMark\(\)[\s\S]*?wa-pantamark[\s\S]*?on Panta[\s\S]*?>Panta</);
    const market = readCode(join(WEB, "components/webapp/screens/MarketScreen.tsx"));
    expect(market).toMatch(/Trade\s*<PantaMark \/>/);
    for (const screen of ["cards.tsx", "screens/CallScreen.tsx", "screens/HomeScreen.tsx", "screens/MarketsScreen.tsx", "screens/PersonScreen.tsx"]) {
      expect({ screen, mark: readCode(join(WEB, "components/webapp", screen)).includes("PantaMark") }).toEqual({ screen, mark: false });
    }
  });

  test("a settled, closed or SOL-quoted market offers no trade, and shows your result", () => {
    const screen = readCode(join(WEB, "components/webapp/screens/MarketScreen.tsx"));
    expect(screen).toMatch(/\{viewerCall && open && tradableMarket\(market\)/);
    expect(screen).not.toMatch(/market\.venue === "panta" \? \(\s*<button/);
    expect(screen).toContain("{outcomeLabel(mine)}");
  });

  test("the way in says offline only when the network is the reason", () => {
    const session = readCode(join(WEB, "components/webapp/session.tsx"));
    expect(session).toMatch(/e instanceof BffOffline\s*\?\s*\{ offline: true, line: "You’re offline" \}/);
    expect(session).toContain("offline: false");
  });

  test("the web app is not indexed (it is per account)", () => {
    const layout = readFileSync(join(WEB, "app/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});

describe("web app: sign-in methods", () => {
  function recorder() {
    const calls: Array<{ path: string; input: unknown; kind: string }> = [];
    const api = makeApi(async <T,>(path: string, input: unknown, kind: "query" | "mutation") => {
      calls.push({ path, input, kind });
      return {} as T;
    });
    return { api, calls };
  }

  test("every link procedure is a mutation; the only identity input is a session token", async () => {
    const { api, calls } = recorder();
    await api.signInMethods("tok");
    await api.unlinkSignIn("tok", "w:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    await api.startSignInLink("tok", "x");
    await api.previewSignInLink("other-tok", "ab".repeat(32));
    await api.completeSignInLink("other-tok", "ab".repeat(32));
    await api.requestWalletNonce("tok", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "chumbucket.fun", "https://chumbucket.fun");
    await api.linkWallet("tok", { address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", message: "message", signature: "signature" });
    expect(calls.map((c) => [c.path, c.kind])).toEqual([
      ["auth.signInMethods", "mutation"],
      ["auth.unlinkSignIn", "mutation"],
      ["auth.startSignInLink", "mutation"],
      ["auth.previewSignInLink", "mutation"],
      ["auth.completeSignInLink", "mutation"],
      ["auth.requestWalletNonce", "mutation"],
      ["auth.linkWallet", "mutation"],
    ]);
    // The other side's token is the procedure's own input, never a header swap.
    expect(calls[3]!.input).toEqual({ supabaseAccessToken: "other-tok", ticket: "ab".repeat(32) });
    for (const banned of ["userId", "authUserId", "viewerUserId"]) {
      expect(calls.flatMap((c) => Object.keys(c.input as object))).not.toContain(banned);
    }
  });

  test("rows read as @x, an email or a short wallet; refusals as one line", () => {
    expect(KINDS).toEqual(["wallet", "x", "google"]);
    expect(methodLabel({ kind: "x", label: "ownerx" })).toBe("@ownerx");
    expect(methodLabel({ kind: "wallet", label: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" })).toBe("7xKX…gAsU");
    expect(methodLabel({ kind: "google", label: null })).toBe("Google");
    expect(accountName({ userId: "u", handle: "dev", displayName: "Dev" })).toBe("@dev");
    expect(linkCopy("ACCOUNT_HAS_MONEY")).toContain("stays separate");
    expect(linkCopy("identity_already_exists")).toContain("another account");
    expect(linkCopy("anything else")).toBe("That didn’t work. Try again.");
  });

  test("the proof window never starts this site's auth client, and drops its tokens", () => {
    const root = readCode(join(WEB, "components/webapp/WebAppRoot.tsx"));
    expect(root).toContain("LINK_CALLBACK_PATH");
    expect(LINK_CALLBACK_PATH).toBe("/app/link");
    expect(existsSync(join(WEB, "app/app/link/page.tsx"))).toBe(true);
    const callback = readCode(join(WEB, "components/webapp/LinkCallback.tsx"));
    expect(callback).not.toMatch(/authClient|from "\.\/session"|refresh_token/);
    expect(callback).toContain("history.replaceState");
    const plumbing = readCode(join(WEB, "components/webapp/linking.ts"));
    // A separate, unpersisted client for proofs; the page's own session is untouched.
    expect(plumbing).toMatch(/persistSession: false/);
    expect(plumbing).toMatch(/BroadcastChannel/);
  });
});
