/**
 * The Gaffer's persona and the context-rendering helpers. The golden rule: he
 * may only use history that is *provided* to him (recalled from Walrus). He never
 * invents a past — that would betray the one thing the product is selling.
 */

import { formatWal } from "../domain/ids.ts";
import type { MemoryRecord } from "../core/memory/MemoryStore.ts";
import type { DossierView } from "../core/projections/DossierProjection.ts";

export const GAFFER_PERSONA = `You are the Gaffer: a grizzled, sharp-tongued football manager who runs a staking prediction game during the World Cup. Each player "signs" for you and makes staked calls on matches. You are their manager — you coach them, you rank them, and you roast them.

Voice: British football vernacular ("son", "bottled it", "the crowd", "form", "you're benched"). Dry, cutting, economical. You are hard but you want them to win — your coaching genuinely helps their P&L.

THE ONE RULE YOU NEVER BREAK: only ever reference history that appears in the MEMORY provided to you below. Quote it, throw it back at them, build on it. Never invent a pick, a quote, or a result that isn't in the memory. If the memory is empty, say so plainly — you don't know them yet.

Plain text only — no markdown, no bullet points, no emojis, no headers. Obey the length limit given for each reply. If the MEMORY is empty, say you don't know them yet rather than inventing anything.`;

/** The distinct generation moments, each with its own output budget. */
export type GafferUseCase = "preBet" | "result" | "verdict" | "chat";

/**
 * Per-use-case output contract. maxTokens caps generation; maxChars is the hard
 * ceiling the text is sanitised down to before it ever leaves the backend, so a
 * chatty model can't blow up a card or a one-line nudge.
 */
export const OUTPUT_SPEC: Record<GafferUseCase, { maxTokens: number; maxChars: number }> = {
  preBet: { maxTokens: 180, maxChars: 320 }, // a coaching nudge, 1–2 sentences
  result: { maxTokens: 120, maxChars: 220 }, // an instant reaction, 1 sentence
  verdict: { maxTokens: 320, maxChars: 600 }, // the shareable card, 2–4 sentences
  chat: { maxTokens: 200, maxChars: 400 }, // banter, 2–3 sentences
};

// Strip markdown punctuation and the common emoji ranges.
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/**
 * The output gate. Whatever the model returns, this is what the user can
 * actually receive: no markdown, no emoji, collapsed whitespace, and truncated
 * at a sentence boundary within the use-case ceiling. Returns "" if nothing
 * usable survives — the caller treats that as a failure and falls back.
 */
export function sanitizeGafferText(raw: string, maxChars: number): string {
  let t = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(EMOJI, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  t = stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : cut;
  return t.trim();
}

export function summariseDossier(d: DossierView | undefined): string {
  if (!d) return "MEMORY: none. This player has not signed yet.";
  const { record, form, gr, tier, pnl } = d;
  const formStr = form.recent.length ? form.recent.join(" ") : "no results yet";
  const traits = d.traits.length
    ? d.traits.map((t) => `- ${t.label} (confidence ${(t.confidence * 100) | 0}%)`).join("\n")
    : "- none distilled yet";
  return [
    `Rank: ${tier} | Gaffer Rating: ${gr} | Record: ${record.won}W-${record.lost}L | P&L: ${formatWal(pnl)} WAL`,
    `Form (recent → newest): ${formStr}${form.hot ? " (HOT)" : form.cold ? " (COLD — benched)" : ""}`,
    `Distilled patterns:\n${traits}`,
  ].join("\n");
}

export function renderMemories(memories: MemoryRecord[]): string {
  if (!memories.length) return "MEMORY: empty. You don't know this player yet.";
  return [
    "MEMORY (most relevant first — these are real, recalled from Walrus):",
    ...memories.map((m) => `• [${m.kind}] ${m.text}`),
  ].join("\n");
}
