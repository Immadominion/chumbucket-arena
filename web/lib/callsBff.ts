/**
 * Server-side reads from the public calls BFF, for the shareable /c, /u and /m
 * pages and the home page. Public queries only: no session, no wallet, no
 * cookie is ever forwarded, so a page shows exactly what a signed-out person
 * may see (public calls; followers-only calls never appear).
 *
 * tRPC over plain GET (`?input={"json":…}`), the same wire the app uses, with
 * short revalidation so a resolved receipt shows up within a minute without
 * every visit costing a round trip to Railway.
 */

export const CALLS_BFF_URL = (
  process.env.CALLS_BFF_URL ??
  process.env.NEXT_PUBLIC_CALLS_BFF_URL ??
  "https://chumbucket-calls-bff-production.up.railway.app"
).replace(/\/+$/, "");

// ── wire shapes (src/calls/types.ts, read-only subset) ──────────────────────

export type Side = "YES" | "NO";
export type CallOutcome = "PENDING" | "CORRECT" | "INCORRECT" | "VOID";
export type MarketStatus = "OPEN" | "CLOSED" | "RESOLVED" | "VOID" | string;

export interface SharePrice {
  venue: string;
  currency: string;
  unit: string;
  yesPrice: string | null;
  noPrice: string | null;
  observedAt: number;
  attribution: string | null;
}

export interface Market {
  id: string;
  venue: string;
  /** The market's quote asset. Panta markets are USDC or SOL; null/absent on older servers (USDC only). */
  quoteCurrency?: "USDC" | "SOL" | null;
  /** Whether Chumbucket can trade it. A SOL-quoted market takes calls only. */
  tradable?: boolean;
  venueMarketId: string | null;
  question: string;
  rulesText: string | null;
  category: string | null;
  outcomes: Array<{ side: Side; label: string }>;
  status: MarketStatus;
  closesAt: number | null;
  resolvesAt: number | null;
}

export interface Person {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** The app's preset picture (1..5) when the person picked one instead of a photo. */
  avatarId?: number | null;
  settledCalls: number;
  correctCalls: number;
}

/** A person as the people.* queries return them (no call counts). */
export interface PersonRef {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  avatarId?: number | null;
}

/** Counts behind a record: only calls the venue decided are right or wrong. */
export interface RecordCounts {
  correct: number;
  incorrect: number;
  voided: number;
  resolved: number;
  decided: number;
  pending: number;
}

export interface LeaderboardRow {
  rank: number | null;
  person: PersonRef;
  record: { counts: RecordCounts };
}

/** people.leaderboard: `ranked` have enough decided calls for a percentage, `building` not yet. */
export interface Leaderboard {
  window: string;
  ranked: LeaderboardRow[];
  building: LeaderboardRow[];
  minimumDecided: number;
}

/** people.suggested (signed out): people worth following, with their records. */
export interface Suggested {
  people: Array<PersonRef & { record?: { counts: RecordCounts } | null }>;
}

export interface Call {
  id: string;
  userId: string;
  marketId: string;
  side: Side;
  confidence: number | null;
  thesis: string | null;
  entryPrice?: SharePrice | null;
  visibility: "public" | "followers";
  createdAt: number;
  lockedAt: number;
  parentCallId: string | null;
  fundingState: string;
}

export interface CallResult {
  callId: string;
  outcome: CallOutcome;
  resolution: Side | "VOID" | null;
  resolvedAt: number | null;
}

export interface CallFeedEntry {
  call: Call;
  author: Person;
  market: Market;
  result: CallResult | null;
  backCount: number;
  fadeCount: number;
}

export interface CallDetail {
  entry: CallFeedEntry;
  parent: CallFeedEntry | null;
  responses: Array<{ id: string; kind: "back" | "fade" | "challenge"; createdAt: number }>;
}

export interface PersonDetail {
  person: Person;
  calls: CallFeedEntry[];
}

export interface MarketDetail {
  market: Market;
  sharePrice?: SharePrice | null;
}

// ── the fetch ────────────────────────────────────────────────────────────────

/** The BFF answered "no such thing" (or "not visible to a stranger"). */
export class NotFound extends Error {}
/** The BFF could not be reached or failed. The page shows a retry state. */
export class Unavailable extends Error {}

