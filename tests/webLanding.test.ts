/**
 * The chumbucket.fun landing page (web/app/page.tsx): what its social-proof
 * section shows for every state of the public calls feed, and that its copy
 * keeps to the product's honesty rules (the same banned words the app's
 * onboarding copy test enforces). The page itself is proven by `next build`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { avatarSrc, type CallFeedEntry, type Leaderboard, type Person, type RecordCounts } from "../web/lib/callsBff.ts";
import { callerRecord, callersLine, pickCallers } from "../web/lib/landingPeople.ts";
import {
  callSentence,
  dayLabel,
  heroProofLink,
  pickFeatured,
  proofState,
  recentPeople,
  statusLine,
} from "../web/lib/landingProof.ts";

const OCT_2 = Date.UTC(2026, 9, 2, 14, 3);
/** How the sentence prints that day: no-break spaces, so it never splits. */
const DAY = "2\u00A0Oct\u00A02026";

function person(id: string, over: Partial<Person> = {}): Person {
  return { id, handle: id, displayName: `Person ${id}`, avatarUrl: null, settledCalls: 0, correctCalls: 0, ...over };
}

function entry(id: string, over: { author?: Person; outcome?: "PENDING" | "CORRECT" | "INCORRECT" | "VOID"; thesis?: string | null; price?: string | null; no?: string } = {}): CallFeedEntry {
  const outcome = over.outcome ?? "PENDING";
  return {
    call: {
      id,
      userId: (over.author ?? person("a")).id,
      marketId: `m-${id}`,
      side: "YES",
      confidence: null,
      thesis: over.thesis ?? null,
      entryPrice:
        over.price === null
          ? null
          : { venue: "panta", currency: "USDC", unit: "share", yesPrice: over.price ?? "0.5", noPrice: over.no ?? "0.5", observedAt: OCT_2, attribution: null },
      visibility: "public",
      createdAt: OCT_2,
      lockedAt: OCT_2,
      parentCallId: null,
      fundingState: "NONE",
    },
    author: over.author ?? person("a"),
    market: {
      id: `m-${id}`,
      venue: "panta",
      venueMarketId: "123",
      question: `Question ${id}?`,
      rulesText: null,
      category: null,
      outcomes: [
        { side: "YES", label: "Yes" },
        { side: "NO", label: "No" },
      ],
      status: outcome === "PENDING" ? "OPEN" : "RESOLVED",
      closesAt: null,
      resolvesAt: null,
    },
    result:
      outcome === "PENDING"
        ? null
        : {
            callId: id,
            outcome,
            resolution: outcome === "VOID" ? "VOID" : outcome === "CORRECT" ? "YES" : "NO",
            resolvedAt: OCT_2,
          },
    backCount: 0,
    fadeCount: 0,
  };
}

