/**
 * What a person may propose as a Panta market, mirrored from Panta's own create
 * rules (docs.panta.market/api-reference/markets/quote.md, read 2026-10-02):
 *
 *   question        required, max 512
 *   resolutionRule  required, max 2048
 *   sourcesOfTruth  required, non-empty, max 20
 *   category        one of the eight create-allowlist slugs below
 *   startTime < endTime <= resolutionTime   (unix seconds)
 *   startTime >= now + on-chain minimumStartDelay (typically 3600s)
 *   outcomes        binary YES/NO only (Panta has no multi-outcome create)
 *
 * The rest is Chumbucket product policy, stated as such and kept inside
 * Panta's bounds: minimum lengths so a question is answerable, http(s) public
 * source links so a reviewer and the venue oracle can check them, a lead time
 * that survives review, and a horizon cap. Panta's quote remains the authority:
 * these checks only catch what we already know it would refuse.
 *
 * Pure and dependency-free so the mobile validator can mirror it line for line.
 */

/** Panta's create allowlist (GET /categories/). The live catalog also carries
 *  other labels (e.g. `pop-culture`, `gaming`) that the create API refuses. */
export const PANTA_CREATE_CATEGORIES = [
  "sports", "crypto", "politics", "entertainment", "finance", "science", "world", "other",
] as const;
export type PantaCreateCategory = (typeof PANTA_CREATE_CATEGORIES)[number];

export const QUESTION_MIN = 10;
export const QUESTION_MAX = 512; // Panta
export const RULES_MIN = 20;
export const RULES_MAX = 2048; // Panta
export const DESCRIPTION_MAX = 1000;
export const SOURCES_MAX = 20; // Panta
export const SOURCE_URL_MAX = 512;

/** Panta's documented typical on-chain `minimumStartDelay`. */
export const PANTA_MIN_START_DELAY_S = 3600;
/** Headroom over that delay for the ~5 minute create session and clock skew. */
export const START_MARGIN_S = 600;
/** A proposal must still have this long before trading closes when it is
 *  published: the derived start time (now + delay + margin) must precede it. */
export const PUBLISH_MIN_LEAD_MS = 2 * 60 * 60 * 1000;
/** Proposals need time to be reviewed before they hit the publish floor. */
export const PROPOSE_MIN_LEAD_MS = 3 * 60 * 60 * 1000;
/** Nobody should wait more than two years for a result. */
export const MAX_HORIZON_MS = 730 * 24 * 60 * 60 * 1000;
/** Results should be known within 90 days of trading closing. */
export const MAX_RESOLUTION_GAP_MS = 90 * 24 * 60 * 60 * 1000;

export interface MarketDraft {
  question: string;
  category: string;
  /** Trading closes (Panta `endTime`), unix ms. */
  closesAt: number;
  /** The result is known by (Panta `resolutionTime`), unix ms. */
  resolvesAt: number;
  /** How the market resolves (Panta `resolutionRule`). */
  rules: string;
  /** Where the result is read from (Panta `sourcesOfTruth`). */
  sources: string[];
  description?: string | null;
}

export type DraftField = "question" | "category" | "closesAt" | "resolvesAt" | "rules" | "sources" | "description";
export interface DraftProblem { field: DraftField; message: string; }

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A public http(s) link a person and the venue can both open. */
export function isPublicSourceUrl(value: string): boolean {
  if (value.length === 0 || value.length > SOURCE_URL_MAX || /\s/.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  // Panta SSRF-guards image hosts; sources get the same treatment from us.
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost" ||
      host.endsWith(".localhost") || IPV4.test(host) || host.startsWith("[")) return false;
  return true;
}

/** Trim and normalise a draft the way the server will store it. */
export function normalizeDraft(draft: MarketDraft): MarketDraft {
  const description = draft.description?.trim() ?? "";
  return {
    question: draft.question.trim().replace(/\s+/g, " "),
    category: draft.category.trim().toLowerCase(),
    closesAt: draft.closesAt,
    resolvesAt: draft.resolvesAt,
    rules: draft.rules.trim(),
    sources: [...new Set(draft.sources.map(s => s.trim()).filter(s => s.length > 0))],
    description: description.length > 0 ? description : null,
  };
}

/**
 * Every problem with a draft, in form order. Empty means proposable now.
 * `now` is unix ms. Normalise first; this does not trim.
 */
