/**
 * Packet F — the only copy a notification may use.
 *
 * WHY COPY IS A CONSTANT AND NOT A COLUMN
 *
 * The legacy `notification_outbox` stores `title` and `body` as free text
 * written by whatever trigger produced the row. That makes the product rules
 * unenforceable: a rule about what a notification may say has to hold at write
 * time, in every writer, forever. `public.social_notifications` therefore has
 * no title and no body column at all, and the copy is rendered HERE, at read
 * time, out of this table — which is twelve strings that are checked against
 * `FORBIDDEN_COPY` when this module is imported.
 *
 * So "no 'everyone is betting' urgency copy, no stake sizes, no P&L, no
 * crowd-consensus pressure" is not a review note. It is an import-time
 * assertion over the complete set of sentences the product can emit.
 *
 * WHAT THE COPY DELIBERATELY DOES NOT DO
 *
 *   · It never counts anybody. Not "3 people backed you", not "most callers
 *     disagree". A relational notification names ONE person — the one who acted
 *     — because that is the relationship. A count is a crowd.
 *   · It never says how a market is trading, and never quotes a probability.
 *   · It never quotes the thesis, the recipient's or the actor's.
 *   · It never tells anyone to do anything within a deadline.
 *   · `{actor}` is the only substitution, it appears only in a title, and it is
 *     passed through `safeDisplayName` first. The venue's market question rides
 *     as a separate structured field (`NotificationView.marketQuestion`), never
 *     spliced into a sentence — §4 says venue text is reproduced verbatim and
 *     never paraphrased, and a sentence built around it would be a paraphrase.
 */

import { assertCopySafe, safeDisplayName } from "./safety.ts";
import type { NotificationKind, RematchReason, SocialNotification } from "./types.ts";

export interface CopyTemplate {
  /** May contain the single placeholder `{actor}`. */
  title: string;
  /** Never contains a placeholder. */
  body: string;
}

/** The key a template is looked up by: the kind, refined by the rematch reason. */
export type CopyKey =
  | "BACKED"
  | "FADED"
  | "RESOLVED:CORRECT"
  | "RESOLVED:INCORRECT"
  | "RESOLVED:VOID"
  | "REMATCH:challenge"
  | "REMATCH:rival_called_again";

/**
 * Every sentence this product can put in a person's inbox. If it is not here,
 * it cannot be sent.
 */
export const COPY_TEMPLATES: Readonly<Record<CopyKey, CopyTemplate>> = {
  BACKED: {
    title: "{actor} backed your call",
    body: "They went on record on the same side as you.",
  },
  FADED: {
    title: "{actor} faded your call",
    body: "They went on record on the other side.",
  },
  "RESOLVED:CORRECT": {
    title: "Your call resolved",
    body: "The venue published its result, and you called it right.",
  },
  "RESOLVED:INCORRECT": {
    title: "Your call resolved",
    body: "The venue published its result, and you called it wrong.",
  },
  "RESOLVED:VOID": {
    // §3: VOID is never a win and never a loss, and the copy has to say so, or
    // a person will read a silent void as a quiet loss.
    title: "Your call was voided",
    body: "The venue cancelled this market. It counts as neither a hit nor a miss.",
  },
  "REMATCH:challenge": {
    title: "{actor} dared you",
    // "Dare", not "challenge": that word also named the retired SOL escrow
    // feature, which did involve money. A dare never does.
    body: "They dared you to go on record on their call.",
  },
  "REMATCH:rival_called_again": {
    title: "{actor} has gone on record again",
    body: "You faded them last time. Their new call is open if you want another go.",
  },
} as const;

// ── the import-time check ────────────────────────────────────────────────────
//
// Cheap (fourteen strings, seven regexes) and absolute: a template that breaks
// a product rule cannot be shipped, because the module that holds it will not
// load.
for (const [key, tpl] of Object.entries(COPY_TEMPLATES)) {
  assertCopySafe(tpl.title, `the ${key} notification title`);
  assertCopySafe(tpl.body, `the ${key} notification body`);
  if (tpl.body.includes("{")) {
    throw new Error(
      `the ${key} notification body must be a constant sentence — a placeholder in a body is how unchecked text gets into copy`,
    );
  }
}

/** The template key for one notification. Total over the four kinds. */
export function copyKeyFor(n: Pick<SocialNotification, "kind" | "outcome" | "rematchReason">): CopyKey {
  switch (n.kind) {
    case "BACKED":
      return "BACKED";
    case "FADED":
      return "FADED";
    case "RESOLVED":
      // The outcome is a verbatim quote of call_results.outcome, and PENDING is
      // never a notification (§0.2), so these three are the whole domain.
      return n.outcome === "CORRECT"
        ? "RESOLVED:CORRECT"
        : n.outcome === "VOID"
          ? "RESOLVED:VOID"
          : "RESOLVED:INCORRECT";
    case "REMATCH":
      return n.rematchReason === "rival_called_again"
        ? "REMATCH:rival_called_again"
        : "REMATCH:challenge";
  }
}

/**
 * Render one notification's copy.
 *
 * `actorName` is somebody's own display name, so it is sanitised (control
 * characters, bidi overrides, length) but never rejected — see `safety.ts`. The
 * sentence around it is a constant that has already been checked.
 */
export function renderCopy(
  n: Pick<SocialNotification, "kind" | "outcome" | "rematchReason">,
  actorName: string | null,
): CopyTemplate {
  const tpl = COPY_TEMPLATES[copyKeyFor(n)];
  const who = safeDisplayName(actorName ?? "", "Someone");
  return { title: tpl.title.replace("{actor}", who), body: tpl.body };
}

/** Every kind has copy, and this is how a test proves the mapping is total. */
export const COPY_KEYS_BY_KIND: Readonly<Record<NotificationKind, readonly CopyKey[]>> = {
  BACKED: ["BACKED"],
  FADED: ["FADED"],
  RESOLVED: ["RESOLVED:CORRECT", "RESOLVED:INCORRECT", "RESOLVED:VOID"],
  REMATCH: ["REMATCH:challenge", "REMATCH:rival_called_again"],
} as const;

export const REMATCH_COPY_KEY = (reason: RematchReason): CopyKey =>
  reason === "challenge" ? "REMATCH:challenge" : "REMATCH:rival_called_again";