async function query<T>(path: string, input: unknown, revalidate: number): Promise<T> {
  const url = `${CALLS_BFF_URL}/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  let res: Response;
  try {
    // `next` is Next.js's fetch extension (ISR); cast so the module also
    // type-checks outside Next (the BFF repo's bun tests import it).
    res = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(8_000),
    } as RequestInit);
  } catch {
    throw new Unavailable(path);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Unavailable(path);
  }
  const err = (body as { error?: { json?: { data?: { code?: string } } } })?.error;
  if (err) {
    const code = err.json?.data?.code;
    if (code === "NOT_FOUND" || code === "BAD_REQUEST") throw new NotFound(path);
    throw new Unavailable(path);
  }
  const data = (body as { result?: { data?: { json?: T } } })?.result?.data?.json;
  if (data === undefined || data === null) throw new NotFound(path);
  return data;
}

export const getCall = (callId: string) => query<CallDetail>("calls.get", { callId }, 60);
export const getPerson = (personRef: string) =>
  query<PersonDetail>("people.get", { personRef: personRef.replace(/^@/, "") }, 60);
export const getMarket = (marketId: string) => query<MarketDetail>("markets.detail", { marketId }, 60);
export const getFeed = (limit = 6) =>
  query<{ entries: CallFeedEntry[] }>("calls.feed", { mode: "global", limit }, 60);
export const getOpenMarkets = () => query<Market[]>("markets.open", {}, 300);
/** Records move only when Panta settles a market, so five minutes is fresh enough. */
export const getLeaderboard = () => query<Leaderboard>("people.leaderboard", {}, 300);
export const getSuggested = () => query<Suggested>("people.suggested", {}, 300);

/** Safe-to-call wrapper for optional page sections: null on any failure. */
export async function maybe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

// ── presentation helpers (pure) ──────────────────────────────────────────────

/**
 * A per-share USDC price as people read it: `0.5` -> "50¢", `1.2` -> "$1.20".
 * Panta's YES and NO prices are independent venue prices (not complementary
 * probabilities) and may exceed 1 USDC, so nothing here assumes 0..1.
 * Missing, negative or unparsable -> null.
 */
export function centsLabel(price: string | null | undefined): string | null {
  if (price === null || price === undefined || price.trim() === "") return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1) return `$${n.toFixed(2)}`;
  const cents = Math.round(n * 1000) / 10;
  return `${Number.isInteger(cents) ? cents.toFixed(0) : cents.toFixed(1)}¢`;
}

/**
 * A per-share price in its market's own unit. USDC reads as cents
 * (`centsLabel`); a SOL-quoted Panta market's price reads in SOL
 * (`0.67 SOL`), never converted to dollars or cents.
 */
export function priceLabel(price: string | null | undefined, currency: string | null | undefined): string | null {
  const parts = priceParts(price, currency);
  return parts && (parts.unit ? `${parts.value} ${parts.unit}` : parts.value);
}

/**
 * `priceLabel` split for display: the figure, and the unit to set beside it
 * when the figure does not carry one. USDC: `{ value: "50¢", unit: null }`;
 * SOL: `{ value: "0.67", unit: "SOL" }`. Missing, negative or unparsable ->
 * null.
 */
export function priceParts(
  price: string | null | undefined,
  currency: string | null | undefined,
): { value: string; unit: "SOL" | null } | null {
  if (currency !== "SOL") {
    const cents = centsLabel(price);
    return cents ? { value: cents, unit: null } : null;
  }
  if (price === null || price === undefined || price.trim() === "") return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return null;
  return { value: n > 0 && n < 0.005 ? "<0.01" : n.toFixed(2), unit: "SOL" };
}

/** "USDC" or "SOL": the unit a share price is quoted in. */
export function priceUnit(currency: string | null | undefined): "USDC" | "SOL" {
  return currency === "SOL" ? "SOL" : "USDC";
}

/** The price a call was locked at, for its own side, in its own unit. */
export function entryLabel(call: Call): string | null {
  const p = call.entryPrice;
  if (!p) return null;
  return priceLabel(call.side === "YES" ? p.yesPrice : p.noPrice, p.currency);
}

export function sideLabel(market: Market, side: Side): string {
  return market.outcomes.find((o) => o.side === side)?.label ?? (side === "YES" ? "Yes" : "No");
}

export function outcomeCopy(result: CallResult | null): { label: string; tone: "pending" | "won" | "lost" | "void" } {
  switch (result?.outcome) {
    // Same words as the app's receipt badges (call_badges.dart).
    case "CORRECT":
      return { label: "Correct", tone: "won" };
    case "INCORRECT":
      return { label: "Incorrect", tone: "lost" };
    case "VOID":
      return { label: "Void", tone: "void" };
    default:
      return { label: "Pending", tone: "pending" };
  }
}

export function statusCopy(status: MarketStatus): string {
  switch (status) {
    case "OPEN":
      return "Open";
    case "CLOSED":
      return "Closed, awaiting result";
    case "RESOLVED":
      return "Resolved";
    case "VOID":
      return "Void";
    default:
      return String(status).toLowerCase();
  }
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export function whenLabel(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return dateFmt.format(new Date(ms));
}

/** Where the venue shows this market. Panta only today. */
export function venueUrl(market: Market): string | null {
  if (market.venue === "panta" && market.venueMarketId) {
    return `https://panta.market/market/${encodeURIComponent(market.venueMarketId)}`;
  }
  return null;
}

/**
 * Whether the page may label this call "free". Only a call the BFF reports as
 * unfunded (`NONE`, or no state at all on an older payload) qualifies; any
 * funding state, even one that is not money yet, is never called free.
 */
export function isFreeCall(call: Pick<Call, "fundingState">): boolean {
  return !call.fundingState || call.fundingState === "NONE";
}

export function recordLabel(p: Person): string {
  if (p.settledCalls === 0) return "No settled calls yet";
  return `${p.correctCalls} of ${p.settledCalls} settled calls right`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** The app's preset pictures, mirrored from the mobile repo into public/img/profile. */
const PRESET_AVATARS = 5;

/**
 * What to show for a person, as the app decides it (avatar_catalog.dart's
 * avatarImageFor): their own https picture (X or Google, when they signed in
 * with one), else the preset picture they chose, else null for initials.
 */
export function avatarSrc(person: { avatarUrl: string | null; avatarId?: number | null }): string | null {
  const own = safeAvatar(person.avatarUrl);
  if (own) return own;
  const id = person.avatarId;
  return typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= PRESET_AVATARS ? `/img/profile/${id}.png` : null;
}

/** Only https avatars are rendered; anything else falls back to initials. */
export function safeAvatar(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