export function validateDraft(draft: MarketDraft, now: number): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const add = (field: DraftField, message: string) => problems.push({ field, message });

  if (draft.question.length < QUESTION_MIN) add("question", `Ask a full question (at least ${QUESTION_MIN} characters).`);
  else if (draft.question.length > QUESTION_MAX) add("question", `Keep the question under ${QUESTION_MAX} characters.`);
  else if (CONTROL.test(draft.question)) add("question", "Remove hidden characters from the question.");

  if (!(PANTA_CREATE_CATEGORIES as readonly string[]).includes(draft.category)) add("category", "Pick one of the listed categories.");

  if (!Number.isSafeInteger(draft.closesAt)) add("closesAt", "Pick when trading closes.");
  else if (draft.closesAt < now + PROPOSE_MIN_LEAD_MS) add("closesAt", "Trading must stay open for at least 3 more hours so the market can be reviewed and published.");
  else if (draft.closesAt > now + MAX_HORIZON_MS) add("closesAt", "Pick a close within the next two years.");

  if (!Number.isSafeInteger(draft.resolvesAt)) add("resolvesAt", "Pick when the result will be known.");
  else if (Number.isSafeInteger(draft.closesAt) && draft.resolvesAt < draft.closesAt) add("resolvesAt", "The result can't be known before trading closes.");
  else if (Number.isSafeInteger(draft.closesAt) && draft.resolvesAt > draft.closesAt + MAX_RESOLUTION_GAP_MS) add("resolvesAt", "The result must be known within 90 days of trading closing.");

  if (draft.rules.length < RULES_MIN) add("rules", `Explain exactly how YES or NO is decided (at least ${RULES_MIN} characters).`);
  else if (draft.rules.length > RULES_MAX) add("rules", `Keep the rules under ${RULES_MAX} characters.`);
  else if (CONTROL.test(draft.rules)) add("rules", "Remove hidden characters from the rules.");

  if (draft.sources.length === 0) add("sources", "Add at least one link where the result can be checked.");
  else if (draft.sources.length > SOURCES_MAX) add("sources", `Use at most ${SOURCES_MAX} source links.`);
  else if (!draft.sources.every(isPublicSourceUrl)) add("sources", "Each source must be a public http(s) link.");

  if (draft.description != null) {
    if (draft.description.length > DESCRIPTION_MAX) add("description", `Keep the description under ${DESCRIPTION_MAX} characters.`);
    else if (CONTROL.test(draft.description)) add("description", "Remove hidden characters from the description.");
  }
  return problems;
}

/** The last moment an approved proposal can still be published, unix ms. */
export const publishDeadline = (closesAt: number): number => closesAt - PUBLISH_MIN_LEAD_MS;

/**
 * Panta's three times for a publish happening at `now`. Panta's `startTime` is
 * the event start and must sit at least `minimumStartDelay` in the future; primary
 * buys are open before it (observed on live quotes, see PantaVenue). We use the
 * earliest start Panta permits so trading opens as soon as the create lands.
 */
export function pantaTimes(draft: Pick<MarketDraft, "closesAt" | "resolvesAt">, now: number):
  { startTime: number; endTime: number; resolutionTime: number } | null {
  const startTime = Math.ceil(now / 1000) + PANTA_MIN_START_DELAY_S + START_MARGIN_S;
  const endTime = Math.floor(draft.closesAt / 1000);
  const resolutionTime = Math.max(endTime, Math.floor(draft.resolvesAt / 1000));
  if (!(startTime < endTime && endTime <= resolutionTime)) return null;
  return { startTime, endTime, resolutionTime };
}

/** The rules the client renders and validates against, from one source. */
export function publicRules() {
  return {
    categories: [...PANTA_CREATE_CATEGORIES],
    outcomes: ["YES", "NO"] as const,
    questionMin: QUESTION_MIN, questionMax: QUESTION_MAX,
    rulesMin: RULES_MIN, rulesMax: RULES_MAX,
    descriptionMax: DESCRIPTION_MAX,
    sourcesMax: SOURCES_MAX, sourceUrlMax: SOURCE_URL_MAX,
    proposeMinLeadMs: PROPOSE_MIN_LEAD_MS,
    publishMinLeadMs: PUBLISH_MIN_LEAD_MS,
    maxHorizonMs: MAX_HORIZON_MS,
    maxResolutionGapMs: MAX_RESOLUTION_GAP_MS,
  };
}
