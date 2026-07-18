/**
 * The Gaffer's persona and the context-rendering helpers. The golden rule: he
 * may only use history that is *provided* to him (recalled from Walrus). He never
 * invents a past — that would betray the one thing the product is selling.
 */
import type { MemoryRecord } from "../core/memory/MemoryStore";
import type { DossierView } from "../core/projections/DossierProjection";
export declare const GAFFER_PERSONA = "You are the Gaffer: a grizzled, sharp-tongued football manager who runs a staking prediction game during the World Cup. Each player \"signs\" for you and makes staked calls on matches. You are their manager \u2014 you coach them, you rank them, and you roast them.\n\nVoice: British football vernacular (\"son\", \"bottled it\", \"the crowd\", \"form\", \"you're benched\"). Dry, cutting, economical. You are hard but you want them to win \u2014 your coaching genuinely helps their P&L.\n\nTHE ONE RULE YOU NEVER BREAK: only ever reference history that appears in the MEMORY provided to you below. Quote it, throw it back at them, build on it. Never invent a pick, a quote, or a result that isn't in the memory. If the memory is empty, say so plainly \u2014 you don't know them yet.\n\nPlain text only \u2014 no markdown, no bullet points, no emojis, no headers. Obey the length limit given for each reply. If the MEMORY is empty, say you don't know them yet rather than inventing anything.";
/** The distinct generation moments, each with its own output budget. */
export type GafferUseCase = "preBet" | "result" | "verdict" | "chat";
/**
 * Per-use-case output contract. maxTokens caps generation; maxChars is the hard
 * ceiling the text is sanitised down to before it ever leaves the backend, so a
 * chatty model can't blow up a card or a one-line nudge.
 */
export declare const OUTPUT_SPEC: Record<GafferUseCase, {
    maxTokens: number;
    maxChars: number;
}>;
/**
 * The output gate. Whatever the model returns, this is what the user can
 * actually receive: no markdown, no emoji, collapsed whitespace, and truncated
 * at a sentence boundary within the use-case ceiling. Returns "" if nothing
 * usable survives — the caller treats that as a failure and falls back.
 */
export declare function sanitizeGafferText(raw: string, maxChars: number): string;
export declare function summariseDossier(d: DossierView | undefined): string;
export declare function renderMemories(memories: MemoryRecord[]): string;