describe("landing social proof", () => {
  test("a feed that cannot be read says so; an empty feed says so", () => {
    expect(proofState(null)).toEqual({ kind: "unavailable" });
    expect(proofState({ entries: [] })).toEqual({ kind: "empty" });
    expect(heroProofLink({ kind: "empty" })).toEqual({ href: "#live", label: "see live calls", kind: "live" });
    expect(heroProofLink({ kind: "unavailable" })).toEqual({ href: "#live", label: "see live calls", kind: "live" });
  });

  test("features the newest settled call (it has a receipt), else the newest call", () => {
    const pending = entry("p1");
    const settled = entry("s1", { outcome: "INCORRECT" });
    expect(pickFeatured([pending, settled])?.call.id).toBe("s1");
    expect(pickFeatured([pending, entry("p2")])?.call.id).toBe("p1");
    expect(heroProofLink(proofState({ entries: [pending, settled] }))).toEqual({ href: "/c/s1", label: "see a receipt", kind: "receipt" });
    expect(heroProofLink(proofState({ entries: [pending] }))).toEqual({ href: "/c/p1", label: "see a live call", kind: "call" });
  });

  test("the hero's second link opens the web app only when the deploy names one", () => {
    const state = proofState({ entries: [entry("s1", { outcome: "CORRECT" })] });
    expect(heroProofLink(state, null)).toEqual({ href: "/c/s1", label: "see a receipt", kind: "receipt" });
    expect(heroProofLink(state, "https://app.example/")).toEqual({ href: "https://app.example/", label: "open web app", kind: "web" });
    expect(heroProofLink({ kind: "unavailable" }, "https://app.example/")).toEqual({ href: "https://app.example/", label: "open web app", kind: "web" });
  });

  test("the people row is the real distinct authors, the featured one first, at most five", () => {
    const a = person("a");
    const b = person("b");
    const entries = [entry("1", { author: b }), entry("2", { author: a, outcome: "CORRECT" }), entry("3", { author: b })];
    const state = proofState({ entries });
    expect(state.kind).toBe("call");
    if (state.kind !== "call") return;
    expect(state.people.map((p) => p.id)).toEqual(["a", "b"]);
    const many = Array.from({ length: 9 }, (_, i) => entry(`e${i}`, { author: person(`p${i}`) }));
    expect(recentPeople(many, many[0]!).map((p) => p.id)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });

  test("the sentence states who, that it was free, which side, the percent, the day and Panta's result", () => {
    const author = person("dev", { displayName: "Dominion" });
    expect(callSentence(entry("x", { author, outcome: "INCORRECT" }))).toBe(
      `Dominion (@dev) made a free call: Yes at 50% on ${DAY}. Panta settled it No.`,
    );
    expect(callSentence(entry("y", { author }))).toBe(`Dominion (@dev) made a free call: Yes at 50% on ${DAY}. Panta hasn’t settled it yet.`);
    expect(callSentence(entry("z", { author, outcome: "VOID", price: null }))).toBe(
      `Dominion (@dev) made a free call: Yes on ${DAY}. Panta voided the market.`,
    );
    expect(callSentence(entry("t", { author, thesis: "  ETF bid is priced in " }))).toBe(
      `“ETF bid is priced in” Dominion (@dev) made a free call: Yes at 50% on ${DAY}. Panta hasn’t settled it yet.`,
    );
    expect(dayLabel(null)).toBeNull();
  });

  test("never 'free' once money is involved, and never cents", () => {
    const author = person("dev", { displayName: "Dominion" });
    const funded = { ...entry("f", { author, price: "0.625", no: "0.375" }), funding: { state: "FILLED", venue: "panta" } };
    expect(callSentence(funded)).toBe(`Dominion (@dev) made a funded call: Yes at 63% on ${DAY}. Panta hasn’t settled it yet.`);
    const submitted = entry("s", { author });
    submitted.call.fundingState = "SUBMITTED";
    expect(callSentence(submitted)).toBe(`Dominion (@dev) called Yes at 50% on ${DAY}. Panta hasn’t settled it yet.`);
    for (const e of [funded, submitted, entry("u", { author })]) expect(callSentence(e)).not.toMatch(/¢|\$|USDC|SOL/);
  });

  test("a receipt is only promised once Panta has settled", () => {
    expect(statusLine(entry("p"))).toEqual({ label: "Open · not settled yet", href: "/c/p", linkText: "See the call" });
    expect(statusLine(entry("w", { outcome: "CORRECT" }))).toEqual({
      label: "Settled · Correct",
      href: "/c/w",
      linkText: "See the receipt",
    });
  });
});

function counts(decided: number, correct = 0, pending = 0): RecordCounts {
  return { correct, incorrect: decided - correct, voided: 0, resolved: decided, decided, pending };
}

function ref(id: string, over: { avatarUrl?: string | null; avatarId?: number | null; displayName?: string } = {}) {
  return { id, handle: id, displayName: over.displayName ?? `Person ${id}`, avatarUrl: over.avatarUrl ?? null, avatarId: over.avatarId ?? null };
}

describe("landing callers (the circles in “See who’s calling it”)", () => {
  test("a person's picture: their own https photo, else their preset, else initials", () => {
    expect(avatarSrc({ avatarUrl: "https://pbs.twimg.com/a.jpg", avatarId: 2 })).toBe("https://pbs.twimg.com/a.jpg");
    expect(avatarSrc({ avatarUrl: "http://insecure/a.jpg", avatarId: 3 })).toBe("/img/profile/3.png");
    expect(avatarSrc({ avatarUrl: null, avatarId: 1 })).toBe("/img/profile/1.png");
    expect(avatarSrc({ avatarUrl: null, avatarId: 9 })).toBeNull();
    expect(avatarSrc({ avatarUrl: null })).toBeNull();
  });

  test("ranked first, then building, then suggested and feed authors, each once, at most five", () => {
    const leaderboard: Leaderboard = {
      window: "30d",
      minimumDecided: 10,
      ranked: [{ rank: 1, person: ref("r1"), record: { counts: counts(12, 9) } }],
      building: [
        { rank: null, person: ref("b1", { avatarId: 2 }), record: { counts: counts(1) } },
        { rank: null, person: ref("r1"), record: { counts: counts(12, 9) } },
      ],
    };
    const suggested = {
      people: [
        { ...ref("s1"), record: { counts: counts(0, 0, 2) } },
        // Suggested but has never made a call: not "calling it".
        { ...ref("s0"), record: { counts: counts(0) } },
      ],
    };
    const callers = pickCallers({ leaderboard, suggested, feed: { entries: [entry("e", { author: person("f1") })] } });
    expect(callers.map((c) => c.id)).toEqual(["r1", "b1", "s1", "f1"]);
    expect(callers[1]!.avatar).toBe("/img/profile/2.png");
    expect(callerRecord(callers[0]!)).toBe("9 of 12 decided calls right");
    expect(callerRecord(callers[1]!)).toBe("0 of 1 decided call right");
    expect(callerRecord(callers[2]!)).toBe("No decided calls yet");
    const many = { ...leaderboard, building: Array.from({ length: 9 }, (_, i) => ({ rank: null, person: ref(`p${i}`), record: { counts: counts(1) } })) };
    expect(pickCallers({ leaderboard: many, suggested: null, feed: null })).toHaveLength(5);
  });

  test("with the BFF down there is nobody to show, and nothing is made up", () => {
    expect(pickCallers({ leaderboard: null, suggested: null, feed: null })).toEqual([]);
    expect(callersLine([])).toBeNull();
  });

  test("the line under the title is true for one, two or many people", () => {
    const dev = pickCallers({ leaderboard: null, suggested: null, feed: { entries: [entry("x", { author: person("dev", { displayName: "Dominion" }) })] } });
    expect(callersLine(dev)).toBe("Dominion (@dev) is calling\u00A0it. There’s room for you.");
    const two = pickCallers({ leaderboard: null, suggested: null, feed: { entries: [entry("1", { author: person("a", { displayName: "Ada" }) }), entry("2", { author: person("b", { displayName: "b" }) })] } });
    expect(callersLine(two)).toBe("Ada (@a) and @b are calling\u00A0it.");
    const three = pickCallers({ leaderboard: null, suggested: null, feed: { entries: ["a", "b", "c"].map((id) => entry(id, { author: person(id) })) } });
    expect(callersLine(three)).toBe("@a, @b and others are calling\u00A0it.");
  });
});

/** A source file with its comments stripped: the words a visitor can read. */
function readCopy(path: string): { file: string; text: string } {
  const text = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return { file: path, text };
}

/** Every .ts/.tsx under a directory, comments stripped. */
function copyOf(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...copyOf(path));
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(readCopy(path));
  }
  return out;
}

