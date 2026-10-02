/**
 * A basic, deliberately conservative text policy for what people publish:
 * theses and notes on calls, display names, usernames and bios.
 *
 * Two rules, both explained to the person in plain words:
 *
 *   1. NO LINKS. A thesis is an opinion on a market, not a place to send
 *      people. Links are how scams and phishing travel in a trading product.
 *      Solana name-service names (`toly.sol`) are not links and are allowed.
 *   2. NO SLURS OR STRONG PROFANITY. A short list, matched as whole words after
 *      undoing common disguises (l33t digits, s.p.a.c.i.n.g, stretched
 *      letters). Ordinary trash talk ("damn", "hell", "crap") is fine.
 *
 * It is a floor, not moderation: reports and admin hides handle the rest.
 * The mobile app carries the same lists (lib/features/trust/data/
 * content_policy.dart) so a person hears the reason before sending; the
 * server is the one that decides.
 */

import { TrustError } from "./errors.ts";

export type TextField = "thesis" | "note" | "name" | "handle" | "bio";

export type ContentVerdict =
  | { ok: true }
  | { ok: false; reason: "link" | "language"; message: string };

const LABEL: Record<TextField, string> = {
  thesis: "your thesis",
  note: "your note",
  name: "your name",
  handle: "that username",
  bio: "your bio",
};

const TLDS = [
  "com", "net", "org", "io", "xyz", "app", "fun", "gg", "co", "me", "ly", "link", "site", "online",
  "ru", "cn", "tk", "info", "biz", "finance", "money", "exchange", "top", "club", "vip", "live", "tv",
  "us", "uk", "ai", "so", "to", "cc", "pw", "dev", "page", "store", "shop", "click", "lol", "win",
  "bet", "casino", "zip", "sh", "im", "gl", "ws", "cx", "su", "trade", "markets", "market", "pro",
];
const LINK_PATTERNS: readonly RegExp[] = [
  /\bhttps?:\/\//i,
  /\bwww\./i,
  // No spaces around the dot: "up. So it goes" is a sentence, not a link.
  // The suffix must be written the way addresses are: lowercase
  // ("pump.fun", "OpenAI.com"), or all capitals after an all-capitals name
  // ("SCAM.COM"). A missed space before a capitalised word ("win.So easy",
  // "up.To the moon") is a typo, not a web address.
  new RegExp(`(?:^|[^A-Za-z0-9-])[A-Za-z0-9][A-Za-z0-9-]{0,62}\\.(?:${TLDS.join("|")})(?![A-Za-z0-9])`),
  new RegExp(`(?:^|[^A-Za-z0-9-])[A-Z0-9][A-Z0-9-]{1,62}\\.(?:${TLDS.join("|").toUpperCase()})(?![A-Za-z0-9])`),
];

/** Whole words. Matched exactly, after normalisation. */
const BLOCKED_WORDS = new Set([
  "kys", "fag", "fags", "kike", "kikes", "spic", "spics", "tranny", "trannies", "wetback", "wetbacks",
  "cunt", "cunts", "pussy", "pussies", "twat", "twats",
]);

/** Stems: also match any word that starts with them (fucking, retarded, ...). */
const BLOCKED_STEMS = [
  "fuck", "motherfuck", "nigger", "nigga", "faggot", "retard", "cocksuck", "whore", "slut", "bitch",
  "asshole", "dickhead", "rapist",
];

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "i",
};

function normalise(text: string): string[] {
  const lowered = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[013457@$!|]/g, (c) => LEET[c] ?? c);
  const raw = lowered.split(/[^a-z]+/).filter(Boolean);
  // Re-join runs of single letters: "f u c k", "f.u.c.k" -> "fuck".
  const tokens: string[] = [];
  let run = "";
  for (const t of raw) {
    if (t.length === 1) {
      run += t;
      continue;
    }
    if (run) tokens.push(run);
    run = "";
    tokens.push(t);
  }
  if (run) tokens.push(run);
  return tokens;
}

/** "fuuuuck" -> "fuck": runs of three or more of a letter become one. */
const unstretch = (t: string): string => t.replace(/([a-z])\1{2,}/g, "$1");

function hasBlockedLanguage(text: string): boolean {
  for (const token of normalise(text)) {
    for (const t of new Set([token, unstretch(token)])) {
      if (BLOCKED_WORDS.has(t)) return true;
      if (BLOCKED_STEMS.some((stem) => t.startsWith(stem))) return true;
    }
  }
  return false;
}

function hasLink(text: string): boolean {
  return LINK_PATTERNS.some((p) => p.test(text));
}

export function checkText(text: string | null | undefined, field: TextField): ContentVerdict {
  if (text === null || text === undefined) return { ok: true };
  const t = String(text);
  if (!t.trim()) return { ok: true };
  if (hasLink(t)) {
    return {
      ok: false,
      reason: "link",
      message: `Links aren't allowed in ${LABEL[field]}. Remove the web address and try again.`,
    };
  }
  if (hasBlockedLanguage(t)) {
    const label = LABEL[field];
    return {
      ok: false,
      reason: "language",
      message: `${label.charAt(0).toUpperCase()}${label.slice(1)} includes language we don't allow. Please rephrase it.`,
    };
  }
  return { ok: true };
}

/** Throws a TrustError carrying the person-readable reason. */
export function assertCleanText(text: string | null | undefined, field: TextField): void {
  const verdict = checkText(text, field);
  if (!verdict.ok) {
    throw new TrustError("TRUST_CONTENT_REFUSED", verdict.message, { field, reason: verdict.reason });
  }
}

/**
 * Usernames that would impersonate the system. `deleted_` is what a deleted
 * account's row is renamed to, so a live person must not be able to claim one.
 */
export function isReservedHandle(handle: string): boolean {
  return handle.trim().replace(/^@/, "").toLowerCase().startsWith("deleted_");
}
