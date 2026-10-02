import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { COVER_SIZE, coverPng } from "../src/marketCreation/cover.ts";
import {
  isPublicSourceUrl, normalizeDraft, pantaTimes, PANTA_CREATE_CATEGORIES, PANTA_MIN_START_DELAY_S, publishDeadline,
  PUBLISH_MIN_LEAD_MS, START_MARGIN_S, validateDraft, type MarketDraft,
} from "../src/marketCreation/rules.ts";

const NOW = 1_790_000_000_000;
const HOUR = 3_600_000;
const draft = (overrides: Partial<MarketDraft> = {}): MarketDraft => normalizeDraft({
  question: "Will BTC close above $120,000 on 31 Dec 2026?", category: "crypto",
  closesAt: NOW + 48 * HOUR, resolvesAt: NOW + 49 * HOUR,
  rules: "Resolves YES if the CoinGecko BTC/USD daily close for 31 Dec 2026 (UTC) is above 120,000.",
  sources: ["https://www.coingecko.com/en/coins/bitcoin"], description: null, ...overrides,
});
const fields = (d: MarketDraft) => validateDraft(d, NOW).map(p => p.field);

test("a complete draft within Panta's rules has no problems", () => {
  expect(validateDraft(draft(), NOW)).toEqual([]);
  expect(PANTA_CREATE_CATEGORIES).toEqual(["sports", "crypto", "politics", "entertainment", "finance", "science", "world", "other"]);
});

test("Panta's documented limits are enforced: question 512, rules 2048, 1-20 sources, allowlisted category", () => {
  expect(fields(draft({ question: "Too short" }))).toEqual(["question"]);
  expect(fields(draft({ question: `Will ${"x".repeat(510)}?` }))).toEqual(["question"]);
  expect(fields(draft({ question: `Will ${"x".repeat(506)}?` }))).toEqual([]);
  expect(fields(draft({ rules: "x".repeat(2049) }))).toEqual(["rules"]);
  expect(fields(draft({ rules: "YES if it happens" }))).toEqual(["rules"]);
  expect(fields(draft({ sources: [] }))).toEqual(["sources"]);
  expect(fields(draft({ sources: Array.from({ length: 21 }, (_, i) => `https://example${i}.com`) }))).toEqual(["sources"]);
  expect(fields(draft({ category: "pop-culture" }))).toEqual(["category"]);
  expect(fields(draft({ category: "gaming" }))).toEqual(["category"]);
  expect(fields(draft({ description: "d".repeat(1001) }))).toEqual(["description"]);
});

test("times: lead for review, horizon, and resolution not before close", () => {
  expect(fields(draft({ closesAt: NOW + 2 * HOUR, resolvesAt: NOW + 3 * HOUR }))).toEqual(["closesAt"]);
  expect(fields(draft({ closesAt: NOW + 3 * HOUR, resolvesAt: NOW + 3 * HOUR }))).toEqual([]);
  expect(fields(draft({ closesAt: NOW + 731 * 24 * HOUR, resolvesAt: NOW + 731 * 24 * HOUR }))).toEqual(["closesAt"]);
  expect(fields(draft({ resolvesAt: NOW + 47 * HOUR }))).toEqual(["resolvesAt"]);
  expect(fields(draft({ resolvesAt: NOW + 48 * HOUR + 91 * 24 * HOUR }))).toEqual(["resolvesAt"]);
  expect(fields(draft({ closesAt: Number.NaN }))).toContain("closesAt");
});

test("sources must be public http(s) links; private and credentialed hosts are refused", () => {
  for (const ok of ["https://www.coingecko.com", "http://espn.com/nba/scores", "https://en.wikipedia.org/wiki/X"]) expect(isPublicSourceUrl(ok)).toBe(true);
  for (const bad of ["coingecko", "ftp://example.com", "https://localhost/x", "http://127.0.0.1/", "https://[::1]/",
    "https://user:pw@example.com", "https://router.local", "javascript:alert(1)", "https://exa mple.com", `https://e.com/${"a".repeat(600)}`]) {
    expect(isPublicSourceUrl(bad)).toBe(false);
  }
});

test("normalisation trims, collapses whitespace, lowercases the category and de-duplicates sources", () => {
  const d = normalizeDraft({ question: "  Will   it\nrain?  ", category: " Crypto ", closesAt: 1, resolvesAt: 2, rules: "  r  ",
    sources: [" https://a.com ", "https://a.com", ""], description: "   " });
  expect(d).toEqual({ question: "Will it rain?", category: "crypto", closesAt: 1, resolvesAt: 2, rules: "r", sources: ["https://a.com"], description: null });
});

test("Panta times use the earliest permitted start and respect start < end <= resolution", () => {
  const times = pantaTimes(draft(), NOW)!;
  expect(times.startTime).toBe(NOW / 1000 + PANTA_MIN_START_DELAY_S + START_MARGIN_S);
  expect(times.endTime).toBe((NOW + 48 * HOUR) / 1000);
  expect(times.resolutionTime).toBe((NOW + 49 * HOUR) / 1000);
  // A close inside the start delay cannot be created at all.
  expect(pantaTimes({ closesAt: NOW + HOUR, resolvesAt: NOW + HOUR }, NOW)).toBeNull();
  // The publish deadline is always on the right side of that boundary.
  const closesAt = NOW + 10 * HOUR;
  expect(publishDeadline(closesAt)).toBe(closesAt - PUBLISH_MIN_LEAD_MS);
  expect(pantaTimes({ closesAt, resolvesAt: closesAt }, publishDeadline(closesAt))).not.toBeNull();
});

test("the generated cover is a valid 1024x1024 RGB PNG, small, and distinct per category", () => {
  const png = coverPng("crypto");
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.readUInt32BE(16)).toBe(COVER_SIZE);
  expect(png.readUInt32BE(20)).toBe(COVER_SIZE);
  expect(png.length).toBeLessThan(200_000);
  const idatLength = png.readUInt32BE(33);
  expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  expect(raw.length).toBe((COVER_SIZE * 3 + 1) * COVER_SIZE);
  expect(coverPng("crypto")).toBe(png); // memoised
  expect(coverPng("sports").equals(png)).toBe(false);
});