describe("landing copy", () => {
  // The app's onboarding copy rules: calls are free, trades are real USDC on
  // Panta and can lose money; never betting or gambling language, never
  // promises of safety or returns.
  const BANNED = [
    /\bbets?\b/i,
    /\bbetting\b/i,
    /\bwin money\b/i,
    /\bearn\b/i,
    /\brisk-free\b/i,
    /\bguaranteed?\b/i,
    /\bodds\b/i,
    /\bjackpot\b/i,
    /\bairdrop\b/i,
    /\bplay money\b/i,
    /\bstake\b/i,
    /\bpots?\b/i,
    /\bTxLINE\b/,
    /\bfootball\b/i,
    /\bchallenge a friend\b/i,
    /\bsafe\b/i,
    /\bchance\b/i,
    /\bprofit\b/i,
  ];
  const files = [
    ...copyOf(join(import.meta.dir, "../web/components/site")),
    readCopy(join(import.meta.dir, "../web/lib/landingProof.ts")),
    // The page and root metadata: titles, descriptions and link previews.
    readCopy(join(import.meta.dir, "../web/app/page.tsx")),
    readCopy(join(import.meta.dir, "../web/app/layout.tsx")),
  ];

  test("uses none of the banned words", () => {
    for (const { file, text } of files) {
      for (const word of BANNED) {
        expect({ file, match: text.match(word)?.[0] ?? null }).toEqual({ file, match: null });
      }
    }
  });

  test("says plainly that calls are free and trades can lose money", () => {
    const all = files.map((f) => f.text).join("\n");
    expect(all).toContain("Calls are free");
    expect(all).toMatch(/can lose what you put in/);
    expect(all).toContain("Panta");
  });

  test("never links the sign-in or Arena routes, which still serve the retired football product", () => {
    for (const { file, text } of files) {
      expect({ file, match: text.match(/["'`]\/(signin|arena)\b/)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });
});
