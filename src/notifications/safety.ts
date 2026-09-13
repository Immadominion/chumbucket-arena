/**
 * Packet F — the guarantees that are checked rather than promised.
 *
 * Three product rules from §0 and from the packet brief are not the kind of
 * thing a type can hold:
 *
 *   1. "A notification must carry no secret, no signature, no balance and no
 *      full thesis text."
 *   2. No stake sizes and no P&L, anywhere near a notification.
 *   3. No "everyone is betting" urgency copy and no crowd-consensus pressure.
 *
 * The schema already makes 1 and 2 structurally impossible — `public.
 * social_notifications` has no column that could hold any of it — but the wire
 * shape is assembled in TypeScript, and a view model is easy to widen by
 * accident. So every payload is walked before it leaves the service, and every
 * copy template is walked at import. A future field called `stakeBaseUnits`,
 * or a body that says "everyone is fading you", fails loudly here instead of
 * shipping.
 *
 * `assertMoneyFree` is reused verbatim from Packet D rather than reimplemented:
 * one definition of "money-shaped", shared by receipts and notifications.
 * `src/calls/**` is read, never edited (§6).
 */

import { assertMoneyFree } from "../calls/types.ts";
import { NotificationsError } from "./errors.ts";

/**
 * Field names that would mean a secret, a credential, a signature or somebody's
 * words. `assertMoneyFree` already covers the money-shaped half (amount, stake,
 * escrow, payout, balance, signature, tx, …); this is the rest of the sentence
 * in the brief.
 *
 * `thesis` and `note` are here because a notification must carry no full thesis
 * text — and this packet's answer to "how much of a thesis is safe to include?"
 * is NONE. An excerpt would need a length rule, an ellipsis rule and a
 * judgement call about where a sentence stops being an excerpt; a missing field
 * needs none of those and cannot be got wrong.
 */
const UNSAFE_KEY =
  /(secret|password|passwd|apikey|api_?key|jwt|bearer|credential|private|seed|mnemonic|nonce|thesis|note|pnl|p_and_l)/i;

/** A Supabase / GoTrue style JWT. */
const JWT_VALUE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;

/** A base58 string long enough to be a Solana signature or a secret key. */
const BASE58_SECRET_VALUE = /\b[1-9A-HJ-NP-Za-km-z]{80,}\b/;

/** A hex string long enough to be a key, a hash or a raw signature. */
const HEX_SECRET_VALUE = /\b[0-9a-fA-F]{64,}\b/;

/**
 * Walk a payload and refuse anything that must never reach a person's inbox.
 *
 * `forbiddenText` lets a caller name strings that are safe in general but not
 * here — the recipient's own thesis, for instance, which is public on the call
 * itself and still has no business being pushed to a device.
 */
export function assertNotificationSafe(
  value: unknown,
  what: string,
  opts: { forbiddenText?: readonly string[] } = {},
): void {
  // Money first: one definition, shared with Packet D's receipts.
  try {
    assertMoneyFree(value, what);
  } catch (e) {
    throw new NotificationsError(
      "NOTIFICATION_UNSAFE_PAYLOAD",
      e instanceof Error ? e.message : String(e),
      { cause: e },
    );
  }
  walk(value, what, "", opts.forbiddenText ?? []);
}

function walk(value: unknown, what: string, path: string, forbidden: readonly string[]): void {
  if (typeof value === "string") {
    assertValueSafe(value, what, path, forbidden);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, what, `${path}[${i}]`, forbidden));
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (UNSAFE_KEY.test(key)) {
      throw new NotificationsError(
        "NOTIFICATION_UNSAFE_PAYLOAD",
        `${what} must carry no secret, no signature, no balance and no thesis: found "${here}". A notification states a fact and links to the call; the call is where the words live.`,
        { details: { field: here } },
      );
    }
    walk(v, what, here, forbidden);
  }
}

