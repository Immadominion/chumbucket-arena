/**
 * The chumbucket.fun landing page (web/app/page.tsx): what its social-proof
 * section shows for every state of the public calls feed, and that its copy
 * keeps to the product's honesty rules (the same banned words the app's
 * onboarding copy test enforces). The page itself is proven by `next build`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CallFeedEntry, Person } from "../web/lib/callsBff.ts";
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

function person(id: string, over: Partial<Person> = {}): Person {
  return { id, handle: id, displayName: `Person ${id}`, avatarUrl: null, settledCalls: 0, correctCalls: 0, ...over };
}

function entry(id: string, over: { author?: Person; outcome?: "PENDING" | "CORRECT" | "INCORRECT" | "VOID"; thesis?: string | null; price?: string | null } = {}): CallFeedEntry {
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
          : { venue: "panta", currency: "USDC", unit: "share", yesPrice: over.price ?? "0.5", noPrice: "0.52", observedAt: OCT_2, attribution: null },
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
    expect(heroProofLink({ kind: "empty" })).toEqual({ href: "#live", label: "see live calls" });
    expect(heroProofLink({ kind: "unavailable" })).toEqual({ href: "#live", label: "see live calls" });
  });

  test("features the newest settled call (it has a receipt), else the newest call", () => {
    const pending = entry("p1");
    const settled = entry("s1", { outcome: "INCORRECT" });
    expect(pickFeatured([pending, settled])?.call.id).toBe("s1");
    expect(pickFeatured([pending, entry("p2")])?.call.id).toBe("p1");
    expect(heroProofLink(proofState({ entries: [pending, settled] }))).toEqual({ href: "/c/s1", label: "see a receipt" });
    expect(heroProofLink(proofState({ entries: [pending] }))).toEqual({ href: "/c/p1", label: "see a live call" });
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

  test("the sentence states who, which side, the locked price, the day and Panta's result", () => {
    const author = person("dev", { displayName: "Dominion" });
    expect(callSentence(entry("x", { author, outcome: "INCORRECT" }))).toBe(
      "Dominion (@dev) called Yes at 50¢ on 2 Oct 2026. Panta settled it No.",
    );
    expect(callSentence(entry("y", { author }))).toBe("Dominion (@dev) called Yes at 50¢ on 2 Oct 2026. Panta hasn’t settled it yet.");
    expect(callSentence(entry("z", { author, outcome: "VOID", price: null }))).toBe(
      "Dominion (@dev) called Yes on 2 Oct 2026. Panta voided the market.",
    );
    expect(callSentence(entry("t", { author, thesis: "  ETF bid is priced in " }))).toBe(
      "“ETF bid is priced in” Dominion (@dev) called Yes at 50¢ on 2 Oct 2026. Panta hasn’t settled it yet.",
    );
    expect(dayLabel(null)).toBeNull();
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

/** Every .tsx under a directory, comments stripped: the words a visitor can read. */
function copyOf(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...copyOf(path));
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) {
      const text = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      out.push({ file: path, text });
    }
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
  ];
  const files = [
    ...copyOf(join(import.meta.dir, "../web/components/site")),
    ...copyOf(join(import.meta.dir, "../web/lib")).filter((f) => f.file.endsWith("landingProof.ts")),
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
});