function assertValueSafe(value: string, what: string, path: string, forbidden: readonly string[]): void {
  if (JWT_VALUE.test(value) || BASE58_SECRET_VALUE.test(value) || HEX_SECRET_VALUE.test(value)) {
    throw new NotificationsError(
      "NOTIFICATION_UNSAFE_PAYLOAD",
      `${what} carries a credential-shaped value at "${path || "(root)"}". A notification never carries a signature, a token or a key.`,
      { details: { field: path } },
    );
  }
  for (const needle of forbidden) {
    if (needle.length >= 8 && value.includes(needle)) {
      throw new NotificationsError(
        "NOTIFICATION_UNSAFE_PAYLOAD",
        `${what} reproduces text that must not be pushed to a device (at "${path || "(root)"}").`,
        { details: { field: path } },
      );
    }
  }
}

// ── copy rules ───────────────────────────────────────────────────────────────

/**
 * The copy a notification may use. Each entry is a rule from §0 or from the
 * product rules, expressed as the thing it forbids.
 *
 * These bind the copy WE write — the template constants in `copy.ts`, which are
 * validated against this list at import. They are deliberately NOT applied to a
 * person's own display name: a name is not our copy, and rejecting one would
 * let somebody break another person's inbox by renaming themselves. Names are
 * length-bounded and control-stripped by `safeDisplayName` instead, and they
 * never appear in `body`.
 */
export const FORBIDDEN_COPY: ReadonlyArray<{ rule: RegExp; why: string }> = [
  {
    rule: /\b(hurry|act now|act fast|last chance|final call|ending soon|don'?t miss|dont miss|before it'?s too late)\b/i,
    why: "urgency copy — §0: the product does not manufacture pressure to act",
  },
  {
    rule: /\b(everyone|everybody|most people|most callers|most users|the crowd|majority|consensus|popular|trending)\b/i,
    why: "crowd-consensus pressure — a person's call is theirs, not a vote count",
  },
  {
    // The word boundary belongs to "percent" alone. `%` is a non-word
    // character, so a trailing \b after it can never match — the original
    // rule caught "62 percent" and let "62%" through, which is the form
    // people actually write.
    rule: /\b\d+\s*(%|percent\b)/i,
    why: "a percentage in a notification is either a crowd split or an accuracy claim, and neither belongs in a push",
  },
  {
    rule: /\b\d+\s+(people|callers|others|users|traders)\b/i,
    why: "\"N people are…\" is the crowd-pressure line in disguise",
  },
  {
    rule: /\b(bet|bets|betting|bettor|wager|wagers|wagering|stake|stakes|staked|odds|payout|payouts|winnings|profit|pnl|p&l)\b/i,
    why: "a call is not a trade (§0.1) — no stake sizes, no P&L, no betting language",
  },
  {
    rule: /(\$\s?\d|\b\d+(\.\d+)?\s?(sol|usdc|usdt|eth|btc)\b)/i,
    why: "money never appears in a notification",
  },
  {
    rule: /\b(balance|wallet|signature|seed phrase|private key)\b/i,
    why: "a notification carries no credential and names no balance",
  },
];

/** Throw if a piece of copy breaks any of the rules above. */
export function assertCopySafe(text: string, what: string): void {
  for (const { rule, why } of FORBIDDEN_COPY) {
    const hit = rule.exec(text);
    if (hit) {
      throw new NotificationsError(
        "NOTIFICATION_UNSAFE_COPY",
        `${what} breaks a notification copy rule: "${hit[0]}" — ${why}. Copy: ${JSON.stringify(text)}`,
        { details: { what, matched: hit[0] } },
      );
    }
  }
}

/**
 * A person's own name, made safe to splice into a title without making it OUR
 * copy: control characters stripped, whitespace collapsed, length bounded.
 * Never rejected — a name is not a rule violation, and an unusable name is a
 * person's own problem, not a reason to break their inbox.
 */
export function safeDisplayName(name: string, fallback = "Someone"): string {
  const cleaned = name
    // C0/C1 controls, zero-width joiners and bidi overrides: a display name must
    // not be able to reflow or hide the sentence it is spliced into.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 40 ? `${cleaned.slice(0, 39)}\u2026` : cleaned;
}
